import {
  CheckCircle2,
  CircleOff,
  Edit3,
  ExternalLink,
  Layers3,
  Package,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useDeferredValue, useMemo, useState, type FormEvent } from "react";
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
  TextArea,
  TextInput,
  useData,
  type ModalState,
} from "../shared";

type ProductSort = "store" | "name" | "newest" | "stock" | "price";
type ProductStatusFilter = "all" | "available" | "out" | "hidden";

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

function parseList<T>(value: T[] | string | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function normalizeSku(value?: string) {
  return String(value || "").replace(/\s+/g, "").toLocaleLowerCase("en-US");
}

function duplicateCount(products: api.Product[]) {
  const byRemote = new Map<string, api.Product[]>();
  const bySku = new Map<string, api.Product[]>();
  for (const product of products) {
    const remoteId = String(product.store_product_id || "").trim();
    const sku = normalizeSku(product.sku);
    if (remoteId) byRemote.set(remoteId, [...(byRemote.get(remoteId) || []), product]);
    if (sku) bySku.set(sku, [...(bySku.get(sku) || []), product]);
  }

  const duplicateIds = new Set<string>();
  for (const bucket of byRemote.values()) bucket.slice(1).forEach((product) => duplicateIds.add(product.id));
  for (const bucket of bySku.values()) {
    const remoteIds = new Set(bucket.map((product) => product.store_product_id).filter(Boolean));
    if (remoteIds.size <= 1) bucket.slice(1).forEach((product) => duplicateIds.add(product.id));
    else bucket.filter((product) => !product.store_product_id).slice(1).forEach((product) => duplicateIds.add(product.id));
  }
  return duplicateIds.size;
}

function isAvailable(product: api.Product) {
  const status = String(product.store_status || "").toLowerCase();
  return product.is_available !== false
    && product.is_available !== 0
    && !["out", "out_of_stock", "unavailable", "hidden", "deleted"].includes(status);
}

function statusMeta(product: api.Product): { label: string; tone: "success" | "warn" | "danger" | "muted" } {
  const status = String(product.store_status || "").toLowerCase();
  if (status === "hidden") return { label: "مخفي", tone: "warn" };
  if (status === "deleted") return { label: "محذوف من سلة", tone: "danger" };
  if (!isAvailable(product) || ["out", "out_of_stock", "unavailable"].includes(status)) {
    return { label: "غير متاح", tone: "danger" };
  }
  if (product.source === "manual") return { label: "يدوي", tone: "muted" };
  return { label: "متاح", tone: "success" };
}

function inventoryLabel(product: api.Product) {
  if (product.unlimited_quantity === true || product.unlimited_quantity === 1) return "غير محدود";
  if (product.stock_quantity === null || product.stock_quantity === undefined) return "غير متتبع";
  return new Intl.NumberFormat("ar-SA").format(product.stock_quantity);
}

function variantsCount(product: api.Product) {
  return parseList<api.ProductVariant>(product.variants).length;
}

function syncedAtLabel(value?: string) {
  if (!value) return "لم تتم المزامنة";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ar-SA", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

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
  const salla = useData(api.getSallaIntegrationStatus);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState<ProductStatusFilter>("all");
  const [source, setSource] = useState("salla");
  const [sort, setSort] = useState<ProductSort>("store");
  const [syncing, setSyncing] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const allProducts = products.data || [];
  const categories = useMemo(() => {
    const values = new Set<string>();
    for (const product of allProducts) {
      if (product.category?.trim()) values.add(product.category.trim());
      for (const item of parseList<{ name?: string }>(product.categories)) {
        if (item.name?.trim()) values.add(item.name.trim());
      }
    }
    return [...values].sort((left, right) => left.localeCompare(right, "ar"));
  }, [allProducts]);

  const summary = useMemo(() => ({
    total: allProducts.length,
    available: allProducts.filter(isAvailable).length,
    out: allProducts.filter((product) => !isAvailable(product)).length,
    variants: allProducts.reduce((total, product) => total + variantsCount(product), 0),
    duplicates: duplicateCount(allProducts),
  }), [allProducts]);

  const filteredProducts = useMemo(() => {
    const query = deferredSearch.trim().toLocaleLowerCase("ar");
    const filtered = allProducts.filter((product) => {
      const haystack = [product.name, product.sku, product.category, product.store_product_id]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("ar");
      if (query && !haystack.includes(query)) return false;
      if (category !== "all") {
        const names = [product.category, ...parseList<{ name?: string }>(product.categories).map((item) => item.name)];
        if (!names.includes(category)) return false;
      }
      if (source !== "all" && product.source !== source) return false;
      if (status === "available" && !isAvailable(product)) return false;
      if (status === "out" && (isAvailable(product) || String(product.store_status).toLowerCase() === "hidden")) return false;
      if (status === "hidden" && String(product.store_status).toLowerCase() !== "hidden") return false;
      return true;
    });

    return filtered.sort((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name, "ar");
      if (sort === "newest") return String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || ""));
      if (sort === "stock") return Number(right.stock_quantity || 0) - Number(left.stock_quantity || 0);
      if (sort === "price") return Number(right.sale_price ?? right.price ?? 0) - Number(left.sale_price ?? left.price ?? 0);
      const leftStore = left.source === "salla" ? 0 : 1;
      const rightStore = right.source === "salla" ? 0 : 1;
      return leftStore - rightStore || left.name.localeCompare(right.name, "ar");
    });
  }, [allProducts, category, deferredSearch, sort, source, status]);

  const refreshAll = async () => {
    await Promise.all([products.refresh(), salla.refresh(), refreshStats()]);
  };

  const openForm = (product?: api.Product) => {
    setModal({
      title: product ? "تعديل إعدادات المنتج" : "إضافة منتج يدوي",
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
              await refreshAll();
            } catch (error) {
              notify(error instanceof Error ? error.message : "تعذر حفظ المنتج", false);
            }
          }}
        />
      ),
    });
  };

  const remove = async (product: api.Product) => {
    if (product.source === "salla" || product.store_product_id) {
      notify("المنتج مرتبط بسلة. احذفه من سلة ثم شغّل المزامنة.", false);
      return;
    }
    if (!window.confirm(`حذف المنتج ${product.name}؟`)) return;
    try {
      await api.deleteProduct(product.id);
      notify("تم حذف المنتج");
      await refreshAll();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر الحذف", false);
    }
  };

  const syncCatalog = async () => {
    if (!salla.data?.linked) {
      notify("اربط متجر سلة من الإعدادات أولاً، ثم ارجع لمزامنة المنتجات.", false);
      return;
    }
    setSyncing(true);
    try {
      const result = await api.syncSallaProductsCatalog();
      const parts = [`جُلب ${result.fetched} منتجاً`, `أضيف ${result.imported}`, `حُدّث ${result.updated}`];
      if (result.deduplicated) parts.push(`دُمج ${result.deduplicated} مكرر`);
      if (result.archived) parts.push(`أُخفي ${result.archived} سجل تاريخي من الكتالوج`);
      notify(parts.join(" · "), result.success);
      await refreshAll();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذرت مزامنة منتجات سلة", false);
    } finally {
      setSyncing(false);
    }
  };

  const cleanDuplicates = async () => {
    if (!window.confirm("سيتم دمج المنتجات المتكررة ونقل ارتباطاتها إلى سجل واحد. متابعة؟")) return;
    setCleaning(true);
    try {
      const result = await api.deduplicateProducts();
      notify(result.deduplicated
        ? `تم دمج ${result.deduplicated} منتج مكرر وإعادة ربط ${result.relinked} سجل`
        : "لا توجد منتجات مكررة تحتاج تنظيفاً");
      await refreshAll();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تنظيف المنتجات المكررة", false);
    } finally {
      setCleaning(false);
    }
  };

  return (
    <>
      <PageHeader
        title="المنتجات"
        subtitle="كتالوج موحد من سلة مع الصور والأسعار والمخزون والتصنيفات، وإعدادات صيانة مستقلة داخل CRM."
        actions={(
          <>
            <Button tone="muted" loading={syncing} onClick={syncCatalog}>
              <RefreshCcw size={16} /> مزامنة سلة
            </Button>
            <Button onClick={() => openForm()}><Plus size={16} /> منتج يدوي</Button>
          </>
        )}
      />

      <section className={`product-sync-banner ${salla.data?.linked ? "connected" : ""}`} aria-label="حالة ربط متجر سلة">
        <div className="product-sync-brand">
          <span className="salla-mark">س</span>
          <div>
            <strong>{salla.data?.store_name || "متجر سلة"}</strong>
            <span>{salla.loading ? "جاري فحص الربط…" : salla.data?.linked ? "متصل وتتم مزامنة الكتالوج من سلة" : "غير متصل — أكمل الربط من الإعدادات"}</span>
          </div>
        </div>
        <div className="product-sync-details">
          <span>آخر مزامنة</span>
          <strong>{syncedAtLabel(salla.data?.last_product_sync_at)}</strong>
        </div>
        <Button tone="muted" loading={cleaning} onClick={cleanDuplicates} disabled={!summary.duplicates && !cleaning}>
          <Sparkles size={15} /> تنظيف التكرار {summary.duplicates ? `(${summary.duplicates})` : ""}
        </Button>
      </section>

      <section className="product-summary-grid" aria-label="ملخص المنتجات">
        <article><Package size={20} /><div><strong>{summary.total}</strong><span>كل المنتجات</span></div></article>
        <article className="success"><CheckCircle2 size={20} /><div><strong>{summary.available}</strong><span>متاح للبيع</span></div></article>
        <article className="danger"><CircleOff size={20} /><div><strong>{summary.out}</strong><span>غير متاح</span></div></article>
        <article><Layers3 size={20} /><div><strong>{summary.variants}</strong><span>متغيرات المنتجات</span></div></article>
      </section>

      <section className="product-catalog-board">
        <div className="product-catalog-toolbar">
          <label className="product-search" htmlFor="product-search-input">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">بحث في المنتجات</span>
            <TextInput
              id="product-search-input"
              name="product_search"
              autoComplete="off"
              type="search"
              placeholder="ابحث بالاسم أو SKU أو رقم سلة…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Field label="الحالة">
            <SelectInput name="product_status_filter" value={status} onChange={(event) => setStatus(event.target.value as ProductStatusFilter)}>
              <option value="all">كل الحالات</option>
              <option value="available">متاح</option>
              <option value="out">غير متاح</option>
              <option value="hidden">مخفي</option>
            </SelectInput>
          </Field>
          <Field label="المصدر">
            <SelectInput name="product_source_filter" value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="all">سلة واليدوي</option>
              <option value="salla">سلة فقط</option>
              <option value="manual">يدوي فقط</option>
            </SelectInput>
          </Field>
          <Field label="الترتيب">
            <SelectInput name="product_sort" value={sort} onChange={(event) => setSort(event.target.value as ProductSort)}>
              <option value="store">منتجات سلة أولاً</option>
              <option value="name">الاسم</option>
              <option value="newest">الأحدث</option>
              <option value="stock">المخزون</option>
              <option value="price">السعر</option>
            </SelectInput>
          </Field>
        </div>

        <div className="product-category-tabs" role="tablist" aria-label="تصنيفات المنتجات">
          <button type="button" role="tab" aria-selected={category === "all"} className={category === "all" ? "active" : ""} onClick={() => setCategory("all")}>
            الكل <b>{summary.total}</b>
          </button>
          {categories.map((item) => (
            <button key={item} type="button" role="tab" aria-selected={category === item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>
              {item}
            </button>
          ))}
        </div>

        {products.loading ? <Loading /> : products.error ? <ErrorBlock message={products.error} retry={products.refresh} /> : (
          <div className="product-table-wrap">
            <div className="product-mobile-list">
              {filteredProducts.map((product) => {
                const state = statusMeta(product);
                const storeManaged = product.source === "salla" || Boolean(product.store_product_id);
                return (
                  <article key={`mobile-${product.id}`} className="product-mobile-card">
                    <div className="product-mobile-head">
                      {product.image_url ? (
                        <img src={product.image_url} alt="" width={58} height={58} loading="lazy" />
                      ) : (
                        <span className="product-image-placeholder"><Package size={23} /></span>
                      )}
                      <div>
                        <strong>{product.name}</strong>
                        <span dir="ltr">{product.sku || "بدون SKU"}</span>
                        <small>{storeManaged ? "Salla" : "CRM"}{product.store_product_id ? ` #${product.store_product_id}` : ""}</small>
                      </div>
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </div>
                    <dl>
                      <div><dt>التصنيف</dt><dd>{product.category || "غير مصنف"}</dd></div>
                      <div><dt>المخزون</dt><dd>{inventoryLabel(product)}</dd></div>
                      <div><dt>السعر</dt><dd>{money(product.sale_price ?? product.price, product.currency || "SAR")}</dd></div>
                      <div><dt>المتغيرات</dt><dd>{variantsCount(product) || "—"}</dd></div>
                    </dl>
                    <footer>
                      <span>{syncedAtLabel(product.last_synced_at || product.updatedAt)}</span>
                      <div className="table-actions">
                        {product.store_admin_url ? (
                          <a className="icon-btn product-link-button" href={product.store_admin_url} target="_blank" rel="noreferrer" title="فتح المنتج في لوحة سلة" aria-label={`فتح ${product.name} في لوحة سلة`}>
                            <ExternalLink size={15} />
                          </a>
                        ) : null}
                        <IconButton title="تعديل إعدادات CRM" onClick={() => openForm(product)}><Edit3 size={15} /></IconButton>
                        {!storeManaged ? <IconButton title="حذف" tone="danger" onClick={() => remove(product)}><Trash2 size={15} /></IconButton> : null}
                      </div>
                    </footer>
                  </article>
                );
              })}
            </div>
            <table className="product-table">
              <thead>
                <tr>
                  <th>المنتج</th>
                  <th>الحالة</th>
                  <th>التصنيف</th>
                  <th>المخزون</th>
                  <th>السعر</th>
                  <th>المتغيرات</th>
                  <th>آخر تحديث</th>
                  <th><span className="sr-only">الإجراءات</span></th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((product) => {
                  const state = statusMeta(product);
                  const storeManaged = product.source === "salla" || Boolean(product.store_product_id);
                  return (
                    <tr key={product.id}>
                      <td>
                        <div className="product-identity">
                          {product.image_url ? (
                            <img src={product.image_url} alt="" width={52} height={52} loading="lazy" />
                          ) : (
                            <span className="product-image-placeholder"><Package size={22} /></span>
                          )}
                          <div>
                            {product.store_url ? (
                              <a href={product.store_url} target="_blank" rel="noreferrer">{product.name}<ExternalLink size={12} aria-hidden="true" /></a>
                            ) : <strong>{product.name}</strong>}
                            <span dir="ltr">{product.sku || "بدون SKU"}</span>
                            <small>{storeManaged ? "Salla" : "CRM"}{product.store_product_id ? ` #${product.store_product_id}` : ""}</small>
                          </div>
                        </div>
                      </td>
                      <td><Badge tone={state.tone}>{state.label}</Badge></td>
                      <td>{product.category || "غير مصنف"}</td>
                      <td><strong className={product.stock_quantity !== null && product.stock_quantity !== undefined && product.stock_quantity <= 0 && !product.unlimited_quantity ? "stock-low" : ""}>{inventoryLabel(product)}</strong></td>
                      <td>
                        <div className="product-price-cell">
                          <strong>{money(product.sale_price ?? product.price, product.currency || "SAR")}</strong>
                          {product.sale_price !== null && product.sale_price !== undefined && product.price !== null && product.price !== undefined && product.sale_price !== product.price ? (
                            <del>{money(product.price, product.currency || "SAR")}</del>
                          ) : null}
                        </div>
                      </td>
                      <td>{variantsCount(product) || "—"}</td>
                      <td><span className="product-sync-time">{syncedAtLabel(product.last_synced_at || product.updatedAt)}</span></td>
                      <td>
                        <div className="table-actions">
                          {product.store_admin_url ? (
                            <a className="icon-btn product-link-button" href={product.store_admin_url} target="_blank" rel="noreferrer" title="فتح المنتج في لوحة سلة" aria-label={`فتح ${product.name} في لوحة سلة`}>
                              <ExternalLink size={15} />
                            </a>
                          ) : null}
                          <IconButton title="تعديل إعدادات CRM" onClick={() => openForm(product)}><Edit3 size={15} /></IconButton>
                          {!storeManaged ? <IconButton title="حذف" tone="danger" onClick={() => remove(product)}><Trash2 size={15} /></IconButton> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!filteredProducts.length && (
              <Empty
                title={allProducts.length ? "لا توجد منتجات مطابقة للبحث أو الفلاتر" : "لا توجد منتجات بعد — شغّل مزامنة سلة لسحب الكتالوج"}
                action={!allProducts.length ? <Button loading={syncing} onClick={syncCatalog}><RefreshCcw size={16} /> مزامنة سلة الآن</Button> : undefined}
              />
            )}
          </div>
        )}
      </section>
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
  const storeManaged = initial?.source === "salla" || Boolean(initial?.store_product_id);
  const [name, setName] = useState(initial?.name || "");
  const [interval, setInterval] = useState(initial?.interval_months || 3);
  const [category, setCategory] = useState(initial?.category || "");
  const [sku, setSku] = useState(initial?.sku || "");
  const [price, setPrice] = useState(initial?.price === null || initial?.price === undefined ? "" : String(initial.price));
  const [salePrice, setSalePrice] = useState(initial?.sale_price === null || initial?.sale_price === undefined ? "" : String(initial.sale_price));
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
      {storeManaged ? (
        <div className="product-managed-note">
          <RefreshCcw size={16} />
          الاسم والتصنيف وSKU والأسعار تُدار من سلة وتتحدث تلقائياً. إعدادات الصيانة والتذكير أدناه تبقى خاصة بالـ CRM.
        </div>
      ) : null}
      <Field label="اسم المنتج"><TextInput required name="product_name" autoComplete="off" disabled={storeManaged} value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <div className="form-grid">
        <Field label="فاصل الصيانة بالأشهر"><TextInput required name="maintenance_interval_months" autoComplete="off" min={1} type="number" value={interval} onChange={(event) => setInterval(Number(event.target.value))} /></Field>
        <Field label="التصنيف"><TextInput name="product_category" autoComplete="off" disabled={storeManaged} value={category} onChange={(event) => setCategory(event.target.value)} /></Field>
      </div>
      <Field label="SKU"><TextInput dir="ltr" name="product_sku" autoComplete="off" spellCheck={false} disabled={storeManaged} value={sku} onChange={(event) => setSku(event.target.value)} /></Field>
      <div className="form-grid">
        <Field label="السعر الأساسي"><TextInput name="product_price" autoComplete="off" disabled={storeManaged} min={0} step="0.01" type="number" value={price} onChange={(event) => setPrice(event.target.value)} /></Field>
        <Field label="سعر البيع"><TextInput name="product_sale_price" autoComplete="off" disabled={storeManaged} min={0} step="0.01" type="number" value={salePrice} onChange={(event) => setSalePrice(event.target.value)} /></Field>
      </div>
      <Field label="نص تذكير الصيانة"><TextArea name="maintenance_reminder_text" autoComplete="off" rows={3} value={remindText} onChange={(event) => setRemindText(event.target.value)} /></Field>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}
