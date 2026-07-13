import type { Express, NextFunction, Request, Response } from "express";
import type { AuthedRequest } from "./auth";
import {
  activateAsset,
  completeServiceCycle,
  createCampaign,
  createUnassignedAssets,
  getAssetDetail,
  getAssetWorkspace,
  getPublicAsset,
  importOdooRows,
  linkReplacementToAsset,
  runAssetReminders,
  sendCampaign,
  setAssetStatus,
  updateProductServicePolicy,
} from "./assetMaintenance";
import { getOdooExternalStatus, syncOdooCustomers } from "./odooExternal";

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function uid(req: Request) {
  return (req as AuthedRequest).user.uid;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function registerAssetPublicRoutes(app: Express) {
  app.get("/public/assets/:token", asyncRoute(async (req, res) => {
    const data = await getPublicAsset(req.params.token);
    const cycles = data.cycles.length
      ? data.cycles.map((cycle) => `<li><strong>${escapeHtml(cycle.task_name)}</strong><span>${escapeHtml(cycle.due_date)} · ${cycle.status === "overdue" ? "متأخر" : "نشط"}</span></li>`).join("")
      : "<li><span>لا توجد مواعيد صيانة نشطة.</span></li>";
    const warranty = data.warranty_end
      ? `<p><strong>الضمان حتى:</strong> ${escapeHtml(data.warranty_end)}</p>`
      : "<p><strong>الضمان:</strong> غير مسجل لهذا الجهاز</p>";
    const servicePhone = String(process.env.PUBLIC_SERVICE_PHONE || "966533971168").replace(/\D/g, "");
    const ctaText = data.cta_type === "reorder" ? "إعادة طلب القطعة" : "حجز موعد صيانة";
    const ctaMessage = data.cta_type === "reorder"
      ? `أرغب في إعادة طلب قطعة للجهاز ${data.asset_code}`
      : `أرغب في حجز صيانة للجهاز ${data.asset_code}`;
    const ctaHref = data.activated
      ? `https://wa.me/${servicePhone}?text=${encodeURIComponent(ctaMessage)}`
      : `tel:+${servicePhone}`;
    res.type("html").send(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#111827"><title>جهاز ${escapeHtml(data.asset_code)}</title>
<style>html{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b1020;color:#f8fafc;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}.card{max-width:680px;margin:auto;background:#111827;border:1px solid #334155;border-radius:20px;padding:24px;box-shadow:0 20px 70px #0008}.code{display:inline-block;direction:ltr;background:#fbbf24;color:#111827;padding:6px 12px;border-radius:999px;font-weight:800;letter-spacing:.08em}h1{font-size:clamp(1.5rem,5vw,2.4rem);text-wrap:balance}p,li{color:#cbd5e1;line-height:1.8}ul{list-style:none;padding:0;display:grid;gap:10px}li{display:flex;justify-content:space-between;gap:16px;border:1px solid #263449;border-radius:12px;padding:12px;overflow-wrap:anywhere}.notice{background:#172554;border:1px solid #1d4ed8;padding:14px;border-radius:12px}a{display:block;text-align:center;margin-top:18px;background:#fbbf24;color:#111827;text-decoration:none;padding:13px;border-radius:12px;font-weight:800}a:focus-visible{outline:3px solid #93c5fd;outline-offset:3px}@media(max-width:520px){body{padding:12px}.card{padding:18px}li{flex-direction:column;gap:2px}}</style></head>
<body><main class="card"><span class="code">${escapeHtml(data.asset_code)}</span><h1>${escapeHtml(data.product_name)}</h1>
${data.activated ? `<p>هذا الجهاز مسجل في نظام متابعة جولدن برو.</p>${warranty}<h2>مواعيد المتابعة</h2><ul>${cycles}</ul>` : '<div class="notice">هذا الملصق غير مفعّل بعد. يجب أن يفعّله الفني من داخل نظام CRM عند التركيب.</div>'}
<a href="${escapeHtml(ctaHref)}">${data.activated ? escapeHtml(ctaText) : "طلب خدمة أو استفسار"}</a></main></body></html>`);
  }));
}

export function registerAssetRoutes(app: Express) {
  app.get("/api/assets/workspace", asyncRoute(async (req, res) => {
    res.json(await getAssetWorkspace(uid(req)));
  }));

  app.post("/api/assets/labels", asyncRoute(async (req, res) => {
    res.status(201).json({ items: await createUnassignedAssets(uid(req), req.body?.count, req.body?.product_id) });
  }));

  app.get("/api/assets/:id", asyncRoute(async (req, res) => {
    res.json(await getAssetDetail(uid(req), req.params.id));
  }));

  app.post("/api/assets/:id/activate", asyncRoute(async (req, res) => {
    res.json(await activateAsset(uid(req), req.params.id, req.body || {}, uid(req)));
  }));

  app.put("/api/assets/:id/status", asyncRoute(async (req, res) => {
    const status = String(req.body?.status || "");
    if (!["active", "paused", "retired"].includes(status)) return res.status(400).json({ error: "حالة الجهاز غير صالحة." });
    res.json(await setAssetStatus(uid(req), req.params.id, status as "active" | "paused" | "retired", uid(req)));
  }));

  app.post("/api/service-cycles/:id/complete", asyncRoute(async (req, res) => {
    res.json(await completeServiceCycle(uid(req), req.params.id, req.body?.completed_date, req.body?.notes, uid(req)));
  }));

  app.put("/api/products/:id/service-policy", asyncRoute(async (req, res) => {
    res.json(await updateProductServicePolicy(uid(req), req.params.id, req.body || {}));
  }));

  app.post("/api/asset-reminders/run", asyncRoute(async (req, res) => {
    res.json(await runAssetReminders({ uid: uid(req), limit: Number(req.body?.limit || 100), trigger: "manual" }));
  }));

  app.post("/api/replacement-links/:id/select", asyncRoute(async (req, res) => {
    res.json(await linkReplacementToAsset(uid(req), req.params.id, String(req.body?.asset_id || ""), uid(req)));
  }));

  app.post("/api/marketing-campaigns", asyncRoute(async (req, res) => {
    res.status(201).json(await createCampaign(uid(req), req.body || {}));
  }));

  app.post("/api/marketing-campaigns/:id/send", asyncRoute(async (req, res) => {
    res.json(await sendCampaign(uid(req), req.params.id));
  }));

  app.post("/api/odoo/import", asyncRoute(async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    res.json(await importOdooRows(uid(req), rows, Boolean(req.body?.commit)));
  }));

  app.get("/api/odoo/external/status", (_req, res) => {
    res.json(getOdooExternalStatus());
  });

  app.post("/api/odoo/external/sync-customers", asyncRoute(async (req, res) => {
    res.json(await syncOdooCustomers(uid(req), Number(req.body?.limit || 500)));
  }));
}
