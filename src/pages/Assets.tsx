import QRCode from "qrcode";
import {
  CheckCircle2,
  ClipboardCheck,
  FileUp,
  MessageSquareText,
  PauseCircle,
  PlayCircle,
  Printer,
  QrCode,
  RefreshCcw,
  ShieldCheck,
  Tag,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as api from "../api";
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
  fmtDate,
  today,
  useData,
} from "../shared";

type Tab = "devices" | "cycles" | "policies" | "campaigns" | "odoo";

const statusText: Record<string, string> = {
  unassigned: "ملصق غير مفعّل",
  active: "نشط",
  paused: "متوقف مؤقتاً",
  retired: "خارج الخدمة",
  overdue: "متأخرة",
  due: "مستحقة اليوم",
  completed: "مكتملة",
};

function parseTasks(product: api.Product): api.ServiceTask[] {
  if (Array.isArray(product.service_tasks)) return product.service_tasks;
  if (typeof product.service_tasks === "string") {
    try { return JSON.parse(product.service_tasks) as api.ServiceTask[]; } catch { return []; }
  }
  return [];
}

export default function AssetsPage({ notify }: { notify: (message: string, ok?: boolean) => void }) {
  const workspace = useData(api.getAssetWorkspace);
  const [tab, setTab] = useState<Tab>("devices");
  const [busy, setBusy] = useState(false);

  const runReminders = async () => {
    setBusy(true);
    try {
      const result = await api.runAssetReminders();
      notify(`أُرسل ${result.sent} تذكير، وتعذّر ${result.failed}`);
      await workspace.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذّر تشغيل التذكيرات", false);
    } finally { setBusy(false); }
  };

  if (workspace.loading) return <Loading />;
  if (workspace.error || !workspace.data) return <ErrorBlock message={workspace.error || "تعذّر تحميل الأجهزة"} retry={workspace.refresh} />;

  const data = workspace.data;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "devices", label: "الأجهزة والملصقات" },
    { id: "cycles", label: "مواعيد الصيانة" },
    { id: "policies", label: "سياسات المنتجات" },
    { id: "campaigns", label: "حملات الجملة" },
    { id: "odoo", label: "استيراد أودو" },
  ];

  return (
    <>
      <PageHeader
        title="الأجهزة وتذكيرات الصيانة"
        subtitle="ملصق مستقل لكل جهاز، وضمان ودورات صيانة تبدأ من التنفيذ الفعلي"
        actions={<Button loading={busy} onClick={runReminders}><RefreshCcw size={16} /> تشغيل التذكيرات الآن</Button>}
      />
      <section className="asset-stats" aria-label="ملخص قسم الأجهزة">
        <Stat icon={<Tag />} label="ملصقات تنتظر التفعيل" value={data.stats.unassigned} />
        <Stat icon={<QrCode />} label="أجهزة نشطة" value={data.stats.active_assets} />
        <Stat icon={<ClipboardCheck />} label="صيانات متأخرة" value={data.stats.overdue} tone="danger" />
        <Stat icon={<ShieldCheck />} label="ضمان ينتهي خلال 60 يوماً" value={data.stats.warranty_expiring} tone="warn" />
      </section>
      <nav className="asset-tabs" aria-label="أقسام إدارة الأجهزة">
        {tabs.map((item) => (
          <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>
      {tab === "devices" && <DevicesPanel data={data} refresh={workspace.refresh} notify={notify} />}
      {tab === "cycles" && <CyclesPanel data={data} refresh={workspace.refresh} notify={notify} />}
      {tab === "policies" && <PoliciesPanel data={data} refresh={workspace.refresh} notify={notify} />}
      {tab === "campaigns" && <CampaignPanel data={data} refresh={workspace.refresh} notify={notify} />}
      {tab === "odoo" && <OdooImportPanel refresh={workspace.refresh} notify={notify} />}
    </>
  );
}

function Stat({ icon, label, value, tone = "normal" }: { icon: ReactNode; label: string; value: number; tone?: "normal" | "danger" | "warn" }) {
  return <article className={`asset-stat ${tone}`}>{icon}<div><strong>{value}</strong><span>{label}</span></div></article>;
}

function DevicesPanel({ data, refresh, notify }: { data: api.AssetWorkspace; refresh: () => Promise<void>; notify: (message: string, ok?: boolean) => void }) {
  const [count, setCount] = useState(1);
  const [labelProduct, setLabelProduct] = useState("");
  const [selected, setSelected] = useState<api.CustomerAsset | null>(null);
  const [printing, setPrinting] = useState(false);

  const createAndPrint = async () => {
    setPrinting(true);
    try {
      const result = await api.createAssetLabels(count, labelProduct || undefined);
      const labels = await Promise.all(result.items.map(async (asset) => ({ ...asset, qr: await QRCode.toDataURL(asset.public_url, { width: 320, margin: 1 }) })));
      const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصقات الأجهزة</title><style>@page{size:A4;margin:10mm}body{font-family:system-ui;margin:0;padding:10mm}.print{padding:10px 18px;margin-bottom:8mm}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm}.label{border:1px dashed #111;padding:5mm;text-align:center;break-inside:avoid}.label img{width:34mm;height:34mm}.code{direction:ltr;font-weight:800;letter-spacing:.08em;font-size:11pt}.hint{font-size:8pt;margin:2mm 0}@media print{body{padding:0}.print{display:none}}</style></head><body><button class="print" onclick="window.print()">طباعة الملصقات</button><main class="grid">${labels.map((item) => `<article class="label"><img alt="رمز الجهاز" src="${item.qr}"><div class="code">${item.asset_code}</div><p class="hint">امسح الرمز لتسجيل أو متابعة الجهاز</p></article>`).join("")}</main></body></html>`;
      const printUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      const printWindow = window.open(printUrl, "_blank", "noopener,noreferrer");
      if (!printWindow) throw new Error("اسمح للنظام بفتح نافذة الطباعة ثم أعد المحاولة.");
      window.setTimeout(() => URL.revokeObjectURL(printUrl), 60_000);
      notify(`تم إنشاء ${labels.length} ملصق غير مفعّل`);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "تعذّر إنشاء الملصقات", false); }
    finally { setPrinting(false); }
  };

  return (
    <section className="asset-panel">
      <div className="asset-create-bar">
        <Field label="عدد الملصقات"><TextInput type="number" min={1} max={100} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} /></Field>
        <Field label="المنتج (اختياري)"><SelectInput value={labelProduct} onChange={(e) => setLabelProduct(e.target.value)}><option value="">يحدده الفني لاحقاً</option>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectInput></Field>
        <Button loading={printing} onClick={createAndPrint}><Printer size={16} /> إنشاء وطباعة QR</Button>
      </div>
      <ReplacementLinks data={data} refresh={refresh} notify={notify} />
      <div className="asset-list">
        {data.assets.map((asset) => (
          <article className="asset-row" key={asset.id}>
            <div className="asset-code"><QrCode size={20} /><span>{asset.asset_code}</span></div>
            <div><strong>{asset.product_name || "منتج غير محدد"}</strong><span>{asset.customer_name || "لم يُربط بعميل"}</span></div>
            <div><span>{asset.location_label || "الموقع غير محدد"}</span><small>{asset.manufacturer_serial ? `رقم المصنع: ${asset.manufacturer_serial}` : "بدون رقم مصنع"}</small></div>
            <Badge tone={asset.status === "active" ? "success" : asset.status === "unassigned" ? "warn" : "muted"}>{statusText[asset.status] || asset.status}</Badge>
            <Button tone="muted" onClick={() => setSelected(asset)}>{asset.status === "unassigned" ? "تفعيل وربط" : "إدارة"}</Button>
          </article>
        ))}
        {!data.assets.length && <Empty title="لا توجد أجهزة أو ملصقات بعد" />}
      </div>
      {selected && <AssetDrawer asset={selected} data={data} close={() => setSelected(null)} refresh={refresh} notify={notify} />}
    </section>
  );
}

