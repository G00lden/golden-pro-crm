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
  | "call_answered_customer"
  | "missed_call_customer"
  | "missed_call_agent"
  | "general_reminder";

const DEFAULT_COMPANY = process.env.COMPANY_NAME || "Breexe Pro";

export const TEMPLATES: Record<TemplateName, string> = {
  call_answered_customer: `شكراً لاتصالك بـ{company_name}.
تم تسجيل اتصالك بنجاح. يمكنك كتابة ما تحتاجه هنا عبر واتساب، وسنتابع معك في أقرب فرصة.`,
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
  missed_call_customer: `شكراً لاتصالك بـ{company_name}.
نعتذر لعدم تمكننا من الرد على مكالمتك بخصوص قسم {department_name}.
سيتواصل معك {agent_name} في أقرب وقت ممكن.
يمكنك أيضاً مراسلتنا هنا مباشرة وسنخدمك فوراً.`,
  missed_call_agent: `📞 مكالمة فائتة — قسم {department_name}
رقم العميل: {customer_phone}
وقت الاتصال: {call_time}
لم تتم الإجابة على المكالمة. يرجى معاودة الاتصال بالعميل في أقرب وقت.`,
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

export function templateVariableNames(name: TemplateName): string[] {
  const seen = new Set<string>();
  for (const match of TEMPLATES[name].matchAll(/\{([a-z_][a-z0-9_]*)\}/gi)) {
    seen.add(match[1]);
  }
  return [...seen];
}

export function cloudTemplateEnvKey(name: TemplateName): string {
  return `WHATSAPP_CLOUD_TEMPLATE_${name.toUpperCase()}`;
}

/**
 * Returns the WhatsApp Cloud API parameter payload for a template message.
 * Cloud API templates are pre-approved by Meta; for the freeform template
 * `general_reminder` maps its single `{message}` variable to one approved
 * Cloud-template body placeholder; WhatsApp Web still renders it as text.
 */
export function templateToCloudParams(name: TemplateName, vars: RenderVars): {
  isFreeform: boolean;
  body: string;
  templateName?: string;
  parameters?: Array<{ type: "text"; text: string }>;
} {
  const merged: RenderVars = { company_name: DEFAULT_COMPANY, ...vars };
  const body = renderTemplate(name, merged);
  return {
    isFreeform: false,
    body,
    templateName: name,
    parameters: templateVariableNames(name).map((key) => ({
      type: "text" as const,
      text: String(merged[key] ?? "-"),
    })),
  };
}
