import type { NextFunction, Request, Response } from "express";
import { isProductionEnvironment } from "../shared/accessControl";

export function createDemoDataEnvironmentGuard(
  environment: () => unknown = () => process.env.NODE_ENV,
) {
  return function demoDataEnvironmentGuard(_req: Request, res: Response, next: NextFunction) {
    if (isProductionEnvironment(environment())) {
      res.status(403).json({ error: "بيانات التجربة معطلة في بيئة الإنتاج." });
      return;
    }
    next();
  };
}

export const requireNonProductionDemoData = createDemoDataEnvironmentGuard();
