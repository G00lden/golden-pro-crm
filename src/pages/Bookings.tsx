import { Plus, Check, Send, Edit3, Trash2, Save, RefreshCcw } from "lucide-react";
import { useState, useEffect, useMemo, useRef, type FormEvent } from "react";
import * as api from "../api";
import { createPerItemActionLock } from "../outboundAction";
import {
  Button,
  Empty,
  ErrorBlock,
  Field,
  IconButton,
  Loading,
  PageHeader,
  SelectInput,
  TextArea,
  TextInput,
  Badge,
  statusLabel,
  today,
  useData,
  type ModalState,
} from "../shared";

export default function BookingsPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const fieldTechLabel = (status?: api.Booking["fieldtech_status"]) => {
    if (status === "scheduled") return "قبله الفني";
    if (status === "progress") return "الفني في التنفيذ";
    if (status === "complete") return "أكمله الفني";
    if (status === "cancelled") return "ملغي في التطبيق";
    return "أرسل للتطبيق";
  };
  const [date, setDate] = useState(today());
  const bookings = useData(() => api.getBookings({ date }), [date]);
  const technicianNoticeLock = useRef(createPerItemActionLock()).current;
  const [sendingTechnicianIds, setSendingTechnicianIds] = useState<Set<string>>(() => new Set());

  const setTechnicianSending = (bookingId: string, sending: boolean) => {
    setSendingTechnicianIds((current) => {
      const next = new Set(current);
      if (sending) next.add(bookingId);
      else next.delete(bookingId);
      return next;
    });
  };

  const sendTechnicianNotice = async (booking: api.Booking, trigger = "manual") => {
    if (!technicianNoticeLock.acquire(booking.id)) return;
    setTechnicianSending(booking.id, true);
    try {
      const result = await api.notifyTechnicianBooking(booking.id, trigger);
      if (result.simulated) {
        notify("محاكاة فقط: تم تجهيز إشعار الفني، ولم تُرسل أي رسالة فعلية.", false);
      } else if (result.dry_run || !result.success) {
        notify("لم يُرسل إشعار الفني. تحقق من إعدادات واتساب ثم حاول مرة أخرى.", false);
      } else {
        notify("تم إرسال الموعد للفني فعلياً");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إرسال الموعد للفني", false);
    } finally {
      technicianNoticeLock.release(booking.id);
      setTechnicianSending(booking.id, false);
    }
  };

  const complete = async (booking: api.Booking) => {
    try {
      await api.completeBooking(booking.id);
      notify("تم إكمال الحجز وتحديث موعد الصيانة القادم");
      await Promise.all([bookings.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إكمال الحجز", false);
    }
  };

  const openForm = (booking?: api.Booking) => {
    setModal({
      title: booking ? "تعديل حجز" : "إضافة حجز",
      wide: true,
      content: (
        <BookingForm
          initial={booking}
          selectedDate={date}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            try {
              if (booking) {
                // Setting the status to "completed" from the edit form must run
                // the completion lifecycle (advance the linked installation's
                // next_maintenance, reset its reminders) — a plain updateBooking
                // would flip the status but leave the installation firing overdue
                // reminders forever. Persist the other field edits first (keeping
                // the current status), then complete.
                const becomingCompleted = payload.status === "completed" && booking.status !== "completed";
                if (becomingCompleted) {
                  await api.updateBooking(booking.id, { ...payload, status: booking.status });
                  await api.completeBooking(booking.id);
                } else {
                  await api.updateBooking(booking.id, payload);
                }
              } else {
                const bookingId = await api.createBooking(payload);
                // Creating a booking already marked completed runs the lifecycle too.
                if (payload.status === "completed") {
                  await api.completeBooking(bookingId);
                }
              }
            } catch (error) {
              notify(error instanceof Error ? error.message : "تعذر حفظ الحجز", false);
              return;
            }
            notify(
              payload.status === "confirmed"
                ? "تم حفظ الحجز دون إرسال. استخدم زر إرسال الموعد للفني عند الرغبة."
                : "تم حفظ الحجز",
            );
            setModal(null);
            await Promise.all([bookings.refresh(), refreshStats()]);
          }}
        />
      ),
    });
  };

  const remove = async (booking: api.Booking) => {
    if (!window.confirm(`حذف حجز ${booking.customer_name}؟`)) return;
    try {
      await api.deleteBooking(booking.id);
      notify("تم حذف الحجز");
      await Promise.all([bookings.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  return (
    <>
      <PageHeader
        title="الحجوزات"
        actions={
          <>
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <Button onClick={() => openForm()}><Plus size={16} /> إضافة حجز</Button>
          </>
        }
      />
      {bookings.loading ? <Loading /> : bookings.error ? <ErrorBlock message={bookings.error} retry={bookings.refresh} /> : (
        <div className="list">
          {(bookings.data || []).map((booking) => (
            <article className="row-card" key={booking.id}>
              <div className="row-main">
                <strong>{booking.customer_name}</strong>
                <span>{booking.product_name} · {booking.tech_name} · {booking.scheduled_time}</span>
                <div className="chips">
                  <Badge>{statusLabel(booking.status)}</Badge>
                  {sendingTechnicianIds.has(booking.id) && (
                    <span role="status" aria-live="polite">
                      <Badge tone="warn">جاري التحقق من الإرسال…</Badge>
                    </span>
                  )}
                  {booking.fieldtech_status && <Badge tone={booking.fieldtech_status === "complete" ? "success" : booking.fieldtech_status === "cancelled" ? "danger" : "warn"}>{fieldTechLabel(booking.fieldtech_status)}</Badge>}
                </div>
              </div>
              <div className="row-actions">
                {booking.status === "confirmed" && (
                  <>
                    <IconButton title="إكمال الحجز" tone="success" onClick={() => complete(booking)}>
                      <Check size={15} />
                    </IconButton>
                    <IconButton
                      title={sendingTechnicianIds.has(booking.id) ? "جاري التحقق من الإرسال" : "إرسال الموعد للفني"}
                      tone="success"
                      disabled={sendingTechnicianIds.has(booking.id)}
                      onClick={() => sendTechnicianNotice(booking)}
                    >
                      {sendingTechnicianIds.has(booking.id)
                        ? <RefreshCcw size={15} className="spin" aria-hidden="true" />
                        : <Send size={15} aria-hidden="true" />}
                    </IconButton>
                  </>
                )}
                <IconButton title="تعديل" onClick={() => openForm(booking)}><Edit3 size={15} /></IconButton>
                <IconButton title="حذف" tone="danger" onClick={() => remove(booking)}><Trash2 size={15} /></IconButton>
              </div>
            </article>
          ))}
          {!bookings.data?.length && <Empty title="لا توجد حجوزات لهذا اليوم" action={<Button onClick={() => openForm()}><Plus size={16} /> إضافة حجز</Button>} />}
        </div>
      )}
    </>
  );
}

function BookingForm({
  initial,
  selectedDate,
  onSave,
  onCancel,
}: {
  initial?: api.Booking;
  selectedDate: string;
  onSave: (payload: Omit<api.Booking, "id">) => Promise<void>;
  onCancel: () => void;
}) {
  const installations = useData(api.getInstallations);
  const technicians = useData(api.getTechnicians);
  const [installationId, setInstallationId] = useState(initial?.installation_id || "");
  const [technicianId, setTechnicianId] = useState(initial?.technician_id || "");
  const [date, setDate] = useState(initial?.date || selectedDate);
  const [time, setTime] = useState(initial?.scheduled_time || "10:00");
  const [status, setStatus] = useState<api.Booking["status"]>(initial?.status || "confirmed");
  const [bookingType, setBookingType] = useState<NonNullable<api.Booking["booking_type"]>>(initial?.booking_type || "maintenance");
  const [parts, setParts] = useState((initial?.parts || []).join("\n"));
  const [requireBeforePhoto, setRequireBeforePhoto] = useState(initial?.fieldtech_require_before_photo ?? true);
  const [requireAfterPhoto, setRequireAfterPhoto] = useState(initial?.fieldtech_require_after_photo ?? true);
  const [requireSignature, setRequireSignature] = useState(initial?.fieldtech_require_signature ?? true);
  const [saving, setSaving] = useState(false);

  const selectableInstallations = useMemo(
    () =>
      (installations.data || []).filter(
        (item) =>
          item.status === "active" ||
          item.status === "pending_installation" ||
          item.status === "pending_external_service" ||
          (initial && item.id === initial.installation_id),
      ),
    [installations.data, initial],
  );
  const selectedInstallation = selectableInstallations.find((item) => item.id === installationId);
  const selectedTechnician = technicians.data?.find((item) => item.id === technicianId);

  useEffect(() => {
    if (!installationId && selectableInstallations[0]) setInstallationId(selectableInstallations[0].id);
  }, [installationId, selectableInstallations]);

  useEffect(() => {
    if (!technicianId && technicians.data?.[0]) setTechnicianId(technicians.data[0].id);
  }, [technicianId, technicians.data]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedInstallation || !selectedTechnician) return;
    setSaving(true);
    try {
      await onSave({
        installation_id: selectedInstallation.id,
        customer_id: selectedInstallation.customer_id,
        customer_name: selectedInstallation.customer_name,
        customer_phone: selectedInstallation.customer_phone,
        product_id: selectedInstallation.product_id,
        product_name: selectedInstallation.product_name,
        technician_id: selectedTechnician.id,
        tech_name: selectedTechnician.name,
        date,
        scheduled_time: time,
        status,
        booking_type: bookingType,
        parts: parts.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        fieldtech_require_before_photo: requireBeforePhoto,
        fieldtech_require_after_photo: requireAfterPhoto,
        fieldtech_require_signature: requireSignature,
      });
    } finally {
      setSaving(false);
    }
  };

  if (installations.loading || technicians.loading) return <Loading />;
  if (!selectableInstallations.length || !technicians.data?.length) return <Empty title="أضف صيانة نشطة وفنيا قبل إنشاء الحجز" />;

  return (
    <form className="form" onSubmit={submit}>
      <Field label="الصيانة">
        <SelectInput value={installationId} onChange={(e) => setInstallationId(e.target.value)}>
          {selectableInstallations.map((installation) => (
            <option key={installation.id} value={installation.id}>{installation.customer_name} - {installation.product_name}</option>
          ))}
        </SelectInput>
      </Field>
      <div className="form-grid">
        <Field label="الفني">
          <SelectInput value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
            {(technicians.data || []).map((tech) => <option key={tech.id} value={tech.id}>{tech.name}</option>)}
          </SelectInput>
        </Field>
        <Field label="الحالة">
          <SelectInput value={status} onChange={(e) => setStatus(e.target.value as api.Booking["status"])}>
            <option value="confirmed">مؤكد</option>
            <option value="completed">مكتمل</option>
            <option value="cancelled">ملغي</option>
          </SelectInput>
        </Field>
      </div>
      <Field label="نوع المهمة">
        <SelectInput value={bookingType} onChange={(event) => setBookingType(event.target.value as NonNullable<api.Booking["booking_type"]>)}>
          <option value="installation">تركيب</option>
          <option value="maintenance">صيانة</option>
          <option value="external_maintenance">صيانة خارجية</option>
          <option value="delivery">توصيل</option>
        </SelectInput>
      </Field>
      <Field label="القطع المتوقعة / المسلّمة للفني">
        <TextArea rows={3} value={parts} onChange={(event) => setParts(event.target.value)} placeholder="فلتر × 1&#10;وصلة 2 متر × 2" />
      </Field>
      <div className="form-grid">
        <Field label="التاريخ"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="الوقت"><TextInput type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
      </div>
      <section className="form-section" aria-labelledby="fieldtech-evidence-title">
        <h3 id="fieldtech-evidence-title">توثيق تطبيق الفني</h3>
        <p className="form-note">لن يتمكن الفني من إنهاء المهمة حتى يرفع العناصر المطلوبة.</p>
        <label className="check-row">
          <input type="checkbox" checked={requireBeforePhoto} onChange={(event) => setRequireBeforePhoto(event.target.checked)} />
          <span>صورة قبل التنفيذ</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={requireAfterPhoto} onChange={(event) => setRequireAfterPhoto(event.target.checked)} />
          <span>صورة بعد التنفيذ</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={requireSignature} onChange={(event) => setRequireSignature(event.target.checked)} />
          <span>توقيع العميل</span>
        </label>
      </section>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}
