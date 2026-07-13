import { ChevronLeft, ChevronRight, Plus, Search, Edit3, Trash2, Save, Filter } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
  fmtStoreOrderDateTime,
  moneyLabel,
  phoneLabel,
  useData,
  type ModalState,
} from "../shared";
import { usePrefixedUrlState, type UrlFilterSchema } from "../filterUrlState";

const CUSTOMER_PAGE_SIZE = 50;

type CustomerUrlFilters = {
  q: string;
  source: string;
  group: string;
  gender: string;
  country: string;
  city: string;
  status: string;
  activity: string;
  date_from: string;
  date_to: string;
  sort_by: string;
  sort_direction: string;
  page: string;
  page_size: string;
};

const CUSTOMER_URL_DEFAULTS: CustomerUrlFilters = {
  q: "",
  source: "",
  group: "",
  gender: "",
  country: "",
  city: "",
  status: "",
  activity: "",
  date_from: "",
  date_to: "",
  sort_by: "name",
  sort_direction: "asc",
  page: "1",
  page_size: String(CUSTOMER_PAGE_SIZE),
};

const CUSTOMER_URL_SCHEMA: UrlFilterSchema<CustomerUrlFilters> = {
  q: { type: "text", maxLength: 200, trim: false },
  source: { type: "text", maxLength: 120 },
  group: { type: "text", maxLength: 120 },
  gender: { type: "text", maxLength: 120 },
  country: { type: "text", maxLength: 120 },
  city: { type: "text", maxLength: 120 },
  status: { type: "enum", values: ["", "active", "blocked", "unknown"] },
  activity: { type: "enum", values: ["", "has_orders", "no_orders", "recent", "inactive"] },
  date_from: { type: "date" },
  date_to: { type: "date" },
  sort_by: { type: "enum", values: ["name", "created_at", "last_order_at", "orders_count", "total_spent"] },
  sort_direction: { type: "enum", values: ["asc", "desc"] },
  page: { type: "integer", minimum: 1, maximum: 10_000 },
  page_size: { type: "enum", values: ["25", "50", "100"] },
};

function facetLabel(option: api.FilterFacetOption) {
  return option.count === undefined ? option.label : `${option.label} (${option.count.toLocaleString("ar-SA")})`;
}

