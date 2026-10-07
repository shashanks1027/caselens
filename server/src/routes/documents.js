import { Router } from 'express';
import multer from 'multer';
import Case from '../models/Case.js';
import Document from '../models/Document.js';
import { ah, HttpError } from '../middleware/error.js';
import { extractPages, chunkPages, withPageMarkers } from '../services/pdf.js';
import { extractDocument } from '../services/claude.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf', 'text/plain'].includes(file.mimetype) || /\.(pdf|txt)$/i.test(file.originalname);
    cb(ok ? null : new HttpError(400, `Unsupported file type: ${file.originalname} (PDF or TXT only)`), ok);
  },
});

const LIST_FIELDS = '-pages -chunks';

async function ownedCase(req, id) {
  const c = await Case.findOne({ _id: id, owner: req.userId });
  if (!c) throw new HttpError(404, 'Case not found');
  return c;
}

async function ownedDoc(req) {
  const d = await Document.findOne({ _id: req.params.docId, owner: req.userId });
  if (!d) throw new HttpError(404, 'Document not found');
  return d;
}

// Runs the AI extraction in the background; the client polls the document status.
async function processDocument(docId) {
  const doc = await Document.findById(docId);
  if (!doc) return;
  try {
    if (!doc.pages.join('').trim()) {
      throw new Error('No selectable text found. Scanned PDFs need OCR before upload.');
    }
    doc.extraction = await extractDocument({ filename: doc.filename, pagedText: withPageMarkers(doc.pages) });
    doc.status = 'ready';
    doc.error = undefined;
  } catch (err) {
    doc.status = 'failed';
    doc.error = err.message;
  }
  await doc.save();
  // Case-wide analyses are now stale
  await Case.updateOne(
    { _id: doc.case },
    { $set: { 'analysis.contradictions': null, 'analysis.legalMapping': null, 'analysis.brief': null } }
  );
}

// Upload one or more documents to a case
router.post(
  '/cases/:id/documents',
  upload.array('files', 10),
  ah(async (req, res) => {
    const c = await ownedCase(req, req.params.id);
    if (!req.files?.length) throw new HttpError(400, 'No files uploaded (form field name: "files")');

    const created = [];
    for (const f of req.files) {
      let parsed;
      try {
        parsed = await extractPages(f.buffer, f.mimetype, f.originalname);
      } catch {
        throw new HttpError(400, `Could not read ${f.originalname}. Is it a valid PDF?`);
      }
      const doc = await Document.create({
        case: c._id,
        owner: req.userId,
        filename: f.originalname,
        mimeType: f.mimetype,
        size: f.size,
        pageCount: parsed.pageCount,
        pages: parsed.pages,
        chunks: chunkPages(parsed.pages),
      });
      created.push(doc);
    }
    c.updatedAt = new Date();
    await c.save();

    // Fire-and-forget processing, one doc after another to stay within API rate limits
    (async () => {
      for (const d of created) await processDocument(d._id);
    })();

    const docs = await Document.find({ _id: { $in: created.map((d) => d._id) } }).select(LIST_FIELDS);
    res.status(201).json({ documents: docs });
  })
);

router.get(
  '/cases/:id/documents',
  ah(async (req, res) => {
    const c = await ownedCase(req, req.params.id);
    const documents = await Document.find({ case: c._id }).select(LIST_FIELDS).sort({ createdAt: 1 });
    res.json({ documents });
  })
);

router.get(
  '/documents/:docId',
  ah(async (req, res) => {
    const doc = await ownedDoc(req);
    const { chunks, ...rest } = doc.toObject();
    res.json({ document: rest });
  })
);

router.post(
  '/documents/:docId/reprocess',
  ah(async (req, res) => {
    const doc = await ownedDoc(req);
    doc.status = 'processing';
    doc.error = undefined;
    await doc.save();
    processDocument(doc._id);
    res.json({ document: { _id: doc._id, status: doc.status } });
  })
);

router.delete(
  '/documents/:docId',
  ah(async (req, res) => {
    const doc = await ownedDoc(req);
    await doc.deleteOne();
    await Case.updateOne(
      { _id: doc.case },
      { $set: { 'analysis.contradictions': null, 'analysis.legalMapping': null, 'analysis.brief': null } }
    );
    res.status(204).end();
  })
);

export default router;
