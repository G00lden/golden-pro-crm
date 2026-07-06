import { Plus, Edit3, Trash2, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import * as api from "../api";
import {
  Badge,
  Button,
  Empty,
  ErrorBlock,
  Field,
  IconButton,
  Loading,
  PageHeader,
  SelectInput,
  TextInput,
  phoneLabel,
  today,
  useData,
  type ModalState,
} from "../shared";

export default function TechniciansPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const technicians = useData(api.getTechnicians);
  const todayBookings = useData(() => api.getBookings({ date: today() }), []);

  const technicianTodayCount = (technicianId: string) =>
    (todayBookings.data || []).filter(
      (booking) => booking.technician_id === technicianId && booking.status === "confirmed",
    ).length;

  const technicianCapacityTone = (count: number, capacity: number): "success" | "warn" | "danger" => {
    if (count >= capacity) return "danger";
    if (count >= Math.max(1, capacity - 1)) return "warn";
    return "success";
  };

  const openForm = (technician?: api.Technician) => {
    setModal({
      title: technician ? "تعديل فني" : "إضافة فني",
      content: (
        <TechnicianForm
          initial={technician}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            try {
              if (technician) await api.updateTechnician(technician.id, payload);
              else await api.createTechnician(payload);
              notify("تم حفظ الفني");
              setModal(null);
              await Promise.all([technicians.refresh(), todayBookings.refresh(), refreshStats()]);
            } catch (error) {
              notify(error instanceof Error ? error.message : "تعذر حفظ الفني", false);
            }
          }}
        />
      ),
    });
  };

  const remove = async (technician: api.Technician) => {
    if (!window.confirm(`حذف الفني ${technician.name}؟`)) return;
    try {
      await api.deleteTechnician(technician.id);
      notify("تم حذف الفني");
      await Promise.all([technicians.refresh(), todayBookings.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  return (
    <>
      <PageHeader title="الفنيون" actions={<Button onClick={() => openForm()}><Plus size={16} /> إضافة فني</Button>} />
      {technicians.loading ? <Loading /> : technicians.error ? <ErrorBlock message={technicians.error} retry={technicians.refresh} /> : (
        <div className="cards-grid">
          {(technicians.data || []).map((technician) => (
            <article className="mini-card" key={technician.id}>
              <div>
                <strong>{technician.name}</strong>
                <span>{phoneLabel(technician.phone)} · {technician.specialty || "عام"}</span>
              </div>
              <p>{technician.max_daily} زيارات يوميا</p>
              <div className="chips">
                <Badge tone={technicianCapacityTone(technicianTodayCount(technician.id), Number(technician.max_daily || 4))}>
                  {technicianTodayCount(technician.id)} / {Number(technician.max_daily || 4)} اليوم
                </Badge>
              </div>
              <div className="row-actions">
                <IconButton title="تعديل" onClick={() => openForm(technician)}><Edit3 size={15} /></IconButton>
                <IconButton title="حذف" tone="danger" onClick={() => remove(technician)}><Trash2 size={15} /></IconButton>
              </div>
            </article>
          ))}
          {!technicians.data?.length && <Empty title="لا يوجد فنيون بعد" action={<Button onClick={() => openForm()}><Plus size={16} /> إضافة أول فني</Button>} />}
        </div>
      )}
    </>
  );
}

function TechnicianForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: api.Technician;
  onSave: (payload: Omit<api.Technician, "id">) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [specialty, setSpecialty] = useState(initial?.specialty || "");
  const [maxDaily, setMaxDaily] = useState(initial?.max_daily || 4);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({ name: name.trim(), phone: phone.trim(), specialty: specialty.trim(), max_daily: Number(maxDaily || 4) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <Field label="الاسم"><TextInput required value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="الجوال"><TextInput required value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      <div className="form-grid">
        <Field label="التخصص"><TextInput value={specialty} onChange={(e) => setSpecialty(e.target.value)} /></Field>
        <Field label="الزيارات اليومية"><TextInput type="number" min={1} value={maxDaily} onChange={(e) => setMaxDaily(Number(e.target.value))} /></Field>
      </div>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}
