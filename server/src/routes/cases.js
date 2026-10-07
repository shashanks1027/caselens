import { Router } from 'express';
import { z } from 'zod';
import Case from '../models/Case.js';
import Document from '../models/Document.js';
import ChatMessage from '../models/ChatMessage.js';
import { validate } from '../middleware/validate.js';
import { ah, HttpError } from '../middleware/error.js';
import { buildCorpus, buildTimeline } from '../services/corpus.js';
import { topChunks } from '../services/retrieval.js';
import * as ai from '../services/claude.js';

const router = Router();

const caseSchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(150),
  description: z.string().trim().max(2000).optional().default(''),
});

// Loads a case owned by the current user, or 404s
async function loadCase(req) {
  const c = await Case.findOne({ _id: req.params.id, owner: req.userId });
  if (!c) throw new HttpError(404, 'Case not found');
  return c;
}

router.get(
  '/',
  ah(async (req, res) => {
    const cases = await Case.find({ owner: req.userId }).sort({ updatedAt: -1 }).select('-analysis').lean();
    const counts = await Document.aggregate([
      { $match: { case: { $in: cases.map((c) => c._id) } } },
      { $group: { _id: '$case', n: { $sum: 1 } } },
    ]);
    const byId = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
    res.json({ cases: cases.map((c) => ({ ...c, documentCount: byId[String(c._id)] || 0 })) });
  })
);

router.post(
  '/',
  validate(caseSchema),
  ah(async (req, res) => {
    const c = await Case.create({ ...req.body, owner: req.userId });
    res.status(201).json({ case: c });
  })
);

router.get(
  '/:id',
  ah(async (req, res) => {
    const c = await loadCase(req);
    res.json({ case: c });
  })
);

router.patch(
  '/:id',
  validate(caseSchema.partial()),
  ah(async (req, res) => {
    const c = await loadCase(req);
    Object.assign(c, req.body);
    await c.save();
    res.json({ case: c });
  })
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const c = await loadCase(req);
    await Promise.all([Document.deleteMany({ case: c._id }), ChatMessage.deleteMany({ case: c._id }), c.deleteOne()]);
    res.status(204).end();
  })
);

// ---------- Timeline (derived from per-document extractions; no extra AI call) ----------
router.get(
  '/:id/timeline',
  ah(async (req, res) => {
    const c = await loadCase(req);
    const docs = await Document.find({ case: c._id, status: 'ready' }).select('filename extraction').lean();
    res.json({ events: buildTimeline(docs) });
  })
);

// ---------- Case-wide AI analyses (cached on the case) ----------
const ANALYSES = {
  contradictions: ai.findContradictions,
  legal: ai.mapLegalElements,
  brief: ai.generateBrief,
};
const FIELD = { contradictions: 'contradictions', legal: 'legalMapping', brief: 'brief' };

router.post(
  '/:id/analysis/:kind',
  ah(async (req, res) => {
    const fn = ANALYSES[req.params.kind];
    if (!fn) throw new HttpError(404, 'Unknown analysis type');
    const c = await loadCase(req);
    const docs = await Document.find({ case: c._id, status: 'ready' }).lean();
    if (!docs.length) throw new HttpError(400, 'Upload and process at least one document first');
    if (req.params.kind === 'contradictions' && docs.length < 2)
      throw new HttpError(400, 'Contradiction analysis needs at least two documents');

    const result = await fn({ caseTitle: c.title, corpus: buildCorpus(docs) });
    const payload = { ...result, generatedAt: new Date(), documentCount: docs.length };
    c.analysis[FIELD[req.params.kind]] = payload;
    c.markModified('analysis');
    await c.save();
    res.json({ result: payload });
  })
);

// ---------- Chat with the case (retrieval + cited answers) ----------
const chatSchema = z.object({ question: z.string().trim().min(2).max(2000) });

router.get(
  '/:id/chat',
  ah(async (req, res) => {
    const c = await loadCase(req);
    const messages = await ChatMessage.find({ case: c._id }).sort({ createdAt: 1 }).lean();
    res.json({ messages });
  })
);

router.delete(
  '/:id/chat',
  ah(async (req, res) => {
    const c = await loadCase(req);
    await ChatMessage.deleteMany({ case: c._id });
    res.status(204).end();
  })
);

router.post(
  '/:id/chat',
  validate(chatSchema),
  ah(async (req, res) => {
    const c = await loadCase(req);
    const docs = await Document.find({ case: c._id, status: 'ready' }).select('filename chunks').lean();
    if (!docs.length) throw new HttpError(400, 'Upload and process at least one document first');

    const allChunks = docs.flatMap((d) =>
      d.chunks.map((ch) => ({ documentId: String(d._id), filename: d.filename, page: ch.page, text: ch.text }))
    );
    const excerpts = topChunks(allChunks, req.body.question, 8);
    const history = (await ChatMessage.find({ case: c._id }).sort({ createdAt: -1 }).limit(6).lean()).reverse();

    const { answer, usedExcerpts = [] } = await ai.answerQuestion({ question: req.body.question, excerpts, history });

    // Citations for every [n] in the answer, plus anything the model said it used
    const cited = new Set(usedExcerpts);
    for (const m of answer.matchAll(/\[(\d+)\]/g)) cited.add(Number(m[1]));
    const citations = [...cited]
      .filter((n) => n >= 1 && n <= excerpts.length)
      .sort((a, b) => a - b)
      .map((n) => {
        const e = excerpts[n - 1];
        return { n, documentId: e.documentId, filename: e.filename, page: e.page, excerpt: e.text.slice(0, 400) };
      });

    // Saved one after the other so createdAt keeps them in order
    const userMsg = await ChatMessage.create({ case: c._id, role: 'user', content: req.body.question });
    const assistantMsg = await ChatMessage.create({ case: c._id, role: 'assistant', content: answer, citations });
    res.status(201).json({ messages: [userMsg, assistantMsg] });
  })
);

export default router;