function ReplacementLinks({ data, refresh, notify }: { data: api.AssetWorkspace; refresh: () => Promise<void>; notify: (message: string, ok?: boolean) => void }) {
  const pending = data.replacement_links.filter((link) => link.status === "pending");
  const [choices, setChoices] = useState<Record<string, string>>({});
  if (!pending.length) return null;
  const select = async (link: Record<string, unknown> & { id: string }) => {
    const assetId = choices[link.id];
    if (!assetId) return notify("اختر الجهاز الذي رُكّب له المنتج", false);
    try { await api.selectReplacementAsset(link.id, assetId); notify("تم ربط المنتج بالجهاز وبدء موعده المستقل"); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "تعذّر ربط المنتج بالجهاز", false); }
  };
  return <section className="replacement-box" aria-labelledby="replacement-title"><h3 id="replacement-title">مشتريات تحتاج تحديد الجهاز</h3><p>يظهر هذا فقط عندما يملك العميل أكثر من جهاز متوافق أو لا توجد مطابقة تلقائية.</p>{pending.map((link) => { const candidateIds = Array.isArray(link.candidate_asset_ids) ? link.candidate_asset_ids.map(String) : []; const candidates = data.assets.filter((asset) => asset.customer_id === link.customer_id && asset.status === "active" && (!candidateIds.length || candidateIds.includes(asset.id))); return <article key={link.id}><div><strong>{String(link.product_name || "منتج استبدال")}</strong><span>{String(link.customer_name || "عميل")} — طلب {String(link.store_order_number || "")}</span></div><SelectInput aria-label={`الجهاز لمنتج ${String(link.product_name || "")}`} value={choices[link.id] || ""} onChange={(e) => setChoices((old) => ({ ...old, [link.id]: e.target.value }))}><option value="">اختر الجهاز أو الموقع</option>{candidates.map((asset) => <option key={asset.id} value={asset.id}>{asset.asset_code} — {asset.location_label || asset.product_name}</option>)}</SelectInput><Button onClick={() => select(link)}>ربط وبدء الموعد</Button></article>; })}</section>;
}

