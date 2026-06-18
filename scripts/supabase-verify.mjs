import { readProjectEnv, masked } from "./env-utils.mjs";

const env = readProjectEnv();

const requiredTables = [
  { name: "customers", select: "id" },
  { name: "products", select: "id" },
  { name: "installations", select: "id" },
  { name: "technicians", select: "id" },
  { name: "bookings", select: "id" },
  { name: "reminders", select: "id" },
  { name: "settings", select: "owner_uid" },
  { name: "store_orders", select: "id" },
  { name: "store_webhook_events", select: "id" },
  { name: "technician_notifications", select: "id" },
];

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function warn(message) {
  console.warn(`WARN ${message}`);
}

function supabaseUrl() {
  return String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
}

function serviceKey() {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || "";
}

function publishableKey() {
  return env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
}

async function rest(path, key) {
  const response = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

async function main() {
  const url = supabaseUrl();
  const key = serviceKey();
  const anon = publishableKey();

  if (!url) fail("SUPABASE_URL is missing.");
  else pass(`Supabase URL configured (${url})`);

  if (!key) fail("SUPABASE_SERVICE_ROLE_KEY is missing.");
  else pass(`Supabase service key configured (${masked(key)})`);

  if (process.exitCode) return;

  for (const table of requiredTables) {
    const { response, body } = await rest(`${table.name}?select=${table.select}&limit=0`, key);
    if (response.ok) {
      pass(`Table ${table.name} is reachable through server key`);
    } else {
      fail(`Table ${table.name} failed (${response.status}): ${JSON.stringify(body).slice(0, 180)}`);
    }
  }

  if (!anon) {
    warn("Publishable/anon key is missing; skipped browser-key RLS smoke check.");
    return;
  }

  for (const table of ["customers", "store_orders", "technician_notifications"]) {
    const { response, body } = await rest(`${table}?select=id&limit=0`, anon);
    if (!response.ok) {
      pass(`Browser key cannot freely read ${table} (${response.status})`);
      continue;
    }
    if (Array.isArray(body) && body.length === 0) {
      pass(`Browser key returned no unauthenticated rows from ${table}`);
      continue;
    }
    fail(`Browser key can read rows from ${table}; verify RLS policies immediately.`);
  }
}

await main();
