import type { NextFunction, Request, Response } from "express";
import type { AuthedRequest } from "./auth";
import { hasAppCapability, type AppCapability } from "../shared/accessControl";

export function requireCapability(capability: AppCapability) {
  return function capabilityGuard(req: Request, res: Response, next: NextFunction) {
    const user = (req as AuthedRequest).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    if (!hasAppCapability(user.role, capability, user.permissions || {})) {
      res.status(403).json({ error: "ليست لديك الصلاحية الكافية لتنفيذ هذا الإجراء." });
      return;
    }
    next();
  };
}
