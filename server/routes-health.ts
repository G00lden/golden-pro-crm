import type { Express, Request, Response } from "express";
import { todayInTimeZone } from "./reminderEngine";
import { outboundSafetyStatus } from "./outboundSafety";
import { getReminderSchedulerState } from "./reminderEngine";
import { getStoreWebhookPublicState } from "./storeWebhook";
import { buildCommit, releaseInfo } from "./releaseInfo";

const timeZone = process.env.APP_TIMEZONE || "Asia/Riyadh";

export function registerHealthRoutes(app: Express) {
  app.get("/api/version", (_req: Request, res: Response) => {
    res.json({
      ...releaseInfo,
      commit: buildCommit,
    });
  });

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      release: releaseInfo,
      commit: buildCommit,
      timeZone,
      today: todayInTimeZone(),
      reminders: getReminderSchedulerState(),
      storeWebhook: getStoreWebhookPublicState(),
      outbound: outboundSafetyStatus(),
    });
  });
}
