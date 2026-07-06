import { Plus, Play, Save, Send, Check, Edit3, Trash2 } from "lucide-react";
import { useState, useEffect, useMemo, type FormEvent } from "react";
import * as api from "../api";
import {
  Button,
  Empty,
  ErrorBlock,
  Field,
  IconButton,
  InstallationCard,
  Loading,
  PageHeader,
  SelectInput,
  TextInput,
  addMonths,
  fmtDate,
  phoneLabel,
  today,
  useData,
  type ModalState,
} from "../shared";

export default function InstallationsPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const installations = useData(api.getInstallations);

  const openForm = (installation?: api.Installation) => {
    setModal({
      title: installation ? "تعديل صيانة" : "إضافة صيانة",
      wide: true,
      content: (
        <InstallationForm
          initial={installation}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            try {
              if (installation) await api.updateInstallation(installation.id, payload);
              else await api.createInstallation(payload);
              notify("تم حفظ الصيانة");
              setModal(null);
              await Promise.all([installations.refresh(), refreshStats()]);
            } catch (error) {
              notify(error instanceof Error ? error.message : "تعذر حفظ الصيانة", false);
            }
          }}
        />
      ),
    });
  };

  const complete = async (installation: api.Installation) => {
    try {
      await api.completeInstallation(installation.id);
      notify("تم إكمال الصيانة");
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الإكمال", false);
    }
  };

  const remind = async (installation: api.Installation) => {
    try {
      await api.remindInstallation(installation.id, installation.next_remind_type || "first");
      notify("تم إرسال التذكير");
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إرسال التذكير", false);
    }
  };

  const runDue = async () => {
    try {
      const result = await api.runDueReminders();
      if (result.blocked) {
        notify(result.error || "التذكيرات متوقفة. راجع تشخيص واتساب والجدولة.", false);
      } else if (result.sent > 0) {
        notify(`تم إرسال ${result.sent} من ${result.checked} تذكير مستحق`);
      } else if (result.failed > 0) {
        notify(`فشل إرسال ${result.failed} تذكير. راجع سجل التذكيرات لمعرفة السبب.`, false);
      } else if (result.checked > 0) {
        notify(`لم يتم إرسال أي تذكير. تم تخطي ${result.skipped || 0} حسب قواعد التكرار.`, false);
      } else {
        notify("لا توجد تذكيرات مستحقة الآن");
      }
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تشغيل التذكيرات", false);
    }
  };

  const remove = async (installation: api.Installation) => {
    if (!window.confirm(`حذف صيانة ${installation.customer_name}؟`)) return;
    try {
      await api.deleteInstallation(installation.id);
      notify("تم حذف الصيانة");
      await Promise.all([installations.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  return (
    <>
      <PageHeader
        title="الصيانة"
        actions={
          <>
            <Button tone="muted" onClick={runDue}><Play size={16} /> تشغيل المستحق</Button>
            <Button onClick={() => openForm()}><Plus size={16} /> إضافة صيانة</Button>
          </>
        }
      />
      {installations.loading ? <Loading /> : installations.error ? <ErrorBlock message={installations.error} retry={installations.refresh} /> : (
        <div className="list">
          {(installations.data || []).map((installation) => (
            <InstallationCard
              key={installation.id}
              installation={installation}
              onRemind={() => remind(installation)}
              onComplete={() => complete(installation)}
              onEdit={() => openForm(installation)}
              onDelete={() => remove(installation)}
            />
          ))}
          {!installations.data?.length && <Empty title="لا توجد عمليات صيانة بعد" action={<Button onClick={() => openForm()}><Plus size={16} /> إضافة أول صيانة</Button>} />}
        </div>
      )}
    </>
  );
}

function InstallationForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: api.Installation;
  onSave: (payload: Omit<api.Installation, "id" | "remind_count" | "status">) => Promise<void>;
  onCancel: () => void;
}) {
  const customers = useData(() => api.getCustomers(""));
  const products = useData(api.getProducts);
  const [customerId, setCustomerId] = useState(initial?.customer_id || "");
  const [productId, setProductId] = useState(initial?.product_id || "");
  const [installDate, setInstallDate] = useState(initial?.install_date || today());
  const [nextMaintenance, setNextMaintenance] = useState(initial?.next_maintenance || today());
  const [label, setLabel] = useState(initial?.label || "");
  const [saving, setSaving] = useState(false);

  const selectedCustomer = useMemo(
    () => customers.data?.data.find((item) => item.id === customerId),
    [customers.data, customerId],
  );
  const selectedProduct = useMemo(
    () => products.data?.find((item) => item.id === productId),
    [products.data, productId],
  );

  useEffect(() => {
    if (!customerId && customers.data?.data[0]) setCustomerId(customers.data.data[0].id);
  }, [customers.data, customerId]);

  useEffect(() => {
    if (!productId && products.data?.[0]) setProductId(products.data[0].id);
  }, [products.data, productId]);

  useEffect(() => {
    if (!initial && selectedProduct) setNextMaintenance(addMonths(installDate, selectedProduct.interval_months));
  }, [installDate, selectedProduct, initial]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedCustomer || !selectedProduct) return;
    setSaving(true);
    try {
      await onSave({
        customer_id: selectedCustomer.id,
        customer_name: selectedCustomer.name,
        customer_phone: selectedCustomer.phone,
        product_id: selectedProduct.id,
        product_name: selectedProduct.name,
        product_sku: selectedProduct.sku || "",
        install_date: installDate,
        next_maintenance: nextMaintenance,
        // Preserve the reminder stage when editing — a null stage means the
        // cycle already finished, so `|| "first"` would silently re-arm it and
        // resend reminders. Only a brand-new installation starts at "first".
        next_remind_type: initial
          ? (initial.next_remind_type === undefined ? "first" : initial.next_remind_type)
          : "first",
        label: label.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  const noData = !customers.loading && !products.loading && (!customers.data?.data.length || !products.data?.length);

  if (customers.loading || products.loading) return <Loading />;
  if (noData) return <Empty title="أضف عميلا ومنتجا قبل إنشاء الصيانة" />;

  return (
    <form className="form" onSubmit={submit}>
      <div className="form-grid">
        <Field label="العميل">
          <SelectInput value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            {(customers.data?.data || []).map((customer) => <option key={customer.id} value={customer.id}>{customer.name} - {phoneLabel(customer.phone)}</option>)}
          </SelectInput>
        </Field>
        <Field label="المنتج">
          <SelectInput value={productId} onChange={(e) => setProductId(e.target.value)}>
            {(products.data || []).map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </SelectInput>
        </Field>
      </div>
      <div className="form-grid">
        <Field label="تاريخ التركيب"><TextInput type="date" value={installDate} onChange={(e) => setInstallDate(e.target.value)} /></Field>
        <Field label="موعد الصيانة القادم"><TextInput type="date" value={nextMaintenance} onChange={(e) => setNextMaintenance(e.target.value)} /></Field>
      </div>
      <Field label="ملاحظة"><TextInput value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}
