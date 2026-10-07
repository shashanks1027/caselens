import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import User from '../models/User.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { ah, HttpError } from '../middleware/error.js';

const router = Router();

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1, 'Password is required'),
});

router.post(
  '/register',
  validate(registerSchema),
  ah(async (req, res) => {
    const { name, email, password } = req.body;
    if (await User.exists({ email: email.toLowerCase() })) throw new HttpError(409, 'Email is already registered');
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, passwordHash });
    res.status(201).json({ token: signToken(user._id), user });
  })
);

router.post(
  '/login',
  validate(loginSchema),
  ah(async (req, res) => {
    const user = await User.findOne({ email: req.body.email.toLowerCase() });
    const ok = user && (await bcrypt.compare(req.body.password, user.passwordHash));
    if (!ok) throw new HttpError(401, 'Invalid email or password');
    res.json({ token: signToken(user._id), user });
  })
);

router.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const user = await User.findById(req.userId);
    if (!user) throw new HttpError(404, 'User not found');
    res.json({ user });
  })
);

export default router;
