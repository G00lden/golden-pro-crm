import { Plus, Edit3, Trash2, Save, MapPin, Power, QrCode, RefreshCcw, WalletCards } from "lucide-react";
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
  const fieldTech = useData(api.getFieldTechStatus);
  const [fieldTechBusy, setFieldTechBusy] = useState("");

  const remoteTechnician = (id: string) =>
    fieldTech.data?.technicians?.find((item) => item.breexeTechnicianId === id);

  const syncFieldTech = async () => {
    setFieldTechBusy("sync");
    try {
      const result = await api.syncFieldTech();
      notify(`تمت مزامنة ${result.bookings} طلب مع تطبيق الفني`);
      await fieldTech.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذرت مزامنة تطبيق الفني", false);
    } finally {
      setFieldTechBusy("");
    }
  };

  const openPairing = async (technician: api.Technician) => {
    setFieldTechBusy(`pair:${technician.id}`);
    try {
      const pairing = await api.createFieldTechPairing(technician.id);
      setModal({
        title: `ربط جوال ${technician.name}`,
        content: (
          <div className="form">
            <div className="empty">
              <img src={pairing.qrDataUrl} width="260" height="260" alt={`رمز ربط الفني ${technician.name}`} />
              <strong>الرمز صالح لمدة 5 دقائق</strong>
              <code dir="ltr">{pairing.code}</code>
              <p>يفتح الفني التطبيق ويمسح الرمز أو يكتب الكود، ثم يصبح الجهاز تحت تحكم Breexe Pro CRM.</p>
            </div>
            <div className="form-actions"><Button tone="muted" onClick={() => setModal(null)}>إغلاق</Button></div>
          </div>
        ),
      });
      await fieldTech.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إنشاء رمز الربط", false);
    } finally {
      setFieldTechBusy("");
    }
  };

  const toggleFieldTech = async (technician: api.Technician, active: boolean) => {
    const verb = active ? "تفعيل" : "إيقاف";
    if (!window.confirm(`${verb} حساب ${technician.name} في تطبيق الفني؟${active ? "" : " ستلغى جلسات أجهزته فورًا."}`)) return;
    setFieldTechBusy(`account:${technician.id}`);
    try {
      await api.setFieldTechAccount(technician.id, active);
      notify(`تم ${verb} حساب تطبيق الفني`);
      await fieldTech.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : `تعذر ${verb} الحساب`, false);
    } finally {
      setFieldTechBusy("");
    }
  };

  const openOperations = async (technician: api.Technician) => {
    setFieldTechBusy(`operations:${technician.id}`);
    try {
      const operations = await api.getFieldTechOperations(technician.id);
      const wallet = operations.wallet;
      setModal({
        title: `تشغيل ${technician.name}`,
        content: (
          <div className="form">
            <div className="cards-grid">
              <article className="mini-card"><strong>{(wallet.availableHalalas / 100).toLocaleString("ar-SA")} ر.س</strong><span>الرصيد المتاح</span></article>
              <article className="mini-card"><strong>{(wallet.heldHalalas / 100).toLocaleString("ar-SA")} ر.س</strong><span>طلبات سحب معلقة</span></article>
              <article className="mini-card"><strong>{operations.devices.filter((item) => !item.revokedAt).length}</strong><span>أجهزة مربوطة</span></article>
            </div>
            {operations.location ? (
              <a className="btn muted" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${operations.location.latitude},${operations.location.longitude}`}>
                <MapPin size={16} /> فتح آخر موقع في Google Maps
              </a>
            ) : <p>لم يشارك الفني موقعه بعد.</p>}
            <div className="form-actions"><Button tone="muted" onClick={() => setModal(null)}>إغلاق</Button></div>
          </div>
        ),
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تحميل بيانات تشغيل الفني", false);
    } finally {
      setFieldTechBusy("");
    }
  };

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
      <PageHeader title="الفنيون" actions={<>
        {fieldTech.data?.configured && <Button tone="muted" loading={fieldTechBusy === "sync"} onClick={syncFieldTech}><RefreshCcw size={16} /> مزامنة التطبيق</Button>}
        <Button onClick={() => openForm()}><Plus size={16} /> إضافة فني</Button>
      </>} />
      {fieldTech.loading ? <Loading /> : fieldTech.error ? <ErrorBlock message={`ربط تطبيق الفني: ${fieldTech.error}`} retry={fieldTech.refresh} /> : (
        <article className="mini-card" style={{ marginBottom: 16 }}>
          <div>
            <strong>ربط تطبيق الفني</strong>
            <span>{fieldTech.data?.configured ? `متصل · آخر مزامنة ${fieldTech.data.lastSync?.at ? new Date(fieldTech.data.lastSync.at).toLocaleString("ar-SA") : "لم تتم بعد"}` : fieldTech.data?.message || "غير مضبوط على الخادم"}</span>
          </div>
          <div className="chips">
            <Badge tone={fieldTech.data?.connected ? "success" : "warn"}>{fieldTech.data?.connected ? "متصل" : "يحتاج إعداد"}</Badge>
            {!!fieldTech.data?.pendingEvents && <Badge tone="warn">{fieldTech.data.pendingEvents} تحديث بانتظار الإرسال</Badge>}
          </div>
        </article>
      )}
      {technicians.loading ? <Loading /> : technicians.error ? <ErrorBlock message={technicians.error} retry={technicians.refresh} /> : (
        <div className="cards-grid">
          {(technicians.data || []).map((technician) => {
            const remote = remoteTechnician(technician.id);
            return <article className="mini-card" key={technician.id}>
              <div>
                <strong>{technician.name}</strong>
                <span>{phoneLabel(technician.phone)} · {technician.specialty || "عام"}</span>
              </div>
              <p>{technician.max_daily} زيارات يوميا</p>
              <div className="chips">
                <Badge tone={technicianCapacityTone(technicianTodayCount(technician.id), Number(technician.max_daily || 4))}>
                  {technicianTodayCount(technician.id)} / {Number(technician.max_daily || 4)} اليوم
                </Badge>
                {fieldTech.data?.configured && <Badge tone={remote?.active ? "success" : "warn"}>{remote ? (remote.active ? `التطبيق مفعل · ${remote.pairedDevices || 0} جهاز` : "التطبيق موقوف") : "بانتظار المزامنة"}</Badge>}
              </div>
              <div className="row-actions">
                {fieldTech.data?.configured && <>
                  <IconButton title="كود ربط التطبيق" disabled={fieldTechBusy === `pair:${technician.id}`} onClick={() => openPairing(technician)}><QrCode size={15} /></IconButton>
                  {remote && <IconButton title={remote.active ? "إيقاف حساب التطبيق" : "تفعيل حساب التطبيق"} tone={remote.active ? "danger" : "success"} disabled={fieldTechBusy === `account:${technician.id}`} onClick={() => toggleFieldTech(technician, !remote.active)}><Power size={15} /></IconButton>}
                  {remote && <IconButton title="الموقع والمحفظة والأجهزة" disabled={fieldTechBusy === `operations:${technician.id}`} onClick={() => openOperations(technician)}><WalletCards size={15} /></IconButton>}
                </>}
                <IconButton title="تعديل" onClick={() => openForm(technician)}><Edit3 size={15} /></IconButton>
                <IconButton title="حذف" tone="danger" onClick={() => remove(technician)}><Trash2 size={15} /></IconButton>
              </div>
            </article>;
          })}
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
