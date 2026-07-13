import { importOdooRows } from "./assetMaintenance";

type JsonRpcResponse<T> = { result?: T; error?: { message?: string; data?: { message?: string } } };

function config() {
  return {
    url: String(process.env.ODOO_URL || "").replace(/\/$/, ""),
    database: String(process.env.ODOO_DATABASE || process.env.ODOO_DB || ""),
    username: String(process.env.ODOO_USERNAME || ""),
    apiKey: String(process.env.ODOO_API_KEY || ""),
    typeField: String(process.env.ODOO_CUSTOMER_TYPE_FIELD || "").trim(),
  };
}

function configured() {
  const value = config();
  return Boolean(value.url && value.database && value.username && value.apiKey);
}

async function rpc<T>(service: "common" | "object", method: string, args: unknown[]): Promise<T> {
  const value = config();
  if (!configured()) throw new Error("إعدادات Odoo API غير مكتملة.");
  const response = await fetch(`${value.url}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json() as JsonRpcResponse<T>;
  if (!response.ok || body.error) throw new Error(body.error?.data?.message || body.error?.message || `Odoo HTTP ${response.status}`);
  return body.result as T;
}

async function authenticate() {
  const value = config();
  const uid = await rpc<number | false>("common", "authenticate", [value.database, value.username, value.apiKey, {}]);
  if (!uid) throw new Error("رفض Odoo بيانات الاتصال.");
  return uid;
}

async function executeKw<T>(uid: number, model: string, method: string, positional: unknown[], keywords: Record<string, unknown>) {
  const value = config();
  return rpc<T>("object", "execute_kw", [value.database, uid, value.apiKey, model, method, positional, keywords]);
}

export function getOdooExternalStatus() {
  const value = config();
  return { configured: configured(), url: value.url || null, database: value.database || null, username: value.username || null, customer_type_field: value.typeField || null };
}

export async function syncOdooCustomers(ownerUid: string, limit = 500) {
  const value = config();
  const uid = await authenticate();
  const fields = ["id", "name", "phone", "mobile", "city", "write_date"];
  if (value.typeField) fields.push(value.typeField);
  const partners = await executeKw<Array<Record<string, unknown>>>(uid, "res.partner", "search_read", [[
    ["customer_rank", ">", 0],
    ["active", "=", true],
  ]], { fields, limit: Math.max(1, Math.min(2000, limit)), order: "write_date desc" });
  const rows = partners.map((partner) => ({
    odoo_id: partner.id,
    name: partner.name,
    phone: partner.mobile || partner.phone,
    city: partner.city || "",
    customer_type: value.typeField ? partner[value.typeField] : "unknown",
  }));
  const imported = await importOdooRows(ownerUid, rows, true);
  return { ...imported, fetched: partners.length };
}
