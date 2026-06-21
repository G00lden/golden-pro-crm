import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

function validationError(res: Response, error: z.ZodError) {
  res.status(400).json({
    error: 'Validation failed',
    details: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
  });
}

export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      validationError(res, result.error);
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      validationError(res, result.error);
      return;
    }
    req.query = result.data as Request['query'];
    next();
  };
}

// Auth schemas

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().optional(),
});

// WhatsApp schemas

export const sendTestSchema = z.object({
  phone: z.string().min(1, 'Phone number is required').max(32),
  message: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const whatsappTemplateSendSchema = z.object({
  phone: z.string().min(1, 'Phone number is required').max(32),
  template: z.string().min(1, 'Template is required').max(120),
  vars: z.record(z.string(), z.string().max(2000)).optional(),
  installation_id: z.string().max(160).optional(),
  booking_id: z.string().max(160).optional(),
  outboundCode: z.string().max(160).optional(),
});

export const whatsappConversationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).passthrough();

export const whatsappWebhookVerifyQuerySchema = z.object({
  'hub.mode': z.string().max(80).optional(),
  'hub.verify_token': z.string().max(4096).optional(),
  'hub.challenge': z.union([z.string().max(4096), z.number()]).optional(),
}).passthrough();

export const whatsappWebhookBodySchema = z.object({
  object: z.string().max(120).optional(),
  entry: z.array(z.unknown()).max(50).optional(),
}).passthrough();

// Escalation schemas

export const resolveEscalationSchema = z.object({
  notes: z.string().optional(),
});

export const assignEscalationSchema = z.object({
  assigned_to: z.string().min(1, 'assigned_to is required'),
  notes: z.string().optional(),
});

// Public webhook schemas

export const storeWebhookSchema = z.object({}).passthrough();

export const sallaWebhookSchema = z.object({}).passthrough();

export const sallaCallbackQuerySchema = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(4096).optional(),
  error: z.string().max(512).optional(),
  error_description: z.string().max(4096).optional(),
}).passthrough();

export const publicInvoiceShareQuerySchema = z.object({
  token: z.string().min(32).max(256),
}).passthrough();
