import dotenv from "dotenv";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

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

const fileFlagIndex = process.argv.indexOf("--file");
const snapshotPath = fileFlagIndex >= 0 ? process.argv[fileFlagIndex + 1] : "";
if (fileFlagIndex >= 0 && !snapshotPath) {
  throw new Error("--file requires the path to a Salla product snapshot JSON file.");
}

const { importSallaProductsSnapshotForUser, syncSallaProductsForUser } = await import("../server/salla");
let result;
if (snapshotPath) {
  const absolutePath = path.resolve(snapshotPath);
  const fileInfo = await stat(absolutePath);
  if (!fileInfo.isFile() || fileInfo.size > 50 * 1024 * 1024) {
    throw new Error("Salla product snapshot must be a JSON file smaller than 50 MB.");
  }
  const payload = JSON.parse(await readFile(absolutePath, "utf8"));
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const pagination = record.pagination && typeof record.pagination === "object"
    ? record.pagination as Record<string, unknown>
    : {};
  const products = Array.isArray(payload)
    ? payload
    : Array.isArray(record.products)
      ? record.products
      : Array.isArray(record.data)
        ? record.data
        : [];
  const advertisedCount = Number(record.advertised_count ?? pagination.total ?? products.length);
  const advertisedPages = Number(
    record.advertised_pages ??
    pagination.total_pages ??
    pagination.totalPages ??
    (products.length ? Math.ceil(products.length / 30) : 0),
  );
  const fetchedAt = typeof record.fetched_at === "string" && Number.isFinite(Date.parse(record.fetched_at))
    ? new Date(record.fetched_at).toISOString()
    : undefined;
  result = await importSallaProductsSnapshotForUser(ownerUid, products, {
    advertisedCount,
    advertisedPages,
    syncedAt: fetchedAt,
  });
} else {
  result = await syncSallaProductsForUser(ownerUid);
}

console.log(JSON.stringify({
  success: result.success,
  fetched: result.fetched,
  imported: result.imported,
  updated: result.updated,
  failed: result.failed,
  deduplicated: result.deduplicated || 0,
  relinked: result.relinked || 0,
  archived: result.archived || 0,
  pages: result.pages,
  advertised_count: result.advertised_count ?? result.fetched,
  complete: result.complete ?? result.success,
  last_sync_at: result.last_sync_at,
  last_error: result.last_error || null,
}, null, 2));
