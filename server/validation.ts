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

export function validateParams(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      validationError(res, result.error);
      return;
    }
    req.params = result.data as Request['params'];
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
  outboundCode: z.string().max(160).optional(),
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

const campaignTemplateSchema = z.literal('general_reminder');

export const communicationPreferenceSchema = z.object({
  phone: z.string().min(1).max(32),
  channel: z.enum(['whatsapp', 'sms']).optional().default('whatsapp'),
  status: z.enum(['granted', 'withdrawn']),
  source: z.string().min(1).max(100).optional().default('manual_admin'),
  evidence: z.string().min(1, 'Consent evidence is required').max(1000),
  lift_suppression: z.boolean().optional().default(false),
});

export const communicationCampaignSchema = z.object({
  name: z.string().trim().min(1).max(160),
  template_name: campaignTemplateSchema,
  audience_filter: z.object({
    allCustomers: z.boolean().optional(),
    city: z.string().trim().min(1).max(160).optional(),
    source: z.string().trim().min(1).max(80).optional(),
    customerIds: z.array(z.string().min(1).max(160)).max(1000).optional(),
  }).refine(
    (value) => Boolean(value.allCustomers || value.city || value.source || value.customerIds?.length),
    'At least one audience criterion is required',
  ),
  template_vars: z.record(z.string().max(80), z.union([z.string().max(2000), z.number()])).optional(),
  rate_limit_per_minute: z.coerce.number().int().min(1).max(120).optional(),
  frequency_cap_days: z.coerce.number().int().min(1).max(90).optional(),
});

export const communicationCampaignLaunchSchema = z.object({
  scheduled_at: z.string().datetime({ offset: true }).optional().nullable(),
});

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

const publicLeadUtmSchema = z.object({
  utm_source: z.string().trim().max(160).optional(),
  utm_medium: z.string().trim().max(160).optional(),
  utm_campaign: z.string().trim().max(240).optional(),
  utm_content: z.string().trim().max(240).optional(),
  utm_term: z.string().trim().max(240).optional(),
  gclid: z.string().trim().max(512).optional(),
  fbclid: z.string().trim().max(512).optional(),
  ttclid: z.string().trim().max(512).optional(),
  landing_url: z.string().trim().max(2048).optional(),
  referrer: z.string().trim().max(2048).optional(),
  ts: z.string().datetime({ offset: true }).optional(),
}).strict();

export const publicLeadSchema = z.object({
  name: z.string().trim().min(2, 'Name must contain at least 2 characters').max(120),
  phone: z.string().trim().min(7).max(32).refine((value) => {
    if (!/^[+0-9 ()-]+$/.test(value)) return false;
    const digits = value.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15;
  }, 'Phone number is invalid'),
  service: z.string().trim().max(120).optional().default(''),
  message: z.string().trim().max(2000).optional().default(''),
  source: z.enum(['landing', 'landing-v2']).optional().default('landing'),
  utm: publicLeadUtmSchema.optional().default({}),
  // Honeypot. Real clients leave this blank; filled submissions are discarded.
  website: z.string().trim().max(200).optional().default(''),
}).strict();

export type PublicLeadInput = z.infer<typeof publicLeadSchema>;

// Telephony / IVR schemas

// Inbound IVR + status webhooks from the telephony provider. Kept permissive
// (passthrough) because exact provider field names are normalized in the
// adapter; we only guard against oversized bodies here.
export const telephonyWebhookSchema = z.object({}).passthrough();

export const telephonyWebhookQuerySchema = z.object({}).passthrough();

const ivrAgentSchema = z.object({
  user_id: z.string().max(160).optional().nullable(),
  name: z.string().max(160).optional().default(''),
  phone: z.string().min(1, 'agent phone is required').max(32),
  sort_order: z.coerce.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
});

export const telephonyDepartmentSchema = z.object({
  digit: z.string().regex(/^[0-9]$/, 'digit must be a single 0-9 character'),
  name: z.string().min(1, 'name is required').max(120),
  ring_timeout_sec: z.coerce.number().int().min(5).max(120).optional(),
  active: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).max(9999).optional(),
  agents: z.array(ivrAgentSchema).max(20).optional(),
});

export const telephonyDepartmentUpdateSchema = telephonyDepartmentSchema.partial();

export const telephonyConfigSchema = z.object({
  main_number: z.string().max(32).optional(),
  greeting: z.string().max(2000).optional(),
  menu_prompt: z.string().max(2000).optional(),
  ring_timeout_sec: z.coerce.number().int().min(5).max(120).optional(),
  enabled: z.boolean().optional(),
});

export const telephonyTestMissedSchema = z.object({
  from_phone: z.string().min(1, 'from_phone is required').max(32),
  digit: z.string().regex(/^[0-9]$/, 'digit must be a single 0-9 character').optional(),
  department_id: z.string().max(160).optional(),
});

export const telephonyCallsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  missed: z.enum(['true', 'false']).optional(),
}).passthrough();

// Self-hosted phone gateway schemas

export const gatewayEventSchema = z.object({
  id: z.string().max(100).optional(),
  eventId: z.string().max(100).optional(),
  callSid: z.string().max(100).optional(),
  type: z.string().min(1, 'type is required').max(40),
  from: z.string().max(32).optional(),
  to: z.string().max(32).optional(),
  text: z.string().max(2000).optional(),
  ts: z.string().max(40).optional(),
  occurredAt: z.string().max(40).optional(),
  device: z.string().max(100).optional(),
  source: z.string().max(40).optional(),
  disposition: z.string().max(40).optional(),
  durationSeconds: z.coerce.number().int().min(0).max(86400).optional(),
  phoneAccountId: z.string().max(160).optional(),
}).passthrough();

export const gatewayOutboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).passthrough();

export const gatewayAckSchema = z.object({
  ids: z.array(z.string().max(64)).max(100).optional(),
  failed: z.array(z.string().max(64)).max(100).optional(),
});

export const gatewayPairSchema = z.object({
  code: z.string().regex(/^\d{8}$/, "code must contain exactly 8 digits"),
  deviceName: z.string().trim().min(1, "deviceName is required").max(100),
  companyNumber: z.string().trim().max(32).optional(),
  clientNonce: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/, "invalid pairing client nonce"),
});

export const gatewayDeviceParamsSchema = z.object({
  id: z.string().regex(/^gwd_[A-Za-z0-9_-]{16}$/, "invalid gateway device id"),
});
