import type { Express, Request, Response, NextFunction } from "express";
import type { AuthedRequest } from "./auth";
import {
  getReminderDiagnostics,
  getReminderSchedulerState,
  runDueReminders,
  sendReminderForInstallation,
} from "./reminderEngine";

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function registerReminderRoutes(app: Express) {
  app.get(
    "/api/reminders/diagnostics",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await getReminderDiagnostics(userReq.user.uid));
    }),
  );

  app.get("/api/reminders/scheduler", (_req, res) => {
    res.json(getReminderSchedulerState());
  });

  app.post(
    "/api/installations/:id/remind",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      const result = await sendReminderForInstallation(
        req.params.id,
        userReq.user.uid,
        req.body?.type,
        "manual",
        req.body?.outboundCode,
      );
      res.json(result);
    }),
  );

  app.post(
    "/api/reminders/run-due",
    asyncRoute(async (req, res) => {
      const userReq = req as AuthedRequest;
      res.json(await runDueReminders({
        uid: userReq.user.uid,
        mode: req.body?.mode || "manual",
        outboundCode: req.body?.outboundCode,
      }));
    }),
  );
}
