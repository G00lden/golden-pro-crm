import {
  CheckCircle2,
  CircleAlert,
  LinkIcon,
  MessageCircle,
  Power,
  QrCode,
  RefreshCcw,
  Search,
  Send,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import * as api from "../api";

type Notifier = (message: string, ok?: boolean) => void;

type TemplateVariableField = {
  key: string;
  label: string;
  placeholder: string;
  type?: "text" | "date" | "time" | "tel" | "datetime-local";
  inputMode?: "text" | "tel" | "numeric";
  autoComplete?: string;
  dir?: "ltr" | "rtl";
  multiline?: boolean;
};

const TEMPLATE_FIELD_DEFINITIONS = {
  customer_name: { key: "customer_name", label: "اسم العميل", placeholder: "مثال: محمد أحمد…", autoComplete: "name" },
  product_name: { key: "product_name", label: "اسم المنتج", placeholder: "مثال: فلتر المياه المنزلي…", autoComplete: "off" },
  maintenance_date: { key: "maintenance_date", label: "تاريخ الصيانة", placeholder: "مثال: 2026-08-15…", type: "date", autoComplete: "off", dir: "ltr" },
  scheduled_time: { key: "scheduled_time", label: "وقت الموعد", placeholder: "مثال: 14:30…", type: "time", autoComplete: "off", dir: "ltr" },
  technician_name: { key: "technician_name", label: "اسم الفني", placeholder: "مثال: أحمد علي…", autoComplete: "name" },
  customer_address: { key: "customer_address", label: "عنوان العميل", placeholder: "مثال: الرياض، حي العليا…", autoComplete: "street-address" },
  next_maintenance_date: { key: "next_maintenance_date", label: "موعد الصيانة القادم", placeholder: "مثال: 2026-11-15…", type: "date", autoComplete: "off", dir: "ltr" },
  department_name: { key: "department_name", label: "اسم القسم", placeholder: "مثال: الصيانة…", autoComplete: "off" },
  agent_name: { key: "agent_name", label: "اسم الموظف المتابع", placeholder: "مثال: سارة أحمد…", autoComplete: "name" },
  customer_phone: { key: "customer_phone", label: "رقم العميل", placeholder: "مثال: 0500000000…", type: "tel", inputMode: "tel", autoComplete: "tel", dir: "ltr" },
  call_time: { key: "call_time", label: "وقت المكالمة", placeholder: "مثال: 2026-07-13 14:30…", type: "datetime-local", autoComplete: "off", dir: "ltr" },
  message: { key: "message", label: "نص التذكير", placeholder: "اكتب الرسالة التي ستظهر داخل القالب…", autoComplete: "off", multiline: true },
} satisfies Record<string, TemplateVariableField>;

type TemplateFieldKey = keyof typeof TEMPLATE_FIELD_DEFINITIONS;
const fieldsFor = (...keys: TemplateFieldKey[]) => keys.map((key) => TEMPLATE_FIELD_DEFINITIONS[key]);

const TEMPLATE_VARIABLE_FIELDS: Record<string, TemplateVariableField[]> = {
  maintenance_reminder_first: fieldsFor("customer_name", "product_name", "maintenance_date"),
  maintenance_reminder_second: fieldsFor("customer_name", "product_name", "maintenance_date"),
  maintenance_reminder_third: fieldsFor("customer_name", "product_name", "maintenance_date"),
  maintenance_reminder_overdue: fieldsFor("customer_name", "product_name", "maintenance_date"),
  booking_confirmed: fieldsFor("customer_name", "product_name", "maintenance_date", "scheduled_time", "technician_name"),
  booking_rescheduled: fieldsFor("customer_name", "product_name", "maintenance_date", "scheduled_time", "technician_name"),
  booking_cancelled: fieldsFor("customer_name", "product_name", "maintenance_date"),
  technician_assigned: fieldsFor("technician_name", "customer_name", "product_name", "customer_address", "maintenance_date", "scheduled_time"),
  completion_thanks: fieldsFor("customer_name", "product_name", "next_maintenance_date"),
  missed_call_customer: fieldsFor("department_name", "agent_name"),
  missed_call_agent: fieldsFor("department_name", "customer_phone", "call_time"),
  general_reminder: fieldsFor("message"),
};

function templateFieldsFor(templateName: string, sample: string): TemplateVariableField[] | null {
  const configured = TEMPLATE_VARIABLE_FIELDS[templateName];
  if (!configured) return null;
  const fields = [...configured];
  const known = new Set(fields.map((field) => field.key));
  for (const match of sample.matchAll(/\{([a-z_][a-z0-9_]*)\}/gi)) {
    const key = match[1];
    if (known.has(key)) continue;
    known.add(key);
    fields.push({
      key,
      label: key,
      placeholder: `أدخل قيمة ${key}…`,
      autoComplete: "off",
      dir: "ltr",
    });
  }
  return fields;
}

function renderSafeTemplatePreview(
  sample: string,
  fields: TemplateVariableField[],
  values: Record<string, string>,
) {
  const sampleContainsEveryField = fields.every((field) => sample.includes(`{${field.key}}`));
  if (!sampleContainsEveryField) {
    return fields.map((field) => {
      const value = String(values[field.key] || "").trim();
      return `${field.label}: ${value || `⟦مطلوب: ${field.label}⟧`}`;
    }).join("\n");
  }
  const byKey = new Map(fields.map((field) => [field.key, field]));
  return sample.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (_full, key: string) => {
    const field = byKey.get(key);
    const value = String(values[key] || "").trim();
    return value || `⟦مطلوب: ${field?.label || key}⟧`;
  });
}