function CustomerFacetSelect({
  label,
  name,
  value,
  allLabel,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  allLabel: string;
  options?: api.FilterFacetOption[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="filter-group">
      <Field label={label}>
        <SelectInput name={name} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">{allLabel}</option>
          {(options || []).map((option) => (
            <option key={option.value} value={option.value}>{facetLabel(option)}</option>
          ))}
        </SelectInput>
      </Field>
    </div>
  );
}

function sourceLabel(source?: string) {
  if (source === "salla") return "سلة";
  if (source === "manual") return "يدوي";
  return source || "مصدر غير معروف";
}

function customerStatus(customer: api.Customer) {
  if (customer.is_blocked === true || customer.status === "blocked") return "blocked";
  if (customer.is_blocked === false || customer.status === "active") return "active";
  return "unknown";
}

function statusPresentation(status: string): { label: string; tone: "muted" | "danger" | "success" | "warn" } {
  if (status === "blocked") return { label: "محظور", tone: "danger" };
  if (status === "active") return { label: "نشط", tone: "success" };
  return { label: "حالة غير معروفة", tone: "muted" };
}

function customerActivity(customer: api.Customer) {
  if (customer.activity_status) return customer.activity_status;
  return Number(customer.orders_count || 0) > 0 ? "recent" : "no_orders";
}

function activityPresentation(activity: string): { label: string; tone: "muted" | "danger" | "success" | "warn" } {
  if (activity === "recent") return { label: "نشاط حديث", tone: "success" };
  if (activity === "inactive") return { label: "غير نشط", tone: "warn" };
  if (activity === "no_orders") return { label: "دون طلبات", tone: "muted" };
  return { label: activity || "نشاط غير معروف", tone: "muted" };
}

function customerDateLabel(value?: string | null) {
  return fmtStoreOrderDateTime(value, "Asia/Riyadh", value);
}

export default function CustomersPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const [urlFilters, setUrlFilters] = usePrefixedUrlState(
    "c",
    CUSTOMER_URL_DEFAULTS,
    CUSTOMER_URL_SCHEMA,
  );
  const [search, setSearch] = useState(urlFilters.q);
  const [debouncedSearch, setDebouncedSearch] = useState(urlFilters.q.trim());
  const [showFilters, setShowFilters] = useState(false);
  const firstFilterControlRef = useRef<HTMLSelectElement | null>(null);
  const page = Number(urlFilters.page) || 1;
  const pageSize = Number(urlFilters.page_size) || CUSTOMER_PAGE_SIZE;
  const dateRangeError = urlFilters.date_from && urlFilters.date_to && urlFilters.date_from > urlFilters.date_to
    ? "يجب أن يكون تاريخ بداية فتح الحساب قبل تاريخ النهاية أو مساويًا له."
    : "";
  const updateCustomerFilter = useCallback((key: keyof CustomerUrlFilters, value: string, resetPage = true) => {
    setUrlFilters((current) => ({
      ...current,
      [key]: value,
      ...(resetPage && key !== "page" ? { page: "1" } : {}),
    }));
  }, [setUrlFilters]);
  const customerQuery = useMemo<api.CustomerListOptions>(() => ({
    source: urlFilters.source,
    group: urlFilters.group,
    gender: urlFilters.gender,
    country: urlFilters.country,
    city: urlFilters.city,
    status: urlFilters.status,
    activity: urlFilters.activity,
    date_from: dateRangeError ? "" : urlFilters.date_from,
    date_to: dateRangeError ? "" : urlFilters.date_to,
    sort_by: urlFilters.sort_by,
    sort_direction: urlFilters.sort_direction as "asc" | "desc",
    page,
    pageSize,
  }), [dateRangeError, page, pageSize, urlFilters]);
  const customerQueryKey = useMemo(() => JSON.stringify(customerQuery), [customerQuery]);
  const customers = useData(
    () => api.getCustomers(debouncedSearch, customerQuery),
    [debouncedSearch, customerQueryKey],
  );

  useEffect(() => {
    if (urlFilters.q !== search) setSearch(urlFilters.q);
  }, [search, urlFilters.q]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const lastPage = customers.data?.totalPages;
    if (lastPage && page > lastPage) updateCustomerFilter("page", String(lastPage), false);
  }, [customers.data?.totalPages, page, updateCustomerFilter]);

  const activeCustomerFilterCount = useMemo(() => (
    (Object.keys(CUSTOMER_URL_DEFAULTS) as Array<keyof CustomerUrlFilters>).filter((key) =>
      key !== "q" && key !== "page" && urlFilters[key] !== CUSTOMER_URL_DEFAULTS[key]).length
  ), [urlFilters]);

  useEffect(() => {
    if (activeCustomerFilterCount > 0) setShowFilters(true);
  }, [activeCustomerFilterCount]);

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
      <section className="store-board">
        <div className="store-board-toolbar">
          <div className="toolbar compact">
            <Search size={16} />
            <TextInput
              aria-label="بحث العملاء"
              autoComplete="off"
              name="customer_search"
              placeholder="بحث بالاسم أو الجوال أو المدينة أو البريد أو رقم سلة…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                updateCustomerFilter("q", event.target.value);
              }}
            />
          </div>
          <button
            type="button"
            className={`btn ${showFilters ? "primary" : "muted"}`}
            aria-expanded={showFilters}
            aria-controls="customer-filters"
            onClick={() => setShowFilters((current) => {
              const next = !current;
              if (next) window.requestAnimationFrame(() => firstFilterControlRef.current?.focus());
              return next;
            })}
          >
            <Filter size={14} /> فلاتر متقدمة{activeCustomerFilterCount ? ` (${activeCustomerFilterCount.toLocaleString("ar-SA")})` : ""}
          </button>
        </div>

        {showFilters && (
          <div className="store-filters-bar" id="customer-filters" role="region" aria-label="فلاتر العملاء">
            <div className="filter-group">
              <Field label="مصدر العميل">
                <select
                  className="input"
                  ref={firstFilterControlRef}
                  name="customer_source_filter"
                  value={urlFilters.source}
                  onChange={(event) => updateCustomerFilter("source", event.target.value)}
                >
                  <option value="">كل المصادر</option>
                  {(customers.data?.facets.sources || []).map((option) => (
                    <option key={option.value} value={option.value}>{facetLabel({ ...option, label: sourceLabel(option.label) })}</option>
                  ))}
                </select>
              </Field>
            </div>
            <CustomerFacetSelect label="مجموعة العميل" name="customer_group_filter" value={urlFilters.group} allLabel="كل المجموعات" options={customers.data?.facets.groups} onChange={(value) => updateCustomerFilter("group", value)} />
            <CustomerFacetSelect label="الجنس" name="customer_gender_filter" value={urlFilters.gender} allLabel="كل الفئات" options={customers.data?.facets.genders} onChange={(value) => updateCustomerFilter("gender", value)} />
            <CustomerFacetSelect label="الدولة" name="customer_country_filter" value={urlFilters.country} allLabel="كل الدول" options={customers.data?.facets.countries} onChange={(value) => updateCustomerFilter("country", value)} />
            <CustomerFacetSelect label="المدينة" name="customer_city_filter" value={urlFilters.city} allLabel="كل المدن" options={customers.data?.facets.cities} onChange={(value) => updateCustomerFilter("city", value)} />
            <div className="filter-group">
              <Field label="حالة الحساب">
                <SelectInput name="customer_status_filter" value={urlFilters.status} onChange={(event) => updateCustomerFilter("status", event.target.value)}>
                  <option value="">كل الحالات</option>
                  <option value="active">نشط</option>
                  <option value="blocked">محظور</option>
                  <option value="unknown">غير معروف</option>
                </SelectInput>
              </Field>
            </div>
            <div className="filter-group">
              <Field label="نشاط الطلبات">
                <SelectInput name="customer_activity_filter" value={urlFilters.activity} onChange={(event) => updateCustomerFilter("activity", event.target.value)}>
                  <option value="">كل مستويات النشاط</option>
                  <option value="has_orders">لديه طلبات</option>
                  <option value="no_orders">دون طلبات</option>
                  <option value="recent">نشاط حديث</option>
                  <option value="inactive">غير نشط</option>
                </SelectInput>
              </Field>
            </div>
            <div className="filter-group">
              <Field label="فتح الحساب من">
                <TextInput
                  type="date"
                  name="customer_date_from"
                  autoComplete="off"
                  value={urlFilters.date_from}
                  max={urlFilters.date_to || undefined}
                  onChange={(event) => updateCustomerFilter("date_from", event.target.value)}
                />
              </Field>
            </div>
            <div className="filter-group">
              <Field label="فتح الحساب إلى">
                <TextInput
                  type="date"
                  name="customer_date_to"
                  autoComplete="off"
                  value={urlFilters.date_to}
                  min={urlFilters.date_from || undefined}
                  onChange={(event) => updateCustomerFilter("date_to", event.target.value)}
                />
              </Field>
            </div>
            <div className="filter-group">
              <Field label="ترتيب حسب">
                <SelectInput name="customer_sort_by" value={urlFilters.sort_by} onChange={(event) => updateCustomerFilter("sort_by", event.target.value)}>
                  <option value="name">الاسم</option>
                  <option value="created_at">تاريخ فتح الحساب</option>
                  <option value="last_order_at">آخر طلب</option>
                  <option value="orders_count">عدد الطلبات</option>
                  <option value="total_spent">إجمالي الإنفاق</option>
                </SelectInput>
              </Field>
            </div>
            <div className="filter-group">
              <Field label="اتجاه الترتيب">
                <SelectInput name="customer_sort_direction" value={urlFilters.sort_direction} onChange={(event) => updateCustomerFilter("sort_direction", event.target.value)}>
                  <option value="asc">تصاعدي</option>
                  <option value="desc">تنازلي</option>
                </SelectInput>
              </Field>
            </div>
            <div className="filter-group">
              <Field label="عدد العملاء في الصفحة">
                <SelectInput name="customer_page_size" value={urlFilters.page_size} onChange={(event) => updateCustomerFilter("page_size", event.target.value)}>
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </SelectInput>
              </Field>
            </div>
            <div className="filter-group filter-actions">
              <Button tone="muted" disabled={!activeCustomerFilterCount} onClick={() => setUrlFilters((current) => ({
                ...CUSTOMER_URL_DEFAULTS,
                q: current.q,
              }))}>إعادة تعيين الفلاتر</Button>
            </div>
            {dateRangeError && <p className="inline-error" role="alert" aria-live="polite">{dateRangeError}</p>}
          </div>
        )}

        {customers.data?.capped && (
          <div className="inline-error" role="status">
            عدد العملاء يتجاوز حد التصفح الآمن؛ تُعرض أول 10,000 نتيجة فقط حفاظًا على أداء النظام، وقد تكون مؤشرات الطلبات والنشاط جزئية إذا تجاوز سجل الطلبات حد المعالجة الآمن.
          </div>
        )}
        {customers.loading ? <Loading /> : customers.error ? <ErrorBlock message={customers.error} retry={customers.refresh} /> : (
          <div className="list">
            {(customers.data?.data || []).map((customer) => {
              const source = customer.store_provider || customer.source;
              const status = statusPresentation(customerStatus(customer));
              const activity = activityPresentation(customerActivity(customer));
              const accountOpenedAt = customer.remote_created_at || customer.remoteCreatedAt || customer.createdAt || customer.created_at;
              return (
                <article className="row-card" key={customer.id}>
                  <div className="row-main">
                    <strong>{customer.name}</strong>
                    <span>{phoneLabel(customer.phone)} · {customer.city || "بدون مدينة"}{customer.country ? ` · ${customer.country}` : ""}</span>
                    <div className="chips">
                      <Badge>{sourceLabel(source)}</Badge>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <Badge tone={activity.tone}>{activity.label}</Badge>
                    </div>
                    <p>
                      الطلبات: {(customer.orders_count || 0).toLocaleString("ar-SA")}
                      {" · "}الإنفاق: {moneyLabel(Number(customer.total_spent || 0))}
                      {" · "}آخر طلب: {customerDateLabel(customer.last_order_at)}
                      {" · "}فتح الحساب: {customerDateLabel(accountOpenedAt)}
                    </p>
                  </div>
                  <div className="row-actions">
                    <IconButton title="تعديل" onClick={() => openForm(customer)}><Edit3 size={15} /></IconButton>
                    <IconButton title="حذف" tone="danger" onClick={() => remove(customer)}><Trash2 size={15} /></IconButton>
                  </div>
                </article>
              );
            })}
            {!customers.data?.data.length && <Empty title="لا يوجد عملاء مطابقون للبحث أو الفلاتر" action={<Button onClick={() => openForm()}><Plus size={16} /> إضافة أول عميل</Button>} />}
            {Boolean(customers.data?.data.length) && (
              <nav className="panel-head" aria-label="التنقل بين صفحات العملاء">
                <span className="note" aria-live="polite">
                  صفحة {customers.data?.page || 1} من {customers.data?.totalPages || 1}
                  {" · "}
                  عرض {((customers.data?.page || 1) - 1) * (customers.data?.pageSize || pageSize) + 1}
                  -{Math.min(
                    (customers.data?.page || 1) * (customers.data?.pageSize || pageSize),
                    customers.data?.total || 0,
                  )} من {customers.data?.total || 0}
                </span>
                <div className="form-actions">
                  <Button
                    tone="muted"
                    disabled={!customers.data?.hasPrevious || customers.loading}
                    onClick={() => updateCustomerFilter("page", String(Math.max(1, page - 1)), false)}
                  >
                    <ChevronRight size={16} aria-hidden="true" /> السابق
                  </Button>
                  <Button
                    tone="muted"
                    disabled={!customers.data?.hasNext || customers.loading}
                    onClick={() => updateCustomerFilter("page", String(Math.min(customers.data?.totalPages || page + 1, page + 1)), false)}
                  >
                    التالي <ChevronLeft size={16} aria-hidden="true" />
                  </Button>
                </div>
              </nav>
            )}
          </div>
        )}
      </section>
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