function AssetDrawer({ asset, data, close, refresh, notify }: { asset: api.CustomerAsset; data: api.AssetWorkspace; close: () => void; refresh: () => Promise<void>; notify: (message: string, ok?: boolean) => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [customerId, setCustomerId] = useState(asset.customer_id || "");
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [customerType, setCustomerType] = useState<"retail" | "wholesale" | "unknown">("unknown");
  const [productId, setProductId] = useState(asset.product_id || "");
  const [serial, setSerial] = useState(asset.manufacturer_serial || "");
  const [location, setLocation] = useState(asset.location_label || "");
  const [purchaseDate, setPurchaseDate] = useState(asset.purchase_date || today());
  const [installDate, setInstallDate] = useState(asset.installation_date || today());
  const [origin, setOrigin] = useState<"sold" | "legacy" | "external">(asset.origin || "sold");
  const [saving, setSaving] = useState(false);
  const activate = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true);
    try {
      await api.activateAsset(asset.id, { customer_id: customerId || undefined, customer_name: customerId ? undefined : customerName, customer_phone: customerId ? undefined : phone, customer_type: customerType, product_id: productId, manufacturer_serial: serial, location_label: location, purchase_date: purchaseDate, installation_date: installDate, origin });
      notify("تم تفعيل الجهاز وربطه بالعميل وإنشاء دورات الصيانة"); close(); await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "تعذّر تفعيل الجهاز", false); }
    finally { setSaving(false); }
  };
  const changeStatus = async (status: "active" | "paused" | "retired") => {
    try { await api.setAssetStatus(asset.id, status); notify("تم تحديث حالة الجهاز"); close(); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "تعذّر تحديث الجهاز", false); }
  };
  return <div className="asset-drawer-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}><aside className="asset-drawer" role="dialog" aria-modal="true" aria-labelledby="asset-drawer-title"><header><div><span className="asset-code-text">{asset.asset_code}</span><h2 ref={headingRef} tabIndex={-1} id="asset-drawer-title">{asset.status === "unassigned" ? "تفعيل الملصق عند التركيب" : "إدارة الجهاز"}</h2></div><Button tone="muted" onClick={close}>إغلاق</Button></header>{asset.status === "unassigned" ? <form className="form" onSubmit={activate}>
    <Field label="عميل مسجل (اختياري)"><SelectInput value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">عميل جديد — أدخل بياناته</option>{data.customers.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.phone}</option>)}</SelectInput></Field>
    {!customerId && <div className="form-grid"><Field label="اسم العميل"><TextInput required value={customerName} onChange={(e) => setCustomerName(e.target.value)} /></Field><Field label="رقم الجوال"><TextInput required inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field><Field label="نوع العميل"><SelectInput value={customerType} onChange={(e) => setCustomerType(e.target.value as typeof customerType)}><option value="unknown">غير محدد</option><option value="retail">أفراد</option><option value="wholesale">جملة</option></SelectInput></Field></div>}
    <Field label="المنتج المركّب"><SelectInput required value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">اختر المنتج</option>{data.products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.policy_active ? " — سياسة مفعلة" : ""}</option>)}</SelectInput></Field>
    <div className="form-grid"><Field label="رقم المصنع (اختياري)"><TextInput value={serial} onChange={(e) => setSerial(e.target.value)} /></Field><Field label="موقع الجهاز"><TextInput placeholder="المطبخ، الفرع الأول…" value={location} onChange={(e) => setLocation(e.target.value)} /></Field><Field label="تاريخ الفاتورة/الشراء"><TextInput type="date" required value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} /></Field><Field label="تاريخ التركيب"><TextInput type="date" required value={installDate} onChange={(e) => setInstallDate(e.target.value)} /></Field><Field label="مصدر الجهاز"><SelectInput value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)}><option value="sold">مباع من عندنا</option><option value="legacy">جهاز قديم</option><option value="external">جهاز خارجي</option></SelectInput></Field></div>
    <p className="form-note">الضمان — إن كان مفعلاً للمنتج — يبدأ من تاريخ الفاتورة. الجهاز القديم أو الخارجي يُسجّل بلا ضمان ما لم توجد فاتورة.</p>
    <Button type="submit" loading={saving}><PlayCircle size={16} /> تفعيل وربط الجهاز</Button>
  </form> : <div className="asset-manage"><dl><div><dt>العميل</dt><dd>{asset.customer_name}</dd></div><div><dt>المنتج</dt><dd>{asset.product_name}</dd></div><div><dt>التركيب</dt><dd>{fmtDate(asset.installation_date)}</dd></div><div><dt>الضمان</dt><dd>{asset.warranty_end ? `حتى ${fmtDate(asset.warranty_end)}` : "غير مسجل"}</dd></div></dl><div className="form-actions">{asset.status === "paused" ? <Button tone="success" onClick={() => changeStatus("active")}><PlayCircle size={16} /> استئناف</Button> : <Button tone="muted" onClick={() => changeStatus("paused")}><PauseCircle size={16} /> إيقاف التذكيرات</Button>}<Button tone="danger" onClick={() => changeStatus("retired")}>إخراج من الخدمة</Button></div><a className="asset-public-link" href={asset.public_url} target="_blank" rel="noreferrer">فتح رابط QR العام</a></div>}</aside></div>;
}

