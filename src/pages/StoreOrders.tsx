import { RefreshCcw, Search, UserRoundCog, Wrench, Save, Send, Filter } from "lucide-react";
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

export default function StoreOrdersPage({
  notify,
  refreshStats,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  setModal: (modal: ModalState) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [productFilter, setProductFilter] = useState("");
  const [minValue, setMinValue] = useState("");
  const [maxValue, setMaxValue] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState("");
  const seenOrderIdsRef = useRef<Set<string>>(new Set());
  const bootstrappedRef = useRef(false);
  const orders = useData(() => api.getStoreOrders({ type: "all" }), []);
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
    const newOrders = nextOrders.filter((order) => !seenOrderIdsRef.current.has(order.id));

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

      const nextOrders = await api.getStoreOrders({ type: "all" });
      setOrderData(nextOrders);
      updateSeenOrders(nextOrders, options.background);

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
  }, [notify, refreshStats, setOrderData, updateSeenOrders]);

  useEffect(() => {
    if (!orders.data) return;
    updateSeenOrders(orders.data, true);
  }, [orders.data, updateSeenOrders]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void refreshOrders({ background: true });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refreshOrders]);

  const allOrders = orders.data || [];
  const matchesType = useCallback((order: api.StoreOrder, value: string) => {
    if (value === "all") return true;
    if (value === "needs_review" || value === "awaiting_schedule" || value === "booking_created") {
      return order.journey_status === value || Boolean(order.items?.some((item) => item.status === value));
    }
    return Boolean(
      order.order_types?.includes(value as api.StoreItemType) ||
        order.items?.some((item) => effectiveStoreOrderType(item) === value),
    );
  }, []);

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLowerCase();
    const productTerm = productFilter.trim().toLowerCase();
    const minVal = minValue ? Number(minValue) : null;
    const maxVal = maxValue ? Number(maxValue) : null;
    return allOrders.filter((order) => {
      if (!matchesType(order, filter)) return false;
      // City filter
      if (cityFilter && (order.customer_city || "").toLowerCase() !== cityFilter.toLowerCase()) return false;
      // Product filter
      if (productTerm) {
        const itemMatch = (order.items || []).some(
          (item) =>
            (item.name || "").toLowerCase().includes(productTerm) ||
            (item.sku || "").toLowerCase().includes(productTerm),
        );
        if (!itemMatch) return false;
      }
      // Value filter
      const orderVal = orderTotal(order);
      if (minVal !== null && (orderVal === null || orderVal < minVal)) return false;
      if (maxVal !== null && (orderVal === null || orderVal > maxVal)) return false;
      // Text search
      if (!term) return true;
      const haystack = [
        order.order_number,
        order.order_id,
        order.customer_name,
        order.customer_phone,
        order.customer_city,
        order.status,
        ...(order.items || []).flatMap((item) => [item.name, item.sku]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [allOrders, filter, matchesType, search, cityFilter, productFilter, minValue, maxValue]);

  // Extract unique cities for filter dropdown
  const availableCities = useMemo(() => {
    const cities = new Set<string>();
    allOrders.forEach((order) => {
      if (order.customer_city) cities.add(order.customer_city);
    });
    return Array.from(cities).sort();
  }, [allOrders]);

  const summary = useMemo(() => {
    const todayKey = today();
    return {
      total: allOrders.length,
      needsReview: allOrders.filter((order) => matchesType(order, "needs_review")).length,
      awaitingSchedule: allOrders.filter((order) => matchesType(order, "awaiting_schedule")).length,
      booked: allOrders.filter((order) => matchesType(order, "booking_created")).length,
      today: allOrders.filter((order) => String(order.imported_at || order.order_date || "").startsWith(todayKey)).length,
    };
  }, [allOrders, matchesType]);

  const tabs = [
    ["all", "الكل", summary.total],
    ["needs_review", "مراجعة", summary.needsReview],
    ["awaiting_schedule", "بانتظار الجدولة", summary.awaitingSchedule],
    ["booking_created", "محولة لفني", summary.booked],
    ["sale_only", "بيع فقط", allOrders.filter((order) => matchesType(order, "sale_only")).length],
    ["install_maintenance", "تركيب", allOrders.filter((order) => matchesType(order, "install_maintenance")).length],
    ["maintenance_existing", "صيانة سابقة", allOrders.filter((order) => matchesType(order, "maintenance_existing")).length],
    ["external_maintenance", "صيانة خارجية", allOrders.filter((order) => matchesType(order, "external_maintenance")).length],
  ] as const;

  const productsLabel = (order: api.StoreOrder) => {
    const items = order.items || [];
    if (!items.length) return "-";
    const visible = items.slice(0, 2).map((item) => `${item.name} × ${item.quantity}`);
    return items.length > 2 ? `${visible.join("، ")} +${items.length - 2}` : visible.join("، ");
  };

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
          <strong>{summary.total}</strong>
          <span>كل الطلبات</span>
        </article>
        <article className="ops-card danger">
          <strong>{summary.needsReview}</strong>
          <span>تحتاج مراجعة</span>
        </article>
        <article className="ops-card warn">
          <strong>{summary.awaitingSchedule}</strong>
          <span>بانتظار الجدولة</span>
        </article>
        <article className="ops-card success">
          <strong>{summary.booked}</strong>
          <span>محولة لفني</span>
        </article>
        <article className="ops-card">
          <strong>{summary.today}</strong>
          <span>وصلت اليوم</span>
        </article>
      </section>

      <section className="store-board">
        <div className="store-board-toolbar">
          <div className="toolbar compact">
            <Search size={16} />
            <TextInput placeholder="ابحث برقم الطلب، العميل، الجوال، المنتج أو SKU" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <button type="button" className={`btn ${showFilters ? "primary" : "muted"}`} onClick={() => setShowFilters(!showFilters)}>
            <Filter size={14} /> فلاتر متقدمة
          </button>
          <label className="toggle-control">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <span>تحديث تلقائي</span>
          </label>
          <span className="sync-meta">{lastUpdated ? `آخر تحديث: ${fmtDate(lastUpdated)}` : "بانتظار أول تحديث"}</span>
        </div>

        {showFilters && (
          <div className="store-filters-bar">
            <div className="filter-group">
              <label>المدينة</label>
              {availableCities.length > 0 ? (
                <select className="input" value={cityFilter} onChange={(e) => setCityFilter(e.target.value)}>
                  <option value="">كل المدن</option>
                  {availableCities.map((city) => (
                    <option key={city} value={city}>{city}</option>
                  ))}
                </select>
              ) : (
                <TextInput placeholder="اكتب اسم المدينة" value={cityFilter} onChange={(e) => setCityFilter(e.target.value)} />
              )}
            </div>
            <div className="filter-group">
              <label>المنتج</label>
              <TextInput placeholder="اسم أو SKU المنتج" value={productFilter} onChange={(e) => setProductFilter(e.target.value)} />
            </div>
            <div className="filter-group">
              <label>قيمة الطلب (من)</label>
              <TextInput placeholder="الحد الأدنى" type="number" value={minValue} onChange={(e) => setMinValue(e.target.value)} />
            </div>
            <div className="filter-group">
              <label>قيمة الطلب (إلى)</label>
              <TextInput placeholder="الحد الأعلى" type="number" value={maxValue} onChange={(e) => setMaxValue(e.target.value)} />
            </div>
            {(cityFilter || productFilter || minValue || maxValue) && (
              <div className="filter-group filter-actions">
                <Button tone="muted" onClick={() => { setCityFilter(""); setProductFilter(""); setMinValue(""); setMaxValue(""); }}>
                  مسح الفلاتر
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="tabs table-tabs">
          {tabs.map(([value, label, count]) => (
            <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
              {label} <b>{count}</b>
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
                  <th>الحالة</th>
                  <th>العميل</th>
                  <th>المنتجات</th>
                  <th>القيمة</th>
                  <th>نوع الرحلة</th>
                  <th>الفني/الحجز</th>
                  <th>الموعد</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order) => {
                  const needsReview = order.journey_status === "needs_review" || order.items?.some((item) => item.status === "needs_review");
                  return (
                    <tr key={order.id}>
                      <td><input type="checkbox" aria-label={`تحديد الطلب ${order.order_number || order.order_id}`} /></td>
                      <td>
                        <div className="order-id-cell">
                          <strong>{order.order_number || order.order_id}</strong>
                          <span>{order.provider || "salla"}</span>
                        </div>
                      </td>
                      <td>{fmtDate(order.order_date || order.imported_at)}</td>
                      <td><Badge tone={journeyTone(order.journey_status)}>{journeyLabel(order.journey_status)}</Badge></td>
                      <td>
                        <div className="order-customer-cell">
                          <strong>{order.customer_name || "-"}</strong>
                          <span>{phoneLabel(order.customer_phone)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="order-products-cell">
                          <span>{productsLabelDetailed(order)}</span>
                          {(order.items || []).slice(0, 2).map((item) => (
                            <button key={`${order.id}-${item.sku}`} type="button" onClick={() => openWorkflowForm(order, item)}>
                              {item.sku || "بدون SKU"} · {journeyLabel(item.status)}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td>{moneyLabel(orderTotal(order))}</td>
                      <td>{orderTypeLabel(order)}</td>
                      <td>{order.booking_ids?.length ? `${order.booking_ids.length} حجز` : "لم يحول"}</td>
                      <td>{order.scheduled_date ? `${fmtDate(order.scheduled_date)} ${order.scheduled_time || ""}` : "غير مجدول"}</td>
                      <td>
                        <div className="table-actions">
                          <Button tone="muted" onClick={() => openWorkflowForm(order)}><UserRoundCog size={16} /> إدارة</Button>
                          {needsReview && <Button tone="success" onClick={() => openLinkForm(order)}><Wrench size={16} /> ربط</Button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!filteredOrders.length && <Empty title="لا توجد طلبات مطابقة لهذا البحث أو الفلتر" />}
          </div>
        )}
      </section>
    </>
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
          <p>{fmtDate(order.order_date)}</p>
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
