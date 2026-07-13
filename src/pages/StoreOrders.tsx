import { RefreshCcw, Search, UserRoundCog, Wrench, Save, Send, Filter, PencilLine } from "lucide-react";
import { useState, useCallback, useEffect, useMemo, useRef, type FormEvent } from "react";
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
  TextInput,
  fmtDate,
  fmtStoreOrderDateTime,
  storeOrderDateKey,
  journeyLabel,
  journeyTone,
  moneyLabel,
  phoneLabel,
  storeOrderTypeLabel,
  effectiveStoreOrderType,
  today,
  useData,
  type ModalState,
} from "../shared";
import { usePrefixedUrlState, type UrlFilterSchema } from "../filterUrlState";

const STORE_ORDER_TABS = [
  ["all", "الكل"],
  ["needs_review", "مراجعة"],
  ["awaiting_schedule", "بانتظار الجدولة"],
  ["booking_created", "محولة لفني"],
  ["sale_only", "بيع فقط"],
  ["install_maintenance", "تركيب"],
  ["maintenance_existing", "صيانة سابقة"],
  ["external_maintenance", "صيانة خارجية"],
] as const;

type StoreOrderUrlFilters = {
  q: string;
  tab: string;
  status: string;
  date_from: string;
  date_to: string;
  payment_method: string;
  shipping_company: string;
  shipment_status: string;
  country: string;
  city: string;
  sales_channel: string;
  assigned_employee: string;
  pickup_branch: string;
  tag: string;
  product: string;
  read_state: string;
  order_kind: string;
  min_total: string;
  max_total: string;
  sort_by: string;
  sort_direction: string;
  page: string;
  page_size: string;
};

const STORE_ORDER_URL_DEFAULTS: StoreOrderUrlFilters = {
  q: "",
  tab: "all",
  status: "",
  date_from: "",
  date_to: "",
  payment_method: "",
  shipping_company: "",
  shipment_status: "",
  country: "",
  city: "",
  sales_channel: "",
  assigned_employee: "",
  pickup_branch: "",
  tag: "",
  product: "",
  read_state: "",
  order_kind: "",
  min_total: "",
  max_total: "",
  sort_by: "order_created_at",
  sort_direction: "desc",
  page: "1",
  page_size: "50",
};

const STORE_ORDER_URL_SCHEMA: UrlFilterSchema<StoreOrderUrlFilters> = {
  q: { type: "text", maxLength: 200, trim: false },
  tab: { type: "enum", values: STORE_ORDER_TABS.map(([value]) => value) },
  status: { type: "text", maxLength: 120 },
  date_from: { type: "date" },
  date_to: { type: "date" },
  payment_method: { type: "text", maxLength: 120 },
  shipping_company: { type: "text", maxLength: 120 },
  shipment_status: { type: "text", maxLength: 120 },
  country: { type: "text", maxLength: 120 },
  city: { type: "text", maxLength: 120 },
  sales_channel: { type: "text", maxLength: 120 },
  assigned_employee: { type: "text", maxLength: 120 },
  pickup_branch: { type: "text", maxLength: 120 },
  tag: { type: "text", maxLength: 120 },
  product: { type: "text", maxLength: 200, trim: false },
  read_state: { type: "enum", values: ["", "read", "unread"] },
  order_kind: { type: "enum", values: ["", "order", "price_quote"] },
  min_total: { type: "decimal", minimum: 0 },
  max_total: { type: "decimal", minimum: 0 },
  sort_by: {
    type: "enum",
    values: ["order_created_at", "order_date", "remote_updated_at", "total", "order_number", "customer_name"],
  },
  sort_direction: { type: "enum", values: ["asc", "desc"] },
  page: { type: "integer", minimum: 1, maximum: 10_000 },
  page_size: { type: "enum", values: ["25", "50", "100"] },
};

function facetLabel(option: api.FilterFacetOption) {
  return option.count === undefined ? option.label : `${option.label} (${option.count.toLocaleString("ar-SA")})`;
}

