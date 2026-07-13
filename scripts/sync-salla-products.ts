import dotenv from "dotenv";

dotenv.config({ path: process.env.ENV_FILE || ".env" });

const ownerUid =
  process.env.SALLA_APP_OWNER_UID ||
  process.env.STORE_WEBHOOK_OWNER_UID ||
  process.env.LOCAL_AUTH_SHARED_UID ||
  "";

if (!ownerUid) {
  throw new Error(
    "SALLA_APP_OWNER_UID or STORE_WEBHOOK_OWNER_UID is required to sync Salla products.",
  );
}

const { syncSallaProductsForUser } = await import("../server/salla");
const result = await syncSallaProductsForUser(ownerUid);

console.log(JSON.stringify({
  success: result.success,
  fetched: result.fetched,
  imported: result.imported,
  updated: result.updated,
  failed: result.failed,
  deduplicated: result.deduplicated || 0,
  relinked: result.relinked || 0,
  pages: result.pages,
  last_sync_at: result.last_sync_at,
  last_error: result.last_error || null,
}, null, 2));
