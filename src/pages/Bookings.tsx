import { Plus, Check, Send, Edit3, Trash2, Save } from "lucide-react";
import { useState, useEffect, useMemo, type FormEvent } from "react";
import * as api from "../api";
import {
  Button,
  Empty,
  ErrorBlock,
  Field,
  IconButton,
  Loading,
  PageHeader,
  SelectInput,
  TextInput,
  Badge,
  statusLabel,
  phoneLabel,
  today,
  useData,
  type ModalState,
} from "../shared";

type BookingPrefill = {
  target?: string;
  call_id?: string;
  customer_id?: string | null;
  customer_name?: string | null;
  phone?: string | null;
};

export default function BookingsPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const [date, setDate] = useState(today());
  const bookings = useData(() => api.getBookings({ date }), [date]);

  const shouldNotifyTechnician = (previous: api.Booking | undefined, next: Omit<api.Booking, "id">) =>
    next.status === "confirmed" &&
    (!previous ||
      previous.status !== "confirmed" ||
      previous.date !== next.date ||
      previous.scheduled_time !== next.scheduled_time ||
      previous.technician_id !== next.technician_id ||
      previous.installation_id !== next.installation_id);

  const sendTechnicianNotice = async (booking: api.Booking, trigger = "manual") => {
    try {
      await api.notifyTechnicianBooking(booking.id, trigger);
      notify("تم إرسال الموعد للفني");
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إرسال الموعد للفني", false);
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

  const openForm = (booking?: api.Booking, prefill?: BookingPrefill) => {
    setModal({
      title: booking ? "تعديل حجز" : "إضافة حجز",
      wide: true,
      content: (
        <BookingForm
          initial={booking}
          prefill={prefill}
          selectedDate={date}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            let bookingId: string;
            try {
              if (booking) {
                bookingId = booking.id;
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
                bookingId = await api.createBooking(payload);
                // Creating a booking already marked completed runs the lifecycle too.
                if (payload.status === "completed") {
                  await api.completeBooking(bookingId);
                }
              }
            } catch (error) {
              notify(error instanceof Error ? error.message : "تعذر حفظ الحجز", false);
              return;
            }
            const shouldNotify = shouldNotifyTechnician(booking, payload);
            if (shouldNotify) {
              try {
                await api.notifyTechnicianBooking(bookingId, booking ? "updated" : "created");
                notify("تم حفظ الحجز وإرسال الموعد للفني");
              } catch (error) {
                notify(error instanceof Error ? `تم حفظ الحجز لكن لم يرسل الموعد للفني: ${error.message}` : "تم حفظ الحجز لكن لم يرسل الموعد للفني", false);
              }
            } else {
              notify("تم حفظ الحجز");
            }
            setModal(null);
            await Promise.all([bookings.refresh(), refreshStats()]);
          }}
        />
      ),
    });
  };

  useEffect(() => {
    try {
      const context = JSON.parse(sessionStorage.getItem("telephony_action_context") || "null") as BookingPrefill | null;
      if (context?.target !== "bookings") return;
      sessionStorage.removeItem("telephony_action_context");
      openForm(undefined, context);
    } catch {
      sessionStorage.removeItem("telephony_action_context");
    }
    // This hand-off is consumed once when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
                <div className="chips"><Badge>{statusLabel(booking.status)}</Badge></div>
              </div>
              <div className="row-actions">
                {booking.status === "confirmed" && (
                  <>
                    <IconButton title="إكمال الحجز" tone="success" onClick={() => complete(booking)}>
                      <Check size={15} />
                    </IconButton>
                    <IconButton title="إرسال الموعد للفني" tone="success" onClick={() => sendTechnicianNotice(booking)}>
                      <Send size={15} />
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
  prefill,
  selectedDate,
  onSave,
  onCancel,
}: {
  initial?: api.Booking;
  prefill?: BookingPrefill;
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
    if (installationId || !selectableInstallations[0]) return;
    const phoneTail = String(prefill?.phone || "").replace(/\D/g, "").slice(-9);
    const preferred = selectableInstallations.find((item) =>
      (prefill?.customer_id && item.customer_id === prefill.customer_id) ||
      (phoneTail && String(item.customer_phone || "").replace(/\D/g, "").endsWith(phoneTail)),
    );
    setInstallationId((preferred || selectableInstallations[0]).id);
  }, [installationId, prefill, selectableInstallations]);

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
      <div className="form-grid">
        <Field label="التاريخ"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="الوقت"><TextInput type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
      </div>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}