function CyclesPanel({ data, refresh, notify }: { data: api.AssetWorkspace; refresh: () => Promise<void>; notify: (message: string, ok?: boolean) => void }) {
  const open = data.cycles.filter((c) => !["completed", "cancelled", "paused"].includes(c.status));
  const complete = async (cycle: api.ServiceCycle) => {
    if (!window.confirm(`تأكيد إنجاز ${cycle.task_name} اليوم؟ سيبدأ الموعد التالي من تاريخ الإنجاز الفعلي.`)) return;
    try { await api.completeServiceCycle(cycle.id, today()); notify("تم إغلاق الدورة وإنشاء الموعد التالي"); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "تعذّر إكمال الصيانة", false); }
  };
  return <section className="asset-panel"><div className="asset-list">{open.map((cycle) => <article className="asset-row cycle-row" key={cycle.id}><div><strong>{cycle.task_name}</strong><span>{cycle.product_name || "منتج"} — {cycle.customer_name || "عميل"}</span></div><div><span>الموعد: {fmtDate(cycle.due_date)}</span><small>{typeof cycle.days_until === "number" && cycle.days_until < 0 ? `متأخرة ${Math.abs(cycle.days_until)} يوم` : `باقي ${cycle.days_until ?? 0} يوم`}</small></div><Badge tone={(cycle.computed_status || cycle.status) === "overdue" ? "danger" : "warn"}>{statusText[cycle.computed_status || cycle.status] || cycle.status}</Badge><Button tone="success" onClick={() => complete(cycle)}><CheckCircle2 size={16} /> تم التنفيذ</Button></article>)}{!open.length && <Empty title="لا توجد دورات صيانة مفتوحة" />}</div></section>;
}

