import "dotenv/config";
import crypto from "node:crypto";
import process from "node:process";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import pino from "pino";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || "3117");
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "").trim();
const NODE_ENV = process.env.NODE_ENV || "development";
const ALLOW_INSECURE_NO_SECRET = process.env.ALLOW_INSECURE_NO_SECRET === "true";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const logger = pino({ level: LOG_LEVEL });
const app = express();
const startedAt = Date.now();

const rawCorsOrigin = process.env.CORS_ORIGIN ?? "";
const corsOriginList = rawCorsOrigin.split(",").map((s) => s.trim()).filter(Boolean);

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) { callback(null, true); return; }

    if (corsOriginList.length > 0) {
      callback(null, corsOriginList.includes(origin));
      return;
    }

    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    callback(null, isLocalhost);
  },
}));
app.use(express.json({ limit: "512kb" }));

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  next();
});

const insecureSecretBypass = !WEBHOOK_SECRET && NODE_ENV !== "production" && ALLOW_INSECURE_NO_SECRET;
if (!WEBHOOK_SECRET && !insecureSecretBypass) {
  throw new Error("WEBHOOK_SECRET is required. To bypass only in development, set ALLOW_INSECURE_NO_SECRET=true.");
}

if (insecureSecretBypass) {
  logger.warn("[amazon] WEBHOOK_SECRET not set - insecure development bypass is enabled via ALLOW_INSECURE_NO_SECRET=true.");
}

function safeCompare(a: string, b: string): boolean {
  const key = Buffer.alloc(32);
  const ha = crypto.createHmac("sha256", key).update(a).digest();
  const hb = crypto.createHmac("sha256", key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireWebhookSecret(req: Request, res: Response, next: NextFunction) {
  if (!WEBHOOK_SECRET) {
    if (insecureSecretBypass) {
      next();
      return;
    }
    res.status(403).json({ error: "Forbidden: WEBHOOK_SECRET not configured" });
    return;
  }

  const received = req.header("x-webhook-secret") || req.header("x-ops-token") || "";
  if (!safeCompare(received, WEBHOOK_SECRET)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}

app.get("/health", requireWebhookSecret, (_req, res) => {
  res.json({
    ok: true,
    service: "amazon-affiliate",
    uptimeSec: Math.max(Math.floor((Date.now() - startedAt) / 1000), 0),
    stats: {
      host: HOST,
      port: PORT,
      nodeEnv: NODE_ENV,
      now: new Date().toISOString(),
    },
  });
});

app.get("/", requireWebhookSecret, (_req, res) => {
  res.json({ ok: true, service: "amazon-affiliate" });
});

app.listen(PORT, HOST, () => {
  logger.info({ host: HOST, port: PORT }, "amazon affiliate service online");
});
