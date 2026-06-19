import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';

export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    req.body = result.data; // use parsed/coerced data
    next();
  };
}

// ── Auth schemas ──

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().optional(),
});

// ── WhatsApp schemas ──

export const sendTestSchema = z.object({
  phone: z.string().min(1, 'Phone number is required'),
  message: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ── Escalation schemas ──

export const resolveEscalationSchema = z.object({
  notes: z.string().optional(),
});

export const assignEscalationSchema = z.object({
  assigned_to: z.string().min(1, 'assigned_to is required'),
  notes: z.string().optional(),
});

// ── Store webhook schema ──

export const storeWebhookSchema = z.object({
}).passthrough();