function PoliciesPanel({ data, refresh, notify }: { data: api.AssetWorkspace; refresh: () => Promise<void>; notify: (message: string, ok?: boolean) => void }) {
  return <section className="asset-panel policy-grid">{data.products.map((product) => <PolicyCard key={product.id} product={product} refresh={refresh} notify={notify} />)}{!data.products.length && <Empty title="أضف منتجاً أولاً ثم فعّل سياسة الصيانة له" />}</section>;
}

function PolicyCard({ product, refresh, notify }: { product: api.Product; refresh: () => Promise<void>; notify: (message: string, ok?: boolean) => void }) {
  const [active, setActive] = useState(Boolean(product.policy_active));
  const [mode, setMode] = useState(product.service_mode || "asset_maintenance");
  const [compatibilityGroup, setCompatibilityGroup] = useState(product.compatibility_group || "");
  const [warranty, setWarranty] = useState(Boolean(product.warranty_enabled));
  const [warrantyMonths, setWarrantyMonths] = useState(product.warranty_months || 12);
  const makeTask = (index: number): api.ServiceTask => ({
    key: `task_${Date.now()}_${index}`,
    name: index ? `مهمة صيانة ${index + 1}` : "الصيانة الدورية",
    interval_value: product.interval_months || 3,
    interval_unit: "months",
    lead_days: 14,
    start_event: "installation",
    template: product.remind_text || "مرحباً {customer_name}، حان موعد {task_name} لجهازك {product_name}. {link}",
    media_type: "none",
    media_url: "",
    cta: "booking",
    active: true,
  });
  const [tasks, setTasks] = useState<api.ServiceTask[]>(() => {
    const stored = parseTasks(product);
    return stored.length ? stored : [makeTask(0)];
  });
  const [saving, setSaving] = useState(false);
  const updateTask = (index: number, patch: Partial<api.ServiceTask>) => setTasks((old) => old.map((task, i) => i === index ? { ...task, ...patch } : task));
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true);
    try {
      const normalizedTasks = tasks.map((task) => ({ ...task, cta: mode === "consumable_replacement" ? "reorder" as const : "booking" as const }));
      await api.updateProductServicePolicy(product.id, {
        policy_active: active,
        service_mode: mode,
        service_tasks: normalizedTasks,
        compatibility_group: compatibilityGroup,
        warranty_enabled: warranty,
        warranty_months: warranty ? warrantyMonths : 0,
        reminder_media_type: normalizedTasks[0]?.media_type || "none",
        reminder_media_url: normalizedTasks[0]?.media_url || "",
      });
      notify(`تم حفظ ${tasks.length} موعد مستقل لمنتج ${product.name}`);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "تعذّر حفظ السياسة", false); }
    finally { setSaving(false); }
  };
  return <form className="policy-card" onSubmit={save}>
    <header><div><h3>{product.name}</h3><span>{product.sku || "بدون SKU"}</span></div><label className="switch-label"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> تفعيل السياسة</label></header>
    <Field label="نوع المتابعة"><SelectInput value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="asset_maintenance">صيانة جهاز</option><option value="consumable_replacement">تبديل مستهلك/فلتر</option><option value="service">خدمة دورية</option><option value="none">بلا متابعة</option></SelectInput></Field>
    {(mode === "asset_maintenance" || mode === "consumable_replacement") && <Field label="مجموعة التوافق"><TextInput value={compatibilityGroup} onChange={(e) => setCompatibilityGroup(e.target.value)} placeholder="مثال: RO-5-STAGE" /></Field>}
    <div className="policy-tasks">
      {tasks.map((task, index) => <fieldset className="policy-task" key={task.key}>
        <legend>الموعد {index + 1}</legend>
        <div className="form-grid"><Field label="اسم المهمة"><TextInput required value={task.name} onChange={(e) => updateTask(index, { name: e.target.value })} /></Field><Field label="كل"><TextInput type="number" min={1} required value={task.interval_value} onChange={(e) => updateTask(index, { interval_value: Number(e.target.value) })} /></Field><Field label="الوحدة"><SelectInput value={task.interval_unit} onChange={(e) => updateTask(index, { interval_unit: e.target.value as "days" | "months" })}><option value="months">أشهر</option><option value="days">أيام</option></SelectInput></Field><Field label="التذكير قبل الموعد"><TextInput type="number" min={0} max={90} value={task.lead_days} onChange={(e) => updateTask(index, { lead_days: Number(e.target.value) })} /></Field></div>
        <Field label="قالب واتساب"><TextArea rows={3} value={task.template} onChange={(e) => updateTask(index, { template: e.target.value })} /></Field>
        <div className="form-grid"><Field label="المرفق"><SelectInput value={task.media_type} onChange={(e) => updateTask(index, { media_type: e.target.value as "none" | "image" | "video" })}><option value="none">نص فقط</option><option value="image">صورة مع النص</option><option value="video">فيديو مع النص</option></SelectInput></Field>{task.media_type !== "none" && <Field label="رابط HTTPS للمرفق"><TextInput type="url" required value={task.media_url} onChange={(e) => updateTask(index, { media_url: e.target.value })} /></Field>}</div>
        {tasks.length > 1 && <Button tone="danger" onClick={() => setTasks((old) => old.filter((_, i) => i !== index))}>حذف هذا الموعد</Button>}
      </fieldset>)}
    </div>
    <Button tone="muted" disabled={tasks.length >= 12} onClick={() => setTasks((old) => [...old, makeTask(old.length)])}>إضافة موعد صيانة آخر</Button>
    <label className="switch-label"><input type="checkbox" checked={warranty} onChange={(e) => setWarranty(e.target.checked)} /> ضمان محسوب من تاريخ الفاتورة</label>
    {warranty && <Field label="مدة الضمان بالأشهر"><TextInput type="number" min={1} max={60} value={warrantyMonths} onChange={(e) => setWarrantyMonths(Number(e.target.value))} /></Field>}
    <Button type="submit" loading={saving}>حفظ السياسة</Button>
  </form>;
}

