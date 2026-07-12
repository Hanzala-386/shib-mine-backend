// ─── Network Guard — VPN / Proxy / Datacenter / Geo blocking ─────────────────
// Zero-Tolerance network security layer. Enforced on every /api/app/* request
// (middleware in index.ts) and on WebSocket upgrades. Two detection layers:
//
//   Layer 1 — Local CIDR lists (X4BNet lists_vpn on GitHub): known VPN exit
//             nodes + datacenter/VPS ranges. Refreshed every 24 h in memory.
//             Always enforced (never depends on an external API being up).
//   Layer 2 — proxycheck.io API: VPN/proxy/hosting classification + country
//             + region (covers Crimea / Donetsk / Luhansk region-level geo).
//             Fail-OPEN on provider error/timeout so an outage never bricks
//             the app; layer 1 still enforces during an outage.
//
// Verdicts are cached in memory per IP for 6 h (user-requested TTL) to stay
// within the proxycheck free tier. A VPN toggle changes the client IP itself,
// so caching does NOT delay detection — a new IP is always a fresh lookup.
//
// Kill switch: PocketBase settings.network_guard_enabled (admin panel toggle,
// default OFF). Env overrides for local testing:
//   NETWORK_GUARD_FORCE=1    → guard active regardless of the PB toggle
//   NETWORK_GUARD_DISABLED=1 → guard inactive regardless of the PB toggle
//
// IMPORTANT: this file must stay byte-identical between server/ and
// shib-mine-backend/server/ (dev + Railway prod copies).

import type { Request, Response, NextFunction } from "express";

// ── Blocklists ────────────────────────────────────────────────────────────────
// ISO 3166-1 alpha-2 codes: Iran, North Korea, Syria, Cuba, Afghanistan,
// Venezuela, Yemen, Somalia, Sudan, Zimbabwe.
const BLOCKED_COUNTRY_CODES = new Set([
  "IR", "KP", "SY", "CU", "AF", "VE", "YE", "SO", "SD", "ZW",
]);
// Region-level blocks inside otherwise-allowed countries (occupied UA regions).
// Matched case-insensitively against proxycheck's region/regionname string.
const BLOCKED_REGION_KEYWORDS = [
  "crimea", "donetsk", "luhansk", "lugansk", "sevastopol",
];

export const NETWORK_BLOCK_MESSAGE =
  "Access Restricted: Your network configuration is not allowed on this " +
  "platform. Please disable any VPN or proxy services to continue.";

export type NetworkVerdict = {
  blocked: boolean;
  // "geo" | "vpn" | "proxy" | "hosting" | null
  reason: string | null;
};

// ── Per-IP verdict cache (6 h TTL, capped) ────────────────────────────────────
const VERDICT_TTL_MS = 6 * 3_600_000; // 6 hours — per user request
const FAIL_OPEN_TTL_MS = 5 * 60_000; // provider failed → retry after 5 min
const CACHE_MAX_ENTRIES = 20_000;

type CacheEntry = { verdict: NetworkVerdict; expiresAt: number };
const verdictCache = new Map<string, CacheEntry>();

function cacheVerdict(ip: string, verdict: NetworkVerdict, ttlMs: number) {
  if (verdictCache.size >= CACHE_MAX_ENTRIES) {
    // Evict ~oldest 10% (Map preserves insertion order)
    let n = Math.ceil(CACHE_MAX_ENTRIES / 10);
    for (const key of verdictCache.keys()) {
      verdictCache.delete(key);
      if (--n <= 0) break;
    }
  }
  verdictCache.set(ip, { verdict, expiresAt: Date.now() + ttlMs });
}

// ── IP helpers ────────────────────────────────────────────────────────────────
function normalizeIp(raw: string): string {
  let ip = (raw || "").trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // IPv4-mapped IPv6
  return ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

export function isPrivateOrLocalIp(rawIp: string): boolean {
  const ip = normalizeIp(rawIp);
  if (!ip) return true;
  if (ip === "::1" || ip === "localhost") return true;
  // IPv6 link-local / unique-local
  const lower = ip.toLowerCase();
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }
  const n = ipv4ToInt(ip);
  if (n === null) return false; // public IPv6 — not private
  const a = n >>> 24;
  const b = (n >>> 16) & 0xff;
  if (a === 10 || a === 127) return true; // 10/8, 127/8
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT (internal)
  return false;
}

// ── Layer 1: local CIDR lists (X4BNet lists_vpn) ─────────────────────────────
// Sorted, merged [start, end] ranges for binary search. IPv4 only — IPv6
// clients are covered by layer 2 (proxycheck).
const CIDR_SOURCES: Array<{ url: string; reason: string }> = [
  {
    url: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt",
    reason: "vpn",
  },
  {
    url: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt",
    reason: "hosting",
  },
];
const CIDR_REFRESH_MS = 24 * 3_600_000;

type IpRange = { start: number; end: number; reason: string };
let cidrRanges: IpRange[] = []; // sorted by start

