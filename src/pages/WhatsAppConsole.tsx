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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [qrAgeSec, setQrAgeSec] = useState(0);
  const lastQrSeenAt = useRef<number | null>(null);
  const lastQrValue = useRef<string | null>(null);

  const [sendPhone, setSendPhone] = useState("");
  const [sendMessage, setSendMessage] = useState("رسالة اختبار من نظام BreeXe Pro CRM");
  const [sendTemplate, setSendTemplate] = useState<string>("");
  const [outboundCode, setOutboundCode] = useState("");

  const [searchPhone, setSearchPhone] = useState("");
  const [searchConv, setSearchConv] = useState<api.WhatsAppMessage[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, st, ds, msgs, tpls] = await Promise.all([
        api.getWhatsAppStatus(),
        api.getWhatsAppDailyStats(),
        api.getWhatsAppDevices(),
        api.listRecentWhatsAppMessages(40),
        api.getWhatsAppTemplates(),
      ]);
      setStatus(s);
      setStats(st);
      setDevices(ds.devices);
      setRecent(msgs.items);
      setTemplates(tpls.templates);
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
    setBusy("send");
    try {
      if (sendTemplate) {
        const result = await api.sendWhatsAppTemplateMessage({
          phone: sendPhone,
          template: sendTemplate,
          outboundCode: outboundCode || undefined,
        });
        notify(`أُرسل قالب ${sendTemplate} → ${result.result.messageId || "(no id)"}`);
      } else {
        const result = await api.testWhatsApp(sendPhone, sendMessage);
        notify(`أُرسلت الرسالة → ${(result.result as { messageId?: string })?.messageId || "(no id)"}`);
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
          <span className="wa-status-pill" style={{ background: tone.bg, color: tone.color, borderColor: tone.color }}>
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
          <img src={status.qr} alt="WhatsApp QR" />
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
        <Stat label="أرسلت اليوم" value={stats?.today.sent || 0} color="#0fbf6c" icon={<Send size={18} />} />
        <Stat label="تم التسليم" value={stats?.today.delivered || 0} color="#a78bfa" icon={<CheckCircle2 size={18} />} />
        <Stat label="تم القراءة" value={stats?.today.read || 0} color="#22d3ee" icon={<CheckCircle2 size={18} />} />
        <Stat label="فشل" value={stats?.today.failed || 0} color="#ef4444" icon={<CircleAlert size={18} />} />
        <Stat label="رسائل واردة" value={stats?.today.inbound || 0} color="#60a5fa" icon={<MessageCircle size={18} />} />
      </div>

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
      <Panel title="إرسال رسالة (اختبار / يدوي)" icon={<Send size={16} />}>
        <form onSubmit={submitSend} className="wa-send-form">
          <label className="field">
            <span>رقم الجوال (05… أو +9665…)</span>
            <input className="input" required dir="ltr" value={sendPhone} onChange={(e) => setSendPhone(e.target.value)} placeholder="0500000000" />
          </label>
          <label className="field">
            <span>قالب (اختياري — يلغي الرسالة اليدوية)</span>
            <select className="input" value={sendTemplate} onChange={(e) => setSendTemplate(e.target.value)}>
              <option value="">— رسالة يدوية —</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </label>
          {!sendTemplate && (
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>نص الرسالة</span>
              <textarea className="input textarea" rows={3} value={sendMessage} onChange={(e) => setSendMessage(e.target.value)} />
            </label>
          )}
          {outbound?.mode === "code" && (
            <label className="field">
              <span>كود التأكيد (OUTBOUND_CONFIRM_CODE)</span>
              <input className="input" dir="ltr" value={outboundCode} onChange={(e) => setOutboundCode(e.target.value)} placeholder="2232" />
            </label>
          )}
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button className="btn primary" type="submit" disabled={busy === "send"}>
              <Send size={14} /> {busy === "send" ? "جاري الإرسال…" : "إرسال"}
            </button>
          </div>
        </form>
      </Panel>

      {/* Conversation search */}
      <Panel title="محادثة عميل" icon={<Search size={16} />}>
        <form onSubmit={submitSearch} className="wa-search-form">
          <label className="field" style={{ flex: 1 }}>
            <span>رقم العميل</span>
            <input className="input" dir="ltr" value={searchPhone} onChange={(e) => setSearchPhone(e.target.value)} placeholder="0500000000" />
          </label>
          <button className="btn primary" type="submit" disabled={searchLoading}>{searchLoading ? "…" : "بحث"}</button>
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
                onClick={() => setSendTemplate(t.name)}
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
      <div className="wa-stat-icon" style={{ color }}>{icon}</div>
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
      <header>
        {icon} <span>{title}</span>
      </header>
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