function CampaignPanel({ data, refresh, notify }: { data: api.AssetWorkspace; refresh: () => Promise<void>; notify: (message: string, ok?: boolean) => void }) {
  const wholesale = data.customers.filter((c) => c.customer_type === "wholesale");
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("منتجات جديدة");
  const [message, setMessage] = useState("مرحباً {customer_name}، وصلتنا منتجات جديدة قد تناسب نشاطكم. تواصل معنا للتفاصيل.");
  const [mediaType, setMediaType] = useState<"none" | "image" | "video">("none");
  const [mediaUrl, setMediaUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const send = async (event: FormEvent) => { event.preventDefault(); if (!selected.length) return notify("اختر عميلاً واحداً على الأقل", false); if (!window.confirm(`إرسال الحملة الآن إلى ${selected.length} عميل؟`)) return; setSaving(true); try { const campaign = await api.createMarketingCampaign({ name, message, selected_customer_ids: selected, media_type: mediaType, media_url: mediaUrl }); const result = await api.sendMarketingCampaign(campaign.id); notify(`أُرسلت الحملة إلى ${result.sent} عميل، وتعذّر ${result.failed}`); setSelected([]); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "تعذّر إرسال الحملة", false); } finally { setSaving(false); } };
  return <section className="asset-panel campaign-layout"><form className="policy-card" onSubmit={send}><h3><MessageSquareText size={18} /> حملة يدوية لعملاء الجملة</h3><Field label="اسم الحملة"><TextInput required value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="الرسالة"><TextArea required rows={5} value={message} onChange={(e) => setMessage(e.target.value)} /></Field><div className="form-grid"><Field label="المرفق"><SelectInput value={mediaType} onChange={(e) => setMediaType(e.target.value as typeof mediaType)}><option value="none">نص فقط</option><option value="image">صورة مع النص</option><option value="video">فيديو مع النص</option></SelectInput></Field>{mediaType !== "none" && <Field label="رابط HTTPS للمرفق"><TextInput type="url" required value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} /></Field>}</div><div className="customer-checks"><div className="select-all"><strong>المستلمون</strong><button type="button" onClick={() => setSelected(selected.length === wholesale.length ? [] : wholesale.map((c) => c.id))}>{selected.length === wholesale.length ? "إلغاء الكل" : "اختيار الكل"}</button></div>{wholesale.map((customer) => <label key={customer.id}><input type="checkbox" checked={selected.includes(customer.id)} onChange={() => setSelected((old) => old.includes(customer.id) ? old.filter((id) => id !== customer.id) : [...old, customer.id])} /><span>{customer.name}<small>{customer.phone}</small></span></label>)}{!wholesale.length && <p className="form-note">لا يوجد عملاء مصنفون كجملة. عدّل نوع العميل من قسم العملاء.</p>}</div><Button type="submit" loading={saving}>إرسال الحملة المختارة</Button></form><div className="campaign-history"><h3>السجل</h3>{data.campaigns.map((campaign) => <article key={campaign.id}><strong>{String(campaign.name || "حملة")}</strong><span>{String(campaign.status || "draft")}</span></article>)}{!data.campaigns.length && <Empty title="لا توجد حملات سابقة" />}</div></section>;
}

