import { Plus, Edit3, Trash2, Save } from "lucide-react";
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
  TextArea,
  TextInput,
  useData,
  type ModalState,
} from "../shared";

const money = (value?: number | null, currency = "SAR") =>
  typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("ar-SA", { style: "currency", currency }).format(value)
    : "بدون سعر";

const parseMoneyInput = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
};

export default function ProductsPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const products = useData(api.getProducts);

  const openForm = (product?: api.Product) => {
    setModal({
      title: product ? "تعديل منتج" : "إضافة منتج",
      content: (
        <ProductForm
          initial={product}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            try {
              if (product) await api.updateProduct(product.id, payload);
              else await api.createProduct(payload);
              notify("تم حفظ المنتج");
              setModal(null);
              await Promise.all([products.refresh(), refreshStats()]);
            } catch (error) {
              notify(error instanceof Error ? error.message : "تعذر حفظ المنتج", false);
            }
          }}
        />
      ),
    });
  };

  const remove = async (product: api.Product) => {
    if (!window.confirm(`حذف المنتج ${product.name}؟`)) return;
    try {
      await api.deleteProduct(product.id);
      notify("تم حذف المنتج");
      await Promise.all([products.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  return (
    <>
      <PageHeader title="المنتجات" actions={<Button onClick={() => openForm()}><Plus size={16} /> إضافة منتج</Button>} />
      {products.loading ? <Loading /> : products.error ? <ErrorBlock message={products.error} retry={products.refresh} /> : (
        <div className="cards-grid">
          {(products.data || []).map((product) => (
            <article className="mini-card" key={product.id}>
              <div>
                <strong>{product.name}</strong>
                <span>كل {product.interval_months} شهر · {product.category || "عام"}</span>
                <span>{money(product.sale_price ?? product.price, product.currency || "SAR")}</span>
              </div>
              <p>{product.remind_text || "رسالة التذكير الافتراضية"}</p>
              <div className="row-actions">
                <IconButton title="تعديل" onClick={() => openForm(product)}><Edit3 size={15} /></IconButton>
                <IconButton title="حذف" tone="danger" onClick={() => remove(product)}><Trash2 size={15} /></IconButton>
              </div>
            </article>
          ))}
          {!products.data?.length && <Empty title="لا توجد منتجات بعد" action={<Button onClick={() => openForm()}><Plus size={16} /> إضافة أول منتج</Button>} />}
        </div>
      )}
    </>
  );
}

function ProductForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: api.Product;
  onSave: (payload: Omit<api.Product, "id">) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [interval, setInterval] = useState(initial?.interval_months || 3);
  const [category, setCategory] = useState(initial?.category || "");
  const [sku, setSku] = useState(initial?.sku || "");
  const [price, setPrice] = useState(initial?.price === null || initial?.price === undefined ? "" : String(initial.price));
  const [salePrice, setSalePrice] = useState(
    initial?.sale_price === null || initial?.sale_price === undefined ? "" : String(initial.sale_price),
  );
  const [remindText, setRemindText] = useState(initial?.remind_text || "");
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        interval_months: Number(interval || 1),
        category: category.trim(),
        sku: sku.trim(),
        price: parseMoneyInput(price),
        sale_price: parseMoneyInput(salePrice),
        currency: initial?.currency || "SAR",
        remind_text: remindText.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <Field label="اسم المنتج"><TextInput required value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="form-grid">
        <Field label="فاصل الصيانة بالأشهر"><TextInput required min={1} type="number" value={interval} onChange={(e) => setInterval(Number(e.target.value))} /></Field>
        <Field label="التصنيف"><TextInput value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
      </div>
      <Field label="SKU"><TextInput value={sku} onChange={(e) => setSku(e.target.value)} /></Field>
      <div className="form-grid">
        <Field label="السعر الأساسي"><TextInput min={0} step="0.01" type="number" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="سعر البيع"><TextInput min={0} step="0.01" type="number" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} /></Field>
      </div>
      <Field label="نص تذكير اختياري"><TextArea rows={3} value={remindText} onChange={(e) => setRemindText(e.target.value)} /></Field>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}
