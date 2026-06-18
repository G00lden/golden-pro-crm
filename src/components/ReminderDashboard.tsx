import { AlertTriangle, CalendarDays, CheckCircle2, RefreshCcw, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import * as api from "../api";

type Notifier = (message: string, ok?: boolean) => void;

type DashboardData = {
  upcoming: api.MaintenanceUpcomingItem[];
  overdue: api.MaintenanceUpcomingItem[];
  escalations: api.EscalationStats;
};

export function ReminderDashboard({
  notify,
  refreshStats,
}: {
  notify: Notifier;
  refreshStats?: () => Promise<void> | void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [upcoming, overdue, escalations] = await Promise.all([
        api.getMaintenanceUpcoming(7),
        api.getMaintenanceOverdue(0),
        api.getEscalationStats(),
      ]);
      setData({ upcoming: upcoming.items, overdue: overdue.items, escalations });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runReminders = async () => {
    setRunning(true);
    try {
      const result = await api.runDueReminders();
      if (result.error) {
        notify(result.error, false);
      } else {
        notify(`أُرسل ${result.sent} تذكير من أصل ${result.checked} (فشل ${result.failed})`);
      }
      await refresh();
      if (refreshStats) await refreshStats();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر تشغيل التذكيرات", false);
    } finally {
      setRunning(false);
    }
  };

  const sendSingle = async (item: api.MaintenanceUpcomingItem) => {
    try {
      await api.remindInstallation(item.id, item.next_remind_type || "first");
      notify(`تم إرسال تذكير لـ ${item.customer_name}`);
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر الإرسال", false);
    }
  };

  if (loading && !data) {
    return (
      <div className="reminder-dash empty">
        <RefreshCcw size={20} className="spin" />
        <span>جاري تحميل لوحة التذكيرات…</span>
      </div>
    );
  }

  const counts = data?.escalations || { total: 0, active: 0, assigned: 0, resolved: 0, today_resolved: 0, today_created: 0 };
  const overdueCount = data?.overdue.length || 0;
  const upcomingCount = data?.upcoming.length || 0;

  return (
    <section className="reminder-dash" dir="rtl" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0 }}>لوحة التذكيرات</h2>
          <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>تحديث تلقائي كل دقيقة</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn muted" type="button" onClick={refresh} disabled={loading}>
            <RefreshCcw size={15} className={loading ? "spin" : ""} /> تحديث
          </button>
          <button className="btn primary" type="button" onClick={runReminders} disabled={running}>
            <Send size={15} /> {running ? "جاري الإرسال…" : "إرسال تذكير"}
          </button>
        </div>
      </header>

      <div className="stats-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <StatCard label="قادم خلال أسبوع" value={upcomingCount} icon={<CalendarDays size={20} />} tone="muted" />
        <StatCard label="متأخر" value={overdueCount} icon={<AlertTriangle size={20} />} tone="danger" />
        <StatCard label="تصعيد نشط" value={counts.active} icon={<AlertTriangle size={20} />} tone={counts.active > 0 ? "danger" : "muted"} badge={counts.active} />
        <StatCard label="تم الحل اليوم" value={counts.today_resolved} icon={<CheckCircle2 size={20} />} tone="success" />
      </div>

      {error && (
        <div className="error-box" role="alert">
          <span>{error}</span>
        </div>
      )}

      <article className="dashboard-list" style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
        <UpcomingPanel
          title="قادم خلال 7 أيام"
          items={data?.upcoming || []}
          emptyText="لا توجد صيانة قادمة قريباً."
          onAction={sendSingle}
          actionLabel="إرسال"
          showDaysUntil
        />
        <UpcomingPanel
          title="متأخر — يحتاج تواصل"
          items={data?.overdue || []}
          emptyText="لا توجد صيانة متأخرة."
          onAction={sendSingle}
          actionLabel="تذكير"
          danger
        />
      </article>
    </section>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone = "muted",
  badge,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: "muted" | "danger" | "success" | "warn";
  badge?: number;
}) {
  const toneColor: Record<string, string> = {
    muted: "#374151",
    danger: "#b91c1c",
    success: "#15803d",
    warn: "#b45309",
  };
  return (
    <div
      style={{
        padding: 14,
        border: `1px solid ${toneColor[tone] || "#374151"}`,
        borderRadius: 12,
        background: "rgba(255,255,255,0.02)",
        display: "flex",
        gap: 12,
        alignItems: "center",
      }}
    >
      <div style={{ color: toneColor[tone] }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>
        <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
      </div>
      {badge !== undefined && badge > 0 && (
        <span style={{ background: toneColor[tone], color: "white", borderRadius: 999, padding: "2px 8px", fontSize: 12 }}>
          {badge}
        </span>
      )}
    </div>
  );
}

function UpcomingPanel({
  title,
  items,
  emptyText,
  onAction,
  actionLabel,
  showDaysUntil,
  danger,
}: {
  title: string;
  items: api.MaintenanceUpcomingItem[];
  emptyText: string;
  onAction: (item: api.MaintenanceUpcomingItem) => Promise<void>;
  actionLabel: string;
  showDaysUntil?: boolean;
  danger?: boolean;
}) {
  return (
    <div
      style={{
        border: "1px solid #2a2f3a",
        borderRadius: 12,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 14, color: danger ? "#fca5a5" : undefined }}>
        {title} <span style={{ opacity: 0.5 }}>({items.length})</span>
      </h3>
      {items.length === 0 ? (
        <p style={{ opacity: 0.6, fontSize: 13 }}>{emptyText}</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
          {items.slice(0, 8).map((item) => (
            <li key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", background: "rgba(255,255,255,0.03)", borderRadius: 8 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{item.customer_name || "—"}</div>
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  {item.product_name || ""} · {item.next_maintenance}
                  {showDaysUntil && item.days_until !== undefined ? ` · بعد ${item.days_until} يوم` : null}
                  {danger && item.days_overdue !== undefined ? ` · متأخر ${item.days_overdue} يوم` : null}
                </div>
              </div>
              <button className="btn muted" type="button" onClick={() => onAction(item)} style={{ fontSize: 12, padding: "4px 8px" }}>
                <Send size={12} /> {actionLabel}
              </button>
            </li>
          ))}
          {items.length > 8 && <li style={{ opacity: 0.6, fontSize: 11, textAlign: "center" }}>+ {items.length - 8} أخرى</li>}
        </ul>
      )}
    </div>
  );
}

export default ReminderDashboard;
