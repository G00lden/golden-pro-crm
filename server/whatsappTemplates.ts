/**
 * Pre-built Arabic message templates for Breexe Pro CRM WhatsApp comms.
 *
 * Templates are plain strings with `{placeholder}` slots. Render them with
 * `renderTemplate(name, vars)`. Unknown placeholders are left as-is (so
 * surprises show in QA instead of silently disappearing); missing vars are
 * replaced with an empty string only if explicitly opted in via `strict=false`.
 */

export type TemplateName =
  | "maintenance_reminder_first"
  | "maintenance_reminder_second"
  | "maintenance_reminder_third"
  | "maintenance_reminder_overdue"
  | "booking_confirmed"
  | "booking_rescheduled"
  | "booking_cancelled"
  | "technician_assigned"
  | "completion_thanks"
  | "general_reminder";

const DEFAULT_COMPANY = process.env.COMPANY_NAME || "Breexe Pro";

export const TEMPLATES: Record<TemplateName, string> = {
  maintenance_reminder_first: `عزيزي {customer_name}،
نذكركم بموعد صيانة {product_name} المقرر في {maintenance_date}.
يرجى تأكيد حضوركم بالرد على هذه الرسالة بكلمة "نعم".
فريق {company_name}`,
  maintenance_reminder_second: `عزيزي {customer_name}،
تذكير: موعد صيانة {product_name} غداً ({maintenance_date}).
لتأكيد الموعد رد بكلمة "نعم"، أو راسلنا لتغييره.
فريق {company_name}`,
  maintenance_reminder_third: `عزيزي {customer_name}،
اليوم موعد صيانة {product_name} ({maintenance_date}).
سيتواصل الفني قبل الحضور. لو تأجل أعلمنا فوراً.
فريق {company_name}`,
  maintenance_reminder_overdue: `عزيزي {customer_name}،
نشير إلى أن موعد صيانة {product_name} قد تجاوز تاريخه المقرر ({maintenance_date}).
نرجو التواصل معنا لتحديد موعد مناسب.
فريق {company_name}`,
  booking_confirmed: `عزيزي {customer_name}،
تم تأكيد موعد الصيانة الخاص بكم:
- المنتج: {product_name}
- التاريخ: {maintenance_date}
- الوقت: {scheduled_time}
- الفني: {technician_name}
شكراً لثقتكم.
فريق {company_name}`,
  booking_rescheduled: `عزيزي {customer_name}،
تم تعديل موعد صيانة {product_name}:
- التاريخ الجديد: {maintenance_date}
- الوقت: {scheduled_time}
- الفني: {technician_name}
فريق {company_name}`,
  booking_cancelled: `عزيزي {customer_name}،
تم إلغاء موعد صيانة {product_name} المقرر في {maintenance_date}.
لإعادة الجدولة، تواصل معنا.
فريق {company_name}`,
  technician_assigned: `عزيزي الفني {technician_name}،
تم تعيينك لموعد صيانة:
- العميل: {customer_name}
- المنتج: {product_name}
- العنوان: {customer_address}
- التاريخ: {maintenance_date}
- الوقت: {scheduled_time}`,
  completion_thanks: `شكراً لكم {customer_name} على ثقتكم.
تم إنجاز صيانة {product_name} بنجاح.
الموعد القادم: {next_maintenance_date}.
فريق {company_name}`,
  general_reminder: `{message}`,
};

export type RenderVars = Record<string, string | number | null | undefined>;

export type RenderOptions = {
  /** When false (default), missing variables are passed through as `{key}` so QA notices them. */
  strict?: boolean;
};

export function renderTemplate(name: TemplateName, vars: RenderVars = {}, options: RenderOptions = {}): string {
  const tmpl = TEMPLATES[name];
  if (!tmpl) throw new Error(`Unknown WhatsApp template: ${name}`);

  const merged: RenderVars = { company_name: DEFAULT_COMPANY, ...vars };
  return tmpl.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (full, key) => {
    const value = merged[key];
    if (value === null || value === undefined || value === "") {
      return options.strict === false ? "" : full;
    }
    return String(value);
  });
}

export function listTemplateNames(): TemplateName[] {
  return Object.keys(TEMPLATES) as TemplateName[];
}

/**
 * Returns the WhatsApp Cloud API parameter payload for a template message.
 * Cloud API templates are pre-approved by Meta; for the freeform template
 * `general_reminder` we instead return a plain text body.
 */
export function templateToCloudParams(name: TemplateName, vars: RenderVars): {
  isFreeform: boolean;
  body: string;
  templateName?: string;
  parameters?: Array<{ type: "text"; text: string }>;
} {
  const body = renderTemplate(name, vars);
  if (name === "general_reminder") {
    return { isFreeform: true, body };
  }
  return {
    isFreeform: false,
    body,
    templateName: name,
    parameters: [{ type: "text", text: body }],
  };
}
