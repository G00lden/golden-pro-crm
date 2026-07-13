import { Check, ClipboardList, Plus, RefreshCcw, Search, UserRoundSearch } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import * as api from "../api";
import { Button, Empty, ErrorBlock, Field, Loading, PageHeader, TextInput } from "../shared";

const STAGES: Array<{ id: api.OdooCrmStage; label: string }> = [
  { id: "lead", label: "Lead" },
  { id: "opportunity", label: "Opportunity" },
  { id: "quote", label: "Quote" },
  { id: "invoice", label: "Invoice" },
  { id: "paid", label: "Paid" },
];

function money(value?: number) {
  return `${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} SAR`;
}

function fmt(value?: string | null) {
  if (!value) return "-";
  return new Date(value.length === 10 ? `${value}T00:00:00` : value).toLocaleDateString("ar-SA");
}

export default function OdooCrmPage({ notify }: { notify: (message: string, ok?: boolean) => void }) {
  const callContext = useMemo(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem("telephony_action_context") || "null") as {
        target?: string;
        customer_id?: string | null;
        phone?: string | null;
      } | null;
      return value?.target === "odooCrm" ? value : null;
    } catch {
      return null;
    }
  }, []);
  const [dashboard, setDashboard] = useState<api.OdooDashboard | null>(null);
  const [pipeline, setPipeline] = useState<Array<{ stage: api.OdooCrmStage; count: number; amount: number; items: api.OdooDeal[] }>>([]);
  const [tasks, setTasks] = useState<api.OdooTask[]>([]);
  const [audit, setAudit] = useState<api.OdooAuditLog[]>([]);
  const [search, setSearch] = useState(callContext?.phone || "");
  const [searchItems, setSearchItems] = useState<api.OdooSearchItem[]>([]);
  const [customer360, setCustomer360] = useState<api.Customer360 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dealTitle, setDealTitle] = useState("");
  const [taskTitle, setTaskTitle] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [dash, pipe, taskRes, auditRes] = await Promise.all([
        api.getOdooDashboard(),
        api.getOdooPipeline(),
        api.getOdooTasks("open"),
        api.getOdooAudit(),
      ]);
      setDashboard(dash);
      setPipeline(pipe.stages.filter((s) => STAGES.some((stage) => stage.id === s.stage)));
      setTasks(taskRes.data);
      setAudit(auditRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!callContext) return;
    sessionStorage.removeItem("telephony_action_context");
    if (!callContext.customer_id) return;
    api.getCustomer360(callContext.customer_id)
      .then(setCustomer360)
      .catch(() => undefined);
  }, [callContext]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!search.trim()) {
        setSearchItems([]);
        return;
      }
      try {
        const res = await api.searchOdoo(search.trim());
        setSearchItems(res.items);
      } catch {
        setSearchItems([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const metrics = useMemo(() => {
    const f = dashboard?.financial;
    const o = dashboard?.operations;
    return [
      { label: "مبيعات مدفوعة", value: money(f?.paid_sales), hint: `${f?.paid_invoices || 0} فاتورة` },
      { label: "فواتير مفتوحة", value: money(f?.open_invoice_total), hint: `${f?.open_invoices || 0} فاتورة` },
      { label: "متأخرة", value: money(f?.overdue_invoice_total), hint: `${f?.overdue_invoices || 0} فاتورة` },
      { label: "متابعات اليوم", value: String((f?.quote_followups_due || 0) + (o?.overdue_tasks || 0)), hint: `${o?.open_tasks || 0} مهمة مفتوحة` },
    ];
  }, [dashboard]);

  const createDeal = async (event: FormEvent) => {
    event.preventDefault();
    if (!dealTitle.trim()) return;
    try {
      await api.createOdooDeal({ title: dealTitle.trim(), stage: "lead" });
      setDealTitle("");
      notify("تم إنشاء lead جديد");
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر إنشاء lead", false);
    }
  };

  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!taskTitle.trim()) return;
    try {
      await api.createOdooTask({
        title: taskTitle.trim(),
        priority: "normal",
        customer_id: customer360?.customer?.id,
      });
      setTaskTitle("");
      notify("تم إنشاء المهمة");
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر إنشاء المهمة", false);
    }
  };

  const markDone = async (task: api.OdooTask) => {
    try {
      await api.updateOdooTask(task.id, { status: "done" });
      notify("تم إغلاق المهمة");
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر تحديث المهمة", false);
    }
  };

  const moveDeal = async (deal: api.OdooDeal, nextStage: api.OdooCrmStage) => {
    if (!deal.id || deal.id.includes(":")) {
      notify("هذا السجل مشتق من عرض/فاتورة. أنشئ فرصة مستقلة لتعديل المرحلة.", false);
      return;
    }
    try {
      await api.updateOdooDeal(deal.id, { stage: nextStage });
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر تحريك الفرصة", false);
    }
  };

  const openCustomer = async (item: api.OdooSearchItem) => {
    if (item.type !== "customer") return;
    try {
      setCustomer360(await api.getCustomer360(item.id));
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر فتح ملف العميل", false);
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorBlock message={error} retry={refresh} />;

  return (
    <div className="cloud-design">
      <PageHeader
        title="CRM مثل Odoo"
        subtitle="Pipeline، عميل 360، مهام، صلاحيات، سجل نشاط، Dashboard، وبحث موحد"
        actions={<Button onClick={refresh}><RefreshCcw size={16} /> تحديث</Button>}
      />

      <div className="stats-grid metric-grid">
        {metrics.map((metric) => (
          <article className="stat" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.hint}</small>
          </article>
        ))}
      </div>

      <div className="toolbar" style={{ gap: 8, flexWrap: "wrap" }}>
        <Search size={16} />
        <TextInput placeholder="بحث موحد: عميل، طلب، عرض، فاتورة، محادثة" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!!searchItems.length && (
        <div className="list">
          {searchItems.map((item) => (
            <button className="row-card" key={`${item.type}:${item.id}`} type="button" onClick={() => openCustomer(item)} style={{ textAlign: "right" }}>
              <div className="row-main">
                <strong>{item.title || item.id}</strong>
                <span>{item.type} · {item.subtitle || "-"} · {item.meta || "-"}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      <section className="panel-section">
        <div className="section-title">
          <h2>Pipeline المبيعات</h2>
          <form className="toolbar" onSubmit={createDeal}>
            <TextInput placeholder="Lead جديد" value={dealTitle} onChange={(e) => setDealTitle(e.target.value)} />
            <Button type="submit"><Plus size={16} /> إضافة</Button>
          </form>
        </div>
        <div className="kanban-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
          {pipeline.map((col) => (
            <div className="row-card" key={col.stage} style={{ alignItems: "stretch" }}>
              <div className="row-main">
                <strong>{STAGES.find((s) => s.id === col.stage)?.label || col.stage}</strong>
                <span>{col.count} سجل · {money(col.amount)}</span>
              </div>
              <div className="list" style={{ marginTop: 10 }}>
                {col.items.slice(0, 6).map((deal) => (
                  <article className="row-card" key={deal.id}>
                    <div className="row-main">
                      <strong>{deal.title}</strong>
                      <span>{deal.customer_name || "بدون عميل"} · {money(Number(deal.amount || 0))}</span>
                    </div>
                    {!deal.id.includes(":") && (
                      <select className="input" value={deal.stage} onChange={(e) => moveDeal(deal, e.target.value as api.OdooCrmStage)}>
                        {STAGES.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
                      </select>
                    )}
                  </article>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-section">
        <div className="section-title">
          <h2>المهام والمتابعات</h2>
          <form className="toolbar" onSubmit={createTask}>
            <TextInput placeholder="مهمة متابعة" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
            <Button type="submit"><ClipboardList size={16} /> إضافة</Button>
          </form>
        </div>
        <div className="list">
          {tasks.map((task) => (
            <article className="row-card" key={task.id}>
              <div className="row-main">
                <strong>{task.title}</strong>
                <span>{task.priority || "normal"} · استحقاق {fmt(task.due_date)}</span>
              </div>
              <Button tone="muted" onClick={() => markDone(task)}><Check size={16} /> تم</Button>
            </article>
          ))}
          {!tasks.length && <Empty title="لا توجد مهام مفتوحة" />}
        </div>
      </section>

      {customer360 ? (
        <section className="panel-section">
          <div className="section-title">
            <h2>عميل 360: {customer360.customer.name}</h2>
          </div>
          <div className="stats-grid metric-grid">
            <article className="stat"><span>طلبات</span><strong>{customer360.store_orders.length}</strong></article>
            <article className="stat"><span>عروض</span><strong>{customer360.quotes.length}</strong></article>
            <article className="stat"><span>فواتير</span><strong>{customer360.invoices.length}</strong></article>
            <article className="stat"><span>محادثات</span><strong>{customer360.conversations.length}</strong></article>
            <article className="stat"><span>مكالمات</span><strong>{customer360.calls.length}</strong></article>
            <article className="stat"><span>فرص هاتفية</span><strong>{customer360.leads.length}</strong></article>
          </div>
          <div className="list">
            {customer360.calls.map((call) => (
              <article className="row-card" key={call.id}>
                <div className="row-main">
                  <strong>مكالمة {call.department_name || "عامة"}</strong>
                  <span>{fmt(call.created_at)} · {call.call_status || call.status} · متابعة {call.follow_up_status}</span>
                </div>
              </article>
            ))}
            {customer360.notes.map((note) => (
              <article className="row-card" key={note.id}>
                <div className="row-main"><strong>{note.body}</strong><span>{fmt(note.created_at)}</span></div>
              </article>
            ))}
          </div>
          <NoteForm customerId={customer360.customer.id} notify={notify} reload={async () => setCustomer360(await api.getCustomer360(customer360.customer.id))} />
        </section>
      ) : (
        <section className="empty">
          <UserRoundSearch size={30} />
          <p>ابحث عن عميل وافتح ملف 360.</p>
        </section>
      )}

      <section className="panel-section">
        <div className="section-title"><h2>سجل النشاط</h2></div>
        <div className="list">
          {audit.slice(0, 10).map((item) => (
            <article className="row-card" key={item.id}>
              <div className="row-main">
                <strong>{item.action} · {item.entity_type}</strong>
                <span>{item.summary || item.entity_id || "-"} · {fmt(item.created_at)}</span>
              </div>
            </article>
          ))}
          {!audit.length && <Empty title="لا يوجد سجل نشاط بعد" />}
        </div>
      </section>
    </div>
  );
}

function NoteForm({ customerId, notify, reload }: { customerId: string; notify: (message: string, ok?: boolean) => void; reload: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    setSaving(true);
    try {
      await api.addCustomer360Note(customerId, body.trim());
      setBody("");
      notify("تمت إضافة الملاحظة");
      await reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "تعذر إضافة الملاحظة", false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <Field label="ملاحظة على العميل">
        <TextInput value={body} onChange={(event) => setBody(event.target.value)} placeholder="اكتب ملاحظة مختصرة" />
      </Field>
      <Button type="submit" loading={saving}><Plus size={16} /> إضافة ملاحظة</Button>
    </form>
  );
}