function FacetFilterSelect({
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

export default function StoreOrdersPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const [urlFilters, setUrlFilters] = usePrefixedUrlState(
    "o",
    STORE_ORDER_URL_DEFAULTS,
    STORE_ORDER_URL_SCHEMA,
  );
  const [debouncedText, setDebouncedText] = useState(() => ({
    search: urlFilters.q.trim(),
    product: urlFilters.product.trim(),
    minTotal: urlFilters.min_total,
    maxTotal: urlFilters.max_total,
  }));
  const [showFilters, setShowFilters] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState("");
  const seenOrderIdsRef = useRef<Set<string>>(new Set());
  const realtimeCreatedIdsRef = useRef<Set<string>>(new Set());
  const refreshRequestSequenceRef = useRef(0);
  const bootstrappedRef = useRef(false);
  const firstFilterControlRef = useRef<HTMLSelectElement | null>(null);
  const filter = urlFilters.tab;
  const page = Number(urlFilters.page) || 1;
  const pageSize = Number(urlFilters.page_size) || 50;
  const journeyFilter = ["needs_review", "awaiting_schedule", "booking_created"].includes(filter)
    ? filter
    : "";
  const typeFilter = filter !== "all" && !journeyFilter ? filter : "";
  const totalRangeError = useMemo(() => {
    const minimum = urlFilters.min_total.trim() === "" ? undefined : Number(urlFilters.min_total);
    const maximum = urlFilters.max_total.trim() === "" ? undefined : Number(urlFilters.max_total);
    if (minimum !== undefined && (!Number.isFinite(minimum) || minimum < 0)) return "أدخل حدًا أدنى صحيحًا للقيمة.";
    if (maximum !== undefined && (!Number.isFinite(maximum) || maximum < 0)) return "أدخل حدًا أعلى صحيحًا للقيمة.";
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      return "يجب أن يكون الحد الأدنى للقيمة أقل من الحد الأعلى أو مساويًا له.";
    }
    return "";
  }, [urlFilters.max_total, urlFilters.min_total]);
  const dateRangeError = urlFilters.date_from && urlFilters.date_to && urlFilters.date_from > urlFilters.date_to
    ? "يجب أن يكون تاريخ البداية قبل تاريخ النهاية أو مساويًا له."
    : "";
  const updateOrderFilter = useCallback((key: keyof StoreOrderUrlFilters, value: string, resetPage = true) => {
    setUrlFilters((current) => ({
      ...current,
      [key]: value,
      ...(resetPage && key !== "page" ? { page: "1" } : {}),
    }));
  }, [setUrlFilters]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedText({
      search: urlFilters.q.trim(),
      product: urlFilters.product.trim(),
      minTotal: urlFilters.min_total,
      maxTotal: urlFilters.max_total,
    }), 300);
    return () => window.clearTimeout(timer);
  }, [urlFilters.max_total, urlFilters.min_total, urlFilters.product, urlFilters.q]);

  const minTotal = !totalRangeError && debouncedText.minTotal !== "" ? Number(debouncedText.minTotal) : undefined;
  const maxTotal = !totalRangeError && debouncedText.maxTotal !== "" ? Number(debouncedText.maxTotal) : undefined;
  const orderQuery = useMemo<api.StoreOrderListParams>(() => ({
    search: debouncedText.search,
    type: typeFilter,
    journey: journeyFilter,
    status: urlFilters.status,
    date_from: dateRangeError ? "" : urlFilters.date_from,
    date_to: dateRangeError ? "" : urlFilters.date_to,
    payment_method: urlFilters.payment_method,
    shipping_company: urlFilters.shipping_company,
    shipment_status: urlFilters.shipment_status,
    country: urlFilters.country,
    city: urlFilters.city,
    sales_channel: urlFilters.sales_channel,
    assigned_employee: urlFilters.assigned_employee,
    pickup_branch: urlFilters.pickup_branch,
    tag: urlFilters.tag,
    product: debouncedText.product,
    read_state: urlFilters.read_state,
    order_kind: urlFilters.order_kind,
    min_total: minTotal,
    max_total: maxTotal,
    sort_by: urlFilters.sort_by,
    sort_direction: urlFilters.sort_direction as "asc" | "desc",
    page,
    pageSize,
  }), [dateRangeError, debouncedText.product, debouncedText.search, journeyFilter, maxTotal, minTotal, page, pageSize, typeFilter, urlFilters]);
  const orderQueryKey = useMemo(() => JSON.stringify(orderQuery), [orderQuery]);
  const activeOrderQueryKeyRef = useRef(orderQueryKey);
  activeOrderQueryKeyRef.current = orderQueryKey;
  const orders = useData(
    () => api.getStoreOrders(orderQuery),
    [orderQueryKey],
  );
  const sallaStatuses = useData(api.getSallaOrderStatuses);
  const setOrderData = orders.setData;

  const openWorkflowForm = (order: api.StoreOrder, item?: api.StoreOrderItem) => {
    setModal({
      title: "إدارة بند الطلب",
      wide: true,
      content: (
        <StoreOrderWorkflowForm
          order={order}
          initialItemSku={item?.sku}
          onCancel={() => setModal(null)}
          onSaved={async (message) => {
            notify(message);
            setModal(null);
            await Promise.all([orders.refresh(), refreshStats()]);
          }}
          onError={(message) => notify(message, false)}
        />
      ),
    });
  };

  const openLinkForm = (order: api.StoreOrder) => {
    setModal({
      title: "ربط طلب صيانة بتركيب سابق",
      wide: true,
      content: (
        <StoreOrderLinkForm
          order={order}
          onCancel={() => setModal(null)}
          onSave={async (payload) => {
            try {
              await api.linkStoreOrderInstallation(order.id, payload);
              notify("تم ربط طلب الصيانة بالتركيب السابق");
              setModal(null);
              await Promise.all([orders.refresh(), refreshStats()]);
            } catch (error) {
              notify(error instanceof Error ? error.message : "تعذر ربط الطلب", false);
            }
          }}
        />
      ),
    });
  };

  const updateSeenOrders = useCallback((nextOrders: api.StoreOrder[], quiet = false) => {
    const nextIds = new Set(nextOrders.map((order) => order.id));
    const newOrders = nextOrders.filter((order) =>
      !seenOrderIdsRef.current.has(order.id) &&
      !realtimeCreatedIdsRef.current.has(order.id) &&
      !realtimeCreatedIdsRef.current.has(order.order_id),
    );

    if (bootstrappedRef.current && newOrders.length && !quiet) {
      notify(`وصل ${newOrders.length} طلب جديد من سلة`);
    }

    seenOrderIdsRef.current = nextIds;
    bootstrappedRef.current = true;
    setLastUpdated(new Date().toISOString());
  }, [notify]);

  const refreshOrders = useCallback(async (options: { sync?: boolean; background?: boolean } = {}) => {
    if (options.sync) setSyncing(true);
    if (!options.background && !options.sync) setRefreshing(true);

    try {
      if (options.sync) {
        const result = await api.syncSallaOrders();
        const products = result.products;
        const productSummary = products ? ` · المنتجات ${products.imported} جديد و${products.updated} محدث` : "";
        notify(`تحديث سلة انتهى: الطلبات ${result.imported} جديد، ${result.updated} محدث، ${result.failed} فشل${productSummary}`, result.failed === 0 && (!products || products.failed === 0));
      }

      const requestedOrderQueryKey = JSON.stringify(orderQuery);
      const requestSequence = ++refreshRequestSequenceRef.current;
      const nextOrders = await api.getStoreOrders(orderQuery);
      if (
        activeOrderQueryKeyRef.current !== requestedOrderQueryKey ||
        refreshRequestSequenceRef.current !== requestSequence
      ) return;
      setOrderData(nextOrders);
      const isUnfilteredFirstPage = page === 1 &&
        (Object.keys(STORE_ORDER_URL_DEFAULTS) as Array<keyof StoreOrderUrlFilters>)
          .every((key) => key === "page" || urlFilters[key] === STORE_ORDER_URL_DEFAULTS[key]);
      updateSeenOrders(nextOrders.data, !isUnfilteredFirstPage);

      if (!options.background || options.sync) {
        await refreshStats();
      }
    } catch (error) {
      if (!options.background) {
        notify(error instanceof Error ? error.message : "تعذر تحديث طلبات المتجر", false);
      }
    } finally {
      setSyncing(false);
      setRefreshing(false);
    }
  }, [notify, orderQuery, page, refreshStats, setOrderData, updateSeenOrders, urlFilters]);
  const refreshOrdersRef = useRef(refreshOrders);
  const realtimeRefreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    refreshOrdersRef.current = refreshOrders;
  }, [refreshOrders]);

  useEffect(() => {
    const unsubscribe = api.subscribeStoreOrderEvents((event) => {
      if (!event.type.startsWith("order.") && event.type !== "sync.completed") return;
      if (event.type === "order.created") {
        const orderKeys = [event.orderId, event.remoteOrderId].filter((value): value is string => Boolean(value));
        const alreadyNotified = orderKeys.some((key) => realtimeCreatedIdsRef.current.has(key));
        if (orderKeys.length && !alreadyNotified) {
          for (const key of orderKeys) realtimeCreatedIdsRef.current.add(key);
          if (event.orderId) seenOrderIdsRef.current.add(event.orderId);
          const visibleOrderNumber = event.remoteOrderId || event.orderId;
          notify(`وصل طلب جديد من سلة: ${visibleOrderNumber}`);
          while (realtimeCreatedIdsRef.current.size > 1_000) {
            const oldest = realtimeCreatedIdsRef.current.values().next().value;
            if (!oldest) break;
            realtimeCreatedIdsRef.current.delete(oldest);
          }
        }
      }
      if (realtimeRefreshTimerRef.current !== null) {
        window.clearTimeout(realtimeRefreshTimerRef.current);
      }
      realtimeRefreshTimerRef.current = window.setTimeout(() => {
        realtimeRefreshTimerRef.current = null;
        void refreshOrdersRef.current({ background: true });
      }, 500);
    });

    return () => {
      unsubscribe();
      if (realtimeRefreshTimerRef.current !== null) {
        window.clearTimeout(realtimeRefreshTimerRef.current);
        realtimeRefreshTimerRef.current = null;
      }
    };
  }, [notify]);

  useEffect(() => {
    if (!orders.data) return;
    updateSeenOrders(orders.data.data, true);
  }, [orders.data, updateSeenOrders]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void refreshOrders({ background: true });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refreshOrders]);

  const pageData = orders.data;
  const allOrders = pageData?.data || [];
  const facets = pageData?.facets;
  const activeSallaStatuses = useMemo(
    () => (sallaStatuses.data || []).filter((status) => status.is_active !== false && status.slug),
    [sallaStatuses.data],
  );
  const availableStatuses = useMemo(() => {
    const bySlug = new Map<string, api.SallaOrderStatus>();
    for (const status of activeSallaStatuses) {
      const slug = String(status.slug || "").trim();
      if (!slug) continue;
      bySlug.set(slug.toLocaleLowerCase("en"), { ...status, slug });
    }
    for (const option of facets?.statuses || []) {
      const slug = String(option.value || "").trim();
      const key = slug.toLocaleLowerCase("en");
      if (!slug || bySlug.has(key)) continue;
      bySlug.set(key, {
        id: `facet:${slug}`,
        slug,
        name: option.label || slug,
        is_active: true,
      });
    }
    return [...bySlug.values()];
  }, [activeSallaStatuses, facets?.statuses]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat("ar-SA"), []);
  const formatCount = useCallback((value: number) => numberFormatter.format(value), [numberFormatter]);
  const activeOrderFilterCount = useMemo(() => (
    (Object.keys(STORE_ORDER_URL_DEFAULTS) as Array<keyof StoreOrderUrlFilters>)
      .filter((key) => !["q", "tab", "page"].includes(key))
      .filter((key) => urlFilters[key] !== STORE_ORDER_URL_DEFAULTS[key]).length
  ), [urlFilters]);

  useEffect(() => {
    if (activeOrderFilterCount > 0) setShowFilters(true);
  }, [activeOrderFilterCount]);

  useEffect(() => {
    if (!pageData?.page || pageData.page === page) return;
    updateOrderFilter("page", String(pageData.page), false);
  }, [page, pageData?.page, updateOrderFilter]);

  const summary = useMemo(() => {
    const todayKey = storeOrderDateKey(new Date().toISOString(), "Asia/Riyadh");
    return {
      total: pageData?.total || 0,
      visible: allOrders.length,
      needsReview: allOrders.filter((order) => order.journey_status === "needs_review" || order.items?.some((item) => item.status === "needs_review")).length,
      currentPage: pageData?.page || 1,
      totalPages: pageData?.totalPages || 1,
      today: allOrders.filter((order) =>
        storeOrderDateKey(order.order_created_at, order.order_timezone, order.order_date) === todayKey).length,
    };
  }, [allOrders, pageData?.page, pageData?.total, pageData?.totalPages]);

  const storeOrderItemTotal = (item: api.StoreOrderItem) => {
    if (typeof item.total_price === "number" && Number.isFinite(item.total_price)) return item.total_price;
    if (typeof item.unit_price === "number" && Number.isFinite(item.unit_price)) {
      return item.unit_price * Number(item.quantity || 1);
    }
    return null;
  };

  const productsLabelDetailed = (order: api.StoreOrder) => {
    const items = order.items || [];
    if (!items.length) return "-";
    const visible = items.slice(0, 2).map((item) => {
      const total = storeOrderItemTotal(item);
      const price = total !== null ? ` - ${moneyLabel(total)}` : "";
      return `${item.name} x ${item.quantity}${price}`;
    });
    return items.length > 2 ? `${visible.join(" | ")} +${items.length - 2}` : visible.join(" | ");
  };

  const orderTotal = (order: api.StoreOrder) => {
    if (typeof order.total === "number" && Number.isFinite(order.total)) return order.total;
    const itemTotal = (order.items || []).reduce((sum, item) => sum + (storeOrderItemTotal(item) || 0), 0);
    return itemTotal > 0 ? itemTotal : null;
  };

  const orderTypeLabel = (order: api.StoreOrder) => {
    const types = Array.from(new Set((order.items || []).map((item) => effectiveStoreOrderType(item))));
    if (!types.length) return storeOrderTypeLabel(order.order_types?.[0]);
    return types.map(storeOrderTypeLabel).join("، ");
  };

  const remoteStatusLabel = (order: api.StoreOrder) => {
    const matched = availableStatuses.find((status) =>
      status.slug === order.remote_status_slug ||
      status.slug === order.status ||
      String(status.id) === String(order.remote_status_id || ""),
    );
    return {
      name: order.remote_status_name || matched?.name || order.status || order.external_status || "-",
      slug: order.remote_status_slug || matched?.slug || "",
    };
  };

  const openSallaStatusForm = (order: api.StoreOrder) => {
    if (sallaStatuses.loading) {
      notify("جاري تحميل حالات الطلب من سلة…");
      return;
    }
    if (sallaStatuses.error) {
      notify("تعذر تحميل حالات سلة. أعد المحاولة ثم افتح الطلب.", false);
      void sallaStatuses.refresh();
      return;
    }
    if (!activeSallaStatuses.length) {
      notify("لم ترجع سلة أي حالات نشطة يمكن اختيارها.", false);
      return;
    }

    setModal({
      title: `تحديث حالة الطلب ${order.order_number || order.order_id} في سلة`,
      content: (
        <StoreOrderStatusForm
          order={order}
          statuses={activeSallaStatuses}
          onCancel={() => setModal(null)}
          onSaved={async (message) => {
            notify(message);
            setModal(null);
            await Promise.all([orders.refresh(), refreshStats()]);
          }}
          onError={(message) => notify(message, false)}
        />
      ),
    });
  };

  const openSallaEditForm = (order: api.StoreOrder) => {
    setModal({
      title: `تعديل بيانات الطلب ${order.order_number || order.order_id} في سلة`,
      wide: true,
      content: (
        <StoreOrderEditForm
          order={order}
          onCancel={() => setModal(null)}
          onSaved={async (message) => {
            notify(message);
            setModal(null);
            await Promise.all([orders.refresh(), refreshStats()]);
          }}
          onError={(message) => notify(message, false)}
        />
      ),
    });
  };

  return (
    <>
      <PageHeader
        title="طلبات المتجر"
        subtitle="لوحة تشغيل يومية للطلبات القادمة من سلة: مراجعة، جدولة، وتحويل للفنيين"
        actions={
          <>
            <Button loading={syncing} onClick={() => refreshOrders({ sync: true })}><RefreshCcw size={16} /> تحديث فوري</Button>
            <Button tone="muted" loading={refreshing} onClick={() => refreshOrders()}><RefreshCcw size={16} /> تحديث الجدول</Button>
          </>
        }
      />

      <section className="ops-strip">
        <article className="ops-card">
          <strong>{formatCount(summary.total)}</strong>
          <span>نتيجة مطابقة</span>
        </article>
        <article className="ops-card danger">
          <strong>{formatCount(summary.needsReview)}</strong>
          <span>تحتاج مراجعة في الصفحة</span>
        </article>
        <article className="ops-card warn">
          <strong>{formatCount(summary.visible)}</strong>
          <span>معروضة في الصفحة</span>
        </article>
        <article className="ops-card success">
          <strong>{formatCount(summary.currentPage)} / {formatCount(summary.totalPages)}</strong>
          <span>رقم الصفحة</span>
        </article>
        <article className="ops-card">
          <strong>{formatCount(summary.today)}</strong>
          <span>وصلت اليوم في الصفحة</span>
        </article>
      </section>

      <section className="store-board">
        <div className="store-board-toolbar">
          <div className="toolbar compact">
            <Search size={16} />
            <TextInput
              aria-label="البحث في طلبات المتجر"
              autoComplete="off"
              name="store_order_search"
              placeholder="ابحث برقم الطلب، العميل، الجوال، المنتج أو SKU…"
              value={urlFilters.q}
              onChange={(event) => updateOrderFilter("q", event.target.value)}
            />
          </div>
          <button
            type="button"
            className={`btn ${showFilters ? "primary" : "muted"}`}
            aria-expanded={showFilters}
            aria-controls="store-order-filters"
            onClick={() => setShowFilters((current) => {
              const next = !current;
              if (next) window.requestAnimationFrame(() => firstFilterControlRef.current?.focus());
              return next;
            })}
          >
            <Filter size={14} /> فلاتر متقدمة{activeOrderFilterCount ? ` (${formatCount(activeOrderFilterCount)})` : ""}
          </button>
          <label className="toggle-control">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <span>تحقق احتياطي كل 60 ثانية</span>
          </label>
          <span className="sync-meta" aria-live="polite">{lastUpdated ? `آخر تحديث: ${fmtDate(lastUpdated)}` : "بانتظار أول تحديث"}</span>
        </div>

        {showFilters && (
          <div className="store-filters-bar" id="store-order-filters" role="region" aria-label="فلاتر طلبات المتجر">
            <div className="filter-group">
              <Field label="حالة الطلب في سلة">
                <select
                  className="input"
                  ref={firstFilterControlRef}
                  name="salla_status_filter"
                  value={urlFilters.status}
                  disabled={sallaStatuses.loading && !availableStatuses.length}
                  onChange={(event) => updateOrderFilter("status", event.target.value)}
                >
                  <option value="">كل حالات سلة</option>
                  {availableStatuses.map((status) => (
                    <option key={String(status.id)} value={status.slug}>{status.name}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="filter-group">
              <Field label="من تاريخ الطلب">
                <TextInput
                  type="date"
                  name="store_order_date_from"
                  autoComplete="off"
                  value={urlFilters.date_from}
                  max={urlFilters.date_to || undefined}
                  onChange={(event) => updateOrderFilter("date_from", event.target.value)}
                />
              </Field>
            </div>
            <div className="filter-group">
              <Field label="إلى تاريخ الطلب">
                <TextInput
                  type="date"
                  name="store_order_date_to"
                  autoComplete="off"
                  value={urlFilters.date_to}
                  min={urlFilters.date_from || undefined}
                  onChange={(event) => updateOrderFilter("date_to", event.target.value)}
                />
              </Field>
            </div>
            <FacetFilterSelect label="طريقة الدفع" name="store_order_payment_method" value={urlFilters.payment_method} allLabel="كل طرق الدفع" options={facets?.paymentMethods} onChange={(value) => updateOrderFilter("payment_method", value)} />
            <FacetFilterSelect label="شركة الشحن" name="store_order_shipping_company" value={urlFilters.shipping_company} allLabel="كل شركات الشحن" options={facets?.shippingCompanies} onChange={(value) => updateOrderFilter("shipping_company", value)} />
            <FacetFilterSelect label="حالة الشحنة" name="store_order_shipment_status" value={urlFilters.shipment_status} allLabel="كل حالات الشحنة" options={facets?.shipmentStatuses} onChange={(value) => updateOrderFilter("shipment_status", value)} />
            <FacetFilterSelect label="الدولة" name="store_order_country" value={urlFilters.country} allLabel="كل الدول" options={facets?.countries} onChange={(value) => updateOrderFilter("country", value)} />
            <FacetFilterSelect label="المدينة" name="store_order_city" value={urlFilters.city} allLabel="كل المدن" options={facets?.cities} onChange={(value) => updateOrderFilter("city", value)} />
            <FacetFilterSelect label="قناة البيع" name="store_order_sales_channel" value={urlFilters.sales_channel} allLabel="كل قنوات البيع" options={facets?.salesChannels} onChange={(value) => updateOrderFilter("sales_channel", value)} />
            <FacetFilterSelect label="الموظف" name="store_order_employee" value={urlFilters.assigned_employee} allLabel="كل الموظفين" options={facets?.employees} onChange={(value) => updateOrderFilter("assigned_employee", value)} />
            <FacetFilterSelect label="فرع الاستلام" name="store_order_pickup_branch" value={urlFilters.pickup_branch} allLabel="كل الفروع" options={facets?.pickupBranches} onChange={(value) => updateOrderFilter("pickup_branch", value)} />
            <FacetFilterSelect label="الوسم" name="store_order_tag" value={urlFilters.tag} allLabel="كل الوسوم" options={facets?.tags} onChange={(value) => updateOrderFilter("tag", value)} />
            <div className="filter-group">
              <Field label="المنتج أو رمز SKU">
                <TextInput
                  name="store_order_product_filter"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="اسم المنتج أو الرمز…"
                  value={urlFilters.product}
                  onChange={(event) => updateOrderFilter("product", event.target.value)}
                />
              </Field>
            </div>
            <div className="filter-group">
              <Field label="حالة القراءة">
                <SelectInput name="store_order_read_state" value={urlFilters.read_state} onChange={(event) => updateOrderFilter("read_state", event.target.value)}>
                  <option value="">المقروءة وغير المقروءة</option>
                  <option value="unread">غير مقروءة</option>
                  <option value="read">مقروءة</option>
                </SelectInput>
              </Field>
            </div>
            <div className="filter-group">
              <Field label="نوع الطلب">
                <SelectInput name="store_order_kind" value={urlFilters.order_kind} onChange={(event) => updateOrderFilter("order_kind", event.target.value)}>
                  <option value="">كل الطلبات</option>
                  <option value="order">طلب عادي</option>
                  <option value="price_quote">عرض سعر</option>
                </SelectInput>
              </Field>
            </div>
            <div className="filter-group">
              <Field label="الحد الأدنى للقيمة">
                <TextInput
                  type="number"
                  inputMode="decimal"
                  name="store_order_min_total_filter"
                  autoComplete="off"
                  min="0"
                  step="0.01"
                  placeholder="مثال: 100…"
                  value={urlFilters.min_total}
                  onChange={(event) => updateOrderFilter("min_total", event.target.value)}
                />
              </Field>
            </div>
            <div className="filter-group">
              <Field label="الحد الأعلى للقيمة">
                <TextInput
                  type="number"
                  inputMode="decimal"
                  name="store_order_max_total_filter"
                  autoComplete="off"
                  min="0"
                  step="0.01"
                  placeholder="مثال: 1,000…"
                  value={urlFilters.max_total}
                  onChange={(event) => updateOrderFilter("max_total", event.target.value)}
                />
              </Field>
            </div>
            <div className="filter-group">
              <Field label="ترتيب حسب">
                <SelectInput name="store_order_sort_by" value={urlFilters.sort_by} onChange={(event) => updateOrderFilter("sort_by", event.target.value)}>
                  <option value="order_created_at">تاريخ الطلب ووقته</option>
                  <option value="order_date">تاريخ الطلب</option>
                  <option value="remote_updated_at">آخر تحديث</option>
                  <option value="order_number">رقم الطلب</option>
                  <option value="customer_name">اسم العميل</option>
                  <option value="total">إجمالي الطلب</option>
                </SelectInput>
              </Field>
            </div>
            <div className="filter-group">
              <Field label="اتجاه الترتيب">
                <SelectInput name="store_order_sort_direction" value={urlFilters.sort_direction} onChange={(event) => updateOrderFilter("sort_direction", event.target.value)}>
                  <option value="desc">الأحدث أو الأعلى أولًا</option>
                  <option value="asc">الأقدم أو الأقل أولًا</option>
                </SelectInput>
              </Field>
            </div>
            <div className="filter-group">
              <Field label="عدد الطلبات في الصفحة">
                <SelectInput
                  name="store_order_page_size"
                  value={urlFilters.page_size}
                  onChange={(event) => updateOrderFilter("page_size", event.target.value)}
                >
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </SelectInput>
              </Field>
            </div>
            <div className="filter-group filter-actions">
              <Button tone="muted" disabled={!activeOrderFilterCount} onClick={() => setUrlFilters((current) => ({
                ...STORE_ORDER_URL_DEFAULTS,
                q: current.q,
                tab: current.tab,
              }))}>إعادة تعيين الفلاتر</Button>
            </div>
            {totalRangeError && <p className="inline-error" role="alert" aria-live="polite">{totalRangeError}</p>}
            {dateRangeError && <p className="inline-error" role="alert" aria-live="polite">{dateRangeError}</p>}
            {sallaStatuses.error && (
              <div className="filter-group filter-actions">
                <Button tone="muted" onClick={() => sallaStatuses.refresh()}>إعادة تحميل حالات سلة</Button>
              </div>
            )}
          </div>
        )}

        <div className="tabs table-tabs">
          {STORE_ORDER_TABS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? "active" : ""}
              aria-pressed={filter === value}
              onClick={() => updateOrderFilter("tab", value)}
            >
              {label} {filter === value && <b>{formatCount(summary.total)}</b>}
            </button>
          ))}
        </div>

        {orders.loading ? <Loading /> : orders.error ? <ErrorBlock message={orders.error} retry={() => refreshOrders()} /> : (
          <div className="orders-table-wrap">
            <table className="orders-table">
              <thead>
                <tr>
                  <th aria-label="تحديد"></th>
                  <th>رقم الطلب</th>
                  <th>تاريخ الطلب</th>
                  <th>العميل</th>
                  <th>المدينة</th>
                  <th>المنتجات</th>
                  <th>القيمة</th>
                  <th>حالة سلة</th>
                  <th>نوع الرحلة</th>
                  <th>الموعد</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {allOrders.map((order) => {
                  const needsReview = order.journey_status === "needs_review" || order.items?.some((item) => item.status === "needs_review");
                  const sallaStatus = remoteStatusLabel(order);
                  const total = orderTotal(order);
                  return (
                    <tr key={order.id} className={needsReview ? "row-needs-review" : ""}>
                      <td><input type="checkbox" aria-label={`تحديد الطلب ${order.order_number || order.order_id}`} /></td>
                      <td>
                        <div className="order-id-cell">
                          <strong>{order.order_number || order.order_id}</strong>
                          <Badge tone={journeyTone(order.journey_status)}>{journeyLabel(order.journey_status)}</Badge>
                        </div>
                      </td>
                      <td>
                        <time dateTime={order.order_created_at || order.order_date || undefined}>
                          {fmtStoreOrderDateTime(order.order_created_at, order.order_timezone, order.order_date)}
                        </time>
                      </td>
                      <td>
                        <div className="order-customer-cell">
                          <strong>{order.customer_name || "-"}</strong>
                          <span>{phoneLabel(order.customer_phone)}</span>
                        </div>
                      </td>
                      <td>{order.customer_city || <span className="muted">-</span>}</td>
                      <td>
                        <div className="order-products-cell">
                          <span>{productsLabelDetailed(order)}</span>
                        </div>
                      </td>
                      <td><strong className="money-val">{moneyLabel(total)}</strong></td>
                      <td>
                        <div className="order-customer-cell">
                          <span className="salla-status">{sallaStatus.name}</span>
                          {sallaStatus.slug && <small translate="no">{sallaStatus.slug}</small>}
                        </div>
                      </td>
                      <td>{orderTypeLabel(order)}</td>
                      <td>{order.scheduled_date ? `${fmtDate(order.scheduled_date)} ${order.scheduled_time || ""}` : "غير مجدول"}</td>
                      <td>
                        <div className="table-actions">
                          <Button
                            tone="muted"
                            disabled={sallaStatuses.loading}
                            onClick={() => openSallaStatusForm(order)}
                          >
                            <RefreshCcw size={16} /> حالة سلة
                          </Button>
                          <Button tone="muted" onClick={() => openSallaEditForm(order)}>
                            <PencilLine size={16} /> تعديل بيانات سلة
                          </Button>
                          <Button tone="muted" onClick={() => openWorkflowForm(order)}><UserRoundCog size={16} /> إدارة</Button>
                          {needsReview && <Button tone="success" onClick={() => openLinkForm(order)}><Wrench size={16} /> ربط</Button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!allOrders.length && <Empty title="لا توجد طلبات مطابقة لهذا البحث أو الفلتر" />}
            {pageData?.capped && (
              <div className="inline-error" role="status">
                نتائج التصفح محدودة بأول 10,000 طلب متاح. استخدم البحث أو الفلاتر للوصول إلى الطلب المطلوب بدقة.
              </div>
            )}
            {pageData && pageData.totalPages > 1 && (
              <nav className="form-actions" aria-label="التنقل بين صفحات طلبات المتجر">
                <Button
                  tone="muted"
                  disabled={!pageData.hasPrevious || orders.loading}
                  onClick={() => updateOrderFilter("page", String(Math.max(1, page - 1)), false)}
                >
                  الصفحة السابقة
                </Button>
                <span className="sync-meta" aria-live="polite">
                  الصفحة {formatCount(pageData.page)} من {formatCount(pageData.totalPages)} · {formatCount(pageData.total)} طلب
                </span>
                <Button
                  tone="muted"
                  disabled={!pageData.hasNext || orders.loading}
                  onClick={() => updateOrderFilter("page", String(Math.min(pageData.totalPages, page + 1)), false)}
                >
                  الصفحة التالية
                </Button>
              </nav>
            )}
          </div>
        )}
      </section>
    </>
  );
}

type SallaShippingForm = {
  deliveryMethod: string;
  branchId: string;
  courierId: string;
  country: string;
  city: string;
  addressLine: string;
  streetNumber: string;
  block: string;
  shortAddress: string;
  buildingNumber: string;
  additionalNumber: string;
  postalCode: string;
  latitude: string;
  longitude: string;
};

const emptySallaShippingForm = (): SallaShippingForm => ({
  deliveryMethod: "",
  branchId: "",
  courierId: "",
  country: "",
  city: "",
  addressLine: "",
  streetNumber: "",
  block: "",
  shortAddress: "",
  buildingNumber: "",
  additionalNumber: "",
  postalCode: "",
  latitude: "",
  longitude: "",
});

function StoreOrderEditForm({
  order,
  onSaved,
  onError,
  onCancel,
}: {
  order: api.StoreOrder;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const [editCustomer, setEditCustomer] = useState(false);
  const [customer, setCustomer] = useState({ id: "", name: "", mobile: "", email: "" });
  const [editReceiver, setEditReceiver] = useState(false);
  const [receiver, setReceiver] = useState({
    name: "",
    countryCode: "",
    phone: "",
    email: "",
    notify: false,
  });
  const [couponCode, setCouponCode] = useState("");
  const [employeeIds, setEmployeeIds] = useState("");
  const [editPayment, setEditPayment] = useState(false);
  const [payment, setPayment] = useState({
    status: "",
    method: "",
    storeBankId: "",
    receiptImagePath: "",
    acceptedMethods: "",
    cashAmount: "",
    cashCurrency: "SAR",
  });
  const [editShipping, setEditShipping] = useState(false);
  const [shipping, setShipping] = useState<SallaShippingForm>(emptySallaShippingForm);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);

  const clearConfirmation = () => {
    setAcknowledged(false);
    setError("");
  };

  const updateReceiver = (key: keyof typeof receiver, value: string | boolean) => {
    setReceiver((current) => ({ ...current, [key]: value }));
    clearConfirmation();
  };

  const updateCustomer = (key: keyof typeof customer, value: string) => {
    setCustomer((current) => ({ ...current, [key]: value }));
    clearConfirmation();
  };

  const updatePayment = (key: keyof typeof payment, value: string) => {
    setPayment((current) => ({ ...current, [key]: value }));
    clearConfirmation();
  };

  const updateShipping = (key: keyof SallaShippingForm, value: string) => {
    setShipping((current) => ({ ...current, [key]: value }));
    clearConfirmation();
  };

  const fail = (message: string) => {
    setError(message);
    window.requestAnimationFrame(() => errorRef.current?.focus());
  };

  const parseOptionalPositiveId = (raw: string, label: string) => {
    if (!raw.trim()) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${label} يجب أن يكون رقمًا صحيحًا موجبًا.`);
    }
    return value;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    const payload: api.SallaOrderUpdatePayload = {};

    if (editCustomer) {
      try {
        const customerId = parseOptionalPositiveId(customer.id, "معرّف العميل في سلة");
        const values = {
          ...(customerId === undefined ? {} : { id: customerId }),
          ...(customer.name.trim() ? { name: customer.name.trim() } : {}),
          ...(customer.mobile.trim() ? { mobile: customer.mobile.trim() } : {}),
          ...(customer.email.trim() ? { email: customer.email.trim() } : {}),
        };
        if (!Object.keys(values).length) throw new Error("أدخل معلومة واحدة على الأقل للعميل.");
        if (values.mobile && !/^\+?[0-9]{5,30}$/.test(values.mobile)) {
          throw new Error("جوال العميل يجب أن يحتوي أرقامًا فقط مع علامة + اختيارية في البداية.");
        }
        if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
          throw new Error("أدخل بريدًا إلكترونيًا صحيحًا للعميل.");
        }
        payload.customer = values;
      } catch (validationError) {
        fail(validationError instanceof Error ? validationError.message : "تحقق من بيانات العميل.");
        return;
      }
    }

    if (editReceiver) {
      const receiverValues = {
        name: receiver.name.trim(),
        country_code: receiver.countryCode.trim(),
        phone: receiver.phone.trim(),
        email: receiver.email.trim(),
      };
      if (!Object.values(receiverValues).some(Boolean)) {
        fail("أدخل معلومة واحدة على الأقل للمستلم، أو أوقف قسم تعديل المستلم.");
        return;
      }
      if (receiverValues.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receiverValues.email)) {
        fail("أدخل بريدًا إلكترونيًا صحيحًا للمستلم.");
        return;
      }
      payload.receiver = {
        ...Object.fromEntries(Object.entries(receiverValues).filter(([, value]) => value)) as api.SallaOrderReceiverUpdate,
        notify: receiver.notify,
      };
    }

    if (couponCode.trim()) payload.coupon_code = couponCode.trim();

    if (employeeIds.trim()) {
      const tokens = employeeIds.split(/[,،\s]+/).filter(Boolean);
      const ids = tokens.map(Number);
      if (!tokens.length || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        fail("أدخل أرقام موظفين صحيحة وموجبة، مفصولة بفواصل.");
        return;
      }
      payload.employees = Array.from(new Set(ids));
    }

    if (editPayment) {
      try {
        const bankId = parseOptionalPositiveId(payment.storeBankId, "معرّف حساب البنك في سلة");
        const acceptedMethods = payment.acceptedMethods.split(/[,،\s]+/).map((value) => value.trim()).filter(Boolean);
        const paymentPayload: NonNullable<api.SallaOrderUpdatePayload["payment"]> = {
          ...(payment.status.trim() ? { status: payment.status.trim() } : {}),
          ...(payment.method.trim() ? { method: payment.method.trim() } : {}),
          ...(bankId === undefined ? {} : { store_bank_id: bankId }),
          ...(payment.receiptImagePath.trim() ? { receipt_image_path: payment.receiptImagePath.trim() } : {}),
          ...(acceptedMethods.length ? { accepted_methods: Array.from(new Set(acceptedMethods)) } : {}),
        };
        if (payment.cashAmount.trim() || payment.cashCurrency.trim() !== "SAR") {
          const amount = Number(payment.cashAmount);
          if (!Number.isFinite(amount) || amount < 0) throw new Error("مبلغ الدفع عند الاستلام يجب أن يكون صفرًا أو أكبر.");
          if (!/^[A-Za-z]{3,12}$/.test(payment.cashCurrency.trim())) throw new Error("عملة الدفع عند الاستلام غير صحيحة.");
          paymentPayload.cash_on_delivery = { amount, currency: payment.cashCurrency.trim().toUpperCase() };
        }
        if (!Object.keys(paymentPayload).length) throw new Error("أدخل معلومة دفع واحدة على الأقل.");
        payload.payment = paymentPayload;
      } catch (validationError) {
        fail(validationError instanceof Error ? validationError.message : "تحقق من بيانات الدفع.");
        return;
      }
    }

    if (editShipping) {
      const requiredAddressFields = [
        ["الدولة", shipping.country],
        ["المدينة", shipping.city],
        ["سطر العنوان", shipping.addressLine],
        ["رقم الشارع", shipping.streetNumber],
        ["الحي أو المربع", shipping.block],
        ["العنوان المختصر", shipping.shortAddress],
        ["رقم المبنى", shipping.buildingNumber],
        ["الرقم الإضافي", shipping.additionalNumber],
        ["الرمز البريدي", shipping.postalCode],
        ["خط العرض", shipping.latitude],
        ["خط الطول", shipping.longitude],
      ] as const;
      const missing = requiredAddressFields.filter(([, value]) => !value.trim()).map(([label]) => label);
      if (missing.length) {
        fail(`أكمل جميع حقول العنوان الوطني قبل الإرسال: ${missing.join("، ")}.`);
        return;
      }

      const latitude = Number(shipping.latitude);
      const longitude = Number(shipping.longitude);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        fail("خط العرض يجب أن يكون رقمًا بين -90 و90.");
        return;
      }
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        fail("خط الطول يجب أن يكون رقمًا بين -180 و180.");
        return;
      }

      try {
        if (shipping.deliveryMethod.trim()) payload.delivery_method = shipping.deliveryMethod.trim();
        payload.branch_id = parseOptionalPositiveId(shipping.branchId, "رقم الفرع");
        payload.courier_id = parseOptionalPositiveId(shipping.courierId, "رقم شركة الشحن");
        const countryId = parseOptionalPositiveId(shipping.country, "معرّف الدولة في سلة");
        const cityId = parseOptionalPositiveId(shipping.city, "معرّف المدينة في سلة");
        if (countryId === undefined || cityId === undefined) {
          throw new Error("معرّف الدولة ومعرّف المدينة في سلة مطلوبان.");
        }
        payload.ship_to = {
          country: countryId,
          city: cityId,
          address_line: shipping.addressLine.trim(),
          street_number: shipping.streetNumber.trim(),
          block: shipping.block.trim(),
          short_address: shipping.shortAddress.trim(),
          building_number: shipping.buildingNumber.trim(),
          additional_number: shipping.additionalNumber.trim(),
          postal_code: shipping.postalCode.trim(),
          geo_coordinates: { lat: latitude, lng: longitude },
        };
      } catch (validationError) {
        fail(validationError instanceof Error ? validationError.message : "تحقق من أرقام الشحن.");
        return;
      }

      if (payload.branch_id === undefined) delete payload.branch_id;
      if (payload.courier_id === undefined) delete payload.courier_id;
    }

    if (!Object.keys(payload).length) {
      fail("أدخل تعديلًا واحدًا على الأقل قبل الإرسال إلى سلة.");
      return;
    }
    if (!acknowledged) {
      fail("أكد فهم أثر التعديل قبل إرساله إلى سلة.");
      return;
    }

    setSaving(true);
    try {
      const result = await api.updateSallaOrder(order.id, payload);
      await onSaved(result.changed === false
        ? "البيانات مطابقة مسبقًا؛ تم تحديث نسخة الطلب في البرنامج."
        : "تم تعديل بيانات الطلب في سلة وتحديث نسخة البرنامج.");
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "تعذر تعديل بيانات الطلب في سلة.";
      fail(`${message} تحقق من حالة الطلب وقيود سلة ثم أعد المحاولة.`);
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" aria-busy={saving} noValidate onSubmit={submit}>
      <div className="cards-grid">
        <article className="mini-card">
          <strong>الطلب</strong>
          <span>{order.order_number || order.order_id}</span>
          <p>{order.customer_name || "عميل سلة"}</p>
        </article>
        <article className="mini-card">
          <strong>الحالة الحالية</strong>
          <span>{order.remote_status_name || order.status || "غير معروفة"}</span>
          <p>يمكن لسلة رفض بعض التعديلات بحسب حالة الطلب.</p>
        </article>
      </div>

      <section aria-labelledby="salla-customer-heading">
        <h3 id="salla-customer-heading">حساب العميل</h3>
        <label className="field checkbox-field">
          <span>تعديل حساب العميل المرتبط بالطلب في سلة</span>
          <input
            type="checkbox"
            name="edit_salla_customer"
            checked={editCustomer}
            disabled={saving}
            onChange={(event) => {
              setEditCustomer(event.target.checked);
              clearConfirmation();
            }}
          />
        </label>
        {editCustomer && (
          <>
            <p className="sync-meta">تسمح سلة بهذا التعديل للضيف أو عندما لا يكون حساب عميل ثابت مرتبطًا بالطلب.</p>
            <div className="form-grid">
              <Field label="معرّف العميل في سلة">
                <TextInput type="number" inputMode="numeric" min="1" step="1" name="salla_customer_id" autoComplete="off" placeholder="رقم العميل…" value={customer.id} disabled={saving} onChange={(event) => updateCustomer("id", event.target.value)} />
              </Field>
              <Field label="اسم العميل">
                <TextInput name="salla_customer_name" autoComplete="off" placeholder="اسم العميل…" value={customer.name} disabled={saving} onChange={(event) => updateCustomer("name", event.target.value)} />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="جوال العميل">
                <TextInput type="tel" inputMode="tel" name="salla_customer_mobile" autoComplete="off" placeholder="05xxxxxxxx…" value={customer.mobile} disabled={saving} onChange={(event) => updateCustomer("mobile", event.target.value)} />
              </Field>
              <Field label="بريد العميل">
                <TextInput type="email" name="salla_customer_email" autoComplete="off" spellCheck={false} placeholder="customer@example.com…" value={customer.email} disabled={saving} onChange={(event) => updateCustomer("email", event.target.value)} />
              </Field>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="salla-receiver-heading">
        <h3 id="salla-receiver-heading">بيانات المستلم</h3>
        <label className="field checkbox-field">
          <span>تعديل بيانات المستلم في سلة</span>
          <input
            type="checkbox"
            name="edit_salla_receiver"
            checked={editReceiver}
            disabled={saving}
            onChange={(event) => {
              setEditReceiver(event.target.checked);
              clearConfirmation();
            }}
          />
        </label>
        {editReceiver && (
          <>
            <div className="form-grid">
              <Field label="اسم المستلم">
                <TextInput
                  name="salla_receiver_name"
                  autoComplete="off"
                  placeholder="مثال: محمد أحمد…"
                  value={receiver.name}
                  disabled={saving}
                  onChange={(event) => updateReceiver("name", event.target.value)}
                />
              </Field>
              <Field label="رمز الدولة">
                <TextInput
                  name="salla_receiver_country_code"
                  autoComplete="off"
                  inputMode="tel"
                  placeholder="مثال: SA…"
                  value={receiver.countryCode}
                  disabled={saving}
                  onChange={(event) => updateReceiver("countryCode", event.target.value)}
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="جوال المستلم">
                <TextInput
                  type="tel"
                  name="salla_receiver_phone"
                  autoComplete="off"
                  inputMode="tel"
                  placeholder="مثال: 05xxxxxxxx…"
                  value={receiver.phone}
                  disabled={saving}
                  onChange={(event) => updateReceiver("phone", event.target.value)}
                />
              </Field>
              <Field label="بريد المستلم">
                <TextInput
                  type="email"
                  name="salla_receiver_email"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="مثال: customer@example.com…"
                  value={receiver.email}
                  disabled={saving}
                  onChange={(event) => updateReceiver("email", event.target.value)}
                />
              </Field>
            </div>
            <label className="field checkbox-field">
              <span>السماح لسلة بإشعار المستلم بهذا التعديل</span>
              <input
                type="checkbox"
                name="salla_receiver_notify"
                checked={receiver.notify}
                disabled={saving}
                onChange={(event) => updateReceiver("notify", event.target.checked)}
              />
            </label>
          </>
        )}
      </section>

      <section aria-labelledby="salla-assignment-heading">
        <h3 id="salla-assignment-heading">الكوبون والموظفون</h3>
        <div className="form-grid">
          <Field label="رمز الكوبون">
            <TextInput
              name="salla_coupon_code"
              autoComplete="off"
              spellCheck={false}
              placeholder="اتركه فارغًا لعدم التعديل…"
              value={couponCode}
              disabled={saving}
              onChange={(event) => {
                setCouponCode(event.target.value);
                clearConfirmation();
              }}
            />
          </Field>
          <Field label="أرقام الموظفين">
            <TextInput
              name="salla_employee_ids"
              autoComplete="off"
              inputMode="numeric"
              placeholder="مثال: 12, 27, 31…"
              value={employeeIds}
              disabled={saving}
              onChange={(event) => {
                setEmployeeIds(event.target.value);
                clearConfirmation();
              }}
            />
          </Field>
        </div>
      </section>

      <section aria-labelledby="salla-payment-heading">
        <h3 id="salla-payment-heading">بيانات الدفع</h3>
        <label className="field checkbox-field">
          <span>تعديل بيانات الدفع في سلة</span>
          <input
            type="checkbox"
            name="edit_salla_payment"
            checked={editPayment}
            disabled={saving}
            onChange={(event) => {
              setEditPayment(event.target.checked);
              clearConfirmation();
            }}
          />
        </label>
        {editPayment && (
          <>
            <p className="sync-meta">تسمح سلة بتغيير الدفع فقط ما دام الدفع قيد الانتظار. استخدم القيم والمعرّفات المعتمدة في متجرك.</p>
            <div className="form-grid">
              <Field label="حالة الدفع">
                <TextInput name="salla_payment_status" autoComplete="off" placeholder="مثال: pending…" value={payment.status} disabled={saving} onChange={(event) => updatePayment("status", event.target.value)} />
              </Field>
              <Field label="طريقة الدفع">
                <TextInput name="salla_payment_method" autoComplete="off" placeholder="طريقة الدفع في سلة…" value={payment.method} disabled={saving} onChange={(event) => updatePayment("method", event.target.value)} />
              </Field>
              <Field label="معرّف حساب البنك في سلة">
                <TextInput type="number" inputMode="numeric" min="1" step="1" name="salla_store_bank_id" autoComplete="off" placeholder="رقم الحساب…" value={payment.storeBankId} disabled={saving} onChange={(event) => updatePayment("storeBankId", event.target.value)} />
              </Field>
            </div>
            <Field label="مسار صورة إيصال الدفع">
              <TextInput name="salla_receipt_image_path" autoComplete="off" spellCheck={false} placeholder="المسار المعتمد لدى سلة…" value={payment.receiptImagePath} disabled={saving} onChange={(event) => updatePayment("receiptImagePath", event.target.value)} />
            </Field>
            <Field label="طرق الدفع المقبولة">
              <TextInput name="salla_accepted_methods" autoComplete="off" placeholder="مفصولة بفواصل…" value={payment.acceptedMethods} disabled={saving} onChange={(event) => updatePayment("acceptedMethods", event.target.value)} />
            </Field>
            <div className="form-grid">
              <Field label="مبلغ الدفع عند الاستلام">
                <TextInput type="number" inputMode="decimal" min="0" step="any" name="salla_cod_amount" autoComplete="off" placeholder="0.00…" value={payment.cashAmount} disabled={saving} onChange={(event) => updatePayment("cashAmount", event.target.value)} />
              </Field>
              <Field label="عملة الدفع عند الاستلام">
                <TextInput name="salla_cod_currency" autoComplete="off" spellCheck={false} placeholder="SAR" value={payment.cashCurrency} disabled={saving} onChange={(event) => updatePayment("cashCurrency", event.target.value)} />
              </Field>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="salla-shipping-heading">
        <h3 id="salla-shipping-heading">الشحن والعنوان الوطني</h3>
        <label className="field checkbox-field">
          <span>تعديل بيانات الشحن والعنوان الوطني في سلة</span>
          <input
            type="checkbox"
            name="edit_salla_shipping"
            checked={editShipping}
            disabled={saving}
            onChange={(event) => {
              setEditShipping(event.target.checked);
              clearConfirmation();
            }}
          />
        </label>
        {editShipping && (
          <>
            <p className="sync-meta">عند تفعيل هذا القسم يجب تعبئة جميع حقول العنوان الوطني. طريقة التوصيل والفرع وشركة الشحن اختيارية.</p>
            <div className="form-grid">
              <Field label="طريقة التوصيل">
                <TextInput
                  name="salla_delivery_method"
                  autoComplete="off"
                  placeholder="مثال: courier…"
                  value={shipping.deliveryMethod}
                  disabled={saving}
                  onChange={(event) => updateShipping("deliveryMethod", event.target.value)}
                />
              </Field>
              <Field label="رقم الفرع">
                <TextInput
                  type="number"
                  inputMode="numeric"
                  name="salla_branch_id"
                  autoComplete="off"
                  min="1"
                  step="1"
                  placeholder="رقم موجب…"
                  value={shipping.branchId}
                  disabled={saving}
                  onChange={(event) => updateShipping("branchId", event.target.value)}
                />
              </Field>
              <Field label="رقم شركة الشحن">
                <TextInput
                  type="number"
                  inputMode="numeric"
                  name="salla_courier_id"
                  autoComplete="off"
                  min="1"
                  step="1"
                  placeholder="رقم موجب…"
                  value={shipping.courierId}
                  disabled={saving}
                  onChange={(event) => updateShipping("courierId", event.target.value)}
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="معرّف الدولة في سلة *">
                <TextInput type="number" inputMode="numeric" min="1" step="1" name="salla_ship_country" autoComplete="off" placeholder="رقم الدولة في سلة…" value={shipping.country} disabled={saving} aria-required="true" onChange={(event) => updateShipping("country", event.target.value)} />
              </Field>
              <Field label="معرّف المدينة في سلة *">
                <TextInput type="number" inputMode="numeric" min="1" step="1" name="salla_ship_city" autoComplete="off" placeholder="رقم المدينة في سلة…" value={shipping.city} disabled={saving} aria-required="true" onChange={(event) => updateShipping("city", event.target.value)} />
              </Field>
            </div>
            <Field label="سطر العنوان *">
              <TextInput name="salla_ship_address_line" autoComplete="off" placeholder="اسم الشارع ووصف الموقع…" value={shipping.addressLine} disabled={saving} aria-required="true" onChange={(event) => updateShipping("addressLine", event.target.value)} />
            </Field>
            <div className="form-grid">
              <Field label="رقم الشارع *">
                <TextInput name="salla_ship_street_number" autoComplete="off" inputMode="numeric" placeholder="مثال: 25…" value={shipping.streetNumber} disabled={saving} aria-required="true" onChange={(event) => updateShipping("streetNumber", event.target.value)} />
              </Field>
              <Field label="الحي أو المربع *">
                <TextInput name="salla_ship_block" autoComplete="off" placeholder="مثال: حي العليا…" value={shipping.block} disabled={saving} aria-required="true" onChange={(event) => updateShipping("block", event.target.value)} />
              </Field>
              <Field label="العنوان المختصر *">
                <TextInput name="salla_ship_short_address" autoComplete="off" spellCheck={false} placeholder="مثال: RRAA1234…" value={shipping.shortAddress} disabled={saving} aria-required="true" onChange={(event) => updateShipping("shortAddress", event.target.value)} />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="رقم المبنى *">
                <TextInput name="salla_ship_building_number" autoComplete="off" inputMode="numeric" placeholder="مثال: 1234…" value={shipping.buildingNumber} disabled={saving} aria-required="true" onChange={(event) => updateShipping("buildingNumber", event.target.value)} />
              </Field>
              <Field label="الرقم الإضافي *">
                <TextInput name="salla_ship_additional_number" autoComplete="off" inputMode="numeric" placeholder="مثال: 5678…" value={shipping.additionalNumber} disabled={saving} aria-required="true" onChange={(event) => updateShipping("additionalNumber", event.target.value)} />
              </Field>
              <Field label="الرمز البريدي *">
                <TextInput name="salla_ship_postal_code" autoComplete="off" inputMode="numeric" placeholder="مثال: 12345…" value={shipping.postalCode} disabled={saving} aria-required="true" onChange={(event) => updateShipping("postalCode", event.target.value)} />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="خط العرض *">
                <TextInput type="number" inputMode="decimal" name="salla_ship_latitude" autoComplete="off" min="-90" max="90" step="any" placeholder="مثال: 24.7136…" value={shipping.latitude} disabled={saving} aria-required="true" onChange={(event) => updateShipping("latitude", event.target.value)} />
              </Field>
              <Field label="خط الطول *">
                <TextInput type="number" inputMode="decimal" name="salla_ship_longitude" autoComplete="off" min="-180" max="180" step="any" placeholder="مثال: 46.6753…" value={shipping.longitude} disabled={saving} aria-required="true" onChange={(event) => updateShipping("longitude", event.target.value)} />
              </Field>
            </div>
          </>
        )}
      </section>

      <div className="inline-error" role="note">
        هذا الإجراء يرسل التعديل مباشرة إلى سلة. قد يتأثر حساب العميل أو المستلم أو الدفع أو الشحن أو رسائل العميل، وقد ترفض سلة التعديل بحسب حالة الطلب.
      </div>
      <label className="field checkbox-field">
        <span>تحققت من البيانات وأفهم أن التعديل سيؤثر في طلب سلة الحقيقي</span>
        <input
          type="checkbox"
          name="acknowledge_salla_order_edit"
          checked={acknowledged}
          disabled={saving}
          onChange={(event) => {
            setAcknowledged(event.target.checked);
            setError("");
          }}
        />
      </label>

      {error && <p ref={errorRef} className="inline-error" role="alert" aria-live="polite" tabIndex={-1}>{error}</p>}

      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> حفظ التعديلات في سلة</Button>
        <Button tone="muted" disabled={saving} onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}

function StoreOrderStatusForm({
  order,
  statuses,
  onSaved,
  onError,
  onCancel,
}: {
  order: api.StoreOrder;
  statuses: api.SallaOrderStatus[];
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const matchedCurrentStatus = statuses.find((status) =>
    status.slug === order.remote_status_slug ||
    status.slug === order.status ||
    String(status.id) === String(order.remote_status_id || ""),
  );
  const currentSlug = order.remote_status_slug || matchedCurrentStatus?.slug || "";
  const currentName = order.remote_status_name || matchedCurrentStatus?.name || order.status || order.external_status || "غير معروفة";
  const [nextStatusKey, setNextStatusKey] = useState(matchedCurrentStatus ? String(matchedCurrentStatus.id) : "");
  const [restoreItems, setRestoreItems] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const nextStatus = statuses.find((status) => String(status.id) === nextStatusKey);
  const unchanged = Boolean(nextStatus && (
    String(nextStatus.id) === String(order.remote_status_id || "") ||
    (currentSlug && nextStatus.slug === currentSlug)
  ));
  const isRestoreTransition = /restor/i.test(nextStatus?.slug || "");
  const isCustomStatus = Boolean(nextStatus && (
    String(nextStatus.type || "").toLowerCase() === "custom" ||
    nextStatus.original ||
    nextStatus.parent
  ));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!nextStatus) {
      setError("اختر الحالة الجديدة من قائمة الحالات القادمة من سلة.");
      return;
    }
    if (unchanged) {
      setError("الحالة المختارة هي الحالة الحالية. اختر حالة مختلفة.");
      return;
    }
    if (!acknowledged) {
      setError("أكد فهم أثر التحديث قبل الإرسال إلى سلة.");
      return;
    }
    if (isCustomStatus && (!Number.isSafeInteger(Number(nextStatus.id)) || Number(nextStatus.id) <= 0)) {
      setError("معرّف الحالة المخصصة القادم من سلة غير صالح.");
      return;
    }

    setSaving(true);
    try {
      const common = isRestoreTransition ? { restore_items: restoreItems } : {};
      const result = isCustomStatus
        ? await api.updateSallaOrderStatus(order.id, {
            status_id: Number(nextStatus.id),
            ...common,
          })
        : await api.updateSallaOrderStatus(order.id, {
            slug: nextStatus.slug,
            ...common,
          });
      await onSaved(result.changed === false
        ? "حالة الطلب في سلة مطابقة مسبقاً؛ تم تحديث نسخة البرنامج."
        : `تم تحديث حالة الطلب في سلة إلى «${nextStatus.name}».`);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "تعذر تحديث حالة الطلب في سلة.";
      setError(`${message} تحقق من صلاحية الطلب والحالة ثم أعد المحاولة.`);
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" aria-busy={saving} onSubmit={submit}>
      <div className="cards-grid">
        <article className="mini-card">
          <strong>الطلب</strong>
          <span>{order.order_number || order.order_id}</span>
          <p>{order.customer_name || "عميل سلة"}</p>
        </article>
        <article className="mini-card">
          <strong>الحالة الحالية في سلة</strong>
          <span>{currentName}</span>
          <p translate="no">{currentSlug || "—"}</p>
        </article>
      </div>

      <Field label="الحالة الجديدة في سلة">
        <SelectInput
          name="salla_order_status"
          value={nextStatusKey}
          disabled={saving}
          onChange={(event) => {
            setNextStatusKey(event.target.value);
            setAcknowledged(false);
            setError("");
          }}
        >
          <option value="">اختر الحالة…</option>
          {statuses.map((status) => (
            <option key={String(status.id)} value={String(status.id)}>{status.name}</option>
          ))}
        </SelectInput>
      </Field>

      {isRestoreTransition && (
        <label className="field checkbox-field">
          <span>إعادة أصناف الطلب إلى المخزون عند الاستعادة</span>
          <input
            type="checkbox"
            name="salla_restore_items"
            checked={restoreItems}
            disabled={saving}
            onChange={(event) => {
              setRestoreItems(event.target.checked);
              setAcknowledged(false);
            }}
          />
        </label>
      )}

      <div className="inline-error" role="note">
        هذا التعديل يُرسل مباشرة إلى سلة، وقد يشغّل رسائل العميل أو إجراءات الدفع والشحن المرتبطة بالحالة. لا تغيّرها إلا بعد التحقق من الطلب.
      </div>

      <label className="field checkbox-field">
        <span>أفهم أن التغيير سيظهر في سلة وبرنامج إدارة العملاء</span>
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={!nextStatus || unchanged || saving}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
      </label>

      {error && <p className="inline-error" role="alert" aria-live="polite">{error}</p>}

      <div className="form-actions">
        <Button type="submit" loading={saving} disabled={!nextStatus || unchanged || !acknowledged}>
          <Save size={16} /> تحديث الحالة في سلة
        </Button>
        <Button tone="muted" disabled={saving} onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}

function StoreOrderWorkflowForm({
  order,
  initialItemSku,
  onSaved,
  onError,
  onCancel,
}: {
  order: api.StoreOrder;
  initialItemSku?: string;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const technicians = useData(api.getTechnicians);
  const installations = useData(api.getInstallations);
  const items = order.items || [];
  const [itemSku, setItemSku] = useState(initialItemSku || items[0]?.sku || "");
  const selectedItem = useMemo(
    () => items.find((item) => item.sku === itemSku) || items[0],
    [items, itemSku],
  );
  const reviewCandidates = useMemo(
    () =>
      (installations.data || []).filter(
        (installation) => installation.status === "active" && installation.customer_phone === order.customer_phone,
      ),
    [installations.data, order.customer_phone],
  );
  const [manualType, setManualType] = useState<api.StoreItemType>(effectiveStoreOrderType(selectedItem) as api.StoreItemType);
  const [technicianId, setTechnicianId] = useState("");
  const [scheduledDate, setScheduledDate] = useState(order.scheduled_date || today());
  const [scheduledTime, setScheduledTime] = useState(order.scheduled_time || "10:00");
  const [installationId, setInstallationId] = useState("");
  const [sendNow, setSendNow] = useState(true);
  const [savingMode, setSavingMode] = useState<"classify" | "assign" | "">("");

  useEffect(() => {
    setManualType(effectiveStoreOrderType(selectedItem) as api.StoreItemType);
    setInstallationId("");
  }, [selectedItem?.sku]);

  useEffect(() => {
    if (!technicianId && technicians.data?.[0]) setTechnicianId(technicians.data[0].id);
  }, [technicianId, technicians.data]);

  useEffect(() => {
    if (!installationId && reviewCandidates[0] && manualType === "maintenance_existing") {
      setInstallationId(reviewCandidates[0].id);
    }
  }, [installationId, manualType, reviewCandidates]);

  const handleClassify = async () => {
    if (!selectedItem) return;
    setSavingMode("classify");
    try {
      if (manualType === "maintenance_existing" && !selectedItem.installation_id && installationId) {
        await api.linkStoreOrderInstallation(order.id, { installationId, itemSku: selectedItem.sku });
      }
      await api.classifyStoreOrderItem(order.id, { itemSku: selectedItem.sku, manualType });
      await onSaved("تم حفظ تصنيف بند الطلب");
    } catch (error) {
      onError(error instanceof Error ? error.message : "تعذر حفظ التصنيف");
    } finally {
      setSavingMode("");
    }
  };

  const handleAssign = async () => {
    if (!selectedItem) return;
    setSavingMode("assign");
    try {
      if (manualType === "maintenance_existing" && !selectedItem.installation_id && installationId) {
        await api.linkStoreOrderInstallation(order.id, { installationId, itemSku: selectedItem.sku });
      }
      await api.classifyStoreOrderItem(order.id, { itemSku: selectedItem.sku, manualType });
      const result = await api.assignStoreOrderTechnician(order.id, {
        itemSku: selectedItem.sku,
        technicianId,
        scheduledDate,
        scheduledTime,
        sendNow,
      });
      await onSaved(sendNow && result.notification ? "تم تحويل الطلب إلى الفني وإرسال الموعد له" : "تم تحويل الطلب إلى الفني وحفظ الحجز");
    } catch (error) {
      onError(error instanceof Error ? error.message : "تعذر تحويل الطلب إلى الفني");
    } finally {
      setSavingMode("");
    }
  };

  const selectedItemTotal =
    selectedItem && typeof selectedItem.total_price === "number"
      ? selectedItem.total_price
      : selectedItem && typeof selectedItem.unit_price === "number"
        ? selectedItem.unit_price * Number(selectedItem.quantity || 1)
        : null;
  const workflowOrderTotal =
    typeof order.total === "number" && Number.isFinite(order.total)
      ? order.total
      : (order.items || []).reduce((sum, item) => {
          if (typeof item.total_price === "number" && Number.isFinite(item.total_price)) return sum + item.total_price;
          if (typeof item.unit_price === "number" && Number.isFinite(item.unit_price)) {
            return sum + item.unit_price * Number(item.quantity || 1);
          }
          return sum;
        }, 0) || null;

  if (technicians.loading || installations.loading) return <Loading />;
  if (!selectedItem) return <Empty title="لا يوجد بند متاح داخل هذا الطلب" />;
  if (!technicians.data?.length) return <Empty title="أضف فنيًا واحدًا على الأقل قبل تحويل الطلب إليه" />;

  return (
    <form className="form" onSubmit={(event) => event.preventDefault()}>
      <div className="cards-grid">
        <article className="mini-card">
          <strong>الطلب</strong>
          <span>{order.order_number || order.order_id}</span>
          <p>{order.customer_name} · {phoneLabel(order.customer_phone)}</p>
        </article>
        <article className="mini-card">
          <strong>قيمة الطلب</strong>
          <span>{moneyLabel(workflowOrderTotal)}</span>
          <p>{fmtStoreOrderDateTime(order.order_created_at, order.order_timezone, order.order_date)}</p>
        </article>
        <article className="mini-card">
          <strong>الحالة الحالية</strong>
          <span>{journeyLabel(order.journey_status)}</span>
          <p>{selectedItem.reason || "البند جاهز للتنفيذ اليدوي."}</p>
        </article>
      </div>
      <Field label="بند الطلب">
        <SelectInput value={itemSku} onChange={(e) => setItemSku(e.target.value)}>
          {items.map((item) => (
            <option key={`${item.sku}-${item.name}`} value={item.sku}>
              {item.name} · الكمية {item.quantity} · {item.sku}
            </option>
          ))}
        </SelectInput>
      </Field>
      <div className="chips">
        {selectedItemTotal !== null && <Badge>{moneyLabel(selectedItemTotal)}</Badge>}
        <Badge>النوع الحالي: {storeOrderTypeLabel(effectiveStoreOrderType(selectedItem))}</Badge>
        {selectedItem.detected_type && <Badge tone="warn">التلقائي: {storeOrderTypeLabel(selectedItem.detected_type)}</Badge>}
        <Badge tone={journeyTone(selectedItem.status)}>رحلة البند: {journeyLabel(selectedItem.status)}</Badge>
      </div>
      <Field label="تصنيف البند">
        <SelectInput value={manualType} onChange={(e) => setManualType(e.target.value as api.StoreItemType)}>
          <option value="sale_only">بيع فقط</option>
          <option value="install_maintenance">منتج جديد يحتاج تركيب وصيانة</option>
          <option value="maintenance_existing">صيانة لمنتج سابق</option>
          <option value="external_maintenance">صيانة جهاز خارجي</option>
          <option value="needs_review">يحتاج مراجعة</option>
        </SelectInput>
      </Field>
      {manualType === "maintenance_existing" && !selectedItem.installation_id && (
        <Field label="التركيب السابق">
          <SelectInput value={installationId} onChange={(e) => setInstallationId(e.target.value)}>
            {reviewCandidates.map((installation) => (
              <option key={installation.id} value={installation.id}>
                {installation.customer_name} - {installation.product_name} - {installation.product_sku || installation.product_id}
              </option>
            ))}
          </SelectInput>
        </Field>
      )}
      {manualType !== "sale_only" && manualType !== "needs_review" && (
        <>
          <div className="form-grid">
            <Field label="الفني">
              <SelectInput value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
                {(technicians.data || []).map((tech) => (
                  <option key={tech.id} value={tech.id}>{tech.name} - {phoneLabel(tech.phone)}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="التاريخ">
              <TextInput type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
            </Field>
          </div>
          <div className="form-grid">
            <Field label="الوقت">
              <TextInput type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} />
            </Field>
            <label className="field checkbox-field">
              <span>إرسال الموعد للفني مباشرة</span>
              <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} />
            </label>
          </div>
        </>
      )}
      <div className="form-actions">
        <Button type="button" loading={savingMode === "classify"} onClick={handleClassify}>
          <Save size={16} /> حفظ التصنيف
        </Button>
        {manualType !== "sale_only" && manualType !== "needs_review" && (
          <Button type="button" tone="success" loading={savingMode === "assign"} onClick={handleAssign}>
            <Send size={16} /> تحويل إلى الفني
          </Button>
        )}
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}

function StoreOrderLinkForm({
  order,
  onSave,
  onCancel,
}: {
  order: api.StoreOrder;
  onSave: (payload: { installationId: string; itemSku?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const installations = useData(api.getInstallations);
  const reviewableItems = (order.items || []).filter((item) => item.status === "needs_review" || item.order_type === "maintenance_existing");
  const [itemSku, setItemSku] = useState(reviewableItems[0]?.sku || "");
  const [installationId, setInstallationId] = useState("");
  const [saving, setSaving] = useState(false);

  const candidates = useMemo(
    () =>
      (installations.data || []).filter(
        (item) =>
          item.status === "active" &&
          (!order.customer_phone || item.customer_phone === order.customer_phone),
      ),
    [installations.data, order.customer_phone],
  );

  useEffect(() => {
    if (!installationId && candidates[0]) setInstallationId(candidates[0].id);
  }, [installationId, candidates]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!installationId) return;
    setSaving(true);
    try {
      await onSave({ installationId, itemSku: itemSku || undefined });
    } finally {
      setSaving(false);
    }
  };

  if (installations.loading) return <Loading />;
  if (!candidates.length) return <Empty title="لا يوجد تركيب نشط بنفس رقم جوال العميل. أضف التركيب أو صحح رقم العميل ثم أعد الربط." />;

  return (
    <form className="form" onSubmit={submit}>
      <Field label="بند الطلب">
        <SelectInput value={itemSku} onChange={(e) => setItemSku(e.target.value)}>
          {reviewableItems.map((item) => (
            <option key={`${item.sku}-${item.order_type}`} value={item.sku}>{item.name} - {item.sku}</option>
          ))}
        </SelectInput>
      </Field>
      <Field label="التركيب السابق">
        <SelectInput value={installationId} onChange={(e) => setInstallationId(e.target.value)}>
          {candidates.map((installation) => (
            <option key={installation.id} value={installation.id}>
              {installation.customer_name} - {installation.product_name} - {installation.product_sku || installation.product_id}
            </option>
          ))}
        </SelectInput>
      </Field>
      <div className="form-actions">
        <Button type="submit" loading={saving}><Save size={16} /> ربط</Button>
        <Button tone="muted" onClick={onCancel}>إلغاء</Button>
      </div>
    </form>
  );
}
