import {
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Copy,
  ExternalLink,
  Phone,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRoundCog,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import * as crmApi from "../api";
import {
  actOnMaintenanceRequest,
  customerPortalUrl,
  getMaintenanceRequest,
  getMaintenanceRequests,
  type MaintenanceRequest,
  type MaintenanceRequestAction,
  type MaintenanceRequestEvent,
} from "../maintenanceRequestsApi";
import {
  Badge,
  Button,
  Empty,
  ErrorBlock,
  Field,
  Loading,
  PageHeader,
  SelectInput,
  TextArea,
  TextInput,
  today,
  useData,
} from "../shared";
import {
  maintenanceRequestStatusLabel,
  maintenanceRequestStatusTone,
  type MaintenanceRequestStatus,
} from "../../shared/maintenanceRequest";
import "./MaintenanceRequests.css";
import { useDialogAccessibility } from "../dialogAccessibility";

const MAINTENANCE_REFRESH_INTERVAL_MS = 15_000;

function useVisiblePolling(refresh: () => Promise<unknown>, enabled = true) {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (!enabled) return undefined;
    const run = () => {
      if (document.visibilityState === "visible") void refreshRef.current();
    };
    const timer = window.setInterval(run, MAINTENANCE_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [enabled]);
}

const dateTimeFormatter = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", { dateStyle: "medium", timeStyle: "short" });

function formatDateTime(value?: string) {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTimeFormatter.format(parsed);
}

function serviceTypeLabel(value?: string) {
  const labels: Record<string, string> = {
    air_conditioning: "تكييف وتبريد",
    electrical: "كهرباء",
    plumbing: "سباكة",
    appliances: "أجهزة منزلية",
    general: "صيانة عامة",
  };
  return labels[String(value || "")] || value || "غير محدد";
}

function filterFromUrl() {
  const url = new URL(window.location.href);
  return {
    status: url.searchParams.get("requestStatus") || "",
    search: url.searchParams.get("requestSearch") || "",
    selectedId: url.searchParams.get("requestId") || "",
  };
}

export default function MaintenanceRequestsPage({
  notify,
  canManage,
  canOverrideClose,
}: {
  notify: (message: string, ok?: boolean) => void;
  canManage: boolean;
  canOverrideClose: boolean;
}) {
  const initial = useMemo(filterFromUrl, []);
  const [status, setStatus] = useState(initial.status);
  const [search, setSearch] = useState(initial.search);
  const [searchDraft, setSearchDraft] = useState(initial.search);
  const [selectedId, setSelectedId] = useState(initial.selectedId);
  const requests = useData(() => getMaintenanceRequests({ status, search }), [status, search]);
  const technicians = useData(crmApi.getTechnicians, [], canManage);
  useVisiblePolling(requests.refreshSilent);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (status) url.searchParams.set("requestStatus", status);
    else url.searchParams.delete("requestStatus");
    if (search) url.searchParams.set("requestSearch", search);
    else url.searchParams.delete("requestSearch");
    if (selectedId) url.searchParams.set("requestId", selectedId);
    else url.searchParams.delete("requestId");
    window.history.replaceState({}, "", url);
  }, [search, selectedId, status]);

  const openRequest = (id: string) => setSelectedId(id);
  const closeRequest = () => setSelectedId("");
  const refresh = async () => {
    await requests.refresh();
  };

  const copyIntakeLink = async () => {
    await navigator.clipboard.writeText(customerPortalUrl());
    notify("تم نسخ رابط صفحة طلب الصيانة للعملاء");
  };

  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(searchDraft.trim());
  };

  const stats = requests.data?.stats || { total: 0, new: 0, active: 0, closed: 0, customer_changes: 0 };
  const statusFilters: Array<{ value: "" | "active" | MaintenanceRequestStatus; label: string; count?: number }> = [
    { value: "", label: "الكل", count: stats.total },
    { value: "new", label: "جديدة", count: stats.new },
    { value: "approved", label: "معتمدة" },
    { value: "scheduled", label: "مجدولة" },
    { value: "in_progress", label: "قيد التنفيذ" },
    { value: "closed", label: "مغلقة", count: stats.closed },
    { value: "cancelled", label: "ملغاة" },
    { value: "rejected", label: "مرفوضة" },
  ];

  return (
    <>
      <PageHeader
        title="طلبات الصيانة"
        subtitle="استلام طلب العميل، اعتماده، إسناده للفني، ومتابعته حتى الإغلاق"
        actions={
          <>
            <Button tone="muted" onClick={copyIntakeLink}><Copy size={16} aria-hidden="true" /> نسخ رابط العميل</Button>
            <a className="btn primary" href={customerPortalUrl()} target="_blank" rel="noreferrer">
              <ExternalLink size={16} aria-hidden="true" /> فتح صفحة العميل
            </a>
          </>
        }
      />

      <section className="maintenance-kpis" aria-label="ملخص طلبات الصيانة">
        <button type="button" onClick={() => setStatus("")}><ClipboardList aria-hidden="true" /><span>إجمالي الطلبات<strong>{stats.total.toLocaleString("ar-SA")}</strong></span></button>
        <button type="button" onClick={() => setStatus("new")}><ShieldCheck aria-hidden="true" /><span>بانتظار الاعتماد<strong>{stats.new.toLocaleString("ar-SA")}</strong></span></button>
        <button type="button" onClick={() => setStatus("active")}><UserRoundCog aria-hidden="true" /><span>طلبات نشطة<strong>{stats.active.toLocaleString("ar-SA")}</strong></span></button>
        <button type="button" onClick={() => setStatus("closed")}><ClipboardCheck aria-hidden="true" /><span>طلبات مغلقة<strong>{stats.closed.toLocaleString("ar-SA")}</strong></span></button>
      </section>

      {stats.customer_changes > 0 && (
        <div className="maintenance-admin-notice" role="status">
          <CalendarClock size={18} aria-hidden="true" /> يوجد {stats.customer_changes.toLocaleString("ar-SA")} طلب تغيير موعد من العملاء.
        </div>
      )}

      <div className="maintenance-toolbar">
        <div className="maintenance-filter-tabs" aria-label="تصفية حسب الحالة">
          {statusFilters.map((filter) => (
            <button
              type="button"
              className={status === filter.value ? "active" : ""}
              aria-pressed={status === filter.value}
              onClick={() => setStatus(filter.value)}
              key={filter.value || "all"}
            >
              {filter.label}{typeof filter.count === "number" ? ` (${filter.count.toLocaleString("ar-SA")})` : ""}
            </button>
          ))}
        </div>
        <form className="maintenance-search" role="search" onSubmit={applySearch}>
          <label className="sr-only" htmlFor="maintenance-request-search">ابحث في طلبات الصيانة</label>
          <TextInput
            id="maintenance-request-search"
            name="request_search"
            type="search"
            autoComplete="off"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="رقم الطلب، العميل، الجوال…"
          />
          <Button type="submit" tone="muted"><Search size={16} aria-hidden="true" /> بحث</Button>
          <Button type="button" tone="muted" onClick={() => requests.refresh()}><RefreshCw size={16} aria-hidden="true" /> تحديث</Button>
        </form>
      </div>

      {requests.loading ? <Loading /> : requests.error ? <ErrorBlock message={requests.error} retry={requests.refresh} /> : (
        <section className="maintenance-request-list" aria-label="قائمة طلبات الصيانة">
          {(requests.data?.data || []).map((request) => (
            <button className="maintenance-request-row" type="button" onClick={() => openRequest(request.id)} key={request.id}>
              <span className="maintenance-request-row__number"><bdi>{request.request_number}</bdi><small>{formatDateTime(request.createdAt || request.created_at)}</small></span>
              <span className="maintenance-request-row__customer"><strong>{request.customer_name}</strong><small><bdi>{request.customer_phone}</bdi> · {request.city || "المدينة غير محددة"}</small></span>
              <span className="maintenance-request-row__service"><strong>{request.product_name}</strong><small>{request.technician_name || "لم يُسند لفني"}</small></span>
              <span className="maintenance-request-row__status">
                {Boolean(request.customer_change_requested) && <Badge tone="warn">تغيير موعد</Badge>}
                <Badge tone={maintenanceRequestStatusTone(request.status)}>{maintenanceRequestStatusLabel(request.status)}</Badge>
              </span>
            </button>
          ))}
          {!requests.data?.data.length && <Empty title="لا توجد طلبات مطابقة للتصفية الحالية" />}
          {requests.data?.capped && <p className="maintenance-cap-note">تظهر أحدث 50 طلبًا. استخدم البحث أو التصفية لتضييق النتائج.</p>}
        </section>
      )}

      {selectedId && (
        <MaintenanceRequestDrawer
          requestId={selectedId}
          technicians={technicians.data || []}
          techniciansLoading={technicians.loading}
          notify={notify}
          canManage={canManage}
          canOverrideClose={canOverrideClose}
          onClose={closeRequest}
          onChanged={refresh}
        />
      )}
    </>
  );
}

