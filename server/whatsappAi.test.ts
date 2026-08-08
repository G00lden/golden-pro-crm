import assert from "node:assert/strict";
import test from "node:test";

process.env.DATA_PROVIDER = "sqlite";
process.env.DB_PROVIDER = "sqlite";
process.env.DB_PATH = ":memory:";
process.env.ENABLE_DAILY_CRON = "false";
process.env.WHATSAPP_AI_ENABLED = "true";
process.env.WHATSAPP_COMMERCE_ENABLED = "true";
process.env.DEEPSEEK_API_KEY = "test-only-deepseek-key";
process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
process.env.WHATSAPP_AI_MAX_REQUESTS_PER_PHONE_HOUR = "20";
process.env.WHATSAPP_AI_CONFIDENCE_THRESHOLD = "0.72";

const db = (await import("./db")).default;
const {
  classifyWhatsAppIntent,
  whatsappAiReadiness,
} = await import("./whatsappAi");

const input = {
  ownerUid: "ai-test-owner",
  phone: "966500000123",
  text: "وين وصل طلبي رقم S-123؟",
};
// Keep the verification fixture inside the production freshness window so the
// test cannot expire merely because the calendar advanced.
const now = new Date();

test.beforeEach(() => {
  db.prepare("DELETE FROM whatsapp_ai_intents").run();
  process.env.WHATSAPP_AI_ENABLED = "true";
  process.env.WHATSAPP_COMMERCE_ENABLED = "true";
  process.env.DEEPSEEK_API_KEY = "test-only-deepseek-key";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
  process.env.WHATSAPP_AI_MAX_REQUESTS_PER_PHONE_HOUR = "20";
  process.env.WHATSAPP_AI_CONFIDENCE_THRESHOLD = "0.72";
});

function deepSeekResponse(content: unknown, status = 200) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("DeepSeek receives only bounded message text and returns a validated intent", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const result = await classifyWhatsAppIntent(input, {
    now: () => now,
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return deepSeekResponse(JSON.stringify({
        intent: "order_status",
        confidence: 0.97,
        order_number: "S-123",
        department: null,
      }));
    },
  });

  assert.equal(capturedUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(
    (capturedInit?.headers as Record<string, string>).Authorization,
    "Bearer test-only-deepseek-key",
  );
  const requestBody = String(capturedInit?.body);
  assert.match(requestBody, /وين وصل طلبي/);
  assert.doesNotMatch(requestBody, /ai-test-owner/);
  assert.doesNotMatch(requestBody, /966500000123/);
  assert.deepEqual(result, {
    attempted: true,
    status: "ok",
    intent: "order_status",
    confidence: 0.97,
    orderNumber: "S-123",
    department: undefined,
  });

  const audit = db.prepare(
    `SELECT owner_uid, phone_hash, input_hash, configuration_hash, intent, status, error_code
       FROM whatsapp_ai_intents`,
  ).get() as Record<string, unknown>;
  assert.equal(audit.owner_uid, input.ownerUid);
  assert.equal(audit.intent, "order_status");
  assert.equal(audit.status, "ok");
  assert.equal(String(audit.phone_hash).length, 64);
  assert.equal(String(audit.input_hash).length, 64);
  assert.equal(String(audit.configuration_hash).length, 64);
  assert.notEqual(audit.configuration_hash, process.env.DEEPSEEK_API_KEY);
  assert.notEqual(audit.phone_hash, input.phone);
  assert.equal(audit.error_code, null);
  const verifiedReadiness = whatsappAiReadiness(input.ownerUid);
  assert.equal(verifiedReadiness.prerequisitesReady, true);
  assert.equal(verifiedReadiness.verified, true);
  assert.equal(verifiedReadiness.ready, true);
  assert.equal(verifiedReadiness.verifiedAt, now.toISOString());
});

test("untrusted fields from the model cannot become tools, URLs, or accepted low-confidence actions", async () => {
  const result = await classifyWhatsAppIntent(input, {
    now: () => now,
    fetchImpl: async () => deepSeekResponse(JSON.stringify({
      intent: "payment_link",
      confidence: 0.4,
      order_number: "../../other-customer",
      department: "root",
      payment_url: "https://evil.example/pay",
      tool: "delete_all_orders",
    })),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.intent, "unknown");
  assert.equal(result.orderNumber, undefined);
  assert.equal(result.department, undefined);
  assert.equal("payment_url" in result, false);
  assert.equal("tool" in result, false);
});

test("invalid and empty model responses fail closed with no business action", async () => {
  const invalidJson = await classifyWhatsAppIntent(input, {
    now: () => now,
    fetchImpl: async () => deepSeekResponse("not-json"),
  });
  assert.equal(invalidJson.status, "failed");
  assert.equal(invalidJson.intent, "unknown");
  assert.equal(invalidJson.reason, "invalid_response");

  const empty = await classifyWhatsAppIntent(
    { ...input, phone: "966500000124" },
    {
      now: () => now,
      fetchImpl: async () => deepSeekResponse(""),
    },
  );
  assert.equal(empty.status, "failed");
  assert.equal(empty.reason, "invalid_response");
});

test("timeouts and upstream HTTP errors are reduced to safe reason codes", async () => {
  const timeout = await classifyWhatsAppIntent(input, {
    now: () => now,
    fetchImpl: async () => {
      throw new DOMException("aborted", "AbortError");
    },
  });
  assert.equal(timeout.status, "failed");
  assert.equal(timeout.reason, "timeout");

  const upstream = await classifyWhatsAppIntent(
    { ...input, phone: "966500000124" },
    {
      now: () => now,
      fetchImpl: async () => new Response("forbidden", { status: 403 }),
    },
  );
  assert.equal(upstream.status, "failed");
  assert.equal(upstream.reason, "deepseek_http_403");
});

test("the per-phone hourly cap prevents a second upstream request", async () => {
  process.env.WHATSAPP_AI_MAX_REQUESTS_PER_PHONE_HOUR = "1";
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return deepSeekResponse(JSON.stringify({
      intent: "menu",
      confidence: 0.99,
      order_number: null,
      department: null,
    }));
  };
  const first = await classifyWhatsAppIntent(input, { now: () => now, fetchImpl });
  const second = await classifyWhatsAppIntent(input, { now: () => now, fetchImpl });
  assert.equal(first.status, "ok");
  assert.equal(second.status, "rate_limited");
  assert.equal(second.reason, "hourly_limit");
  assert.equal(requests, 1);
});

test("readiness exposes no credential and missing configuration makes no request", async () => {
  delete process.env.DEEPSEEK_API_KEY;
  const readiness = whatsappAiReadiness();
  assert.deepEqual(readiness, {
    provider: "deepseek",
    enabled: true,
    configured: false,
    commerceEnabled: true,
    storeSupported: true,
    prerequisitesReady: false,
    verified: false,
    verifiedAt: undefined,
    ready: false,
    model: "deepseek-v4-flash",
  });
  assert.equal("apiKey" in readiness, false);
  let requested = false;
  const result = await classifyWhatsAppIntent(input, {
    fetchImpl: async () => {
      requested = true;
      return deepSeekResponse("{}");
    },
  });
  assert.equal(result.status, "not_configured");
  assert.equal(result.attempted, false);
  assert.equal(requested, false);
});
