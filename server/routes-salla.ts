import type { Express, Request, Response, NextFunction } from "express";
import {
  getSallaStatus,
  getSallaConnectUrl,
  syncSallaStoreForUser,
} from "./salla";
import { adminDb } from "./firebaseAdmin";
import { getStoreOrdersForUser } from "./storeWebhook";
import { ownedCount } from "./sharedRouteHelpers";
import type { AuthedRequest } from "./auth";

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

export function registerSallaRoutes(app: Express) {
  app.get(
    "/api/integrations/salla/status",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await getSallaStatus(userReq.user.uid, req));
    }),
  );

  app.get(
    "/api/integrations/salla/orders",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const uid = userReq.user.uid;
      const [status, orders] = await Promise.all([
        getSallaStatus(uid, req),
        getStoreOrdersForUser(uid, String(req.query.type || "all")),
      ]);
      const list = Array.isArray(orders) ? orders : (orders as { orders?: unknown[] }).orders ?? orders;
      const arr = Array.isArray(list) ? list : [];
      res.json({
        provider: "salla",
        linked: (status as { linked?: boolean }).linked || false,
        last_sync_at: (status as { last_sync_at?: string | null }).last_sync_at || null,
        last_sync_status: (status as { last_sync_status?: string | null }).last_sync_status || null,
        last_sync_count: (status as { last_sync_count?: number }).last_sync_count ?? null,
        last_sync_error: (status as { last_sync_error?: string | null }).last_sync_error || null,
        sync_enabled: (status as { sync_enabled?: boolean }).sync_enabled ?? false,
        sync_schedule: (status as { sync_schedule?: string }).sync_schedule ?? null,
        total: arr.length,
        orders: arr,
      });
    }),
  );

  app.get(
    "/api/integrations/salla/products",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const uid = userReq.user.uid;
      const products = await adminDb
        .collection("products")
        .where("createdBy", "==", uid)
        .limit(500)
        .get();
      const orders = await adminDb
        .collection("store_orders")
        .where("createdBy", "==", uid)
        .limit(500)
        .get();

      const usageBySku = new Map<string, number>();
      for (const doc of orders.docs) {
        const data = doc.data() as { items?: Array<{ sku?: string }> };
        const items = Array.isArray(data.items) ? data.items : [];
        for (const item of items) {
          if (item?.sku) usageBySku.set(item.sku, (usageBySku.get(item.sku) || 0) + 1);
        }
      }

      const mapped = products.docs.map((doc) => {
        const data = doc.data() as Record<string, unknown>;
        const sku = (data.sku as string) || "";
        return {
          id: doc.id,
          name: (data.name as string) || "",
          sku,
          category: (data.category as string) || "",
          source: (data.source as string) || "manual",
          store_provider: (data.store_provider as string) || null,
          store_product_id: (data.store_product_id as string) || null,
          mapped_to_salla: ((data.source as string) === "salla") || Boolean(data.store_product_id),
          order_usage_count: sku ? usageBySku.get(sku) ?? 0 : 0,
        };
      });

      res.json({
        provider: "salla",
        total: mapped.length,
        mapped_count: mapped.filter((p) => p.mapped_to_salla).length,
        products: mapped,
      });
    }),
  );

  app.get(
    "/api/integrations/salla/connect",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      try {
        res.json(await getSallaConnectUrl(userReq.user.uid, req));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw httpError(409, message);
      }
    }),
  );

  app.post(
    "/api/integrations/salla/sync",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      try {
        res.json(await syncSallaStoreForUser(userReq.user.uid));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not linked") || message.includes("token")) {
          throw httpError(412, message);
        }
        throw httpError(424, message.includes("Salla") ? message : `Salla sync failed: ${message}`);
      }
    }),
  );
}