function MaintenanceRequestDrawer({
  requestId,
  technicians,
  techniciansLoading,
  notify,
  canManage,
  canOverrideClose,
  onClose,
  onChanged,
}: {
  requestId: string;
  technicians: crmApi.Technician[];
  techniciansLoading: boolean;
  notify: (message: string, ok?: boolean) => void;
  canManage: boolean;
  canOverrideClose: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const details = useData(() => getMaintenanceRequest(requestId), [requestId]);
  const [actionMode, setActionMode] = useState<"" | "assign" | "reject" | "close" | "close_override" | "cancel">("");
  const [saving, setSaving] = useState(false);
  const request = details.data?.request;
  const drawerRef = useRef<HTMLElement>(null);
  useDialogAccessibility(drawerRef, onClose);
  useVisiblePolling(details.refreshSilent);

  const runAction = async (action: MaintenanceRequestAction, successMessage: string) => {
    setSaving(true);
    try {
      await actOnMaintenanceRequest(requestId, action);
      notify(successMessage);
      setActionMode("");
      await Promise.all([details.refresh(), onChanged()]);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "تعذر تحديث الطلب", false);
    } finally {
      setSaving(false);
    }
  };

  const submitAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (actionMode === "assign") {
      await runAction({
        action: "assign",
        technician_id: String(data.get("technician_id") || ""),
        date: String(data.get("date") || ""),
        scheduled_time: String(data.get("scheduled_time") || ""),
        note: String(data.get("note") || ""),
      }, "تم إنشاء الحجز وإسناد الطلب للفني");
    } else if (actionMode === "reject") {
      await runAction({ action: "reject", reason: String(data.get("reason") || "") }, "تم رفض الطلب وتحديث صفحة العميل");
    } else if (actionMode === "close") {
      await runAction({ action: "close", note: String(data.get("note") || "") }, "تم إكمال الحجز وإغلاق الطلب");
    } else if (actionMode === "close_override") {
      await runAction({ action: "close_override", reason: String(data.get("reason") || "") }, "تم الإغلاق الاستثنائي وتسجيل سبب التجاوز");
    } else if (actionMode === "cancel") {
      await runAction({ action: "cancel", reason: String(data.get("reason") || "") }, "تم إلغاء الطلب والحجز المرتبط");
    }
  };

  const copyPortalLink = async () => {
    if (!request?.portal_token) return;
    await navigator.clipboard.writeText(customerPortalUrl(request.portal_token));
    notify("تم نسخ رابط متابعة العميل");
  };

  return (
    <div className="maintenance-drawer-overlay" data-dialog-overlay role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <aside ref={drawerRef} tabIndex={-1} className="maintenance-drawer" role="dialog" aria-modal="true" aria-labelledby="maintenance-drawer-title">
        <div className="maintenance-drawer__head">
          <div>
            <span>تفاصيل الطلب</span>
            <h2 id="maintenance-drawer-title"><bdi>{request?.request_number || requestId}</bdi></h2>
          </div>
          <button type="button" className="maintenance-drawer__close" onClick={onClose} aria-label="إغلاق تفاصيل الطلب"><XCircle aria-hidden="true" /></button>
        </div>

        {details.loading ? <Loading /> : details.error ? <ErrorBlock message={details.error} retry={details.refresh} /> : request ? (
          <div className="maintenance-drawer__body">
            <div className="maintenance-drawer__status">
              <Badge tone={maintenanceRequestStatusTone(request.status)}>{maintenanceRequestStatusLabel(request.status)}</Badge>
              {Boolean(request.customer_change_requested) && <Badge tone="warn">العميل طلب تغيير الموعد</Badge>}
            </div>

            <section className="maintenance-detail-grid" aria-label="بيانات الطلب">
              <article><span>العميل</span><strong>{request.customer_name}</strong><a href={`tel:+${request.customer_phone}`}><Phone size={15} aria-hidden="true" /> <bdi>{request.customer_phone}</bdi></a></article>
              <article><span>الخدمة</span><strong>{request.product_name}</strong><small>{serviceTypeLabel(request.service_type)}</small></article>
              <article className="wide"><span>العنوان</span><strong>{request.address || "غير محدد"}</strong><small>{request.city}</small></article>
              <article className="wide"><span>وصف العطل</span><p>{request.issue_description}</p></article>
              <article><span>الموعد المطلوب</span><strong><bdi>{request.preferred_date || "غير محدد"} {request.preferred_time || ""}</bdi></strong></article>
              <article><span>الموعد المعتمد</span><strong><bdi>{request.scheduled_date || "لم يحدد"} {request.scheduled_time || ""}</bdi></strong><small>{request.technician_name || "لم يسند"}</small></article>
            </section>

            <div className="maintenance-drawer__links">
              {request.portal_token ? (
                <Button tone="muted" onClick={copyPortalLink}><Copy size={16} aria-hidden="true" /> نسخ رابط العميل</Button>
              ) : (
                <Badge tone="warn">رابط العميل ملغى</Badge>
              )}
              {request.portal_token && <a className="btn muted" href={customerPortalUrl(request.portal_token)} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" /> معاينة صفحة العميل</a>}
              {canManage && (
                <Button tone="muted" onClick={() => runAction({ action: "rotate_portal_link" }, "تم إصدار رابط جديد وإبطال الرابط السابق")} loading={saving}>
                  إصدار رابط جديد
                </Button>
              )}
              {canManage && request.portal_token && (
                <Button tone="danger" onClick={() => runAction({ action: "revoke_portal_link" }, "تم إلغاء رابط متابعة العميل")} loading={saving}>
                  إلغاء الرابط
                </Button>
              )}
              {request.customer_id && <a className="btn muted" href={`?section=customers&customerId=${encodeURIComponent(request.customer_id)}`}><ExternalLink size={16} aria-hidden="true" /> سجل العميل</a>}
              {request.booking_id && <a className="btn muted" href="?section=bookings"><CalendarClock size={16} aria-hidden="true" /> الحجز المرتبط</a>}
            </div>

            {canManage ? <section className="maintenance-drawer__actions" aria-labelledby="request-actions-title">
              <h3 id="request-actions-title">إدارة الطلب</h3>
              <div className="maintenance-action-buttons">
                {request.status === "new" && <Button tone="success" onClick={() => runAction({ action: "approve" }, "تم اعتماد الطلب") } loading={saving}><CheckCircle2 size={16} aria-hidden="true" /> اعتماد</Button>}
                {["new", "approved", "scheduled"].includes(request.status) && <Button onClick={() => setActionMode("assign")}><UserRoundCog size={16} aria-hidden="true" /> {request.status === "scheduled" ? "إعادة الجدولة" : "إسناد لفني"}</Button>}
                {request.status === "new" && <Button tone="danger" onClick={() => setActionMode("reject")}><XCircle size={16} aria-hidden="true" /> رفض</Button>}
                {request.status === "scheduled" && <Button tone="success" onClick={() => runAction({ action: "start" }, "تم نقل الطلب إلى قيد التنفيذ") } loading={saving}><Play size={16} aria-hidden="true" /> بدء التنفيذ</Button>}
                {["scheduled", "in_progress"].includes(request.status) && <Button tone="success" onClick={() => setActionMode("close")}><ClipboardCheck size={16} aria-hidden="true" /> إغلاق الطلب</Button>}
                {canOverrideClose && ["scheduled", "in_progress"].includes(request.status) && <Button tone="danger" onClick={() => setActionMode("close_override")}><ShieldCheck size={16} aria-hidden="true" /> إغلاق استثنائي</Button>}
                {["new", "approved", "scheduled", "in_progress"].includes(request.status) && <Button tone="danger" onClick={() => setActionMode("cancel")}><XCircle size={16} aria-hidden="true" /> إلغاء</Button>}
              </div>

              {actionMode && (
                <form className="maintenance-action-form" onSubmit={submitAction}>
                  {actionMode === "assign" ? (
                    <>
                      <Field label="الفني">
                        <SelectInput name="technician_id" defaultValue={request.technician_id || ""} required disabled={techniciansLoading}>
                          <option value="" disabled>{techniciansLoading ? "جاري تحميل الفنيين…" : "اختر الفني"}</option>
                          {technicians.map((technician) => <option value={technician.id} key={technician.id}>{technician.name}</option>)}
                        </SelectInput>
                      </Field>
                      <Field label="التاريخ"><TextInput name="date" type="date" min={today()} defaultValue={request.scheduled_date || request.preferred_date || today()} required /></Field>
                      <Field label="الوقت"><TextInput name="scheduled_time" type="time" defaultValue={request.scheduled_time || request.preferred_time || "10:00"} required /></Field>
                      <Field label="تعليمات للفني"><TextArea name="note" rows={3} maxLength={2000} placeholder="تفاصيل الوصول أو تعليمات المهمة…" /></Field>
                    </>
                  ) : actionMode === "close" ? (
                    <Field label="ملخص الإجراء والإصلاح"><TextArea name="note" rows={4} maxLength={2000} required placeholder="اكتب ما تم تنفيذه قبل الإغلاق…" /></Field>
                  ) : actionMode === "close_override" ? (
                    <Field label="سبب تجاوز أدلة FieldTech"><TextArea name="reason" rows={4} minLength={10} maxLength={2000} required placeholder="اشرح سبب الإغلاق الاستثنائي ومن أجازه…" /></Field>
                  ) : (
                    <Field label={actionMode === "reject" ? "سبب الرفض" : "سبب الإلغاء"}><TextArea name="reason" rows={4} minLength={3} maxLength={2000} required placeholder="اكتب السبب الذي سيظهر للعميل…" /></Field>
                  )}
                  <div className="maintenance-action-form__footer">
                    <Button type="submit" tone={actionMode === "reject" || actionMode === "cancel" ? "danger" : "primary"} loading={saving}>
                      {actionMode === "assign" ? "إنشاء الحجز وتجهيزه للفني" : actionMode === "close" ? "إكمال الحجز وإغلاق الطلب" : actionMode === "close_override" ? "تأكيد الإغلاق الاستثنائي" : "تأكيد الإجراء"}
                    </Button>
                    <Button tone="muted" onClick={() => setActionMode("")} disabled={saving}>رجوع</Button>
                  </div>
                </form>
              )}
            </section> : (
              <div className="maintenance-admin-notice" role="note">لديك صلاحية عرض الطلب فقط. إجراءات الاعتماد والإسناد والإغلاق تتطلب صلاحية إدارة طلبات الصيانة.</div>
            )}

            <RequestTimeline events={details.data?.events || []} />
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function RequestTimeline({ events }: { events: MaintenanceRequestEvent[] }) {
  return (
    <section className="maintenance-admin-timeline" aria-labelledby="admin-timeline-title">
      <h3 id="admin-timeline-title">سجل المتابعة</h3>
      <ol>
        {events.map((event, index) => (
          <li key={event.id || `${event.action}-${index}`}>
            <span aria-hidden="true"><CheckCircle2 size={16} /></span>
            <div>
              <strong>{event.to_status ? maintenanceRequestStatusLabel(event.to_status) : "تحديث"}</strong>
              {event.message && <p>{event.message}</p>}
              <time dateTime={event.createdAt || event.created_at}>{formatDateTime(event.createdAt || event.created_at)}</time>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
