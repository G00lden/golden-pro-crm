import { readFile } from "node:fs/promises";
import path from "node:path";

const API_BASE = "https://api.salla.dev/admin/v2";
const apply = process.argv.includes("--apply");
const ownerUid = process.env.SALLA_APP_OWNER_UID || process.env.STORE_WEBHOOK_OWNER_UID || "";
const appUrl = String(process.env.APP_URL || "").replace(/\/$/, "");
const secret = process.env.SALLA_APP_WEBHOOK_SECRET || process.env.STORE_WEBHOOK_SECRET || "";
const integrationPath = path.resolve(process.env.SALLA_INTEGRATION_STORE_PATH || ".runtime/salla-integrations.json");

const desiredEvents = [
  "order.created",
  "order.updated",
  "order.status.updated",
  "order.cancelled",
  "order.refunded",
  "order.deleted",
  "order.products.updated",
  "order.payment.updated",
  "order.coupon.updated",
  "order.total.price.updated",
  "order.shipping.address.updated",
  "order.shipment.creating",
  "order.shipment.created",
  "order.shipment.cancelled",
  "order.shipment.return.created",
  "order.shipment.return.creating",
  "order.shipment.return.cancelled",
  "order.customer.updated",
  "product.created",
  "product.updated",
  "product.deleted",
];

function requireValue(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function dataRows(payload) {
  const rows = payload?.data ?? payload?.events ?? payload?.webhooks ?? [];
  return Array.isArray(rows) ? rows : [];
}

async function request(token, pathname, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${API_BASE}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Salla webhook API failed with HTTP ${response.status}.`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function eventName(value) {
  if (typeof value === "string") return value;
  return String(value?.event || value?.name || value?.slug || "").trim();
}

function webhookUrl(event) {
  const url = new URL(`${appUrl}/api/integrations/salla/webhook`);
  // Salla updates an existing subscription when the URL is identical. A
  // stable event query gives every one-event subscription a distinct URL.
  url.searchParams.set("event", event);
  return url.toString();
}

async function listWebhooks(token) {
  return dataRows(await request(token, "/webhooks"));
}

async function main() {
  requireValue(ownerUid, "SALLA_APP_OWNER_UID");
  requireValue(appUrl, "APP_URL");
  requireValue(secret, "SALLA_APP_WEBHOOK_SECRET");
  const store = JSON.parse(await readFile(integrationPath, "utf8"));
  const integration = store?.[ownerUid];
  const token = requireValue(integration?.access_token, "Connected Salla access token");
  const scope = String(integration?.scope || "").split(/\s+/);
  if (!scope.includes("webhooks.read_write")) {
    throw new Error("The connected Salla token does not include webhooks.read_write.");
  }

  const available = new Set(dataRows(await request(token, "/webhooks/events")).map(eventName).filter(Boolean));
  if (!available.size) throw new Error("Salla returned no available webhook events; no subscriptions were changed.");
  const supported = desiredEvents.filter((event) => available.has(event));
  const unavailable = desiredEvents.filter((event) => !available.has(event));
  let active = await listWebhooks(token);
  const missing = supported.filter((event) => !active.some((webhook) =>
    eventName(webhook) === event && String(webhook?.url || "") === webhookUrl(event)));

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    supported: supported.length,
    missing: missing.length,
    unavailable,
  }));
  if (!apply) return;

  for (const event of missing) {
    const body = {
      name: `Breexe CRM ${event}`.slice(0, 120),
      event,
      url: webhookUrl(event),
      version: 2,
      headers: [{ key: "X-Golden-Webhook-Secret", value: secret }],
    };
    try {
      await request(token, "/webhooks/subscribe", { method: "POST", body: JSON.stringify(body) });
    } catch (error) {
      // A lost POST response is ambiguous. Read the authoritative list before
      // deciding whether this event still needs operator attention.
      active = await listWebhooks(token);
      const exists = active.some((webhook) =>
        eventName(webhook) === event && String(webhook?.url || "") === webhookUrl(event));
      if (!exists) throw error;
    }
  }

  active = await listWebhooks(token);
  const remaining = supported.filter((event) => !active.some((webhook) =>
    eventName(webhook) === event && String(webhook?.url || "") === webhookUrl(event)));
  if (remaining.length) throw new Error(`Webhook reconciliation incomplete for ${remaining.join(", ")}.`);
  console.log(JSON.stringify({ applied: missing.length, verified: supported.length }));
}

await main();
