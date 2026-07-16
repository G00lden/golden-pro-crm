import type { Express, NextFunction, Request, Response } from "express";
import type { AuthedRequest } from "./auth";
import { requireCapability } from "./capabilityGuard";
import {
  beginGoogleContactsOAuth,
  completeGoogleContactsOAuth,
  disconnectGoogleContacts,
  googleContactsStatus,
  syncNamedGoogleContacts,
} from "./googleContacts";

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requestBaseUrl(req: Request) {
  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "https";
  const forwardedHost = String(req.get("x-forwarded-host") || "").split(",")[0].trim();
  const host = forwardedHost || req.get("host") || "";
  return `${protocol}://${host}`;
}

export function registerGoogleContactsCallbackRoute(app: Express) {
  app.get("/api/integrations/google-contacts/callback", asyncRoute(async (req, res) => {
    const error = String(req.query.error || "").trim();
    const state = String(req.query.state || "").trim();
    const code = String(req.query.code || "").trim();
    if (error) {
      res.redirect(`/?section=callSystem&callTab=contacts&google=error&message=${encodeURIComponent(error)}`);
      return;
    }
    if (!state || !code) {
      res.redirect("/?section=callSystem&callTab=contacts&google=error&message=missing_callback_data");
      return;
    }
    try {
      const result = await completeGoogleContactsOAuth({ state, code, baseUrl: requestBaseUrl(req) });
      const returnUrl = new URL(result.returnUrl, requestBaseUrl(req));
      returnUrl.searchParams.set("google", "connected");
      res.redirect(`${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      res.redirect(`/?section=callSystem&callTab=contacts&google=error&message=${encodeURIComponent(message.slice(0, 300))}`);
    }
  }));
}

export function registerGoogleContactsRoutes(app: Express, options: { ownerUid: () => string }) {
  app.get("/api/integrations/google-contacts/status", requireCapability("mobile.contacts.sync"), (req, res) => {
    const user = (req as AuthedRequest).user;
    res.setHeader("Cache-Control", "no-store");
    res.json(googleContactsStatus(options.ownerUid(), user.uid, requestBaseUrl(req)));
  });

  app.post("/api/integrations/google-contacts/connect", requireCapability("mobile.contacts.sync"), (req, res) => {
    const user = (req as AuthedRequest).user;
    try {
      res.json(beginGoogleContactsOAuth({
        ownerUid: options.ownerUid(), userUid: user.uid, baseUrl: requestBaseUrl(req),
        returnUrl: String(req.body?.returnUrl || "/?section=callSystem&callTab=contacts"),
      }));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/integrations/google-contacts/disconnect", requireCapability("mobile.contacts.sync"), (req, res) => {
    const user = (req as AuthedRequest).user;
    res.json({ disconnected: disconnectGoogleContacts(options.ownerUid(), user.uid) });
  });

  app.post("/api/integrations/google-contacts/sync", requireCapability("mobile.contacts.sync"), asyncRoute(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const status = googleContactsStatus(options.ownerUid(), user.uid, requestBaseUrl(req));
    if (!status.connected) {
      res.status(409).json({ error: "اربط حساب Google أولًا ثم أعد المزامنة." });
      return;
    }
    res.json(await syncNamedGoogleContacts({
      ownerUid: options.ownerUid(), userUid: user.uid, baseUrl: requestBaseUrl(req),
      limit: Math.max(1, Math.min(500, Number(req.body?.limit || 100))),
    }));
  }));
}
