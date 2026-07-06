import { Plus, Search, Edit3, Trash2, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import * as api from "../api";
import {
  Button,
  Empty,
  ErrorBlock,
  Field,
  IconButton,
  Loading,
  PageHeader,
  TextInput,
  phoneLabel,
  useData,
  type ModalState,
} from "../shared";

export default function CustomersPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const [search, setSearch] = useState("");
  const customers = useData(() => api.getCustomers(search), [search]);

  const openForm = (customer?: api.Customer) => {
    setModal({
      title: customer ? "تعديل عميل" : "إضافة عميل",
      content: (
        <CustomerForm
          initial={customer}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            try {
              if (customer) await api.updateCustomer(customer.id, payload);
              else await api.createCustomer(payload);
              notify("تم حفظ العميل");
              setModal(null);
              await Promise.all([customers.refresh(), refreshStats()]);
            } catch (error) {
              notify(error instanceof Error ? error.message : "تعذر حفظ العميل", false);
            }
          }}
        />
      ),
    });
  };

  const remove = async (customer: api.Customer) => {
    if (!window.confirm(`حذف العميل ${customer.name}؟`)) return;
    try {
      await api.deleteCustomer(customer.id);
      notify("تم حذف العميل");
      await Promise.all([customers.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  return (
    <>
      <PageHeader
        title="العملاء"
        subtitle={`${customers.data?.total || 0} عميل`}
        actions={<Button onClick={() => openForm()}><Plus size={16} /> إضافة عميل</Button>}
      />
      <div className="toolbar">
        <Search size={16} />
        <TextInput placeholder="بحث بالاسم أو الجوال أو المدينة" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {customers.loading ? <Loading /> : customers.error ? <ErrorBlock message={customers.error} retry={customers.refresh} /> : (
        <div className="list">
          {(customers.data?.data || []).map((customer) => (
            <article className="row-card" key={customer.id}>
              <div className="row-main">
                <strong>{customer.name}</strong>
                <span>{phoneLabel(customer.phone)} · {customer.city || "بدون مدينة"}</span>
              </div>
              <div className="row-actions">
                <IconButton title="تعديل" onClick={() => openForm(customer)}><Edit3 size={15} /></IconButton>
                <IconButton title="حذف" tone="danger" onClick={() => remove(customer)}><Trash2 size={15} /></IconButton>
              </div>
            </article>
          ))}
          {!customers.data?.data.length && <Empty title="لا يوجد عملاء بعد" action={<Button onClick={() => openForm()}><Plus size={16} /> إضافة أول عميل</Button>} />}
        </div>
      )}
    </>
  );
}

function CustomerForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: api.Customer;
  onSave: (payload: Omit<api.Customer, "id">) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [city, setCity] = useState(initial?.city || "");
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({ name: name.trim(), phone: phone.trim(), city: city.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <Field label="الاسم"><TextInput required value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="الجوال"><TextInput required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="05xxxxxxxx" /></Field>
      <Field label="المدينة"><TextInput value={city} onChange={(e) => setCity(e.target.value)} /></Field>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}
