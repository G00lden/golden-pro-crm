import { Users, FileText, Package, UserRoundCog, Wrench, CircleAlert, CalendarDays, UserPlus, Plus, Send, PhoneMissed } from "lucide-react";
import { useRef, useState } from "react";
import * as api from "../api";
import { createPerItemActionLock, isOutboundSimulation } from "../outboundAction";
import {
  Button,
  Badge,
  Empty,
  ErrorBlock,
  InstallationCard,
  Loading,
  PageHeader,
  Stat,
  fmtDate,
  today,
  useData,
  type Page,
} from "../shared";
import { ReminderDashboard } from "../components/ReminderDashboard";

export default function Dashboard({
  stats,
  notify,
  refreshStats,
  go,
  canManageCalls = false,
  canSeedDemoData = false,
}: {
  stats: api.DashboardStats;
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  go: (page: Page) => void;
  canManageCalls?: boolean;
  canSeedDemoData?: boolean;
}) {
  const installations = useData(api.getInstallations);
  const callStats = useData(api.getCallStats, [], canManageCalls);
  const missedPending = callStats.data?.missed_unhandled || 0;
  const [seeding, setSeeding] = useState(false);
  const [remindingIds, setRemindingIds] = useState<Set<string>>(() => new Set());
  const reminderLock = useRef(createPerItemActionLock()).current;
  const showDemoDataAction = canSeedDemoData && !import.meta.env.PROD;
  const urgent = (installations.data || []).filter((item) => item.status === "active" && Number(item.days_until) <= 7);
  const upcoming = (installations.data || []).filter((item) => item.status === "active" && Number(item.days_until) > 7 && Number(item.days_until) <= 30);
  const completedRate = stats.installations ? Math.round(((stats.completed || 0) / stats.installations) * 100) : 0;
  const messageLimit = stats.maxDaily || 24;
  const messageUsage = Math.min(100, Math.round(((stats.sentToday || 0) / messageLimit) * 100));

  const setReminderPending = (installationId: string, pending: boolean) => {
    setRemindingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(installationId);
      else next.delete(installationId);
      return next;
    });
  };

  const sendReminder = async (installation: api.Installation) => {
    if (!reminderLock.acquire(installation.id)) return;
    setReminderPending(installation.id, true);
    try {
      const result = await api.remindInstallation(installation.id, installation.next_remind_type || "first");
      if (isOutboundSimulation(result)) {
        notify("محاكاة فقط: لم تُرسل رسالة للعميل ولم يتغير عداد أو مرحلة التذكير.", false);
        return;
      }
      if (!result.success) {
        notify(result.error || result.reason || "لم يُرسل التذكير. راجع إعدادات واتساب.", false);
        return;
      }
      notify("تم إرسال التذكير فعلياً");
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "فشل إرسال التذكير", false);
    } finally {
      reminderLock.release(installation.id);
      setReminderPending(installation.id, false);
    }
  };

  const addDemoData = async () => {
    if (!window.confirm("ستُضاف سجلات تجريبية جديدة إلى حسابك المحلي. هل تريد المتابعة؟")) return;
    setSeeding(true);
    try {
      const result = await api.seedDemoData(10);
      notify(`تمت إضافة ${result.customers} عملاء و${result.installations} تركيبات للتجربة`);
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إضافة بيانات التجربة", false);
    } finally {
      setSeeding(false);
    }
  };

  return (
    <>
      <div className="dashboard-page cloud-design">
      <section className="cloud-hero dashboard-hero">
        <div className="cloud-hero-copy">
          <span className="eyebrow">لوحة المعلومات</span>
          <h1>مركز تشغيل BreeXe Pro</h1>
          <p>المهام الحرجة، الصيانة، ورعاية العملاء في شاشة واحدة.</p>
          <div className="hero-actions">
            <Button onClick={() => go("installations")}><Plus size={16} /> إضافة صيانة</Button>
            {showDemoDataAction && (
              <Button tone="muted" loading={seeding} onClick={addDemoData}><Plus size={16} /> إضافة 10 تجربة</Button>
            )}
          </div>
        </div>
        <div className="hero-status-grid">
          <article>
            <span>إجراءات عاجلة</span>
            <strong>{urgent.length}</strong>
          </article>
          <article>
            <span>رعاية العملاء</span>
            <strong>{stats.care || 0}</strong>
          </article>
          <article>
            <span>رسائل اليوم</span>
            <strong>{stats.sentToday || 0}/{messageLimit}</strong>
          </article>
        </div>
      </section>
      <PageHeader
        title="لوحة التحكم"
        subtitle={fmtDate(today())}
        actions={
          <>
            <Button onClick={() => go("installations")}><Plus size={16} /> إضافة صيانة</Button>
            {showDemoDataAction && (
              <Button tone="muted" loading={seeding} onClick={addDemoData}><Plus size={16} /> إضافة 10 تجربة</Button>
            )}
          </>
        }
      />

      <div className="stats-grid metric-grid">
        <Stat title="العملاء" value={stats.customers || 0} icon={<Users size={20} />} />
        <Stat title="عروض الأسعار" value={stats.quotes || 0} icon={<FileText size={20} />} />
        <Stat title="المنتجات" value={stats.products || 0} icon={<Package size={20} />} />
        <Stat title="الفنيون" value={stats.technicians || 0} icon={<UserRoundCog size={20} />} />
        <Stat title="التركيبات" value={stats.installations || 0} icon={<Wrench size={20} />} />
        <Stat title="متأخرة" value={stats.overdue || 0} icon={<CircleAlert size={20} />} tone="danger" />
        <Stat title="خلال أسبوع" value={stats.week || 0} icon={<CalendarDays size={20} />} tone="warn" />
        <Stat title="تحتاج رعاية" value={stats.care || 0} icon={<UserPlus size={20} />} tone={stats.care ? "danger" : "success"} />
        {canManageCalls && (
          <Stat title="مكالمات فائتة للمتابعة" value={missedPending} icon={<PhoneMissed size={20} />} tone={missedPending ? "danger" : "success"} onClick={() => go("callSystem")} />
        )}
      </div>

      <section className="cloud-panel operations-strip">
        <div>
          <span>اكتمال الصيانة</span>
          <strong>{completedRate}%</strong>
          <div className="progress-track"><i style={{ width: `${completedRate}%` }} /></div>
        </div>
        <div>
          <span>استخدام الرسائل</span>
          <strong>{messageUsage}%</strong>
          <div className="progress-track"><i style={{ width: `${messageUsage}%` }} /></div>
        </div>
        <div>
          <span>خلال 30 يوم</span>
          <strong>{upcoming.length}</strong>
          <p>موعد قادم يحتاج متابعة مبكرة</p>
        </div>
      </section>

      <ReminderDashboard notify={notify} refreshStats={refreshStats} />

      <section className="panel">
        <div className="panel-head">
          <h2>تحتاج إجراء</h2>
          <Badge tone={urgent.length ? "danger" : "success"}>{urgent.length}</Badge>
        </div>
        {installations.loading ? <Loading /> : urgent.length ? (
          <div className="list">
            {urgent.slice(0, 8).map((item) => {
              const reminderPending = remindingIds.has(item.id);
              return (
                <fieldset
                  key={item.id}
                  disabled={reminderPending}
                  aria-busy={reminderPending}
                  style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0 }}
                >
                  <InstallationCard installation={item} onRemind={() => sendReminder(item)} />
                  {reminderPending && (
                    <p className="note" role="status" aria-live="polite">
                      جاري التحقق من وضع الإرسال…
                    </p>
                  )}
                </fieldset>
              );
            })}
          </div>
        ) : (
          <Empty title="لا توجد صيانة عاجلة" />
        )}
      </section>

      {!!upcoming.length && (
        <section className="panel">
          <div className="panel-head">
            <h2>خلال 30 يوم</h2>
            <Badge>{upcoming.length}</Badge>
          </div>
          <div className="list">
            {upcoming.slice(0, 6).map((item) => (
              <InstallationCard key={item.id} installation={item} />
            ))}
          </div>
        </section>
      )}
      </div>
    </>
  );
}
