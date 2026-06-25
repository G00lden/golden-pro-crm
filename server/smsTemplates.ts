/**
 * Short Arabic SMS templates for the self-hosted phone gateway.
 *
 * SMS is the no-external-provider reply channel: messages are queued and sent
 * from the company SIM by the user's Android automation app. Keep them short.
 */
const COMPANY = process.env.COMPANY_NAME || "Breexe Pro";

export type SmsTemplateVars = Record<string, string | number | null | undefined>;

function render(tmpl: string, vars: SmsTemplateVars): string {
  return tmpl.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (full, key) => {
    const v = vars[key];
    return v === null || v === undefined || v === "" ? full : String(v);
  });
}

/** Missed call, menu mode: ask the caller to reply with a department digit. */
export function smsMissedMenu(menu: string): string {
  return render(
    `شكراً لاتصالك بـ{company}. تعذّر الرد على مكالمتك.\nللخدمة الأسرع أرسل رقم القسم:\n{menu}`,
    { company: COMPANY, menu },
  );
}

/** Missed call, direct mode: tell the caller who will follow up. */
export function smsMissedDirect(departmentName: string, agentName: string): string {
  return render(
    `شكراً لاتصالك بـ{company}. تعذّر الرد على مكالمتك.\nسيتواصل معك {agent} من قسم {dept} في أقرب وقت.`,
    { company: COMPANY, dept: departmentName || "خدمة العملاء", agent: agentName || "أحد موظفينا" },
  );
}

/** Confirmation after the caller picked a department by SMS. */
export function smsRoutedCustomer(departmentName: string, agentName: string): string {
  return render(
    `تم تحويل طلبك إلى قسم {dept}. سيتواصل معك {agent} قريباً. شكراً لك.`,
    { dept: departmentName, agent: agentName || "الموظف المختص" },
  );
}

/** Alert to the assigned agent to call the customer back. */
export function smsAgentAlert(departmentName: string, customerPhone: string): string {
  return render(
    `مكالمة فائتة - قسم {dept}\nالعميل: {customer}\nيرجى معاودة الاتصال.`,
    { dept: departmentName || "-", customer: customerPhone || "-" },
  );
}
