const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const zoneName = process.env.CLOUDFLARE_ZONE_NAME || "breexe-pro.com";
const recordName = process.env.CLOUDFLARE_RECORD_NAME || "crm";
const recordType = process.env.CLOUDFLARE_RECORD_TYPE || "CNAME";
const recordTarget = process.env.CLOUDFLARE_DNS_TARGET;
const proxied = process.env.CLOUDFLARE_PROXIED === "true";

if (!apiToken) {
  throw new Error("CLOUDFLARE_API_TOKEN is required.");
}

if (!recordTarget) {
  throw new Error("CLOUDFLARE_DNS_TARGET is required.");
}

const headers = {
  Authorization: `Bearer ${apiToken}`,
  "Content-Type": "application/json",
};

async function cloudflare(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    throw new Error(JSON.stringify(body?.errors || body || { status: response.status }, null, 2));
  }
  return body.result;
}

const zones = await cloudflare(`/zones?name=${encodeURIComponent(zoneName)}`);
const zone = zones[0];
if (!zone) throw new Error(`Cloudflare zone was not found: ${zoneName}`);

const fqdn = recordName.includes(".") ? recordName : `${recordName}.${zoneName}`;
const records = await cloudflare(
  `/zones/${zone.id}/dns_records?type=${encodeURIComponent(recordType)}&name=${encodeURIComponent(fqdn)}`,
);

const payload = {
  type: recordType,
  name: fqdn,
  content: recordTarget,
  ttl: 1,
  proxied,
  comment: "Golden Pro CRM managed by scripts/cloudflare-dns.mjs",
};

const result = records[0]
  ? await cloudflare(`/zones/${zone.id}/dns_records/${records[0].id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    })
  : await cloudflare(`/zones/${zone.id}/dns_records`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

console.log(JSON.stringify({
  success: true,
  zone: zoneName,
  record: result.name,
  type: result.type,
  target: result.content,
  proxied: result.proxied,
}, null, 2));
