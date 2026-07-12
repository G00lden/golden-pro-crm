export async function getLocalTestToken(baseUrl, uid) {
  if (process.env.CRM_BEARER_TOKEN) return process.env.CRM_BEARER_TOKEN;

  const response = await fetch(new URL("/api/dev/local-token", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid }),
  });
  if (!response.ok) {
    throw new Error(
      `Local test token request failed (${response.status}). ` +
      "Run a non-production loopback server with ALLOW_LOCAL_AUTH=true and a 32+ character LOCAL_AUTH_TOKEN.",
    );
  }
  const payload = await response.json();
  if (!payload?.token) throw new Error("Local test token response did not include a token.");
  return payload.token;
}
