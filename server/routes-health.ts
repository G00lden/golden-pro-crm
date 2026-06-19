import type { Express, Request, Response } from "express";
import { todayInTimeZone } from "./reminderEngine";
import { outboundSafetyStatus } from "./outboundSafety";
import { getReminderSchedulerState } from "./reminderEngine";
import { getStoreWebhookPublicState } from "./storeWebhook";

const timeZone = process.env.APP_TIMEZONE || "Asia/Riyadh";

export function registerHealthRoutes(app: Express) {
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timeZone,
      today: todayInTimeZone(),
      reminders: getReminderSchedulerState(),
      storeWebhook: getStoreWebhookPublicState(),
      outbound: outboundSafetyStatus(),
    });
  });
}