function parseCidrLine(line: string, reason: string): IpRange | null {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const [base, bitsStr] = t.split("/");
  const start = ipv4ToInt(base);
  if (start === null) return null;
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = bits === 0 ? 0x1_0000_0000 : 2 ** (32 - bits);
  const rangeStart = bits === 0 ? 0 : (start - (start % size)) >>> 0;
  return { start: rangeStart, end: rangeStart + size - 1, reason };
}

async function refreshCidrLists(): Promise<void> {
  const next: IpRange[] = [];
  let anySuccess = false;
  for (const src of CIDR_SOURCES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      const resp = await fetch(src.url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      let count = 0;
      for (const line of text.split("\n")) {
        const r = parseCidrLine(line, src.reason);
        if (r) {
          next.push(r);
          count++;
        }
      }
      anySuccess = true;
      console.log(`[networkGuard] CIDR list loaded: ${src.reason} (${count} ranges)`);
    } catch (e: any) {
      console.warn(`[networkGuard] CIDR list fetch failed (${src.reason}):`, e?.message);
    }
  }
  if (anySuccess && next.length > 0) {
    next.sort((x, y) => x.start - y.start);
    // Merge overlapping/adjacent intervals — binary search over overlapping
    // ranges is unsound (a probe landing on a narrow nested range would miss
    // IPs covered only by the enclosing wider range). Reason precedence:
    // "vpn" wins over "hosting" when ranges merge.
    const merged: IpRange[] = [];
    for (const r of next) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end + 1) {
        if (r.end > last.end) last.end = r.end;
        if (r.reason === "vpn") last.reason = "vpn";
      } else {
        merged.push({ ...r });
      }
    }
    cidrRanges = merged; // atomic swap; keep old lists if all fetches failed
    console.log(
      `[networkGuard] CIDR ranges merged: ${next.length} → ${merged.length}`,
    );
  }
}

function cidrLookup(rawIp: string): string | null {
  const n = ipv4ToInt(normalizeIp(rawIp));
  if (n === null || cidrRanges.length === 0) return null;
  let lo = 0;
  let hi = cidrRanges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = cidrRanges[mid];
    if (n < r.start) hi = mid - 1;
    else if (n > r.end) lo = mid + 1;
    else return r.reason;
  }
  return null;
}

