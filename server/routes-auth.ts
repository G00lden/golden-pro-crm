import type { Express, Request, Response, NextFunction } from "express";
import { validate, loginSchema, registerSchema } from "./validation";
import { authenticate, generateToken, createUser, findUserByEmail } from "./localAuth";

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

function createRateLimiter(options: { windowMs: number; max: number; name: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  function clientIp(req: Request) {
    return String(
      req.get("cf-connecting-ip") ||
        req.get("x-real-ip") ||
        req.get("x-forwarded-for")?.split(",")[0] ||
        req.socket.remoteAddress ||
        "unknown",
    ).trim();
  }

  function prune(now: number) {
    if (hits.size < 5000) return;
    for (const [key, bucket] of hits) {
      if (bucket.resetAt <= now) hits.delete(key);
    }
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.DISABLE_RATE_LIMIT === "true") {
      next();
      return;
    }

    const now = Date.now();
    prune(now);
    const key = `${options.name}:${clientIp(req)}`;
    const current = hits.get(key);
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    hits.set(key, bucket);

    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, options.max - bucket.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.max) {
      res.status(429).json({ error: "Too many requests. Please try again shortly." });
      return;
    }

    next();
  };
}

export function registerAuthRoutes(app: Express) {
  const authRateLimit = createRateLimiter({
    windowMs: 300_000,
    max: 20,
    name: "auth",
  });

  app.post(
    "/api/auth/login",
    authRateLimit,
    validate(loginSchema),
    asyncRoute(async (req, res) => {
      const { email, password } = req.body as { email: string; password: string };
      const user = authenticate(email, password);
      if (!user) {
        res.status(401).json({ error: "Invalid email or password." });
        return;
      }
      const token = generateToken(user);
      res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    }),
  );

  app.post(
    "/api/auth/register",
    authRateLimit,
    validate(registerSchema),
    asyncRoute(async (req, res) => {
      const { email, password, name } = req.body as { email: string; password: string; name?: string };
      const existing = findUserByEmail(email);
      if (existing) {
        res.status(409).json({ error: "Email already registered." });
        return;
      }
      const user = createUser(email, password, name || "");
      const token = generateToken(user);
      res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    }),
  );
}
