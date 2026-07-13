import crypto from "crypto";
import type { Express, NextFunction, Request, Response } from "express";
import db from "./db";
import { requestOwnerUid, type AuthedRequest } from "./auth";
import { todayInTimeZone } from "./reminderEngine";

type CrmStage = "lead" | "opportunity" | "quote" | "invoice" | "paid" | "lost";
type CrmTaskStatus = "open" | "done" | "cancelled";

const STAGES: CrmStage[] = ["lead", "opportunity", "quote", "invoice", "paid", "lost"];
const WRITE_ROLES = new Set(["admin", "manager", "sales"]);
const READ_ROLES = new Set(["admin", "manager", "sales", "technician"]);

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function httpError(status: number, message: string) {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

function uid(req: Request) {
  return requestOwnerUid(req);
}

function actorUid(req: Request) {
  return (req as AuthedRequest).user.uid;
}

function role(req: Request) {
  return (req as AuthedRequest).user.role;
}

function requireCrmRead(req: Request, res: Response, next: NextFunction) {
  if (!READ_ROLES.has(role(req))) {
    res.status(403).json({ error: "لا تملك صلاحية عرض CRM." });
    return;
  }
  next();
}

function requireCrmWrite(req: Request, res: Response, next: NextFunction) {
  if (!WRITE_ROLES.has(role(req))) {
    res.status(403).json({ error: "لا تملك صلاحية تعديل CRM." });
    return;
  }
  next();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function stage(value: unknown): CrmStage {
  const next = String(value || "lead").toLowerCase() as CrmStage;
  return STAGES.includes(next) ? next : "lead";
}

function num(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function row<T = Record<string, unknown>>(sql: string, ...args: unknown[]) {
  return db.prepare(sql).get(...args) as T | undefined;
}

function rows<T = Record<string, unknown>>(sql: string, ...args: unknown[]) {
  return db.prepare(sql).all(...args) as T[];
}

function likeQuery(q: string) {
  return `%${q.trim().toLowerCase()}%`;
}

function recordAudit(input: {
  ownerUid: string;
  actorUid?: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
}) {
  db.prepare(
    `INSERT INTO audit_logs (id, owner_uid, actor_uid, action, entity_type, entity_id, summary, before_data, after_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id("audit"),
    input.ownerUid,
    input.actorUid || null,
    input.action,
    input.entityType,
    input.entityId || null,
    input.summary || "",
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    nowIso(),
  );
}

function listPipeline(ownerUid: string) {
  const deals = rows(
    "SELECT *, 'deal' AS record_type FROM crm_deals WHERE owner_uid = ? ORDER BY updated_at DESC LIMIT 300",
    ownerUid,
  );
  const linkedQuotes = new Set(deals.map((deal) => String(deal.quote_id || "")).filter(Boolean));
  const linkedInvoices = new Set(deals.map((deal) => String(deal.invoice_id || "")).filter(Boolean));

  // Terminal statuses are no longer live pipeline: a declined/expired quote or a
  // cancelled/refunded invoice is a dead sale and must not be counted as active
  // pipeline value.
  const DEAD_QUOTE_STATUSES = new Set(["declined", "expired"]);
  const DEAD_INVOICE_STATUSES = new Set(["cancelled", "refunded"]);

  const invoiceRows = rows(
    `SELECT id, invoice_number, quote_id, customer_id, customer_name, customer_phone, title, status, total_with_vat, currency, due_date, paid_at, updated_at, created_at
     FROM invoices WHERE owner_uid = ? ORDER BY created_at DESC LIMIT 300`,
    ownerUid,
  );

  // A quote that has already been converted to an invoice is represented by that
  // invoice — don't also count it in the "quote" stage, or one sale is counted twice.
  const invoicedQuoteIds = new Set(
    invoiceRows.map((invoice) => String(invoice.quote_id || "")).filter(Boolean),
  );

  const quoteDeals = rows(
    `SELECT id, quote_number, customer_id, customer_name, customer_phone, title, status, total, currency, follow_up_date, updated_at, created_at
     FROM quotes WHERE owner_uid = ? ORDER BY created_at DESC LIMIT 300`,
    ownerUid,
  )
    .filter((quote) => !linkedQuotes.has(String(quote.id)))
    .filter((quote) => !invoicedQuoteIds.has(String(quote.id)))
    .filter((quote) => !DEAD_QUOTE_STATUSES.has(String(quote.status || "")))
    .map((quote) => ({
      id: `quote:${quote.id}`,
      record_type: "quote",
      title: quote.title || quote.quote_number || "عرض سعر",
      customer_id: quote.customer_id,
      customer_name: quote.customer_name,
      customer_phone: quote.customer_phone,
      stage: "quote",
      amount: quote.total || 0,
      currency: quote.currency || "SAR",
      probability: quote.status === "confirmed" ? 80 : 55,
      expected_close: quote.follow_up_date || null,
      quote_id: quote.id,
      invoice_id: null,
      status: quote.status,
      updated_at: quote.updated_at,
      created_at: quote.created_at,
      source: "quote",
    }));

  const invoiceDeals = invoiceRows
    .filter((invoice) => !linkedInvoices.has(String(invoice.id)))
    .filter((invoice) => !DEAD_INVOICE_STATUSES.has(String(invoice.status || "")))
    .map((invoice) => ({
      id: `invoice:${invoice.id}`,
      record_type: "invoice",
      title: invoice.title || invoice.invoice_number || "فاتورة",
      customer_id: invoice.customer_id,
      customer_name: invoice.customer_name,
      customer_phone: invoice.customer_phone,
      stage: invoice.status === "paid" ? "paid" : "invoice",
      amount: invoice.total_with_vat || 0,
      currency: invoice.currency || "SAR",
      probability: invoice.status === "paid" ? 100 : 90,
      expected_close: invoice.due_date || null,
      quote_id: invoice.quote_id,
      invoice_id: invoice.id,
      status: invoice.status,
      paid_at: invoice.paid_at,
      updated_at: invoice.updated_at,
      created_at: invoice.created_at,
      source: "invoice",
    }));

  const items = [...deals, ...quoteDeals, ...invoiceDeals];
  const byStage = STAGES.map((name) => {
    const stageItems = items.filter((item) => String(item.stage) === name);
    return {
      stage: name,
      count: stageItems.length,
      amount: stageItems.reduce((sum, item) => sum + num(item.amount), 0),
      items: stageItems,
    };
  });
  return { stages: byStage, items };
}

function dashboard(ownerUid: string) {
  const pipeline = listPipeline(ownerUid);
  // Use the project's Asia/Riyadh day boundary — not UTC — so overdue/follow-up
  // counts don't shift by a day during the nightly UTC/KSA window.
  const today = todayInTimeZone();
  const paid = row<{ total: number; count: number }>(
    "SELECT COALESCE(SUM(total_with_vat),0) AS total, COUNT(*) AS count FROM invoices WHERE owner_uid = ? AND status = 'paid'",
    ownerUid,
  ) || { total: 0, count: 0 };
  const openInvoices = row<{ total: number; count: number }>(
    "SELECT COALESCE(SUM(total_with_vat),0) AS total, COUNT(*) AS count FROM invoices WHERE owner_uid = ? AND status NOT IN ('paid','cancelled','refunded')",
    ownerUid,
  ) || { total: 0, count: 0 };
  const overdue = row<{ total: number; count: number }>(
    "SELECT COALESCE(SUM(total_with_vat),0) AS total, COUNT(*) AS count FROM invoices WHERE owner_uid = ? AND status NOT IN ('paid','cancelled','refunded') AND due_date IS NOT NULL AND due_date < ?",
    ownerUid,
    today,
  ) || { total: 0, count: 0 };
  const followUps = row<{ count: number }>(
    // Follow-ups are open quotes that still need chasing: 'issued' (sent, awaiting a
    // decision) and 'follow_up' (explicitly flagged). 'sent' is an invoice status, not
    // a quote status, so the old filter matched nothing there and dropped 'follow_up'.
    "SELECT COUNT(*) AS count FROM quotes WHERE owner_uid = ? AND status IN ('issued','follow_up') AND follow_up_date IS NOT NULL AND follow_up_date <= ?",
    ownerUid,
    today,
  ) || { count: 0 };
  const tasks = row<{ open: number; overdue: number }>(
    "SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status = 'open' AND due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END) AS overdue FROM crm_tasks WHERE owner_uid = ?",
    today,
    ownerUid,
  ) || { open: 0, overdue: 0 };
  return {
    pipeline: pipeline.stages.map(({ stage: stageName, count, amount }) => ({ stage: stageName, count, amount })),
    financial: {
      paid_sales: num(paid.total),
      paid_invoices: num(paid.count),
      open_invoice_total: num(openInvoices.total),
      open_invoices: num(openInvoices.count),
      overdue_invoice_total: num(overdue.total),
      overdue_invoices: num(overdue.count),
      quote_followups_due: num(followUps.count),
    },
    operations: {
      open_tasks: num(tasks.open),
      overdue_tasks: num(tasks.overdue),
    },
  };
}

export function registerOdooCrmRoutes(app: Express) {
  app.use("/api/odoo", requireCrmRead);

  app.get("/api/odoo/dashboard", asyncRoute(async (req, res) => {
    res.json(dashboard(uid(req)));
  }));

  app.get("/api/odoo/pipeline", asyncRoute(async (req, res) => {
    res.json(listPipeline(uid(req)));
  }));

  app.post("/api/odoo/pipeline", requireCrmWrite, asyncRoute(async (req, res) => {
    const ownerUid = uid(req);
    const body = req.body || {};
    const deal = {
      id: id("deal"),
      owner_uid: ownerUid,
      title: String(body.title || "").trim(),
      customer_id: body.customer_id ? String(body.customer_id) : null,
      customer_name: String(body.customer_name || "").trim(),
      customer_phone: String(body.customer_phone || "").trim(),
      stage: stage(body.stage),
      amount: num(body.amount),
      currency: String(body.currency || "SAR"),
      probability: Math.max(0, Math.min(100, Number(body.probability ?? 10))),
      expected_close: body.expected_close ? String(body.expected_close) : null,
      assigned_to: body.assigned_to ? String(body.assigned_to) : null,
      source: String(body.source || "manual"),
      quote_id: body.quote_id ? String(body.quote_id) : null,
      invoice_id: body.invoice_id ? String(body.invoice_id) : null,
      notes: String(body.notes || ""),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (!deal.title) throw httpError(400, "عنوان الفرصة مطلوب.");
    db.prepare(
      `INSERT INTO crm_deals (id, owner_uid, title, customer_id, customer_name, customer_phone, stage, amount, currency, probability, expected_close, assigned_to, source, quote_id, invoice_id, notes, created_at, updated_at)
       VALUES (@id, @owner_uid, @title, @customer_id, @customer_name, @customer_phone, @stage, @amount, @currency, @probability, @expected_close, @assigned_to, @source, @quote_id, @invoice_id, @notes, @created_at, @updated_at)`,
    ).run(deal);
    recordAudit({ ownerUid, actorUid: actorUid(req), action: "create", entityType: "crm_deal", entityId: deal.id, summary: deal.title, after: deal });
    res.status(201).json({ deal });
  }));

  app.put("/api/odoo/pipeline/:id", requireCrmWrite, asyncRoute(async (req, res) => {
    const ownerUid = uid(req);
    const before = row("SELECT * FROM crm_deals WHERE id = ? AND owner_uid = ?", req.params.id, ownerUid);
    if (!before) throw httpError(404, "الفرصة غير موجودة.");
    const body = req.body || {};
    const next = {
      title: body.title !== undefined ? String(body.title).trim() : before.title,
      customer_id: body.customer_id !== undefined ? String(body.customer_id || "") || null : before.customer_id,
      customer_name: body.customer_name !== undefined ? String(body.customer_name || "") : before.customer_name,
      customer_phone: body.customer_phone !== undefined ? String(body.customer_phone || "") : before.customer_phone,
      stage: body.stage !== undefined ? stage(body.stage) : before.stage,
      amount: body.amount !== undefined ? num(body.amount) : before.amount,
      probability: body.probability !== undefined ? Math.max(0, Math.min(100, Number(body.probability))) : before.probability,
      expected_close: body.expected_close !== undefined ? String(body.expected_close || "") || null : before.expected_close,
      assigned_to: body.assigned_to !== undefined ? String(body.assigned_to || "") || null : before.assigned_to,
      notes: body.notes !== undefined ? String(body.notes || "") : before.notes,
      updated_at: nowIso(),
      id: req.params.id,
      owner_uid: ownerUid,
    };
    db.prepare(
      `UPDATE crm_deals SET title=@title, customer_id=@customer_id, customer_name=@customer_name, customer_phone=@customer_phone,
       stage=@stage, amount=@amount, probability=@probability, expected_close=@expected_close, assigned_to=@assigned_to, notes=@notes, updated_at=@updated_at
       WHERE id=@id AND owner_uid=@owner_uid`,
    ).run(next);
    const after = row("SELECT * FROM crm_deals WHERE id = ? AND owner_uid = ?", req.params.id, ownerUid);
    recordAudit({ ownerUid, actorUid: actorUid(req), action: "update", entityType: "crm_deal", entityId: req.params.id, summary: String(next.title || ""), before, after });
    res.json({ deal: after });
  }));

  app.get("/api/odoo/tasks", asyncRoute(async (req, res) => {
    const ownerUid = uid(req);
    const status = String(req.query.status || "open");
    const filter = status === "all" ? "" : "AND status = ?";
    const args: unknown[] = status === "all" ? [ownerUid] : [ownerUid, status];
    const data = rows(`SELECT * FROM crm_tasks WHERE owner_uid = ? ${filter} ORDER BY COALESCE(due_date, '9999-12-31'), created_at DESC LIMIT 300`, ...args);
    res.json({ data, total: data.length });
  }));

  app.post("/api/odoo/tasks", requireCrmWrite, asyncRoute(async (req, res) => {
    const ownerUid = uid(req);
    const body = req.body || {};
    const task = {
      id: id("task"),
      owner_uid: ownerUid,
      title: String(body.title || "").trim(),
      status: "open" as CrmTaskStatus,
      priority: String(body.priority || "normal"),
      due_date: body.due_date ? String(body.due_date) : null,
      assigned_to: body.assigned_to ? String(body.assigned_to) : null,
      related_type: body.related_type ? String(body.related_type) : null,
      related_id: body.related_id ? String(body.related_id) : null,
      customer_id: body.customer_id ? String(body.customer_id) : null,
      notes: String(body.notes || ""),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (!task.title) throw httpError(400, "عنوان المهمة مطلوب.");
    db.prepare(
      `INSERT INTO crm_tasks (id, owner_uid, title, status, priority, due_date, assigned_to, related_type, related_id, customer_id, notes, created_at, updated_at)
       VALUES (@id, @owner_uid, @title, @status, @priority, @due_date, @assigned_to, @related_type, @related_id, @customer_id, @notes, @created_at, @updated_at)`,
    ).run(task);
    recordAudit({ ownerUid, actorUid: actorUid(req), action: "create", entityType: "crm_task", entityId: task.id, summary: task.title, after: task });
    res.status(201).json({ task });
  }));

  app.put("/api/odoo/tasks/:id", asyncRoute(async (req, res) => {
    const ownerUid = uid(req);
    const userRole = role(req);
    if (!WRITE_ROLES.has(userRole) && userRole !== "technician") throw httpError(403, "لا تملك صلاحية تعديل المهمة.");
    const before = row("SELECT * FROM crm_tasks WHERE id = ? AND owner_uid = ?", req.params.id, ownerUid);
    if (!before) throw httpError(404, "المهمة غير موجودة.");
    const body = req.body || {};
    const status = ["open", "done", "cancelled"].includes(String(body.status)) ? String(body.status) as CrmTaskStatus : String(before.status || "open") as CrmTaskStatus;
    const next = {
      id: req.params.id,
      owner_uid: ownerUid,
      title: body.title !== undefined ? String(body.title).trim() : before.title,
      status,
      priority: body.priority !== undefined ? String(body.priority || "normal") : before.priority,
      due_date: body.due_date !== undefined ? String(body.due_date || "") || null : before.due_date,
      assigned_to: body.assigned_to !== undefined ? String(body.assigned_to || "") || null : before.assigned_to,
      notes: body.notes !== undefined ? String(body.notes || "") : before.notes,
      updated_at: nowIso(),
      completed_at: status === "done" ? (before.completed_at || nowIso()) : null,
    };
    db.prepare(
      `UPDATE crm_tasks SET title=@title, status=@status, priority=@priority, due_date=@due_date, assigned_to=@assigned_to,
       notes=@notes, updated_at=@updated_at, completed_at=@completed_at WHERE id=@id AND owner_uid=@owner_uid`,
    ).run(next);
    const after = row("SELECT * FROM crm_tasks WHERE id = ? AND owner_uid = ?", req.params.id, ownerUid);
    recordAudit({ ownerUid, actorUid: actorUid(req), action: "update", entityType: "crm_task", entityId: req.params.id, summary: String(next.title || ""), before, after });
    res.json({ task: after });
  }));

  app.get("/api/odoo/customer-360/:id", asyncRoute(async (req, res) => {
    const ownerUid = uid(req);
    const customer = row("SELECT * FROM customers WHERE id = ? AND owner_uid = ?", req.params.id, ownerUid);
    if (!customer) throw httpError(404, "العميل غير موجود.");
    const phone = String(customer.phone || "");
    res.json({
      customer,
      store_orders: rows("SELECT * FROM store_orders WHERE owner_uid = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 50", ownerUid, req.params.id),
      quotes: rows("SELECT * FROM quotes WHERE owner_uid = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 50", ownerUid, req.params.id),
      invoices: rows("SELECT * FROM invoices WHERE owner_uid = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 50", ownerUid, req.params.id),
      installations: rows("SELECT * FROM installations WHERE owner_uid = ? AND customer_id = ? ORDER BY next_maintenance DESC LIMIT 50", ownerUid, req.params.id),
      bookings: rows("SELECT * FROM bookings WHERE owner_uid = ? AND customer_id = ? ORDER BY date DESC LIMIT 50", ownerUid, req.params.id),
      conversations: phone ? rows("SELECT * FROM whatsapp_messages WHERE owner_uid = ? AND (from_phone LIKE ? OR to_phone LIKE ?) ORDER BY created_at DESC LIMIT 50", ownerUid, `%${phone.slice(-9)}%`, `%${phone.slice(-9)}%`) : [],
      calls: rows("SELECT * FROM call_logs WHERE owner_uid = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 50", ownerUid, req.params.id),
      leads: phone ? rows("SELECT * FROM crm_deals WHERE owner_uid = ? AND (customer_id = ? OR customer_phone LIKE ?) ORDER BY created_at DESC LIMIT 50", ownerUid, req.params.id, `%${phone.slice(-9)}%`) : [],
      notes: rows("SELECT * FROM crm_notes WHERE owner_uid = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 50", ownerUid, req.params.id),
      tasks: rows("SELECT * FROM crm_tasks WHERE owner_uid = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 50", ownerUid, req.params.id),
      audit: rows("SELECT * FROM audit_logs WHERE owner_uid = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 50", ownerUid, req.params.id),
    });
  }));

  app.post("/api/odoo/customer-360/:id/notes", requireCrmWrite, asyncRoute(async (req, res) => {
    const ownerUid = uid(req);
    const customer = row("SELECT id FROM customers WHERE id = ? AND owner_uid = ?", req.params.id, ownerUid);
    if (!customer) throw httpError(404, "العميل غير موجود.");
    const body = String(req.body?.body || "").trim();
    if (!body) throw httpError(400, "نص الملاحظة مطلوب.");
    const note = { id: id("note"), owner_uid: ownerUid, customer_id: req.params.id, body, created_by: actorUid(req), created_at: nowIso() };
    db.prepare("INSERT INTO crm_notes (id, owner_uid, customer_id, body, created_by, created_at) VALUES (@id, @owner_uid, @customer_id, @body, @created_by, @created_at)").run(note);
    recordAudit({ ownerUid, actorUid: actorUid(req), action: "create", entityType: "customer_note", entityId: req.params.id, summary: body.slice(0, 120), after: note });
    res.status(201).json({ note });
  }));

  app.get("/api/odoo/search", asyncRoute(async (req, res) => {
    const ownerUid = uid(req);
    const q = String(req.query.q || "").trim();
    if (!q) {
      res.json({ items: [] });
      return;
    }
    const needle = likeQuery(q);
    const items = [
      ...rows("SELECT 'customer' AS type, id, name AS title, phone AS subtitle, city AS meta FROM customers WHERE owner_uid = ? AND (LOWER(name) LIKE ? OR phone LIKE ? OR LOWER(IFNULL(city,'')) LIKE ?) LIMIT 15", ownerUid, needle, `%${q}%`, needle),
      ...rows("SELECT 'store_order' AS type, id, order_number AS title, customer_name AS subtitle, status AS meta FROM store_orders WHERE owner_uid = ? AND (LOWER(IFNULL(order_number,'')) LIKE ? OR LOWER(IFNULL(customer_name,'')) LIKE ?) LIMIT 15", ownerUid, needle, needle),
      ...rows("SELECT 'quote' AS type, id, quote_number AS title, customer_name AS subtitle, status AS meta FROM quotes WHERE owner_uid = ? AND (LOWER(quote_number) LIKE ? OR LOWER(customer_name) LIKE ? OR LOWER(title) LIKE ?) LIMIT 15", ownerUid, needle, needle, needle),
      ...rows("SELECT 'invoice' AS type, id, invoice_number AS title, customer_name AS subtitle, status AS meta FROM invoices WHERE owner_uid = ? AND (LOWER(invoice_number) LIKE ? OR LOWER(customer_name) LIKE ? OR LOWER(title) LIKE ?) LIMIT 15", ownerUid, needle, needle, needle),
      ...rows("SELECT 'whatsapp' AS type, id, COALESCE(from_phone, to_phone) AS title, message AS subtitle, status AS meta FROM whatsapp_messages WHERE owner_uid = ? AND (LOWER(message) LIKE ? OR from_phone LIKE ? OR to_phone LIKE ?) LIMIT 15", ownerUid, needle, `%${q}%`, `%${q}%`),
    ];
    res.json({ items: items.slice(0, 50) });
  }));

  app.get("/api/odoo/audit", asyncRoute(async (req, res) => {
    const ownerUid = uid(req);
    const entityType = String(req.query.entity_type || "");
    const entityId = String(req.query.entity_id || "");
    if (entityType && entityId) {
      res.json({ data: rows("SELECT * FROM audit_logs WHERE owner_uid = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 100", ownerUid, entityType, entityId) });
      return;
    }
    res.json({ data: rows("SELECT * FROM audit_logs WHERE owner_uid = ? ORDER BY created_at DESC LIMIT 100", ownerUid) });
  }));
}