function OdooImportPanel({ refresh, notify }: { refresh: () => Promise<void>; notify: (message: string, ok?: boolean) => void }) {
  const status = useData(api.getOdooExternalStatus);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [preview, setPreview] = useState<Array<Record<string, unknown>>>([]);
  const [busy, setBusy] = useState(false);
  const parseCsv = async (file?: File) => { if (!file) return; const text = await file.text(); const lines = text.split(/\r?\n/).filter(Boolean); const headers = (lines.shift() || "").split(",").map((v) => v.trim().replace(/^"|"$/g, "")); const parsed = lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [headers[index], value.trim().replace(/^"|"$/g, "")]))); setRows(parsed); setPreview([]); };
  const run = async (commit: boolean) => { if (!rows.length) return notify("اختر ملف CSV أولاً", false); setBusy(true); try { const result = await api.importOdooCustomers(rows, commit); setPreview(result.preview || []); notify(commit ? `تم إنشاء ${result.created} وتحديث ${result.updated} عميل` : `المعاينة جاهزة: ${result.preview.length} سجل`); if (commit) await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "تعذّر استيراد الملف", false); } finally { setBusy(false); } };
  const syncApi = async () => { setBusy(true); try { const result = await api.syncOdooCustomers(); notify(`جلب Odoo ${result.fetched} سجل: إنشاء ${result.created} وتحديث ${result.updated}`); await refresh(); } catch (error) { notify(error instanceof Error ? error.message : "تعذّرت مزامنة Odoo", false); } finally { setBusy(false); } };
  const headers = useMemo(() => preview.length ? Object.keys(preview[0]).slice(0, 6) : [], [preview]);
  return <section className="asset-panel odoo-panel"><div className="upload-box"><FileUp size={30} /><h3>استيراد عملاء أودو</h3><p>ارفع CSV يحتوي على الاسم والجوال، ويمكن أن يتضمن رقم أودو والمدينة ونوع العميل.</p><input aria-label="ملف CSV من أودو" type="file" accept=".csv,text/csv" onChange={(e) => parseCsv(e.target.files?.[0])} /><span>{rows.length ? `${rows.length} سجل جاهز` : "لم يُحدد ملف"}</span><div className="form-actions"><Button tone="muted" loading={busy} onClick={() => run(false)}>معاينة بلا حفظ</Button><Button loading={busy} onClick={() => run(true)}>اعتماد الاستيراد</Button></div><hr /><p>{status.data?.configured ? `اتصال API جاهز: ${status.data.database}` : "اتصال Odoo API غير مضبوط بعد"}</p><Button tone="success" loading={busy} disabled={!status.data?.configured} onClick={syncApi}>مزامنة العملاء عبر API</Button></div>{preview.length > 0 && <div className="table-scroll"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{preview.slice(0, 20).map((row, index) => <tr key={index}>{headers.map((header) => <td key={header}>{String(row[header] ?? "")}</td>)}</tr>)}</tbody></table></div>}</section>;
}