const STATUS_TONE: Record<string, { label: string; color: string; bg: string }> = {
  connected: { label: "متصل", color: "#0fbf6c", bg: "rgba(15,191,108,0.12)" },
  qr_pending: { label: "بانتظار مسح QR", color: "#fbbf24", bg: "rgba(251,191,36,0.12)" },
  connecting: { label: "جاري الاتصال…", color: "#60a5fa", bg: "rgba(96,165,250,0.12)" },
  disconnected: { label: "غير متصل", color: "#9ca3af", bg: "rgba(156,163,175,0.12)" },
  error: { label: "خطأ", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
};

const DIRECTION_TONE: Record<string, { label: string; color: string }> = {
  inbound: { label: "وارد", color: "#60a5fa" },
  outbound: { label: "صادر", color: "#0fbf6c" },
};

const MSG_STATUS_TONE: Record<string, string> = {
  sent: "#60a5fa",
  delivered: "#a78bfa",
  read: "#0fbf6c",
  failed: "#ef4444",
  dry_run: "#fbbf24",
  pending: "#9ca3af",
};

function fmtDateTime(value?: string | null) {
  if (!value) return "—";
  try {
    return new Date(value.replace(" ", "T") + (value.length === 19 ? "Z" : "")).toLocaleString("ar-SA");
  } catch {
    return value;
  }
}

function phoneLabel(phone?: string | null) {
  if (!phone) return "—";
  const d = String(phone).replace(/\D/g, "");
  if (d.startsWith("966") && d.length === 12) return `+966 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return phone;
}

export function WhatsAppConsole({ notify }: { notify: Notifier }) {
  const [status, setStatus] = useState<api.WhatsAppStatus | null>(null);
  const [devices, setDevices] = useState<api.WhatsAppDevice[]>([]);
  const [stats, setStats] = useState<api.WhatsAppDailyStats | null>(null);
  const [recent, setRecent] = useState<api.WhatsAppMessage[]>([]);
  const [templates, setTemplates] = useState<api.WhatsAppTemplateInfo[]>([]);
  const [queue, setQueue] = useState<{ summary: api.CommunicationQueueSummary; jobs: api.CommunicationJob[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [qrAgeSec, setQrAgeSec] = useState(0);
  const lastQrSeenAt = useRef<number | null>(null);
  const lastQrValue = useRef<string | null>(null);

  const [sendPhone, setSendPhone] = useState("");
  const [sendMessage, setSendMessage] = useState("رسالة اختبار من نظام BreeXe Pro CRM");
  const [sendTemplate, setSendTemplate] = useState<string>("");
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [sendError, setSendError] = useState("");
  const [outboundCode, setOutboundCode] = useState("");
  const sendErrorRef = useRef<HTMLParagraphElement | null>(null);
  const sendFormRef = useRef<HTMLFormElement | null>(null);
  const templateSelectRef = useRef<HTMLSelectElement | null>(null);

  const [searchPhone, setSearchPhone] = useState("");
  const [searchConv, setSearchConv] = useState<api.WhatsAppMessage[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.name === sendTemplate) || null,
    [sendTemplate, templates],
  );
  const selectedTemplateFields = useMemo(
    () => selectedTemplate ? templateFieldsFor(selectedTemplate.name, selectedTemplate.sample) : [],
    [selectedTemplate],
  );
  const missingTemplateFields = useMemo(
    () => selectedTemplateFields?.filter((field) => !String(templateVars[field.key] || "").trim()) || [],
    [selectedTemplateFields, templateVars],
  );
  const templatePreview = useMemo(
    () => selectedTemplate && selectedTemplateFields
      ? renderSafeTemplatePreview(selectedTemplate.sample, selectedTemplateFields, templateVars)
      : "",
    [selectedTemplate, selectedTemplateFields, templateVars],
  );

  const changeSendTemplate = (templateName: string) => {
    setSendTemplate(templateName);
    setTemplateVars({});
    setSendError("");
  };

  const useTemplateFromLibrary = (templateName: string) => {
    changeSendTemplate(templateName);
    window.requestAnimationFrame(() => {
      sendFormRef.current?.scrollIntoView({ block: "start" });
      templateSelectRef.current?.focus();
    });
  };

  const showSendError = (message: string) => {
    setSendError(message);
    notify(message, false);
    window.requestAnimationFrame(() => sendErrorRef.current?.focus());
  };

  const refresh = useCallback(async () => {
    try {
      const [s, st, ds, msgs, tpls, jobs] = await Promise.all([
        api.getWhatsAppStatus(),
        api.getWhatsAppDailyStats(),
        api.getWhatsAppDevices(),
        api.listRecentWhatsAppMessages(40),
        api.getWhatsAppTemplates(),
        api.getWhatsAppJobs(30),
      ]);
      setStatus(s);
      setStats(st);
      setDevices(ds.devices);
      setRecent(msgs.items);
      setTemplates(tpls.templates);
      setQueue(jobs);
      if (s.qr) {
        // Restart the age clock every time a *new* QR string arrives (the code
        // rotates ~every minute). Previously the timestamp was set only once,
        // so the counter kept climbing across rotations and never reset.
        if (lastQrValue.current !== s.qr) {
          lastQrValue.current = s.qr;
          lastQrSeenAt.current = Date.now();
          setQrAgeSec(0);
        }
      } else {
        lastQrValue.current = null;
        lastQrSeenAt.current = null;
        setQrAgeSec(0);
      }
    } catch (err) {
      // soft fail — surface in inline status
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const isPending = status?.status === "qr_pending" || status?.status === "connecting";
    const interval = isPending ? 3_000 : 12_000;
    const timer = window.setInterval(refresh, interval);
    return () => window.clearInterval(timer);
  }, [status?.status, refresh]);

  useEffect(() => {
    if (status?.qr && lastQrSeenAt.current) {
      const tick = () => setQrAgeSec(Math.floor((Date.now() - (lastQrSeenAt.current ?? Date.now())) / 1000));
      tick();
      const timer = window.setInterval(tick, 1000);
      return () => window.clearInterval(timer);
    }
  }, [status?.qr]);

  const connect = async () => {
    setBusy("connect");
    try {
      const s = await api.connectWhatsApp();
      setStatus(s);
      lastQrSeenAt.current = null;
      lastQrValue.current = null;
      notify("تم بدء الاتصال — امسح الـ QR إذا ظهر");
      setTimeout(refresh, 2000);
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل الاتصال", false);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("فصل جلسة واتساب الحالية؟ ستحتاج لمسح QR مرة أخرى لإعادة الربط.")) return;
    setBusy("disconnect");
    try {
      const s = await api.disconnectWhatsApp();
      setStatus(s);
      setDevices([]);
      notify("تم فصل الاتصال");
      setTimeout(refresh, 1500);
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل الفصل", false);
    } finally {
      setBusy(null);
    }
  };

  const submitSend = async (event: FormEvent) => {
    event.preventDefault();
    setSendError("");
    const normalizedPhone = sendPhone.trim();
    if (!normalizedPhone) {
      showSendError("أدخل رقم الجوال قبل محاولة الإرسال.");
      return;
    }

    let normalizedTemplateVars: Record<string, string> | undefined;
    if (sendTemplate) {
      if (!selectedTemplate) {
        showSendError("تعذر العثور على القالب المحدد. حدّث الصفحة ثم اختر القالب من جديد.");
        return;
      }
      if (!selectedTemplateFields) {
        showSendError("هذا القالب لا يملك تعريف متغيرات آمن في هذه الصفحة، لذلك مُنع إرساله يدويًا. استخدم قسمه التشغيلي أو رسالة يدوية.");
        return;
      }
      if (missingTemplateFields.length) {
        showSendError(`أكمل متغيرات القالب المطلوبة: ${missingTemplateFields.map((field) => field.label).join("، ")}.`);
        return;
      }
      if (/\{[a-z_][a-z0-9_]*\}/i.test(templatePreview)) {
        showSendError("تحتوي معاينة القالب على متغير غير محلول. راجع القيم وأزل أي placeholder قبل الإرسال.");
        return;
      }
      normalizedTemplateVars = Object.fromEntries(
        selectedTemplateFields.map((field) => [field.key, String(templateVars[field.key] || "").trim()]),
      );
    } else {
      const normalizedMessage = sendMessage.trim();
      if (!normalizedMessage) {
        showSendError("اكتب نص الرسالة اليدوية قبل الإرسال.");
        return;
      }
      if (/\{[a-z_][a-z0-9_]*\}/i.test(normalizedMessage)) {
        showSendError("الرسالة اليدوية تحتوي على placeholder غير محلول. استبدله بقيمة فعلية قبل الإرسال.");
        return;
      }
    }

    setBusy("send");
    try {
      if (sendTemplate) {
        const result = await api.sendWhatsAppTemplateMessage({
          phone: normalizedPhone,
          template: sendTemplate,
          vars: normalizedTemplateVars,
          outboundCode: outboundCode.trim() || undefined,
        });
        const details = result.result as typeof result.result & { dryRun?: boolean };
        const simulated = result.simulated === true || result.dry_run === true || details.dryRun === true;
        notify(simulated
          ? `تمت محاكاة قالب ${sendTemplate} بأمان؛ لم تُرسل رسالة فعلية.`
          : `أُرسل قالب ${sendTemplate} → ${details.messageId || "(no id)"}`);
      } else {
        const result = await api.testWhatsApp(
          normalizedPhone,
          sendMessage.trim(),
          undefined,
          outboundCode.trim() || undefined,
        );
        const details = result.result as { messageId?: string; dryRun?: boolean };
        const simulated = result.simulated === true || result.dry_run === true || details?.dryRun === true;
        notify(simulated
          ? "تمت محاكاة الرسالة بأمان؛ لم تُرسل رسالة فعلية."
          : `أُرسلت الرسالة → ${details?.messageId || "(no id)"}`);
      }
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "فشل الإرسال", false);
    } finally {
      setBusy(null);
    }
  };

  const submitSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!searchPhone.trim()) return;
    setSearchLoading(true);
    try {
      const result = await api.getConversationByPhone(searchPhone.trim(), 200);
      setSearchConv(result.messages);
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر جلب المحادثة", false);
    } finally {
      setSearchLoading(false);
    }
  };

  const statusKey = status?.status || "disconnected";
  const tone = STATUS_TONE[statusKey] || STATUS_TONE.disconnected;
  const outbound = status?.outbound;

  if (loading && !status) {
    return (
      <div className="empty" dir="rtl">
        <RefreshCcw className="spin" size={26} />
        <p>جاري تحميل وحدة واتساب…</p>
      </div>
    );
  }

  return (
    <section dir="rtl" className="whatsapp-console cloud-design">
      <header className="wa-console-head">
        <div>
          <h1 style={{ margin: 0 }}>وحدة تحكم واتساب</h1>
          <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>الاتصال + الأجهزة المرتبطة + الإرسال + سجل الرسائل</p>
        </div>
        <div className="wa-actions">
          <span className="wa-status-pill" role="status" aria-live="polite" style={{ background: tone.bg, color: tone.color, borderColor: tone.color }}>
            ● {tone.label}
          </span>
          <button className="btn muted" type="button" onClick={refresh}><RefreshCcw size={14} /> تحديث</button>
          {statusKey !== "connected" ? (
            <button className="btn primary" type="button" onClick={connect} disabled={busy === "connect"}>
              <Power size={14} /> {busy === "connect" ? "…" : "بدء الاتصال"}
            </button>
          ) : (
            <button className="btn muted" type="button" onClick={disconnect} disabled={busy === "disconnect"}>
              <Trash2 size={14} /> {busy === "disconnect" ? "…" : "فصل"}
            </button>
          )}
        </div>
      </header>

      {/* QR */}
      {status?.qr && (
        <div className="wa-qr-card">
          <img src={status.qr} alt="رمز QR لربط واتساب" />
          <div>
            <h3 style={{ margin: 0, color: "#fbbf24" }}><QrCode size={18} style={{ verticalAlign: "middle" }} /> امسح هذا الرمز</h3>
            <p style={{ marginTop: 6 }}>افتح واتساب على جوالك → <strong>الإعدادات</strong> → <strong>الأجهزة المرتبطة</strong> → <strong>ربط جهاز</strong> → وجّه الكاميرا على هذا الرمز.</p>
            <p style={{ fontSize: 12, opacity: 0.7 }}>عمر الرمز الحالي: <strong>{qrAgeSec} ثانية</strong> (الرمز يتجدد كل دقيقة تقريباً، سيظهر الجديد تلقائياً)</p>
            <button className="btn primary" type="button" onClick={connect}>
              <RefreshCcw size={14} /> توليد QR جديد
            </button>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="wa-stat-grid">
        <Stat label="عمليات اليوم" value={stats?.today.sent || 0} color="#0fbf6c" icon={<Send size={18} aria-hidden="true" />} />
        <Stat label="تم التسليم" value={stats?.today.delivered || 0} color="#a78bfa" icon={<CheckCircle2 size={18} />} />
        <Stat label="تم القراءة" value={stats?.today.read || 0} color="#22d3ee" icon={<CheckCircle2 size={18} />} />
        <Stat label="فشل" value={stats?.today.failed || 0} color="#ef4444" icon={<CircleAlert size={18} />} />
        <Stat label="رسائل واردة" value={stats?.today.inbound || 0} color="#60a5fa" icon={<MessageCircle size={18} />} />
      </div>
      <p className="note" role="note">
        «عمليات اليوم» تعد كل العمليات الصادرة المسجلة، بما فيها المحاكاة الآمنة. الرسائل الفعلية تُعرف من مؤشري «تم التسليم» و«تم القراءة» ومن حالة كل رسالة.
      </p>

      <Panel title="طابور رسائل المكالمات والحملات" icon={<RefreshCcw size={16} />}>
        <div className="wa-stat-grid" style={{ marginBottom: 12 }}>
          <Stat label="بانتظار المعالجة" value={queue?.summary.waiting || 0} color="#60a5fa" icon={<RefreshCcw size={18} />} />
          <Stat label="أُرسلت" value={queue?.summary.sent || 0} color="#0fbf6c" icon={<CheckCircle2 size={18} />} />
          <Stat label="تحتاج تدخلاً" value={queue?.summary.attention || 0} color="#ef4444" icon={<CircleAlert size={18} />} />
          <Stat label="انتهت صلاحيتها" value={queue?.summary.expired || 0} color="#9ca3af" icon={<CircleAlert size={18} />} />
        </div>
        {queue?.jobs.length ? (
          <div className="scrollable-table-region" role="region" aria-label="طابور رسائل المكالمات والحملات" tabIndex={0}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ textAlign: "right", opacity: 0.7 }}>
                <th scope="col" style={{ padding: 6 }}>الوقت</th><th scope="col" style={{ padding: 6 }}>المستلم</th>
                <th scope="col" style={{ padding: 6 }}>القالب</th><th scope="col" style={{ padding: 6 }}>الحالة</th>
                <th scope="col" style={{ padding: 6 }}>المحاولات</th><th scope="col" style={{ padding: 6 }}>آخر خطأ</th>
              </tr></thead>
              <tbody>{queue.jobs.slice(0, 12).map((job) => (
                <tr key={job.id} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <td style={{ padding: 6, whiteSpace: "nowrap" }}>{fmtDateTime(job.created_at)}</td>
                  <td style={{ padding: 6 }} dir="ltr">{phoneLabel(job.recipient_phone)}</td>
                  <td style={{ padding: 6 }}><code>{job.template_name || job.kind}</code></td>
                  <td style={{ padding: 6 }}>{job.status}</td>
                  <td style={{ padding: 6 }}>{job.attempts}/{job.max_attempts}</td>
                  <td style={{ padding: 6, color: job.last_error ? "#ef4444" : undefined }}>{job.last_error || "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p style={{ opacity: 0.65 }}>لا توجد مهام اتصال مسجلة بعد.</p>}
      </Panel>

      {/* Devices + outbound mode */}
      <div className="wa-split">
        <Panel title="الأجهزة المرتبطة" icon={<Smartphone size={16} />}>
          {devices.length === 0 ? (
            <p style={{ opacity: 0.6 }}>لا يوجد جهاز مرتبط حالياً.</p>
          ) : (
            <ul className="wa-device-list">
              {devices.map((d) => (
                <li key={d.id}>
                  <strong dir="ltr" style={{ display: "block", direction: "ltr", textAlign: "right" }}>{d.id}</strong>
                  <small style={{ opacity: 0.7 }}>{d.label} · مرتبط منذ {fmtDateTime(d.connected_since)}</small>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="وضع الإرسال" icon={<CircleAlert size={16} />}>
          <p style={{ margin: 0 }}>
            <strong>{outbound?.mode === "dry_run" ? "تجريبي آمن" : outbound?.mode === "code" ? "بكود تأكيد" : outbound?.mode === "allowlist" ? "أرقام مسموحة فقط" : "إنتاج"}</strong>
          </p>
          {outbound?.mode === "code" && (
            <p style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              كل إرسال يتطلب كود التأكيد <code>{import.meta.env.VITE_OUTBOUND_HINT || "(يُمرَّر في حقل الإرسال أدناه)"}</code>.
            </p>
          )}
          {status?.lastError && (
            <p style={{ color: "#ef4444", fontSize: 12, marginTop: 4 }}>{status.lastError}</p>
          )}
          <p style={{ fontSize: 11, opacity: 0.5, marginTop: 8 }}>المزوّد: <code>{status?.provider}</code> {status?.user ? `· الجلسة: ${status.user}` : ""}</p>
        </Panel>
      </div>

      {/* Send test message */}
      <Panel title={outbound?.dryRun ? "محاكاة رسالة (اختبار / يدوي)" : "إرسال رسالة (اختبار / يدوي)"} icon={<Send size={16} />}>
        <form ref={sendFormRef} onSubmit={submitSend} className="wa-send-form" noValidate aria-busy={busy === "send"}>
          <label className="field">
            <span>رقم الجوال (05… أو +9665…)</span>
            <input
              className="input"
              type="tel"
              inputMode="tel"
              name="manual_whatsapp_phone"
              autoComplete="tel"
              aria-required="true"
              dir="ltr"
              value={sendPhone}
              onChange={(event) => {
                setSendPhone(event.target.value);
                setSendError("");
              }}
              placeholder="مثال: 0500000000…"
            />
          </label>
          <label className="field">
            <span>قالب (اختياري — يلغي الرسالة اليدوية)</span>
            <select
              ref={templateSelectRef}
              className="input"
              name="manual_whatsapp_template"
              autoComplete="off"
              value={sendTemplate}
              onChange={(event) => changeSendTemplate(event.target.value)}
            >
              <option value="">— رسالة يدوية —</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </label>
          {!sendTemplate && (
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>نص الرسالة</span>
              <textarea
                className="input textarea"
                rows={3}
                name="manual_whatsapp_message"
                autoComplete="off"
                aria-required="true"
                value={sendMessage}
                onChange={(event) => {
                  setSendMessage(event.target.value);
                  setSendError("");
                }}
                placeholder="اكتب رسالة مكتملة دون placeholders…"
              />
            </label>
          )}
          {sendTemplate && !selectedTemplateFields && (
            <p className="inline-error" role="alert" aria-live="polite" style={{ gridColumn: "1 / -1" }}>
              هذا القالب غير معرّف بمتغيراته في الصفحة، لذلك مُنع إرساله يدويًا. استخدم رسالة يدوية أو القسم التشغيلي المرتبط بالقالب.
            </p>
          )}
          {sendTemplate && selectedTemplateFields && (
            <>
              {selectedTemplateFields.map((field) => (
                <label className="field" key={field.key} style={field.multiline ? { gridColumn: "1 / -1" } : undefined}>
                  <span>{field.label} *</span>
                  {field.multiline ? (
                    <textarea
                      className="input textarea"
                      rows={3}
                      name={`template_${field.key}`}
                      autoComplete={field.autoComplete || "off"}
                      aria-required="true"
                      dir={field.dir}
                      value={templateVars[field.key] || ""}
                      onChange={(event) => {
                        setTemplateVars((current) => ({ ...current, [field.key]: event.target.value }));
                        setSendError("");
                      }}
                      placeholder={field.placeholder}
                    />
                  ) : (
                    <input
                      className="input"
                      type={field.type || "text"}
                      inputMode={field.inputMode}
                      name={`template_${field.key}`}
                      autoComplete={field.autoComplete || "off"}
                      aria-required="true"
                      dir={field.dir}
                      value={templateVars[field.key] || ""}
                      onChange={(event) => {
                        setTemplateVars((current) => ({ ...current, [field.key]: event.target.value }));
                        setSendError("");
                      }}
                      placeholder={field.placeholder}
                    />
                  )}
                </label>
              ))}
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <span>معاينة آمنة للقالب</span>
                <pre
                  className="wa-template-preview"
                  aria-live="polite"
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}
                >
                  {templatePreview}
                </pre>
                <small className={missingTemplateFields.length ? "inline-error" : "note"} role="status">
                  {missingTemplateFields.length
                    ? `متغيرات مطلوبة قبل الإرسال: ${missingTemplateFields.map((field) => field.label).join("، ")}.`
                    : "المعاينة مكتملة ولا تحتوي متغيرات فارغة."}
                </small>
              </div>
            </>
          )}
          {outbound?.mode === "code" && (
            <label className="field">
              <span>كود التأكيد (OUTBOUND_CONFIRM_CODE)</span>
              <input
                className="input"
                name="manual_whatsapp_outbound_code"
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                value={outboundCode}
                onChange={(event) => setOutboundCode(event.target.value)}
                placeholder="مثال: 2232…"
              />
            </label>
          )}
          {sendError && (
            <p
              ref={sendErrorRef}
              className="inline-error"
              role="alert"
              aria-live="polite"
              tabIndex={-1}
              style={{ gridColumn: "1 / -1" }}
            >
              {sendError}
            </p>
          )}
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button className="btn primary" type="submit" disabled={busy === "send"}>
              <Send size={14} aria-hidden="true" /> {busy === "send" ? "جاري التنفيذ…" : outbound?.dryRun ? "محاكاة الإرسال" : sendTemplate ? "إرسال القالب" : "إرسال الرسالة"}
            </button>
          </div>
        </form>
      </Panel>

      {/* Conversation search */}
      <Panel title="محادثة عميل" icon={<Search size={16} />}>
        <form onSubmit={submitSearch} className="wa-search-form" aria-busy={searchLoading}>
          <label className="field" style={{ flex: 1 }}>
            <span>رقم العميل</span>
            <input
              className="input"
              dir="ltr"
              type="tel"
              inputMode="tel"
              name="whatsapp_conversation_phone"
              autoComplete="tel"
              value={searchPhone}
              onChange={(e) => setSearchPhone(e.target.value)}
              placeholder="مثال: 0500000000…"
            />
          </label>
          <button className="btn primary" type="submit" disabled={searchLoading} aria-busy={searchLoading}>{searchLoading ? "جارٍ البحث…" : "بحث"}</button>
        </form>
        {searchConv && (
          <div className="wa-message-list compact">
            {searchConv.length === 0 ? <p style={{ opacity: 0.6 }}>لا توجد رسائل مع هذا الرقم.</p> : searchConv.map((m) => (
              <MessageRow key={m.id} m={m} />
            ))}
          </div>
        )}
      </Panel>

      {/* Recent activity stream */}
      <Panel title={`آخر ${recent.length} نشاط`} icon={<MessageCircle size={16} />}>
        {recent.length === 0 ? (
          <p style={{ opacity: 0.6 }}>لم تُسجّل أي رسائل حتى الآن.</p>
        ) : (
          <div className="wa-message-list">
            {recent.map((m) => <MessageRow key={m.id} m={m} />)}
          </div>
        )}
      </Panel>

      {/* Templates reference */}
      <Panel title="قوالب الرسائل المتاحة" icon={<LinkIcon size={16} />}>
        <div className="wa-template-grid">
          {templates.map((t) => (
            <div key={t.name} className="wa-template-card">
              <strong style={{ display: "block", fontSize: 13, marginBottom: 6 }}>{t.name}</strong>
              <pre>{t.sample}</pre>
              <button
                className="btn muted"
                type="button"
                style={{ marginTop: 6, fontSize: 12 }}
                onClick={() => useTemplateFromLibrary(t.name)}
              >
                استخدم هذا
              </button>
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );
}

function Stat({ label, value, color, icon }: { label: string; value: number; color: string; icon: React.ReactNode }) {
  return (
    <div className="wa-stat" style={{ borderColor: `${color}44` }}>
      <div className="wa-stat-icon" style={{ color }} aria-hidden="true">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="wa-panel">
      <h2 className="wa-panel-title">
        <span aria-hidden="true">{icon}</span> {title}
      </h2>
      {children}
    </section>
  );
}

function MessageRow({ m }: { m: api.WhatsAppMessage }) {
  const dir = m.direction || "outbound";
  const dirTone = DIRECTION_TONE[dir] || DIRECTION_TONE.outbound;
  const statusColor = (m.status && MSG_STATUS_TONE[m.status]) || "#9ca3af";
  const phone = dir === "inbound" ? m.from_phone : m.to_phone;
  return (
    <div className="wa-message-row" style={{ borderRightColor: dirTone.color }}>
      <div className="wa-message-meta">
        <span><strong style={{ color: dirTone.color }}>{dirTone.label}</strong> · {phoneLabel(phone)} {m.template_name ? `· ${m.template_name}` : ""}</span>
        <span><span style={{ color: statusColor }}>{m.status || "—"}</span> · {fmtDateTime(m.created_at)}</span>
      </div>
      {m.message && (
        <p>{m.message}</p>
      )}
    </div>
  );
}

export default WhatsAppConsole;