// ── Layer 2: proxycheck.io lookup ─────────────────────────────────────────────
// Returns a verdict, or null when the provider is unreachable (fail-open).
async function proxycheckLookup(rawIp: string): Promise<NetworkVerdict | null> {
  const ip = normalizeIp(rawIp);
  const key = process.env.PROXYCHECK_API_KEY || "";
  const url =
    `https://proxycheck.io/v2/${encodeURIComponent(ip)}` +
    `?vpn=3&asn=1&risk=1${key ? `&key=${encodeURIComponent(key)}` : ""}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4_000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data: any = await resp.json();
    if (data?.status && data.status !== "ok" && data.status !== "warning") {
      // "denied" (rate limit / bad key) or "error" — fail open
      console.warn(`[networkGuard] proxycheck status=${data.status} ${data.message ?? ""}`);
      return null;
    }
    const info = data?.[ip];
    if (!info || typeof info !== "object") return null;

    // 1) Geo: country + occupied-region keywords
    const iso = String(info.isocode ?? "").toUpperCase();
    if (BLOCKED_COUNTRY_CODES.has(iso)) {
      return { blocked: true, reason: "geo" };
    }
    const regionHaystack =
      `${info.region ?? ""} ${info.regionname ?? ""} ${info.city ?? ""}`.toLowerCase();
    if (BLOCKED_REGION_KEYWORDS.some((k) => regionHaystack.includes(k))) {
      return { blocked: true, reason: "geo" };
    }

    // 2) VPN / proxy of any type
    const proxyFlag = String(info.proxy ?? "").toLowerCase() === "yes";
    const type = String(info.type ?? "").toLowerCase();
    if (proxyFlag || type.includes("vpn")) {
      return { blocked: true, reason: type.includes("vpn") ? "vpn" : "proxy" };
    }

    // 3) Datacenter / VPS hosting
    const hostingFlag =
      String(info.hosting ?? "").toLowerCase() === "yes" || type === "hosting";
    if (hostingFlag) {
      return { blocked: true, reason: "hosting" };
    }

    return { blocked: false, reason: null };
  } catch (e: any) {
    console.warn(`[networkGuard] proxycheck lookup failed for ${ip}:`, e?.message);
    return null; // fail-open
  }
}

// ── Core verdict engine ───────────────────────────────────────────────────────
// In-flight de-duplication so a burst of parallel requests from one new IP
// costs a single proxycheck query.
const inFlight = new Map<string, Promise<NetworkVerdict>>();

export async function checkNetworkAccess(rawIp: string): Promise<NetworkVerdict> {
  const ip = normalizeIp(rawIp);
  if (!ip || isPrivateOrLocalIp(ip)) return { blocked: false, reason: null };

  const cached = verdictCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.verdict;

  const pending = inFlight.get(ip);
  if (pending) return pending;

  const task = (async (): Promise<NetworkVerdict> => {
    // Layer 1 — local CIDR lists (free, instant, always available)
    const cidrHit = cidrLookup(ip);
    if (cidrHit) {
      const verdict: NetworkVerdict = { blocked: true, reason: cidrHit };
      cacheVerdict(ip, verdict, VERDICT_TTL_MS);
      console.warn(`[networkGuard] BLOCKED ${ip} (cidr:${cidrHit})`);
      return verdict;
    }

    // Layer 2 — proxycheck.io
    const apiVerdict = await proxycheckLookup(ip);
    if (apiVerdict === null) {
      // Provider unreachable — fail open, short cache so we retry soon
      const verdict: NetworkVerdict = { blocked: false, reason: null };
      cacheVerdict(ip, verdict, FAIL_OPEN_TTL_MS);
      return verdict;
    }
    // Boot window: if the CIDR lists haven't loaded yet, a "clean" verdict may
    // only be clean because Layer 1 was empty — cache it briefly so the IP is
    // re-evaluated once the lists arrive. Blocked verdicts keep the full TTL.
    const cidrReady = cidrRanges.length > 0;
    cacheVerdict(
      ip,
      apiVerdict,
      apiVerdict.blocked || cidrReady ? VERDICT_TTL_MS : FAIL_OPEN_TTL_MS,
    );
    if (apiVerdict.blocked) {
      console.warn(`[networkGuard] BLOCKED ${ip} (proxycheck:${apiVerdict.reason})`);
    }
    return apiVerdict;
  })().finally(() => inFlight.delete(ip));

  inFlight.set(ip, task);
  return task;
}

// ── Enabled state ─────────────────────────────────────────────────────────────
// PB settings toggle is injected by routes.ts (setNetworkGuardSettingsProvider)
// so this module has no PocketBase dependency. Result cached 60 s.
let settingsProvider: (() => Promise<boolean>) | null = null;
let enabledCache: { value: boolean; at: number } | null = null;

export function setNetworkGuardSettingsProvider(fn: () => Promise<boolean>) {
  settingsProvider = fn;
}

export async function isNetworkGuardEnabled(): Promise<boolean> {
  if (process.env.NETWORK_GUARD_DISABLED === "1") return false;
  if (process.env.NETWORK_GUARD_FORCE === "1") return true;
  if (!settingsProvider) return false;
  if (enabledCache && Date.now() - enabledCache.at < 60_000) return enabledCache.value;
  try {
    const value = await settingsProvider();
    enabledCache = { value, at: Date.now() };
    return value;
  } catch {
    return enabledCache?.value ?? false;
  }
}

// ── Express middleware (mount at /api/app in index.ts) ────────────────────────
export function networkGuardMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.method === "OPTIONS") return next();
      // The check endpoint itself must stay reachable (it returns the verdict
      // the client polls for) — never 403 it.
      if (req.path.startsWith("/security/network-check")) return next();
      if (!(await isNetworkGuardEnabled())) return next();

      const verdict = await checkNetworkAccess(req.ip || "");
      if (!verdict.blocked) return next();

      return res.status(403).json({
        blocked: true,
        code: "NETWORK_BLOCKED",
        reason: verdict.reason,
        error: NETWORK_BLOCK_MESSAGE,
      });
    } catch (e: any) {
      // Guard must never take the API down — fail open on internal errors.
      console.warn("[networkGuard] middleware error (fail-open):", e?.message);
      return next();
    }
  };
}

// ── WebSocket upgrade guard ───────────────────────────────────────────────────
// Raw upgrade requests bypass Express, so extract the client IP the same way
// `trust proxy = 1` does: the LAST X-Forwarded-For entry (appended by our own
// trusted reverse proxy — earlier entries are client-supplied and spoofable).
export function clientIpFromUpgrade(request: {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): string {
  const xff = request.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  if (raw) {
    const parts = String(raw).split(",");
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
  }
  return request.socket?.remoteAddress || "";
}

/** Returns true when the upgrade may proceed. When blocked, writes a raw
 *  HTTP 403 response and destroys the socket. */
export async function guardWebSocketUpgrade(
  request: any,
  socket: { write: (s: string) => void; destroy: () => void },
): Promise<boolean> {
  try {
    if (!(await isNetworkGuardEnabled())) return true;
    const ip = clientIpFromUpgrade(request);
    const verdict = await checkNetworkAccess(ip);
    if (!verdict.blocked) return true;
    try {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\n" +
          "Content-Type: application/json\r\n" +
          "Connection: close\r\n\r\n" +
          JSON.stringify({ blocked: true, code: "NETWORK_BLOCKED", reason: verdict.reason }),
      );
    } catch {}
    try {
      socket.destroy();
    } catch {}
    return false;
  } catch (e: any) {
    console.warn("[networkGuard] ws guard error (fail-open):", e?.message);
    return true; // fail-open
  }
}

// ── Init — load CIDR lists now + refresh daily ────────────────────────────────
let initialized = false;

export function initNetworkGuard() {
  if (initialized) return;
  initialized = true;
  refreshCidrLists().catch(() => {});
  setInterval(() => refreshCidrLists().catch(() => {}), CIDR_REFRESH_MS).unref();
  console.log("[networkGuard] initialized (CIDR refresh every 24h, verdict cache 6h)");
}
