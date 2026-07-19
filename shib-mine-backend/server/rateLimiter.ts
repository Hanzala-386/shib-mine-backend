/* ────────────────────────────────────────────────────────────────────────────
 * Basic API request limiter — keeps the server smooth under bursty or runaway
 * clients. Fixed 60s window; keyed per-user (pbId) when the request carries
 * one, else per-IP. Per-user keying matters because most players are mobile
 * users behind carrier NAT (many users share one IP) — a pure-IP limiter
 * would throttle innocent users collectively.
 * In-memory only (single-process server); resets on restart, which is fine
 * for a smoothing limiter (not a security boundary).
 * ──────────────────────────────────────────────────────────────────────────── */
import type { Request, Response, NextFunction } from "express";

const WINDOW_MS = 60_000;
// Generous ceilings — normal app polling stays far below these.
const MAX_PER_USER = 240; // authenticated app traffic (pbId present)
const MAX_PER_IP = 300;   // unauthenticated / shared-IP fallback
const CLEANUP_MS = 5 * 60_000;

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();

function clientIp(req: Request): string {
  // `trust proxy` is set in index.ts, so req.ip is the proxy-verified client
  // address. Never parse x-forwarded-for ourselves — the first hop is
  // client-controlled and spoofable.
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// PocketBase record IDs are 15-char alphanumeric segments.
const PB_ID_SEGMENT = /^[a-zA-Z0-9]{15}$/;

/** Prefer a per-user key when the request identifies the user; else per-IP. */
function limiterKey(req: Request): { key: string; max: number } {
  let pbId =
    (req.body && typeof req.body === "object" && (req.body as any).pbId) ||
    (req.query && (req.query as any).pbId);
  if (!(typeof pbId === "string" && /^[a-zA-Z0-9_-]{5,32}$/.test(pbId))) {
    // Route-param IDs (e.g. /api/app/mine/active/:pbId) aren't visible in
    // req.params from an app.use() middleware, so scan the path segments for
    // a PB-id-shaped one. GET polling routes carry the user ID this way.
    pbId = undefined;
    for (const seg of req.path.split("/")) {
      if (PB_ID_SEGMENT.test(seg)) { pbId = seg; break; }
    }
  }
  if (typeof pbId === "string" && pbId.length > 0) {
    return { key: `u:${pbId}`, max: MAX_PER_USER };
  }
  return { key: `ip:${clientIp(req)}`, max: MAX_PER_IP };
}

// Periodic sweep so the map can't grow without bound.
const sweeper: any = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.windowStart > WINDOW_MS * 2) buckets.delete(k);
  }
}, CLEANUP_MS);
if (typeof sweeper?.unref === "function") sweeper.unref();

export function apiRateLimiter() {
  return (req: Request, res: Response, next: NextFunction) => {
    const { key, max } = limiterKey(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.windowStart >= WINDOW_MS) {
      b = { count: 0, windowStart: now };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      if (b.count === max + 1) {
        console.warn(`[rateLimiter] 429 for ${key} (${b.count} req in window)`);
      }
      return res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
    }
    next();
  };
}
