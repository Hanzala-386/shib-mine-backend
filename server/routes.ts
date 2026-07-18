import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import multer from "multer";
import { WebSocketServer } from "ws";
import {
  effectiveRatePerSec,
  normalizeVipLevel,
  highestBalanceEligibleTier,
  VIP_REQUIREMENTS,
  meetsVipRequirements,
  unmetVipRequirements,
  lockedBalanceForVipLevel,
  MAX_VIP_LEVEL,
} from "../shared/vip";
import { ticketsToShib, validateRedeem } from "../shared/gamehub";
import {
  findKycCountry,
  isKycCountryBlocked,
  isBinanceSupported,
  BINANCE_WITHDRAW_COUNTRY,
  normalizeKycStatus,
  validateBep20Address,
  validateKycEmail,
  validateKycPhone,
} from "../shared/kyc";
import {
  checkNetworkAccess,
  isNetworkGuardEnabled,
  setNetworkGuardSettingsProvider,
  setNetworkGuardKeyProvider,
} from "./networkGuard";

// ─── Multer — memory storage for proof screenshot uploads ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
});


const PB_URL = "https://api.webcod.in";

// ─── PocketBase HTTP helper ────────────────────────────────────────────────
function pbHttp(
  method: string,
  path: string,
  body: object | null,
  token?: string,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (data) headers["Content-Length"] = String(Buffer.byteLength(data));

    const url = new URL(path, PB_URL);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch {
            resolve({ raw: b });
          }
        });
      },
    );
    // 30-second hard timeout for all PocketBase requests
    req.setTimeout(30_000, () => {
      req.destroy(new Error("PocketBase request timed out after 30s"));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── PocketBase multipart helpers (file uploads) ──────────────────────────
async function pbFetchMultipart(method: string, path: string, form: FormData): Promise<any> {
  const token = await getAdminToken();
  const url = new URL(path, PB_URL).toString();
  const res = await globalThis.fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return res.json();
}

// ─── Admin token cache ─────────────────────────────────────────────────────
let adminToken = "";
let tokenExpiry = 0;

async function getAdminToken(): Promise<string> {
  if (adminToken && Date.now() < tokenExpiry) return adminToken;
  const res = await pbHttp(
    "POST",
    "/api/admins/auth-with-password",
    {
      identity: process.env.PB_ADMIN_EMAIL,
      password: process.env.PB_ADMIN_PASSWORD,
    },
    undefined,
  );
  if (!res.token) throw new Error(`PB admin auth failed: ${JSON.stringify(res)}`);
  adminToken = res.token;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23 hours
  return adminToken;
}

// ─── WebSocket game session anti-cheat ────────────────────────────────────
// Supports two game modes on the same /api/ws/game endpoint:
//
//  Weapon Master (Construct 3) — score-validation mode:
//    GAME_START → SESSION_READY → ... play ... → GAME_OVER {score, elapsed_ms}
//    Server validates score ≤ elapsed_ms/1000 × 15 pts/sec and ≤ 2000, then
//    stores last_session_score.  No per-action signals needed.
//
//  Knife Hit — per-hit mode (legacy, kept for possible future use):
//    GAME_START → SESSION_READY → KNIFE_HIT × N → GAME_OVER
//    Server counts hits at 5 PT each with timing/burst guards.

const WS_PT_PER_HIT   = 5;           // tokens awarded per validated hit
const WS_MAX_PT       = 2000;        // hard session cap
const WS_MAX_HITS     = WS_MAX_PT / WS_PT_PER_HIT;  // 400 hits
const WS_MIN_HIT_MS   = 280;         // 300ms poll interval - 20ms jitter tolerance
const WS_BURST_WINDOW = 5_000;       // rolling ms window for burst detection
const WS_BURST_MAX    = 18;          // max hits in BURST_WINDOW: 1/300ms tick × 5s ≈ 16-17
const WS_SESSION_MS   = 3 * 60_000; // 3-minute hard timer
const WS_SESSION_GRACE_MS = 15_000;  // grace so the client's GAME_OVER (with the displayed score) lands BEFORE the server auto-commit on max-length games — payout stays bounded by the 185s elapsed clamp regardless

interface WsGameSession {
  pbId: string;
  hits: number;
  serverPT: number;
  startMs: number;
  lastHitMs: number;
  hitLog: number[];    // timestamps of recent hits
  rejectLog: number[]; // timestamps of REJECTED hits (shadow-blacklist monitor)
  committed: boolean;
  blacklisted: boolean; // impossible score detected → match voided, 0 PT
  legacy: boolean;      // old-bridge client (no `v` in GAME_START) → no hard gate
  logId: string | null; // game_score record id created at GAME_START
  timer: ReturnType<typeof setTimeout> | null;
}

const wsSessions = new Map<string, WsGameSession>();

// Semver-ish compare: true iff v is a parseable "x.y.z" >= min.
// Absent/garbage input → false (treated as legacy — never blocks a client).
function appVersionAtLeast(v: unknown, min: string): boolean {
  if (typeof v !== "string" || !v.trim()) return false;
  const a = v.trim().split(".").map(n => parseInt(n, 10));
  const b = min.split(".").map(n => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = a[i], y = b[i] ?? 0;
    if (!Number.isFinite(x)) return false;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

// ─── Cryptographically signed match ids ─────────────────────────────────────
// matchId format: "<uuid>.<hmac16>" — the HMAC-SHA256 signature is embedded in
// the id itself, so every client/bridge passes it through untouched (opaque
// string; NO client or bridge.js change needed). Claims presenting a matchId
// whose signature does not verify are rejected outright before any DB work.
// Unsigned ids (no ".") are legacy sessions created before this deploy — they
// fall through to the existing DB row validation.
const MATCH_SIG_SECRET = process.env.SESSION_SECRET || "shib-match-sig-v1";
if (!process.env.SESSION_SECRET) {
  console.warn("[anti-cheat] SESSION_SECRET is NOT set — match signatures use the built-in fallback key. Set SESSION_SECRET in this environment for production-grade signing.");
}
// The signature binds BOTH the match uuid AND the owning pbId — a matchId
// issued to account A fails verification when presented by account B.
function signMatchId(pbId: string): string {
  const id = crypto.randomUUID();
  const sig = crypto.createHmac("sha256", MATCH_SIG_SECRET).update(`${id}:${pbId}`).digest("hex").slice(0, 16);
  return `${id}.${sig}`;
}
function matchSigState(matchId: string, pbId: string): "valid" | "invalid" | "unsigned" {
  const dot = matchId.lastIndexOf(".");
  if (dot < 0) return "unsigned";
  const id  = matchId.slice(0, dot);
  const sig = matchId.slice(dot + 1);
  const expected = crypto.createHmac("sha256", MATCH_SIG_SECRET).update(`${id}:${pbId}`).digest("hex").slice(0, 16);
  try {
    return sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
      ? "valid" : "invalid";
  } catch { return "invalid"; }
}

// ─── Account-level anti-cheat flag ───────────────────────────────────────────
// Impossible score / claim tampering → flag the ACCOUNT (not just the match):
// first offense sets is_blacklist_1, repeat offense escalates to is_blacklist_2
// (same soft-tier convention as the referral anti-cheat, surfaced in the admin
// panel). Fire-and-forget — never blocks or fails the request flow.
async function flagUserBlacklist(pbId: string, reason: string): Promise<void> {
  try {
    const u = await pbGet(`/api/collections/users/records/${pbId}?fields=id,is_blacklist_1,is_blacklist_2`);
    if (!u || u.code) return;
    const body = u.is_blacklist_1 ? { is_blacklist_2: true } : { is_blacklist_1: true };
    await pbPatch(`/api/collections/users/records/${pbId}`, body);
    console.warn(`[anti-cheat] ACCOUNT FLAGGED ${Object.keys(body)[0]} (${pbId}): ${reason}`);
  } catch (e: any) {
    console.warn(`[anti-cheat] account flag failed (${pbId}):`, e.message);
  }
}

async function wsCommitSession(sid: string, session: WsGameSession): Promise<void> {
  if (session.committed) return;
  session.committed = true;
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
  const finalPT = session.blacklisted ? 0 : session.serverPT;
  const status  = session.blacklisted ? "blacklisted" : "started";
  console.log(`[ws/game] commit ${sid.slice(0, 8)}: ${session.hits} hits = ${finalPT} PT status=${status} (${session.pbId})`);
  try {
    // Store as last_session_score — the existing REST claim/double flow reads it
    await pbPatch(`/api/collections/users/records/${session.pbId}`, {
      last_session_score: finalPT,
    });
    // Match lifecycle: the game_score row was created at GAME_START with
    // match_status "active". PATCH the SAME row (by id, or by match_id lookup)
    // to "started" (= awaiting claim) with the server-validated raw_score.
    // final_tokens mirrors raw_score here (1× default); the claim PATCH sets
    // the final value: is_double ? raw_score*2 : raw_score. "blacklisted"
    // voids the match entirely.
    const logBody = {
      raw_score:    finalPT,
      final_tokens: finalPT,
      match_status: status,
    };
    if (session.logId) {
      pbPatch(`/api/collections/game_score/records/${session.logId}`, logBody).catch(() => {});
    } else {
      // Row id unknown (legacy async create still in flight, or it failed).
      // PATCH-or-INSERT by match_id — NEVER a blind insert: one game = one row.
      (async () => {
        const found = await pbGet(
          `/api/collections/game_score/records?filter=${encodeURIComponent(`match_id="${sid}"`)}&perPage=1`
        );
        const row = found?.items?.[0];
        if (row?.id) {
          await pbPatch(`/api/collections/game_score/records/${row.id}`, logBody);
        } else if (session.legacy) {
          // LEGACY clients only: the best-effort create at GAME_START never
          // landed — write the one row now so the claim path can validate.
          // (A stray late GAME_START insert is deleted by its own race guard.)
          await pbPost("/api/collections/game_score/records", {
            user:      session.pbId,
            user_id:   session.pbId,
            is_double: false,
            match_id:  sid,
            ...logBody,
          });
        }
      })().catch(() => {});
    }
  } catch (e: any) {
    console.error(`[ws/game] commit error (${session.pbId}):`, e.message);
  }
  wsSessions.delete(sid);
}

export function setupGameWebSocket(wss: WebSocketServer): void {
  wss.on("connection", (ws) => {
    let sid: string | null = null;
    const send = (obj: object) => { try { ws.send(JSON.stringify(obj)); } catch {} };

    ws.on("message", async (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.type) {

        case "GAME_START": {
          const { pbId } = msg;
          if (!pbId) { send({ type: "ERROR", reason: "pbId_required" }); return; }
          // VERSION-AWARE routing keyed on APP version (NOT bridge version —
          // bridge.js on webcod.in is SHARED by all APKs, so a bridge flag
          // alone cannot separate 1.0.2 from 1.0.3):
          //   appVersion >= 1.0.3 → NEW security logic: hard gate (match row
          //     confirmed before SESSION_READY) + strict verification.
          //   appVersion absent or < 1.0.3 (ALL legacy APKs incl. 1.0.2) →
          //     LEGACY logic: immediate SESSION_READY, best-effort match row,
          //     no hard gate — plays exactly as before.
          // The 1.0.3+ RN app passes appVersion via INJECT_VARS and the
          // bridge forwards it here in GAME_START.
          const strictClient = appVersionAtLeast(msg.appVersion, "1.0.3");
          const user = await pbGet(`/api/collections/users/records/${pbId}?fields=id`);
          if (user.code) { send({ type: "ERROR", reason: "user_not_found" }); return; }
          // Clean up any prior session on this connection
          if (sid) {
            const old = wsSessions.get(sid);
            if (old && !old.committed) { old.committed = true; if (old.timer) clearTimeout(old.timer); wsSessions.delete(sid); }
          }
          sid = signMatchId(pbId); // HMAC-signed match id (bound to this user) — forged ids fail the claim gate
          const session: WsGameSession = {
            pbId, hits: 0, serverPT: 0, startMs: Date.now(),
            lastHitMs: 0, hitLog: [], rejectLog: [],
            committed: false, blacklisted: false, legacy: !strictClient,
            logId: null, timer: null,
          };
          // Create the match record at game start (match_status "active").
          // Lifecycle: active → started (game-over commit) →
          // completed | expired | blacklisted. The expiry sweeper voids any
          // row stuck in active/started for too long.
          const rowBody = {
            user:         pbId,
            user_id:      pbId,
            raw_score:    0,
            is_double:    false,
            final_tokens: 0,
            match_id:     sid,
            match_status: "active",
          };
          if (strictClient) {
            // HARD GATE (new bridge only): SESSION_READY is sent ONLY after
            // the row write is CONFIRMED. If the write fails, the game must
            // NOT start — the client gets ERROR match_create_failed and shows
            // a retry screen.
            let matchRow: any = null;
            try {
              matchRow = await pbPost("/api/collections/game_score/records", rowBody);
            } catch {}
            if (!matchRow || matchRow.code || !matchRow.id) {
              console.error(`[ws/game] match row create FAILED for ${pbId} — game start BLOCKED`);
              sid = null;
              send({ type: "ERROR", reason: "match_create_failed" });
              break;
            }
            session.logId = matchRow.id;
          } else {
            // LEGACY (old APKs): start immediately — the old bridge treats a
            // delayed/blocked SESSION_READY as "Connection failed". The row is
            // created async best-effort; wsCommitSession has a legacy-only
            // fallback INSERT if this write never lands.
            pbPost("/api/collections/game_score/records", rowBody)
              .then((r: any) => {
                if (!r || !r.id || r.code) return;
                if (session.committed) {
                  // RACE: session already ended (fast game-over commit or
                  // zero-score disconnect) before this insert landed. The
                  // commit path handled the outcome (legacy fallback INSERT
                  // wrote the final row / zero-score wrote nothing) — this
                  // late row is a stray duplicate, remove it.
                  pbDelete(`/api/collections/game_score/records/${r.id}`).catch(() => {});
                  return;
                }
                session.logId = r.id;
              })
              .catch(() => {});
          }
          // Auto-commit when the 3-minute server timer fires
          session.timer = setTimeout(async () => {
            const s = wsSessions.get(sid!);
            if (s) await wsCommitSession(sid!, s);
            send({ type: "GAME_OVER", reason: "time", serverPT: session.serverPT });
          }, WS_SESSION_MS + WS_SESSION_GRACE_MS);
          wsSessions.set(sid, session);
          send({ type: "SESSION_READY", sessionId: sid });
          console.log(`[ws/game] session ${sid.slice(0, 8)} started for ${pbId}${strictClient ? "" : " (legacy client)"}`);
          break;
        }

        case "KNIFE_HIT": {
          if (!sid) { send({ type: "HIT_REJECTED", reason: "no_session" }); return; }
          const session = wsSessions.get(sid);
          if (!session || session.committed) { send({ type: "HIT_REJECTED", reason: "session_invalid" }); return; }
          const now = Date.now();
          // Guard: minimum time between throws (physics-enforced minimum ~300 ms)
          if (session.lastHitMs > 0 && (now - session.lastHitMs) < WS_MIN_HIT_MS) {
            console.warn(`[ws/game] ${sid.slice(0, 8)} too_fast (${now - session.lastHitMs}ms)`);
            // Shadow-blacklist monitor: log-only for now (no enforcement) —
            // flag sessions with >10 rejected hits in any 30s window.
            session.rejectLog.push(now);
            session.rejectLog = session.rejectLog.filter(t => now - t < 30_000);
            if (session.rejectLog.length > 10) {
              console.warn(`[ws/game] ${sid.slice(0, 8)} SHADOW-BLACKLIST candidate: ${session.rejectLog.length} rejected hits/30s (${session.pbId})`);
            }
            send({ type: "HIT_REJECTED", reason: "too_fast" }); return;
          }
          // Guard: burst detection — max 15 valid hits in any 5-second window
          session.hitLog = session.hitLog.filter(t => now - t < WS_BURST_WINDOW);
          if (session.hitLog.length >= WS_BURST_MAX) {
            console.warn(`[ws/game] ${sid.slice(0, 8)} burst (${session.hitLog.length} hits/${WS_BURST_WINDOW}ms)`);
            session.rejectLog.push(now);
            session.rejectLog = session.rejectLog.filter(t => now - t < 30_000);
            if (session.rejectLog.length > 10) {
              console.warn(`[ws/game] ${sid.slice(0, 8)} SHADOW-BLACKLIST candidate: ${session.rejectLog.length} rejected hits/30s (${session.pbId})`);
            }
            send({ type: "HIT_REJECTED", reason: "burst_detected" }); return;
          }
          // Guard: hard session cap — force end if 400 hits reached
          if (session.hits >= WS_MAX_HITS) {
            await wsCommitSession(sid, session);
            send({ type: "GAME_OVER", reason: "score_limit", serverPT: session.serverPT }); return;
          }
          // Valid hit — strictly additive: only ever += 5, never synced to client score
          session.hits++;
          session.serverPT += WS_PT_PER_HIT;
          session.lastHitMs = now;
          session.hitLog.push(now);
          send({ type: "HIT_ACK", serverPT: session.serverPT, serverHits: session.hits });
          break;
        }

        case "GAME_OVER": {
          if (!sid) return;
          const session = wsSessions.get(sid);
          if (!session || session.committed) { send({ type: "COMMITTED", serverPT: session?.serverPT ?? 0 }); return; }

          // SCORE RECONCILIATION — the score displayed on the player's screen
          // is authoritative (bounded by the rate cap + hard cap below). The
          // per-hit counter can UNDERCOUNT honest play two ways: (1) queued
          // hits drain from the bridge every ~100ms and get rejected by the
          // 280ms spacing guard; (2) hits thrown before the WS handshake
          // completes never reach the server at all. Paying less than the
          // displayed score (65 shown → 45 paid) is a payout bug, not
          // security — so GAME_OVER reconciles UP to the client score.
          if (msg.score !== undefined) {
            const rawScore = Math.max(0, Number(msg.score) || 0);
            const serverElapsed = Date.now() - session.startMs;
            const clientElapsed = Number(msg.elapsed_ms) || 0;
            // The WS session can start LATE relative to real gameplay (legacy
            // instant start / slow handshake), so serverElapsed may be far
            // shorter than the real game — clamping to serverElapsed+2s was
            // capping HONEST scores. Trust the LARGER of the two clocks,
            // bounded by the 3-minute session hard limit (+5s tolerance).
            const elapsedMs = Math.max(1000, Math.min(Math.max(clientElapsed, serverElapsed), 185_000));
            // Time-based cap mirrors bridge.js client check: max 15 pts/sec
            const maxForTime = Math.ceil((elapsedMs / 1000) * 15);
            if (rawScore > maxForTime * 1.2 + 20) {
              // Impossible score for the elapsed time → blacklist the match.
              // wsCommitSession stores 0 PT + match_status "blacklisted";
              // any reward claim on this matchId is denied.
              session.blacklisted = true;
              session.serverPT = 0;
              console.warn(`[ws/game] BLACKLIST ${sid.slice(0, 8)}: impossible score ${rawScore} in ${Math.round(elapsedMs/1000)}s (max ${maxForTime}) (${session.pbId})`);
              // Account-level flag: an impossible score for the elapsed time
              // is unambiguous tampering — blacklist the ACCOUNT, not just
              // the match (tier 1 → tier 2 on repeat).
              flagUserBlacklist(session.pbId, `impossible score ${rawScore} in ${Math.round(elapsedMs / 1000)}s (max ${maxForTime})`).catch(() => {});
            } else {
              // Never pay LESS than the honest displayed score; never MORE
              // than the rate/hard caps. Per-hit tally stays as fraud telemetry.
              session.serverPT = Math.max(session.serverPT, Math.min(rawScore, WS_MAX_PT, maxForTime));
              console.log(`[ws/game] score reconciled: raw=${rawScore} perHit=${session.hits * WS_PT_PER_HIT} elapsed=${Math.round(elapsedMs/1000)}s cap=${maxForTime} final=${session.serverPT} (${session.pbId})`);
            }
          }

          await wsCommitSession(sid, session);
          // Return matchId so the client can pass it as a replay-attack guard
          // when it calls /api/app/game/reward.
          send({ type: "COMMITTED", serverPT: session.serverPT, matchId: sid });
          break;
        }
      }
    });

    ws.on("close", () => {
      if (!sid) return;
      const session = wsSessions.get(sid);
      if (!session || session.committed) return;
      // Commit any earned PT on disconnect so players don't lose progress
      // serverPT > 0 covers both Weapon Master (score set on GAME_OVER) and Knife Hit (per-hit accumulation)
      if (session.hits > 0 || session.serverPT > 0) {
        wsCommitSession(sid, session).catch(() => {});
      } else {
        // Zero-score disconnect: void the match row immediately so it never
        // lingers as an open "active" row (would otherwise wait for sweeper).
        if (session.timer) clearTimeout(session.timer);
        session.committed = true;
        if (session.logId) {
          pbPatch(`/api/collections/game_score/records/${session.logId}`, {
            match_status: "expired",
          }).catch(() => {});
        }
        wsSessions.delete(sid);
      }
    });
  });
}

// ─── PB convenience helpers ────────────────────────────────────────────────
async function pbGet(path: string) {
  const token = await getAdminToken();
  return pbHttp("GET", path, null, token);
}
async function pbPost(path: string, body: object) {
  const token = await getAdminToken();
  return pbHttp("POST", path, body, token);
}
async function pbPatch(path: string, body: object) {
  const token = await getAdminToken();
  return pbHttp("PATCH", path, body, token);
}
async function pbDelete(path: string) {
  const token = await getAdminToken();
  return pbHttp("DELETE", path, null, token);
}

// ─── Brevo SMTP mailer (nodemailer) ────────────────────────────────────────
// Tries port 465 (SMTPS / TLS-immediate) first — Railway allows this even when
// port 587 (STARTTLS) times out.  Falls back to port 587 automatically via
// nodemailer's built-in fallback only if needed.
//
// SMTP_USER — Brevo SMTP login  (a52a0a001@smtp-brevo.com).
//             If accidentally set to the API key it is detected and swapped.
// SMTP_KEY  — Brevo SMTP API key (xsmtpsib-…). Required.

async function sendOtpEmail(to: string, otp: string) {
  const envUser = process.env.SMTP_USER || 'a52a0a001@smtp-brevo.com';
  const envKey  = process.env.SMTP_KEY  || '';

  if (!envKey) {
    throw new Error('SMTP_KEY environment variable is not set — cannot send email.');
  }

  // Defensive: if SMTP_USER contains the API key, swap them
  const smtpUser = envUser.startsWith('xsmtpsib-') ? 'a52a0a001@smtp-brevo.com' : envUser;
  const smtpPass = envUser.startsWith('xsmtpsib-') ? envUser : envKey;

  const htmlBody = `
<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#111;color:#fff;border-radius:16px;">
  <h2 style="color:#FF6B00;margin:0 0 6px;font-size:22px;">Shiba Hit</h2>
  <p style="color:#999;font-size:13px;margin:0 0 28px;">Account Deletion Request</p>
  <p style="color:#ccc;margin:0 0 20px;">Enter the code below inside the app to confirm your account deletion. <strong>Do not click any links</strong> — just type the digits.</p>
  <div style="background:#1e1e1e;border:1px solid #333;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px;">
    <p style="color:#888;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin:0 0 10px;">Your 6-Digit Code</p>
    <p style="color:#FFD700;font-size:44px;font-weight:bold;letter-spacing:16px;margin:0;font-family:monospace;">${otp}</p>
  </div>
  <p style="color:#888;font-size:13px;margin:0 0 6px;">⏱ Expires in <strong style="color:#fff;">5 minutes</strong>.</p>
  <p style="color:#888;font-size:13px;margin:0 0 24px;">If you didn't request this, you can safely ignore this email — your account is safe.</p>
  <hr style="border:none;border-top:1px solid #222;margin:0 0 16px;"/>
  <p style="color:#555;font-size:12px;margin:0;">Shiba Hit &nbsp;&bull;&nbsp; support@shibahit.com</p>
</div>`;

  // Port 465 = SMTPS (TLS from the start) — different path than STARTTLS on 587
  // and confirmed reachable from Railway's network.
  const ports: Array<{ port: number; secure: boolean }> = [
    { port: 465, secure: true  },
    { port: 587, secure: false },
    { port: 2525, secure: false },
  ];

  let lastErr: Error | null = null;
  for (const { port, secure } of ports) {
    console.log(`[SMTP] Trying smtp-relay.brevo.com:${port} secure=${secure} user=${smtpUser} key-ends=${smtpPass.slice(-8)} to=${to}`);
    try {
      const transporter = nodemailer.createTransport({
        host:   'smtp-relay.brevo.com',
        port,
        secure,
        auth:   { user: smtpUser, pass: smtpPass },
        tls:    { rejectUnauthorized: false },
        connectionTimeout: 10_000,
        greetingTimeout:   10_000,
        socketTimeout:     15_000,
      });
      await transporter.sendMail({
        from:    '"Shiba Hit" <support@shibahit.com>',
        to,
        subject: 'Your Shiba Hit Account Deletion OTP',
        html:    htmlBody,
        text:    `Your 6-digit security code is: ${otp}\n\nExpires in 5 minutes. Do not share it.\n\n— Shiba Hit Team`,
      });
      console.log(`[SMTP] Email delivered to ${to} via port ${port} ✓`);
      return; // success — stop trying further ports
    } catch (err: any) {
      console.warn(`[SMTP] Port ${port} failed: ${err?.message}`);
      lastErr = err;
      // ETIMEDOUT or ECONNREFUSED → try next port
      // Auth failure (responseCode 535) → no point trying other ports with same creds
      if (err?.responseCode === 535) break;
    }
  }

  throw lastErr ?? new Error('All SMTP ports failed');
}

// ─── Add masked_name field to withdrawals + backfill existing records ──────
async function backfillWithdrawalMaskedNames() {
  try {
    // 1. Add the masked_name text field to the withdrawals collection (idempotent)
    const col = await pbGet("/api/collections/withdrawals");
    if (!col.code) {
      const hasField = (col.fields || []).some((f: any) => f.name === "masked_name");
      const hasReason = (col.fields || []).some((f: any) => f.name === "cancellation_reason");
      if (!hasField || !hasReason) {
        const token = await getAdminToken();
        const newFields: any[] = [];
        if (!hasField) newFields.push({ name: "masked_name", type: "text", required: false });
        if (!hasReason) newFields.push({ name: "cancellation_reason", type: "text", required: false });
        const updatedFields = [...(col.fields || []), ...newFields];
        await pbHttp("PATCH", `/api/collections/${col.id}`, { fields: updatedFields }, token);
        console.log("[withdrawals] masked_name / cancellation_reason fields added ✓");
      }
    }

    // 2. Fetch all approved/completed withdrawals that still lack masked_name
    const statuses = ["completed", "approved"];
    for (const status of statuses) {
      let page = 1;
      while (true) {
        const batch = await pbGet(
          `/api/collections/withdrawals/records?filter=${encodeURIComponent(`status="${status}" && masked_name=""`)}` +
          `&expand=user&sort=-created&perPage=50&page=${page}`
        );
        const items: any[] = batch.items || [];
        if (!items.length) break;

        for (const w of items) {
          let name: string = w.expand?.user?.display_name || w.expand?.user?.username || "";
          if (name.includes("@")) name = name.split("@")[0];
          if (!name) continue;
          await pbPatch(`/api/collections/withdrawals/records/${w.id}`, { masked_name: name })
            .catch(() => {});
        }

        if (batch.totalPages <= page) break;
        page++;
      }
    }
    console.log("[withdrawals] masked_name backfill complete ✓");
  } catch (e: any) {
    console.warn("[withdrawals] masked_name backfill failed:", e.message);
  }
}

// ─── Ensure the withdrawals.method select accepts the Hit-Ticket redeem value ──
// The redeem flow (WalletContext) creates a withdrawals row with
// method:'Hit Ticket Redeem'. The select was limited to ['BEP-20','Binance Email'],
// so PocketBase rejected the create and redeem returned "failed". Appending the
// value (idempotent) fixes it for the SHARED PB — dev, prod, and the published APK
// all read the same instance, so a single backend boot repairs redeem everywhere.
async function ensureWithdrawalRedeemMethod() {
  try {
    const col = await pbGet("/api/collections/withdrawals");
    if (col.code) return; // collection missing → nothing to patch
    // Older PB exposes the field list under `schema`; newer PB under `fields`. This
    // instance uses `schema`, so reading `col.fields` returned [] and the patch never
    // applied. Read whichever the instance uses and PATCH back under the same key.
    const usesSchemaKey = Array.isArray(col.schema);
    const schema: any[] = col.schema || col.fields || [];
    const methodField = schema.find((f: any) => f.name === "method");
    if (!methodField) return;
    // PB exposes select values either flattened (field.values) or nested (field.options.values).
    const holder = Array.isArray(methodField.values)
      ? methodField
      : (methodField.options && Array.isArray(methodField.options.values) ? methodField.options : null);
    if (!holder) return;
    if (holder.values.includes("Hit Ticket Redeem")) return; // already present
    holder.values = [...holder.values, "Hit Ticket Redeem"];
    const token = await getAdminToken();
    await pbHttp("PATCH", `/api/collections/${col.id}`, usesSchemaKey ? { schema } : { fields: schema }, token);
    console.log('[withdrawals] method select → added "Hit Ticket Redeem" ✓');
  } catch (e: any) {
    console.warn("[withdrawals] ensureWithdrawalRedeemMethod failed:", e?.message);
  }
}

// ─── Ensure daily_usage collection exists in PocketBase ───────────────────
async function ensureDailyUsageCollection() {
  try {
    const check = await pbGet("/api/collections/daily_usage");
    if (!check.code) return; // already exists
    const token = await getAdminToken();
    await pbHttp("POST", "/api/collections", {
      name: "daily_usage",
      type: "base",
      fields: [
        { name: "date_day", type: "text",   required: true },
        { name: "count",    type: "number", required: true },
      ],
    }, token);
    console.log("[daily_usage] Collection created in PocketBase");
  } catch (e: any) {
    console.warn("[daily_usage] Could not auto-create collection:", e.message);
  }
}

// ─── Check and increment daily email limit (max 300/day) ──────────────────
async function checkAndIncrementDailyEmailLimit(): Promise<{ allowed: boolean; message?: string }> {
  const today = new Date().toISOString().substring(0, 10); // YYYY-MM-DD
  try {
    const result = await pbGet(
      `/api/collections/daily_usage/records?filter=${encodeURIComponent(`date_day="${today}"`)}&perPage=1`
    );
    if (result.items && result.items.length > 0) {
      const rec = result.items[0];
      if (rec.count >= 300) {
        console.warn(`[daily_usage] Daily OTP limit reached: ${rec.count} emails sent today`);
        return { allowed: false, message: "Daily limit reached. Please try again after 24 hours." };
      }
      await pbPatch(`/api/collections/daily_usage/records/${rec.id}`, { count: rec.count + 1 });
      console.log(`[daily_usage] Email count for ${today}: ${rec.count + 1}`);
    } else {
      await pbPost("/api/collections/daily_usage/records", { date_day: today, count: 1 });
      console.log(`[daily_usage] New daily usage record created for ${today}`);
    }
    return { allowed: true };
  } catch (e: any) {
    console.warn("[daily_usage] Could not check limit (allowing anyway):", e.message);
    return { allowed: true }; // fail open — don't block emails if tracking fails
  }
}

// ─── Ensure otp_codes collection exists in PocketBase ─────────────────────
async function ensureOtpCollection() {
  try {
    const check = await pbGet("/api/collections/otp_codes");
    const token = await getAdminToken();
    if (check.code) {
      // Collection does not exist — create it
      await pbHttp("POST", "/api/collections", {
        name: "otp_codes",
        type: "base",
        fields: [
          { name: "user",       type: "relation", required: true, options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
          { name: "code",       type: "text",     required: true },
          { name: "expires_at", type: "date",     required: true },
        ],
        listRule:   "user = @request.auth.id",
        viewRule:   "user = @request.auth.id",
        createRule: "@request.auth.id != \"\"",
        updateRule: null,
        deleteRule: "user = @request.auth.id",
      }, token);
      console.log("[otp_codes] Collection created with correct API rules");
    } else {
      // Collection exists — always patch rules so authenticated users can CRUD their own OTPs
      await pbHttp("PATCH", `/api/collections/${check.id}`, {
        listRule:   "user = @request.auth.id",
        viewRule:   "user = @request.auth.id",
        createRule: "@request.auth.id != \"\"",
        updateRule: null,
        deleteRule: "user = @request.auth.id",
      }, token);
      console.log("[otp_codes] API rules patched — authenticated users can manage their own OTPs");
    }
  } catch (e: any) {
    console.warn("[otp_codes] Could not setup collection:", e.message);
  }
}

// ─── Patch users + leaderboard-related collection rules ──────────────────────
async function ensureCollectionRules() {
  try {
    const token = await getAdminToken();
    // Allow authenticated users to LIST the users collection (needed for leaderboard)
    // View/update/delete stay scoped to own record for privacy
    const usersCol = await pbGet("/api/collections/users");
    if (!usersCol.code) {
      await pbHttp("PATCH", `/api/collections/${usersCol.id}`, {
        // Anyone authenticated can list (needed for leaderboard)
        listRule: "@request.auth.id != \"\"",
        // A user can view their own record — needed so pbGetSelf() works in APK
        viewRule: "@request.auth.id = id",
        // Allow public creation so APK can create PB user directly when Express unreachable
        createRule: "",
        // CRITICAL: allow a user to update their own record.
        // Without this, pbStartMining / pbClaimMining / pbActivateBooster balance writes all fail
        // silently in the APK because the PB SDK authenticates as a regular user, not admin.
        //
        // NOTE: referral commission cross-user updates are handled via the referral_earnings_log
        // collection (see ensureReferralEarningsLogCollection). The claimer writes a pending entry,
        // and the referrer processes it on their next app open (self-update, always allowed).
        //
        // KYC fields are server-managed ONLY — the `:isset = false` guards stop a
        // client from self-verifying or editing their verified payout destination.
        updateRule:
          "@request.auth.id = id" +
          " && @request.data.kyc_status:isset = false" +
          " && @request.data.kyc_country:isset = false" +
          " && @request.data.kyc_country_code:isset = false" +
          " && @request.data.kyc_full_name:isset = false" +
          " && @request.data.kyc_phone:isset = false" +
          " && @request.data.kyc_binance_email:isset = false" +
          " && @request.data.kyc_bep20_address:isset = false" +
          " && @request.data.kyc_reject_reason:isset = false" +
          " && @request.data.submission_count:isset = false" +
          " && @request.data.wa_verified_phone:isset = false" +
          " && @request.data.wa_verified_at:isset = false",
        // Allow a user to delete ONLY their own record (needed for APK account deletion flow)
        deleteRule: "@request.auth.id = id",
      }, token);
      console.log("[users] listRule + viewRule + createRule + updateRule + deleteRule patched — APK self-CRUD enabled");
    }
    // deleted_emails: public read (APK checks before sign-up without auth), authenticated create
    const deCol = await pbGet("/api/collections/deleted_emails");
    if (!deCol.code) {
      await pbHttp("PATCH", `/api/collections/${deCol.id}`, {
        listRule:   "",   // public read — APK can check at sign-up without a PB session
        viewRule:   "",
        createRule: "@request.auth.id != \"\"",
        updateRule: null,
        deleteRule: null,
      }, token);
      console.log("[deleted_emails] rules patched — public read, authenticated create");
    }
    // fraud_emails: public read (APK checks at login/signup without auth), authenticated create
    const feCol = await pbGet("/api/collections/fraud_emails");
    if (!feCol.code) {
      await pbHttp("PATCH", `/api/collections/${feCol.id}`, {
        listRule:   "",
        viewRule:   "",
        createRule: "@request.auth.id != \"\"",
        updateRule: null,
        deleteRule: null,
      }, token);
      console.log("[fraud_emails] rules patched — public read, authenticated create");
    }
  } catch (e: any) {
    console.warn("[ensureCollectionRules] Patch failed:", e.message);
  }
}

// ─── Patch mining_sessions collection rules for APK SDK access ───────────────
// Express uses an admin token and can always read/write mining_sessions.
// The APK fallback uses the PB SDK authenticated as a regular user, so the
// collection rules MUST allow the record owner to create and update sessions.
// Without this patch, pbStartMining (create) and pbClaimMining (update) both
// fail with 403 Forbidden — the claim silently returns 0 with no UI feedback.
async function ensureMiningSessionsRules() {
  try {
    const token = await getAdminToken();
    const col = await pbGet("/api/collections/mining_sessions");
    if (col.code) {
      console.warn("[mining_sessions] Collection not found — skipping rules patch");
      return;
    }
    // Ensure the vip_level field exists — locked into each session at start
    // (exactly like booster_multiplier) so mid-session upgrades never apply retroactively.
    const sessSchema: any[] = col.schema || [];
    if (!sessSchema.find((f: any) => f.name === "vip_level")) {
      sessSchema.push({ name: "vip_level", type: "number", required: false });
      await pbHttp("PATCH", `/api/collections/${col.id}`, { schema: sessSchema }, token);
      console.log("[mining_sessions] Added vip_level field");
    }
    await pbHttp("PATCH", `/api/collections/${col.id}`, {
      // User can list/view only their own sessions
      listRule:   "user = @request.auth.id",
      viewRule:   "user = @request.auth.id",
      // Any authenticated user can open a new session (APK pbStartMining)
      createRule: "@request.auth.id != \"\"",
      // CRITICAL: user can update their own session.
      // This is the rule that was missing — pbClaimMining's update call was returning
      // 403, causing the claim to silently fail in every APK build.
      updateRule: "user = @request.auth.id",
      // No user deletion — sessions are permanent audit records
      deleteRule: null,
    }, token);
    console.log("[mining_sessions] Rules patched — APK can create + claim sessions via PB SDK");
  } catch (e: any) {
    console.warn("[mining_sessions] Rules patch failed:", e.message);
  }
}

// ─── Ensure referral_earnings_log collection exists in PocketBase ──────────
// This collection is the secure mechanism for referral commission payouts.
//
// Architecture:
//   1. When user A claims a mining reward, they CREATE a record here pointing to referrer B.
//   2. When user B (the referrer) opens the app, processPendingReferralEarnings() runs
//      client-side: reads their pending log entries, totals them, and credits their OWN
//      balance (self-update — always allowed by @request.auth.id = id rule).
//   3. The entries are marked processed.
//
// This avoids the need for a cross-user updateRule (which this PB version's parser rejects).
async function ensureReferralEarningsLogCollection() {
  try {
    const token = await getAdminToken();
    const check = await pbGet("/api/collections/referral_earnings_log");
    if (!check.code) {
      // Collection already exists — just ensure rules are correct
      const patchRes = await pbHttp("PATCH", `/api/collections/${check.id}`, {
        listRule:   "referrer_id = @request.auth.id",
        viewRule:   "referrer_id = @request.auth.id",
        createRule: "@request.auth.id != \"\"",
        updateRule: "referrer_id = @request.auth.id",
        deleteRule: null,
      }, token);
      if (!patchRes.code) {
        console.log("[referral_earnings_log] Rules patched");
      }
      return;
    }
    // Create the collection first WITHOUT rules.
    // NOTE: This PB version uses the `schema` key (older API), not `fields`.
    const created = await pbHttp("POST", "/api/collections", {
      name: "referral_earnings_log",
      type: "base",
      schema: [
        { name: "referrer_id",  type: "text",   required: true  },
        { name: "claimer_id",   type: "text",   required: true  },
        { name: "amount",       type: "number", required: true  },
        { name: "processed",    type: "bool",   required: false },
      ],
    }, token);
    if (created.code) {
      console.warn("[referral_earnings_log] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    console.log("[referral_earnings_log] Collection created — patching rules...");
    // Patch rules in a separate step (required for older PB versions)
    const patchRes = await pbHttp("PATCH", `/api/collections/${created.id}`, {
      listRule:   "referrer_id = @request.auth.id",
      viewRule:   "referrer_id = @request.auth.id",
      createRule: "@request.auth.id != \"\"",
      updateRule: "referrer_id = @request.auth.id",
      deleteRule: null,
    }, token);
    if (patchRes.code) {
      console.warn("[referral_earnings_log] Rules patch failed:", JSON.stringify(patchRes).slice(0, 200));
      // Fall back to open createRule so at least writes work
      await pbHttp("PATCH", `/api/collections/${created.id}`, {
        listRule:   "@request.auth.id != \"\"",
        viewRule:   "@request.auth.id != \"\"",
        createRule: "@request.auth.id != \"\"",
        updateRule: "@request.auth.id != \"\"",
        deleteRule: null,
      }, token);
    } else {
      console.log("[referral_earnings_log] Secure referral payout pipeline active");
    }
  } catch (e: any) {
    console.warn("[referral_earnings_log] Setup failed:", e.message);
  }
}

// ─── Ensure session_logs collection exists in PocketBase ──────────────────
// One record per mining session claim (or fraud attempt).
// Fields: user (pbId), session_type ("1x"|"2x"|"4x"|"6x"|"10x"|"fraud"),
//         income (SHIB reward), booster_multiplier, duration_seconds.
async function ensureSessionLogsCollection() {
  try {
    const token = await getAdminToken();
    const check = await pbGet("/api/collections/session_logs");
    if (!check.code) {
      console.log("[session_logs] Collection already exists ✓");
      return;
    }
    const created = await pbHttp("POST", "/api/collections", {
      name: "session_logs",
      type: "base",
      schema: [
        { name: "user",              type: "text",   required: true  },
        { name: "session_type",      type: "text",   required: true  },
        { name: "income",            type: "number", required: false },
        { name: "booster_multiplier",type: "number", required: false },
        { name: "duration_seconds",  type: "number", required: false },
      ],
    }, token);
    if (created.code) {
      console.warn("[session_logs] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    // Admin-only access (server writes via admin token)
    await pbHttp("PATCH", `/api/collections/${created.id}`, {
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    }, token);
    console.log("[session_logs] Collection created ✓");
  } catch (e: any) {
    console.warn("[session_logs] Setup failed:", e.message);
  }
}

// ─── game_score: ONE row per game (total-reset pipeline) ───────────────────
// Lifecycle (STRICT — no other code path may INSERT into this collection):
//   1. GAME_START  → INSERT one row  {raw_score:0, final_tokens:0,
//                    is_double:false, match_status:"active"}
//   2. Game over   → PATCH that row  {raw_score:<server score>,
//                    final_tokens:<raw_score>, match_status:"started"}
//   3. Claim       → PATCH that row  {is_double, final_tokens, "completed"}
//                    where final_tokens = is_double ? raw_score*2 : raw_score
// "blacklisted" voids the match; the sweeper marks stale rows "expired".
async function ensureGameScoreCollection() {
  try {
    const token = await getAdminToken();
    const check = await pbGet("/api/collections/game_score");
    if (!check.code) {
      console.log("[game_score] Collection already exists ✓");
      // ADDITIVE migration: plain-text user_id mirror of the player's PB id
      // (the `user` relation stays untouched — user_id is for direct tracking).
      const existingNames: string[] = (check.schema || check.fields || []).map((f: any) => f.name);
      if (!existingNames.includes("user_id")) {
        const updatedSchema = [
          ...(check.schema || check.fields || []),
          { name: "user_id", type: "text", required: false },
        ];
        await pbHttp("PATCH", `/api/collections/${check.id}`, { schema: updatedSchema }, token);
        console.log("[game_score] user_id field added ✓");
      } else {
        console.log("[game_score] user_id field already present ✓");
      }
      return;
    }
    // `user` is a true RELATION to the users collection (needs its id)
    const usersColl = await pbGet("/api/collections/users");
    if (usersColl.code || !usersColl.id) {
      console.warn("[game_score] users collection lookup failed — cannot create");
      return;
    }
    const created = await pbHttp("POST", "/api/collections", {
      name: "game_score",
      type: "base",
      schema: [
        { name: "user",         type: "relation", required: true,
          options: { collectionId: usersColl.id, maxSelect: 1, cascadeDelete: false } },
        { name: "user_id",      type: "text",   required: false },
        { name: "match_id",     type: "text",   required: false },
        { name: "raw_score",    type: "number", required: false },
        { name: "final_tokens", type: "number", required: false },
        { name: "is_double",    type: "bool",   required: false },
        { name: "match_status", type: "text",   required: false },
      ],
    }, token);
    if (created.code) {
      console.warn("[game_score] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    // Server-only collection: ALL client API rules locked (admin token only)
    await pbHttp("PATCH", `/api/collections/${created.id}`, {
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    }, token);
    console.log("[game_score] Collection created ✓");
  } catch (e: any) {
    console.warn("[game_score] Setup failed:", e.message);
  }
}

// ─── Auto-expire unclaimed matches ─────────────────────────────────────────
// A match must be claimed within MATCH_CLAIM_WINDOW_MS of its last transition
// ("active" set at GAME_START, "started" set at the game-over commit — each
// PB write bumps `updated`). The sweeper marks stale rows "expired" so the
// reward endpoints reject them. Window is aligned with the 10-minute ad-token
// TTL so a slow rewarded ad can never outlive its match. Runs on both the dev
// and Railway servers against the shared PB — the patch is idempotent and
// AGE-GATED via `updated` (never touches fresh rows).
const MATCH_CLAIM_WINDOW_MS = 10 * 60_000;
function startMatchExpirySweeper() {
  setInterval(async () => {
    try {
      // PB datetime filters require a SPACE separator (not ISO "T")
      const cutoff = new Date(Date.now() - MATCH_CLAIM_WINDOW_MS)
        .toISOString().replace("T", " ");
      const filter = encodeURIComponent(
        `(match_status="active" || match_status="started") && updated < "${cutoff}"`
      );
      const page = await pbGet(`/api/collections/game_score/records?filter=${filter}&perPage=50&fields=id`);
      const ids: string[] = (page?.items || []).map((r: any) => r.id);
      for (const id of ids) {
        await pbPatch(`/api/collections/game_score/records/${id}`, { match_status: "expired" }).catch(() => {});
      }
      if (ids.length) console.log(`[game_score] sweeper: expired ${ids.length} stale match(es)`);
    } catch { /* transient PB errors — next tick retries */ }
  }, 60_000).unref();
}

// ─── Migrate users: add is_flagged + flag_reason for security violations ──
// is_flagged  (bool) — set to true when root/emulator/integrity/autoclicker detected
// flag_reason (text) — one of: 'root' | 'emulator' | 'play_integrity' | 'autoclicker'
async function ensureIsFlaggedField() {
  try {
    const token = await getAdminToken();
    const coll  = await pbGet("/api/collections/users");
    if (coll.code) return;
    const existingNames: string[] = (coll.schema || coll.fields || []).map((f: any) => f.name);
    if (existingNames.includes("is_flagged")) {
      console.log("[users] is_flagged / flag_reason already present ✓");
      return;
    }
    const updatedSchema = [
      ...(coll.schema || coll.fields || []),
      { name: "is_flagged",  type: "bool", required: false },
      { name: "flag_reason", type: "text", required: false },
    ];
    await pbHttp("PATCH", `/api/collections/${coll.id}`, { schema: updatedSchema }, token);
    console.log("[users] is_flagged + flag_reason fields added ✓");
  } catch (e: any) {
    console.warn("[users] is_flagged migration failed:", e.message);
  }
}

// ─── Migrate users: add referral anti-cheat blacklist tiers ───────────────────
// is_blacklist_1        (bool) — first soft offense (suspicious referral claim).
// is_blacklist_2        (bool) — second offense while already on tier 1.
// blacklist_1_notified  (bool) — guards the one-time warning notifications.
// blacklist_1_notified_at (text) — ISO timestamp the warnings were sent.
// All NON-blocking: the user keeps using the app; admin reviews/terminates.
async function ensureBlacklistFields() {
  try {
    const token = await getAdminToken();
    const coll  = await pbGet("/api/collections/users");
    if (coll.code) return;
    const existingNames: string[] = (coll.schema || coll.fields || []).map((f: any) => f.name);
    if (existingNames.includes("is_blacklist_1")) {
      console.log("[users] blacklist tier fields already present ✓");
      return;
    }
    const updatedSchema = [
      ...(coll.schema || coll.fields || []),
      { name: "is_blacklist_1",          type: "bool", required: false },
      { name: "is_blacklist_2",          type: "bool", required: false },
      { name: "blacklist_1_notified",    type: "bool", required: false },
      { name: "blacklist_1_notified_at", type: "text", required: false },
    ];
    await pbHttp("PATCH", `/api/collections/${coll.id}`, { schema: updatedSchema }, token);
    console.log("[users] blacklist tier fields added ✓");
  } catch (e: any) {
    console.warn("[users] blacklist migration failed:", e.message);
  }
}

// ─── Single-session enforcement: users.session_token ───────────────────────
// Each device login writes a fresh random token here (self-update via PB SDK).
// Every client compares its locally stored token against this field (realtime
// subscribe + poll); a mismatch means another device claimed the session →
// forced logout on the older device. Client-side claim/enforce logic lives in
// context/AuthContext.tsx.
async function ensureSessionTokenField() {
  try {
    const token = await getAdminToken();
    const coll  = await pbGet("/api/collections/users");
    if (coll.code) return;
    const existingNames: string[] = (coll.schema || coll.fields || []).map((f: any) => f.name);
    if (existingNames.includes("session_token")) {
      console.log("[users] session_token field already present ✓");
      return;
    }
    const updatedSchema = [
      ...(coll.schema || coll.fields || []),
      { name: "session_token", type: "text", required: false },
    ];
    await pbHttp("PATCH", `/api/collections/${coll.id}`, { schema: updatedSchema }, token);
    console.log("[users] session_token field added ✓ (single-session enforcement)");
  } catch (e: any) {
    console.warn("[users] session_token migration failed:", e.message);
  }
}

// ─── KYC verification: users fields + verification_requests collection ─────
// users.kyc_status: '' | 'none' | 'under_review' | 'verified' | 'rejected'
// verification_requests.status is a PB SELECT field with EXACTLY these three
// options (human-readable — editable as a dropdown in the PocketBase admin UI):
const KYC_STATUS_UNDER_REVIEW = "Under Review";
const KYC_STATUS_VERIFIED     = "Verified";
const KYC_STATUS_REJECTED     = "Rejected";
const KYC_STATUS_OPTIONS = [KYC_STATUS_UNDER_REVIEW, KYC_STATUS_VERIFIED, KYC_STATUS_REJECTED];
// Telegram bot "Share Contact" verification — replaces the old WhatsApp OTP.
// Env overrides win so the bot can be rotated without a code deploy. The bot
// token lives ONLY on the server — the app just opens a t.me deep link.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "Shibahit_Bot";
// Telegram echoes this secret in a header on every webhook call so random
// POSTs to the public webhook route are ignored. Derived from the bot token
// so dev + prod (same codebase, same token) always agree on it.
const TELEGRAM_WEBHOOK_SECRET = crypto.createHash("sha256").update(`shibahit-tg-${TELEGRAM_BOT_TOKEN}`).digest("hex").slice(0, 40);
async function tgApi(method: string, body: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}
// ─── Telegram verification: sessions collection + webhook registration ─────
// telegram_verifications rows are short-lived server-side sessions binding a
// one-time deep-link token to {user, phone}. Stored in PB (NOT memory) so a
// token minted by one server (Replit dev) can be consumed by whichever server
// currently owns the bot webhook (VPS prod) — both share the same PocketBase.
// Admin-only API rules: the app never touches this collection directly.
async function ensureTelegramVerificationsCollection() {
  try {
    const token = await getAdminToken();
    const check = await pbGet("/api/collections/telegram_verifications");
    if (check.code) {
      await pbHttp("POST", "/api/collections", {
        name: "telegram_verifications",
        type: "base",
        fields: [
          { name: "token",      type: "text", required: true },
          { name: "user",       type: "text", required: true },
          { name: "phone",      type: "text", required: true },
          { name: "status",     type: "text", required: false },
          { name: "chat_id",    type: "text", required: false },
          { name: "tg_user_id", type: "text", required: false },
        ],
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      }, token);
      console.log("[telegram] telegram_verifications collection created ✓");
    } else {
      console.log("[telegram] telegram_verifications ✓");
    }
  } catch (e: any) {
    console.warn("[telegram] Could not ensure telegram_verifications:", e.message);
  }
  registerTelegramWebhook().catch((e) => console.warn("[telegram] webhook registration failed:", e.message));
}

// Points the bot's webhook at THIS server. Dev (Replit) and prod (VPS) share
// one bot — whichever server booted LAST owns the webhook. After a VPS
// redeploy/restart the prod server takes it back automatically.
async function registerTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set — webhook registration skipped, phone verification disabled");
    return;
  }
  const base =
    process.env.TELEGRAM_WEBHOOK_BASE ||
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "https://backend.webcod.in");
  const r = await tgApi("setWebhook", {
    url: `${base}/api/app/telegram/webhook`,
    secret_token: TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
  });
  if (r?.ok) console.log(`[telegram] webhook registered → ${base}/api/app/telegram/webhook ✓`);
  else console.warn("[telegram] setWebhook failed:", JSON.stringify(r).slice(0, 200));
}

// Map any legacy/alias value ('under_review' | 'approved' | 'unverified' | …)
// onto the canonical SELECT label. Unknown values pass through unchanged.
function toDbKycStatus(v: unknown): string {
  const k = String(v ?? "").trim().toLowerCase().replace(/[\s_]+/g, "_");
  if (k === "under_review" || k === "pending") return KYC_STATUS_UNDER_REVIEW;
  if (k === "verified" || k === "approved") return KYC_STATUS_VERIFIED;
  if (k === "rejected" || k === "unverified") return KYC_STATUS_REJECTED;
  return String(v ?? "");
}
// On APPROVAL the verified destination is COPIED onto the users record
// (kyc_country / kyc_binance_email / kyc_bep20_address / …) so the withdrawal
// route reads it with zero extra PB calls; request rows stay as audit trail.
async function ensureVerificationSchema() {
  try {
    const token = await getAdminToken();

    // 1) users collection — additive kyc_* text fields
    const coll = await pbGet("/api/collections/users");
    if (!coll.code) {
      const existingNames: string[] = (coll.schema || coll.fields || []).map((f: any) => f.name);
      const wanted = [
        "kyc_status", "kyc_reject_reason", "kyc_full_name", "kyc_country",
        "kyc_country_code", "kyc_phone", "kyc_binance_email", "kyc_bep20_address",
        // Verified phone (Telegram share-contact): proven number + when
        "wa_verified_phone", "wa_verified_at",
      ];
      const missing = wanted.filter((n) => !existingNames.includes(n));
      // submission_count is a NUMBER field (max 3 verification attempts per user)
      const needsCount = !existingNames.includes("submission_count");
      if (missing.length || needsCount) {
        const updatedSchema = [
          ...(coll.schema || coll.fields || []),
          ...missing.map((name) => ({ name, type: "text", required: false })),
          ...(needsCount ? [{ name: "submission_count", type: "number", required: false }] : []),
        ];
        await pbHttp("PATCH", `/api/collections/${coll.id}`, { schema: updatedSchema }, token);
        console.log(`[users] KYC fields added: ${[...missing, ...(needsCount ? ["submission_count"] : [])].join(", ")} ✓`);
      } else {
        console.log("[users] KYC fields already present ✓");
      }
    }

    // 2) verification_requests collection
    const check = await pbGet("/api/collections/verification_requests");
    if (!check.code) {
      console.log("[verification_requests] Collection already exists ✓");
      await ensureKycStatusSelectField(check, token);
      await ensureRequestPhoneVerifiedField(token);
      return;
    }
    const usersColl = await pbGet("/api/collections/users");
    if (usersColl.code || !usersColl.id) {
      console.warn("[verification_requests] users collection lookup failed — cannot create");
      return;
    }
    const created = await pbHttp("POST", "/api/collections", {
      name: "verification_requests",
      type: "base",
      schema: [
        { name: "user",           type: "relation", required: true,
          options: { collectionId: usersColl.id, maxSelect: 1, cascadeDelete: false } },
        { name: "full_name",      type: "text", required: false },
        { name: "country",        type: "text", required: false },
        { name: "country_code",   type: "text", required: false },
        { name: "phone",          type: "text", required: false },
        { name: "binance_email",  type: "text", required: false },
        { name: "bep20_address",  type: "text", required: false },
        // true when the submitted number matched the user's WhatsApp-OTP-verified number
        { name: "phone_verified", type: "bool", required: false },
        // PB SELECT — 'Under Review' | 'Verified' | 'Rejected'
        { name: "status",         type: "select", required: false,
          options: { maxSelect: 1, values: KYC_STATUS_OPTIONS } },
        { name: "reject_reason",  type: "text", required: false },
      ],
    }, token);
    if (created.code) {
      console.warn("[verification_requests] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    // Owner may READ their own requests (status screen fallback). All writes are
    // server-only (submit needs admin-token cross-user duplicate checks).
    await pbHttp("PATCH", `/api/collections/${created.id}`, {
      listRule: 'user = @request.auth.id',
      viewRule: 'user = @request.auth.id',
      createRule: null, updateRule: null, deleteRule: null,
    }, token);
    console.log("[verification_requests] Collection created ✓");
  } catch (e: any) {
    console.warn("[verification_requests] Setup failed:", e.message);
  }
}

// Additive: verification_requests.phone_verified (bool) — stamped at submit
// time when the submitted number matches the user's WhatsApp-OTP-verified one.
async function ensureRequestPhoneVerifiedField(token: string) {
  try {
    // Refetch — ensureKycStatusSelectField may have just patched the schema;
    // a stale copy here would silently revert its SELECT conversion.
    const coll = await pbGet("/api/collections/verification_requests");
    if (coll.code) return;
    const fields: any[] = coll.schema || coll.fields || [];
    if (fields.some((f: any) => f.name === "phone_verified")) {
      console.log("[verification_requests] phone_verified field present ✓");
      return;
    }
    await pbHttp("PATCH", `/api/collections/${coll.id}`, {
      schema: [...fields, { name: "phone_verified", type: "bool", required: false }],
    }, token);
    console.log("[verification_requests] phone_verified field added ✓");
  } catch (e: any) {
    console.warn("[verification_requests] phone_verified ensure failed:", e.message);
  }
}

// Convert verification_requests.status from the legacy TEXT field into a PB
// SELECT field with exactly ['Under Review','Verified','Rejected']. Existing
// row values are migrated FIRST — a select field silently drops any stored
// value that is not in its options list, so the order here matters.
async function ensureKycStatusSelectField(coll: any, token: string) {
  try {
    const fields: any[] = coll.schema || coll.fields || [];
    const statusField = fields.find((f: any) => f.name === "status");
    if (!statusField) {
      console.warn("[verification_requests] no status field found — skipping SELECT conversion");
      return;
    }
    const values: string[] = statusField?.options?.values || statusField?.values || [];
    const alreadyCorrect =
      statusField.type === "select" &&
      values.length === KYC_STATUS_OPTIONS.length &&
      KYC_STATUS_OPTIONS.every((v) => values.includes(v));
    if (alreadyCorrect) {
      console.log("[verification_requests] status SELECT field OK ✓");
      return;
    }
    // PB refuses in-place field type changes ("Field type cannot be changed"),
    // so the conversion is a 3-phase swap:
    //   A) add a temp SELECT field `status_select`
    //   B) copy every row's (alias-mapped) status value into it
    //   C) drop the old TEXT field and rename the temp field → `status`
    // Idempotent — a partial run resumes from whichever phase is incomplete.
    const TMP = "status_select";

    // A) temp select field
    if (!fields.find((f: any) => f.name === TMP)) {
      const addUpd = await pbHttp("PATCH", `/api/collections/${coll.id}`, {
        schema: [
          ...fields,
          { name: TMP, type: "select", required: false,
            options: { maxSelect: 1, values: KYC_STATUS_OPTIONS } },
        ],
      }, token);
      if (addUpd.code) {
        console.warn("[verification_requests] temp SELECT field add FAILED:", JSON.stringify(addUpd).slice(0, 200));
        return;
      }
    }

    // B) copy row values (collect ALL ids first, then patch — never paginate
    //    while mutating).
    const rows: Array<{ id: string; status: string; [k: string]: any }> = [];
    let page = 1;
    for (;;) {
      const r = await pbGet(
        `/api/collections/verification_requests/records?page=${page}&perPage=200&fields=id,status,${TMP}`,
      );
      rows.push(...((r?.items || []) as Array<{ id: string; status: string }>));
      if (!r || page >= (r.totalPages || 1)) break;
      page++;
    }
    let migrated = 0;
    for (const row of rows) {
      const mapped = toDbKycStatus(row.status);
      if (!KYC_STATUS_OPTIONS.includes(mapped)) continue; // empty/unknown → leave blank
      if (row[TMP] === mapped) continue; // already copied (resume path)
      const p = await pbHttp(
        "PATCH",
        `/api/collections/verification_requests/records/${row.id}`,
        { [TMP]: mapped },
        token,
      );
      if (!p.code) migrated++;
      else console.warn(`[verification_requests] row ${row.id} status copy failed:`, JSON.stringify(p).slice(0, 150));
    }

    // C) swap — drop the old text `status` field, rename temp → `status`
    //    (rename keeps the temp field's id, which PB allows; the missing old
    //    field id deletes the text column).
    const fresh = await pbGet("/api/collections/verification_requests");
    const curFields: any[] = fresh.schema || fresh.fields || [];
    if (!curFields.length) {
      console.warn("[verification_requests] re-fetch for swap returned no fields — aborting");
      return;
    }
    const swapped = curFields
      .filter((f: any) => !(f.name === "status" && f.type !== "select"))
      .map((f: any) => (f.name === TMP ? { ...f, name: "status" } : f));
    const upd = await pbHttp("PATCH", `/api/collections/${coll.id}`, { schema: swapped }, token);
    if (upd.code) {
      console.warn("[verification_requests] status → SELECT swap FAILED:", JSON.stringify(upd).slice(0, 200));
    } else {
      console.log(`[verification_requests] status → SELECT ['Under Review','Verified','Rejected'] ✓ (migrated ${migrated} row value${migrated === 1 ? "" : "s"})`);
    }
  } catch (e: any) {
    console.warn("[verification_requests] status SELECT setup failed:", e.message);
  }
}

// ─── Ensure referral_history collection exists in PocketBase ──────────────
// One record per referral commission payment (admin analytics only — separate
// from referral_earnings_log which drives the secure payout pipeline).
// Fields: referrer_id, claimer_id, referrer_email, claimer_email, amount, source.
async function ensureReferralHistoryCollection() {
  try {
    const token = await getAdminToken();
    const check = await pbGet("/api/collections/referral_history");
    if (!check.code) {
      console.log("[referral_history] Collection already exists ✓");
      return;
    }
    const created = await pbHttp("POST", "/api/collections", {
      name: "referral_history",
      type: "base",
      schema: [
        { name: "referrer_id",    type: "text",   required: true  },
        { name: "claimer_id",     type: "text",   required: true  },
        { name: "referrer_email", type: "text",   required: false },
        { name: "claimer_email",  type: "text",   required: false },
        { name: "amount",         type: "number", required: true  },
        { name: "source",         type: "text",   required: false }, // "mining_claim" | "game_reward"
      ],
    }, token);
    if (created.code) {
      console.warn("[referral_history] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    await pbHttp("PATCH", `/api/collections/${created.id}`, {
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    }, token);
    console.log("[referral_history] Collection created ✓");
  } catch (e: any) {
    console.warn("[referral_history] Setup failed:", e.message);
  }
}

// ─── Ensure tasks collection exists in PocketBase ─────────────────────────
async function ensureTasksCollection() {
  try {
    const token = await getAdminToken();
    const check = await pbGet("/api/collections/tasks");
    if (!check.code) { console.log("[tasks] Collection already exists ✓"); return; }
    const created = await pbHttp("POST", "/api/collections", {
      name: "tasks",
      type: "base",
      schema: [
        { name: "title",         type: "text",   required: true  },
        { name: "description",   type: "text",   required: false },
        { name: "link",          type: "url",    required: false },
        { name: "reward_amount", type: "number", required: true  },
        { name: "reward_type",   type: "text",   required: true  },
        { name: "is_active",     type: "bool",   required: false },
      ],
    }, token);
    if (created.code) { console.warn("[tasks] Could not create:", JSON.stringify(created).slice(0, 200)); return; }
    await pbHttp("PATCH", `/api/collections/${created.id}`, { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null }, token);
    console.log("[tasks] Collection created ✓");
  } catch (e: any) { console.warn("[tasks] Setup failed:", e.message); }
}

// ─── Ensure task_submissions collection exists in PocketBase ───────────────
async function ensureTaskSubmissionsCollection() {
  try {
    const token = await getAdminToken();
    const check = await pbGet("/api/collections/task_submissions");
    if (!check.code) { console.log("[task_submissions] Collection already exists ✓"); return; }
    const created = await pbHttp("POST", "/api/collections", {
      name: "task_submissions",
      type: "base",
      schema: [
        { name: "user_id",          type: "text",   required: true  },
        { name: "task_id",          type: "text",   required: true  },
        { name: "task_title",       type: "text",   required: false },
        { name: "user_email",       type: "text",   required: false },
        { name: "proof_screenshot", type: "text",   required: false },
        { name: "status",           type: "text",   required: true  },
        { name: "admin_notes",      type: "text",   required: false },
        { name: "reward_amount",    type: "number", required: false },
        { name: "reward_type",      type: "text",   required: false },
      ],
    }, token);
    if (created.code) { console.warn("[task_submissions] Could not create:", JSON.stringify(created).slice(0, 200)); return; }
    await pbHttp("PATCH", `/api/collections/${created.id}`, { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null }, token);
    console.log("[task_submissions] Collection created ✓");
  } catch (e: any) { console.warn("[task_submissions] Setup failed:", e.message); }
}

// ─── Add unique composite index (user_id, task_id) to task_submissions ────
// This enforces at the PocketBase database engine level that a given user
// can only ever have ONE submission record per task — regardless of status.
// Any direct PocketBase SDK call (APK fallback path) that attempts to insert
// a duplicate will receive a 400/409 from PocketBase before Express even runs.
async function ensureTaskSubmissionsUniqueIndex() {
  try {
    const token = await getAdminToken();
    const col   = await pbGet("/api/collections/task_submissions");
    if (col.code) { console.log("[task_submissions] Collection not found — skip index"); return; }

    const UNIQUE_IDX =
      "CREATE UNIQUE INDEX `idx_user_task` ON `task_submissions` (`user_id`, `task_id`)";
    const existingIndexes: string[] = col.indexes || [];

    if (existingIndexes.some((s: string) => s.includes("idx_user_task"))) {
      console.log("[task_submissions] unique index idx_user_task already present ✓");
      return;
    }

    const r = await pbHttp("PATCH", `/api/collections/${col.id}`, {
      indexes: [...existingIndexes, UNIQUE_IDX],
    }, token);

    if (!r.code) {
      console.log("[task_submissions] unique composite index (user_id, task_id) created ✓");
    } else {
      console.warn("[task_submissions] Index creation failed:", JSON.stringify(r).slice(0, 200));
    }
  } catch (e: any) {
    console.warn("[task_submissions] Index migration failed:", e.message);
  }
}

// ─── Migrate proof_screenshot field: text → file ───────────────────────────
async function migrateProofScreenshotToFile() {
  try {
    const token = await getAdminToken();
    const col = await pbGet("/api/collections/task_submissions");
    if (col.code) { console.log("[task_submissions] Collection not found — skip migration"); return; }

    // Detect current field type (schema key = older PB API; fields key = newer)
    const schema: any[] = col.schema || col.fields || [];
    const field = schema.find((f: any) => f.name === "proof_screenshot");
    if (!field) { console.log("[task_submissions] proof_screenshot field not found — skip"); return; }
    if (field.type === "file") { console.log("[task_submissions] proof_screenshot already file type ✓"); return; }

    // Build updated schema with proof_screenshot as file type
    const updatedSchema = schema.map((f: any) =>
      f.name === "proof_screenshot"
        ? {
            name: "proof_screenshot",
            type: "file",
            required: false,
            options: { maxSelect: 1, maxSize: 5242880, mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
          }
        : f,
    );

    // Try schema key first (older PB), then fields key (newer PB)
    let r = await pbHttp("PATCH", `/api/collections/${col.id}`, { schema: updatedSchema }, token);
    if (r.code) {
      r = await pbHttp("PATCH", `/api/collections/${col.id}`, { fields: updatedSchema }, token);
    }
    if (!r.code) {
      console.log("[task_submissions] proof_screenshot migrated text→file ✓");
    } else {
      console.warn("[task_submissions] Field migration failed:", JSON.stringify(r).slice(0, 300));
    }
  } catch (e: any) {
    console.warn("[task_submissions] Migration error:", e.message);
  }
}

// ─── Patch tasks + task_submissions collection rules for PB SDK access ────
// These collections are created with listRule:null (admin-only) by default.
// This function patches them to allow:
//   tasks            → public read (listRule: "")    — tasks are public info
//   task_submissions → authenticated read (listRule: "@request.auth.id != ''")
async function patchTasksCollectionRules() {
  try {
    const token = await getAdminToken();
    const [tasksCol, subsCol] = await Promise.all([
      pbGet("/api/collections/tasks"),
      pbGet("/api/collections/task_submissions"),
    ]);
    if (!tasksCol.code) {
      await pbHttp("PATCH", `/api/collections/${tasksCol.id}`, { listRule: "", viewRule: "" }, token);
      console.log("[tasks] listRule/viewRule patched → public read ✓");
    }
    if (!subsCol.code) {
      await pbHttp("PATCH", `/api/collections/${subsCol.id}`, {
        listRule:   "@request.auth.id != ''",
        viewRule:   "@request.auth.id != ''",
        createRule: "@request.auth.id != ''",
      }, token);
      console.log("[task_submissions] listRule/viewRule/createRule patched → authenticated read+create ✓");
    }
  } catch (e: any) {
    console.warn("[tasks/task_submissions] Rule patch failed:", e.message);
  }
}

// ─── Ensure notifications collection exists in PocketBase ─────────────────
async function ensureNotificationsCollection() {
  try {
    const token = await getAdminToken();
    const check = await pbGet("/api/collections/notifications");
    if (!check.code) {
      // Collection exists — ensure rules allow public read (server reads via admin token)
      await pbHttp("PATCH", `/api/collections/${check.id}`, {
        listRule:   "",
        viewRule:   "",
        createRule: null,
        updateRule: null,
        deleteRule: null,
      }, token);
      console.log("[notifications] Collection rules verified ✓");
      return;
    }
    // Create the collection
    const created = await pbHttp("POST", "/api/collections", {
      name: "notifications",
      type: "base",
      schema: [
        { name: "title",       type: "text",     required: true,  options: {} },
        { name: "message",     type: "text",     required: true,  options: {} },
        { name: "type",        type: "select",   required: true,  options: { values: ["global", "personal"], maxSelect: 1 } },
        { name: "target_user", type: "relation", required: false, options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
      ],
    }, token);
    if (created.code) {
      console.warn("[notifications] Could not create collection:", JSON.stringify(created).slice(0, 300));
      return;
    }
    // Patch rules in a separate step (required for older PB versions)
    await pbHttp("PATCH", `/api/collections/${created.id}`, {
      listRule:   "",
      viewRule:   "",
      createRule: null,
      updateRule: null,
      deleteRule: null,
    }, token);
    console.log("[notifications] Collection created ✓");
  } catch (e: any) {
    console.warn("[notifications] Collection setup failed:", e.message);
  }
}

// ─── Ensure deleted_emails collection exists in PocketBase ─────────────────
async function ensureDeletedEmailsCollection() {
  try {
    const check = await pbGet("/api/collections/deleted_emails");
    if (!check.code) return; // already exists — code field absent on success
    const token = await getAdminToken();
    const res = await pbHttp("POST", "/api/collections", {
      name: "deleted_emails",
      type: "base",
      // IMPORTANT: this PocketBase version uses "schema" (not "fields") for collection creation
      schema: [
        { name: "email",  type: "text", required: true,  options: {} },
        { name: "reason", type: "text", required: false, options: {} },
      ],
      listRule:   "",
      viewRule:   "",
      createRule: "@request.auth.id != \"\"",
      updateRule: null,
      deleteRule: null,
    }, token);
    if (res.code) throw new Error(`PB rejected creation: ${JSON.stringify(res)}`);
    console.log("[deleted_emails] Collection created in PocketBase");
  } catch (e: any) {
    console.warn("[deleted_emails] Could not auto-create collection:", e.message);
  }
}

// ─── Ensure fraud_emails collection exists in PocketBase ──────────────────────
async function ensureFraudEmailsCollection() {
  try {
    const check = await pbGet("/api/collections/fraud_emails");
    if (!check.code) {
      // Collection exists — make sure rules are correct
      const token = await getAdminToken();
      await pbHttp("PATCH", `/api/collections/${check.id}`, {
        listRule:   "",
        viewRule:   "",
        createRule: "@request.auth.id != \"\"",
        updateRule: null,
        deleteRule: null,
      }, token);
      console.log("[fraud_emails] Collection already exists — rules confirmed");
      return;
    }
    // Collection does not exist — create it
    const token = await getAdminToken();
    const res = await pbHttp("POST", "/api/collections", {
      name: "fraud_emails",
      type: "base",
      // IMPORTANT: this PocketBase version uses "schema" (not "fields") for collection creation
      schema: [
        { name: "email",  type: "text", required: true,  options: {} },
        { name: "reason", type: "text", required: false, options: {} },
      ],
      listRule:   "",
      viewRule:   "",
      createRule: "@request.auth.id != \"\"",
      updateRule: null,
      deleteRule: null,
    }, token);
    if (res.code) throw new Error(`PB rejected creation: ${JSON.stringify(res)}`);
    console.log("[fraud_emails] Collection created in PocketBase ✓");
  } catch (e: any) {
    console.warn("[fraud_emails] Could not auto-create collection:", e.message);
  }
}

/** Save an email address to the permanent blacklist before account deletion */
async function blacklistEmail(email: string): Promise<void> {
  if (!email) return;
  try {
    const normalised = email.toLowerCase().trim();
    // Idempotent: check if already blacklisted
    const existing = await pbGet(
      `/api/collections/deleted_emails/records?filter=${encodeURIComponent(`email="${normalised}"`)}&perPage=1`
    );
    if (existing.items?.[0]) {
      console.log(`[deleted_emails] Email already blacklisted: ${normalised}`);
      return;
    }
    await pbPost("/api/collections/deleted_emails/records", { email: normalised });
    console.log(`[deleted_emails] Email blacklisted: ${normalised}`);
  } catch (e: any) {
    console.warn(`[deleted_emails] Failed to blacklist email ${email}:`, e.message);
  }
}

// ─── Ensure public_referrals collection exists (for APK referral validation) ─
// This collection is publicly readable so the APK can validate referral codes
// without a PocketBase auth session (which doesn't exist yet at sign-up time).
async function ensurePublicReferralsCollection() {
  try {
    const token = await getAdminToken();
    const check = await pbGet("/api/collections/public_referrals");
    if (check.code) {
      // Collection does not exist — create it.
      // Use 'schema' (not 'fields') — this PocketBase version uses the pre-v0.22 API.
      await pbHttp("POST", "/api/collections", {
        name: "public_referrals",
        type: "base",
        schema: [
          { name: "code",    type: "text", required: true,  options: {} },
          { name: "user_id", type: "text", required: true,  options: {} },
        ],
        listRule:   "",
        viewRule:   "",
        createRule: "",
        updateRule: null,
        deleteRule: null,
      }, token);
      console.log("[public_referrals] Collection created with public rules");
    }
    // Always ensure it has a public listRule and open createRule
    const col = await pbGet("/api/collections/public_referrals");
    if (!col.code) {
      await pbHttp("PATCH", `/api/collections/${col.id}`, {
        listRule:   "",   // public — anyone can query referral codes
        viewRule:   "",
        createRule: "",   // public — APK fallback can insert without auth
        updateRule: null,
        deleteRule: null,
      }, token);
      console.log("[public_referrals] Rules patched — public list/create enabled");
    }
    // Backfill any existing users whose code is not yet in public_referrals
    const existing = await pbGet(
      `/api/collections/users/records?perPage=200&fields=id,referral_code`,
    );
    const items: any[] = existing.items || [];
    let backfilled = 0;
    for (const u of items) {
      if (!u.referral_code) continue;
      const dup = await pbGet(
        `/api/collections/public_referrals/records?filter=${encodeURIComponent(`code="${u.referral_code}"`)}&perPage=1`,
        token,
      );
      if (!(dup.items?.[0])) {
        await pbHttp("POST", "/api/collections/public_referrals/records", {
          code: u.referral_code,
          user_id: u.id,
        }, token).catch(() => {});
        backfilled++;
      }
    }
    if (backfilled > 0) console.log(`[public_referrals] Backfilled ${backfilled} existing users`);
  } catch (e: any) {
    console.warn("[public_referrals] Setup failed:", e.message);
  }
}

/** Returns true if the email is permanently blacklisted (previously deleted account) */
async function isEmailBlacklisted(email: string): Promise<boolean> {
  try {
    const normalised = email.toLowerCase().trim();
    const res = await pbGet(
      `/api/collections/deleted_emails/records?filter=${encodeURIComponent(`email="${normalised}"`)}&perPage=1`
    );
    return !!(res.items?.[0]);
  } catch {
    return false; // on error, do not block signup
  }
}

/** Returns true if the email belongs to a permanently fraud-blocked account */
async function isFraudEmail(email: string): Promise<boolean> {
  try {
    const normalised = email.toLowerCase().trim();
    const res = await pbGet(
      `/api/collections/fraud_emails/records?filter=${encodeURIComponent(`email="${normalised}"`)}&perPage=1`
    );
    return !!(res.items?.[0]);
  } catch {
    return false; // on error, do not block
  }
}

/** Saves an email to the fraud_emails collection (idempotent) */
async function saveFraudEmail(email: string): Promise<void> {
  const normalised = email.toLowerCase().trim();
  if (!normalised) return;
  try {
    // Verify admin token is available before attempting write
    const token = await getAdminToken();
    if (!token) {
      console.error(`[fraud_emails] CRITICAL: No admin token — PB_ADMIN_EMAIL/PB_ADMIN_PASSWORD missing in Railway Variables. Cannot save fraud email: ${normalised}`);
      return;
    }
    const existing = await pbGet(
      `/api/collections/fraud_emails/records?filter=${encodeURIComponent(`email="${normalised}"`)}&perPage=1`
    );
    if (existing.items?.[0]) {
      console.log(`[fraud_emails] Already in blacklist: ${normalised}`);
      return;
    }
    const res = await pbPost("/api/collections/fraud_emails/records", { email: normalised });
    if (!res.id) {
      console.error(`[fraud_emails] PocketBase rejected write — full response: ${JSON.stringify(res)}`);
      return;
    }
    console.log(`[fraud_emails] ✓ Fraud email saved to PocketBase: ${normalised} (id=${res.id})`);
  } catch (e: any) {
    console.error(`[fraud_emails] FAILED to save ${normalised}:`, e.message, e.stack?.split('\n')[1] || '');
  }
}

// Settings cache
let settingsCache: any = null;
let settingsCacheAt = 0;
const SETTINGS_TTL = 5 * 60 * 1000;

async function fetchSettings() {
  if (settingsCache && Date.now() - settingsCacheAt < SETTINGS_TTL)
    return settingsCache;
  const res = await pbGet("/api/collections/settings/records?perPage=1");
  const s = res.items?.[0];
  if (s) {
    settingsCache = s;
    settingsCacheAt = Date.now();
  }
  return settingsCache;
}

// Network guard kill-switch reads the PB settings toggle. (Guard caches the
// result 60 s; admin settings updates bust settingsCache immediately.)
setNetworkGuardSettingsProvider(async () => {
  const s = await fetchSettings();
  return !!s?.network_guard_enabled;
});

// ─── proxycheck.io API-key rotation (PB `proxy_api` collection) ──────────────
// Admin adds/removes keys manually in PocketBase. Backend re-reads the list
// every 60 s, serves the first active key with usage_count < 900, and rotates
// to the next active key when one is exhausted. If ALL keys are exhausted it
// keeps serving the last one (avoid downtime — proxycheck fails open anyway).
// usage_count auto-resets when a key's last_used is a previous UTC day
// (proxycheck limits are per-day).
const PROXY_KEY_DAILY_LIMIT = 900;
const PROXY_KEYS_TTL = 60_000;
type ProxyKeyRec = {
  id: string;
  api_key: string;
  is_active: boolean;
  usage_count: number;
  last_used: string;
};
let proxyKeysCache: ProxyKeyRec[] = [];
let proxyKeysCacheAt = 0;
let lastServedProxyKey: string | null = null;

function pbNowDate(): string {
  // PB date format: "YYYY-MM-DD HH:MM:SS.sssZ" (space separator)
  return new Date().toISOString().replace("T", " ");
}

async function refreshProxyKeys(): Promise<void> {
  const token = await getAdminToken();
  const res = await pbHttp(
    "GET",
    "/api/collections/proxy_api/records?perPage=200&sort=created",
    null,
    token,
  );
  const items: ProxyKeyRec[] = (res.items || []).map((r: any) => ({
    id: r.id,
    api_key: String(r.api_key || "").trim(),
    is_active: !!r.is_active,
    usage_count: Number(r.usage_count) || 0,
    last_used: String(r.last_used || ""),
  }));
  // Daily reset: proxycheck quotas reset per UTC day
  const today = new Date().toISOString().slice(0, 10);
  for (const rec of items) {
    if (rec.usage_count > 0 && rec.last_used && rec.last_used.slice(0, 10) < today) {
      rec.usage_count = 0;
      pbHttp(
        "PATCH",
        `/api/collections/proxy_api/records/${rec.id}`,
        { usage_count: 0 },
        token,
      )
        .then(() => console.log(`[proxy_api] daily reset: ${rec.api_key.slice(0, 6)}…`))
        .catch((e: any) => console.warn("[proxy_api] daily reset failed:", e?.message));
    }
  }
  proxyKeysCache = items;
  proxyKeysCacheAt = Date.now();
}

async function getProxyApiKey(): Promise<string | null> {
  if (Date.now() - proxyKeysCacheAt > PROXY_KEYS_TTL) {
    try {
      await refreshProxyKeys();
    } catch (e: any) {
      console.warn("[proxy_api] key refresh failed:", e?.message);
      proxyKeysCacheAt = Date.now(); // don't hammer PB on repeated failures
    }
  }
  const active = proxyKeysCache.filter((k) => k.is_active && k.api_key);
  if (active.length === 0) return null; // guard falls back to env key / keyless
  const available = active.find((k) => k.usage_count < PROXY_KEY_DAILY_LIMIT);
  if (available) {
    if (available.api_key !== lastServedProxyKey) {
      console.log(
        `[proxy_api] serving key ${available.api_key.slice(0, 6)}… (used ${available.usage_count}/${PROXY_KEY_DAILY_LIMIT})`,
      );
    }
    lastServedProxyKey = available.api_key;
    return available.api_key;
  }
  // All active keys exhausted — keep using the last served (or first) key
  const fallback =
    active.find((k) => k.api_key === lastServedProxyKey) || active[0];
  lastServedProxyKey = fallback.api_key;
  console.warn(
    `[proxy_api] all ${active.length} active keys ≥${PROXY_KEY_DAILY_LIMIT} today — reusing ${fallback.api_key.slice(0, 6)}… to avoid downtime`,
  );
  return fallback.api_key;
}

function flushProxyKeyUsage(rec: ProxyKeyRec, body: Record<string, any>): void {
  getAdminToken()
    .then((token) =>
      pbHttp("PATCH", `/api/collections/proxy_api/records/${rec.id}`, body, token),
    )
    .catch((e: any) => console.warn("[proxy_api] usage flush failed:", e?.message));
}

function reportProxyKeyUse(key: string): void {
  const rec = proxyKeysCache.find((k) => k.api_key === key);
  if (!rec) return;
  rec.usage_count += 1;
  rec.last_used = pbNowDate();
  // "usage_count+" is PocketBase's atomic increment — safe with the Railway
  // prod backend counting against the same shared collection.
  flushProxyKeyUsage(rec, { "usage_count+": 1, last_used: rec.last_used });
}

function reportProxyKeyExhausted(key: string): void {
  const rec = proxyKeysCache.find((k) => k.api_key === key);
  if (!rec) return;
  if (rec.usage_count < PROXY_KEY_DAILY_LIMIT) {
    rec.usage_count = PROXY_KEY_DAILY_LIMIT;
    rec.last_used = pbNowDate();
    console.warn(`[proxy_api] key ${key.slice(0, 6)}… denied by proxycheck — marked exhausted, rotating`);
    flushProxyKeyUsage(rec, {
      usage_count: PROXY_KEY_DAILY_LIMIT,
      last_used: rec.last_used,
    });
  }
}

setNetworkGuardKeyProvider({
  getKey: getProxyApiKey,
  reportUse: reportProxyKeyUse,
  reportExhausted: reportProxyKeyExhausted,
});

// Ensure the proxy_api collection exists (schema only — keys are added
// manually by the admin in PocketBase). All API rules null = admin-only, so
// API keys are NEVER readable by clients.
async function ensureProxyApiCollection(): Promise<void> {
  try {
    const token = await getAdminToken();
    const colls = await pbHttp("GET", "/api/collections?perPage=200", null, token);
    if ((colls.items || []).find((c: any) => c.name === "proxy_api")) {
      console.log("[proxy_api] collection present ✓");
      return;
    }
    await pbHttp(
      "POST",
      "/api/collections",
      {
        name: "proxy_api",
        type: "base",
        schema: [
          { name: "api_key", type: "text", required: false },
          { name: "is_active", type: "bool", required: false },
          { name: "usage_count", type: "number", required: false },
          { name: "last_used", type: "date", required: false },
        ],
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
      },
      token,
    );
    console.log("[proxy_api] collection created (admin-only rules) ✓");
  } catch (e: any) {
    console.warn("[proxy_api] ensure collection skipped:", e?.message);
  }
}

function generateReferralCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// ─── Ensure PB users collection has all required fields, all optional ────────
async function ensureUserSchema() {
  // All number/text fields the app writes to the users collection.
  // ALL must be required:false so that 0 / "" are accepted without errors.
  const REQUIRED_FIELDS: Array<{ name: string; type: string }> = [
    { name: "firebase_uid",       type: "text"   },
    { name: "display_name",       type: "text"   },
    { name: "referral_code",      type: "text"   },
    { name: "referred_by",        type: "text"   },
    { name: "is_verified",        type: "bool"   },
    { name: "shib_balance",       type: "number" },
    { name: "power_tokens",       type: "number" },
    { name: "referral_balance",   type: "number" },
    { name: "referral_earnings",  type: "number" },
    { name: "total_claims",       type: "number" },
    { name: "total_wins",         type: "number" },
    { name: "fraud_attempts",          type: "number" },
    { name: "status",                  type: "text"   },
    { name: "current_mining_session",  type: "text"   },
    // VIP system
    { name: "vip_level",               type: "number" }, // current VIP tier 0-8
    { name: "is_admin_promoted",       type: "bool"   }, // true → immune to auto-downgrade
    { name: "admin_promoted_level",    type: "number" }, // immutable demotion floor set by admin
  ];

  try {
    const token = await getAdminToken();
    const colls = await pbHttp("GET", "/api/collections?perPage=200", null, token);
    const usersCol = (colls.items || []).find((c: any) => c.name === "users");
    if (!usersCol) return;

    const schema: any[] = usersCol.schema || [];
    let changed = false;

    for (const desired of REQUIRED_FIELDS) {
      const existing = schema.find((f: any) => f.name === desired.name);
      if (!existing) {
        // Field missing — add it as optional
        schema.push({ name: desired.name, type: desired.type, required: false });
        changed = true;
      } else if (existing.required === true) {
        // Field exists but is required — make it optional so 0/"" are accepted
        existing.required = false;
        changed = true;
      }
    }

    if (!changed) return;

    await pbHttp("PATCH", `/api/collections/${usersCol.id}`, { schema }, token);
    console.log("[PB] users schema updated — all app fields are now optional");
  } catch (e: any) {
    console.warn("[PB] Schema update skipped:", e.message);
  }
}

// Verifies brevo_api_key exists in the PocketBase 'settings' collection.
// Collection is named 'settings' (not 'app_settings'). The APK reads the key
// directly from PocketBase and calls Brevo REST API — no Railway proxy needed.
async function ensureBrevoKeyInSettings(): Promise<void> {
  try {
    const token = await getAdminToken();
    const colls = await pbHttp("GET", "/api/collections?perPage=200", null, token);
    // PocketBase uses 'settings' as the collection name (confirmed via admin API)
    const settingsCol = (colls.items || []).find(
      (c: any) => c.name === "settings" || c.name === "app_settings"
    );
    if (!settingsCol) {
      console.warn("[settings] Settings collection not found — skipping brevo_api_key patch");
      return;
    }
    const schema: any[] = settingsCol.schema || [];
    let changed = false;
    if (!schema.find((f: any) => f.name === "brevo_api_key")) {
      schema.push({ name: "brevo_api_key", type: "text", required: false });
      changed = true;
      console.log(`[${settingsCol.name}] brevo_api_key field added — set value in PocketBase admin panel`);
    } else {
      console.log(`[${settingsCol.name}] brevo_api_key field already present ✓`);
    }
    if (!schema.find((f: any) => f.name === "force_unity_only")) {
      schema.push({ name: "force_unity_only", type: "bool", required: false });
      changed = true;
      console.log(`[${settingsCol.name}] force_unity_only field added (default false) ✓`);
    } else {
      console.log(`[${settingsCol.name}] force_unity_only field already present ✓`);
    }
    if (!schema.find((f: any) => f.name === "network_guard_enabled")) {
      schema.push({ name: "network_guard_enabled", type: "bool", required: false });
      changed = true;
      console.log(`[${settingsCol.name}] network_guard_enabled field added (default false) ✓`);
    } else {
      console.log(`[${settingsCol.name}] network_guard_enabled field already present ✓`);
    }
    // strict_match_enforcement (default false = grace mode): when true, the
    // game reward endpoints REJECT claims without a valid matchId. Flip to
    // true only after all three artifacts ship the matchId chain:
    // Railway backend redeploy, bridge.js re-upload to webcod.in, new APK.
    if (!schema.find((f: any) => f.name === "strict_match_enforcement")) {
      schema.push({ name: "strict_match_enforcement", type: "bool", required: false });
      changed = true;
      console.log(`[${settingsCol.name}] strict_match_enforcement field added (default false) ✓`);
    } else {
      console.log(`[${settingsCol.name}] strict_match_enforcement field already present ✓`);
    }
    // bep20_fees — dynamic BEP-20 network fee (SHIB) deducted from every BEP-20
    // withdrawal payout. 0/unset means "use the 3680 built-in default" wherever
    // it is read, so an unseeded record can never make withdrawals free.
    let bep20FeesAdded = false;
    if (!schema.find((f: any) => f.name === "bep20_fees")) {
      schema.push({ name: "bep20_fees", type: "number", required: false });
      changed = true;
      bep20FeesAdded = true;
      console.log(`[${settingsCol.name}] bep20_fees field added ✓`);
    } else {
      console.log(`[${settingsCol.name}] bep20_fees field already present ✓`);
    }
    if (changed) {
      await pbHttp("PATCH", `/api/collections/${settingsCol.id}`, { schema }, token);
    }
    // Seed the current fixed fee so the dashboard shows the live value immediately
    if (bep20FeesAdded) {
      try {
        const rec = await pbHttp("GET", `/api/collections/${settingsCol.name}/records?perPage=1`, null, token);
        const row = rec.items?.[0];
        if (row && !(Number(row.bep20_fees) > 0)) {
          await pbHttp("PATCH", `/api/collections/${settingsCol.name}/records/${row.id}`, { bep20_fees: 3680 }, token);
          console.log(`[${settingsCol.name}] bep20_fees seeded to 3680 ✓`);
        }
      } catch (e: any) {
        console.warn("[settings] bep20_fees seed skipped:", e.message);
      }
    }
  } catch (e: any) {
    console.warn("[settings] brevo_api_key patch skipped:", e.message);
  }
}

// ─── Per-user in-memory security guards ───────────────────────────────────
// Hourly game/ad reward limit: max 30 PT claims per hour per user
const gameRewardHourly = new Map<string, { count: number; windowStart: number }>();
// Daily PT cap: max 5 000 PT earned per calendar day per user
const dailyPtEarned   = new Map<string, { earned: number; day: string }>();
// One-time ad tokens: token → { pbId, reward, matchId?, expiresAt }
// matchId is bound at issue time so the 2× ad claim closes the SAME match the
// game committed — the client cannot swap in a different matchId at claim time.
const adTokenStore    = new Map<string, { pbId: string; reward: number; matchId?: string; expiresAt: number }>();
// Replay-attack guard: match IDs that have already been claimed this server instance.
// Prevents TOCTOU race conditions where two simultaneous requests both read
// match_status="started" before either has written "completed".
// Entries auto-expire after 6 hours to prevent unbounded memory growth.
const claimedMatchIds = new Map<string, number>(); // matchId → claimedAt timestamp
setInterval(() => {
  const cutoff = Date.now() - 6 * 3_600_000;
  for (const [id, ts] of claimedMatchIds) { if (ts < cutoff) claimedMatchIds.delete(id); }
}, 3_600_000).unref();

function checkHourlyRewardLimit(pbId: string): boolean {
  const MAX = 30;
  const now = Date.now();
  const e = gameRewardHourly.get(pbId);
  if (!e || now - e.windowStart > 3_600_000) {
    gameRewardHourly.set(pbId, { count: 1, windowStart: now });
    return true;
  }
  if (e.count >= MAX) return false;
  e.count++;
  return true;
}

function checkDailyPtCap(pbId: string, amount: number): boolean {
  const MAX = 5_000;
  const today = new Date().toISOString().slice(0, 10);
  const e = dailyPtEarned.get(pbId);
  if (!e || e.day !== today) {
    dailyPtEarned.set(pbId, { earned: amount, day: today });
    return true;
  }
  if (e.earned + amount > MAX) return false;
  e.earned += amount;
  return true;
}

// ─── Startup env-var validation ────────────────────────────────────────────
function validateEnv() {
  const REQUIRED = ['PB_ADMIN_EMAIL', 'PB_ADMIN_PASSWORD'];
  const RECOMMENDED = ['SMTP_USER', 'SMTP_KEY'];
  const missing = REQUIRED.filter((k) => !process.env[k]);
  const missingRec = RECOMMENDED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[ENV] ❌ CRITICAL — Missing required variables: ${missing.join(', ')}`);
    console.error('[ENV]    PocketBase admin operations WILL FAIL (fraud email save, OTP store, etc.)');
    console.error('[ENV]    Add these in Railway → Variables tab immediately.');
  } else {
    console.log('[ENV] ✓ PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are set');
  }
  if (missingRec.length) {
    console.warn(`[ENV] ⚠  Missing recommended variables: ${missingRec.join(', ')}`);
    console.warn('[ENV]    OTP email will fall back to hardcoded Brevo credentials (may fail on Railway).');
    console.warn('[ENV]    Add SMTP_USER + SMTP_KEY in Railway → Variables tab to fix email delivery.');
  } else {
    console.log('[ENV] ✓ SMTP_USER and SMTP_KEY are set — OTP email will use env credentials');
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────
export async function registerRoutes(app: Express): Promise<Server> {
  // Validate environment variables on startup — catches Railway misconfiguration immediately
  validateEnv();

  // Warm up admin token, ensure PB schema on startup
  getAdminToken()
    .then(() => ensureUserSchema())
    .then(() => ensureOtpCollection())
    .then(() => ensureDailyUsageCollection())
    .then(() => ensureDeletedEmailsCollection())
    .then(() => ensureFraudEmailsCollection())
    .then(() => ensureCollectionRules())
    .then(() => ensurePublicReferralsCollection())
    .then(() => ensureMiningSessionsRules())
    .then(() => ensureReferralEarningsLogCollection())
    .then(() => ensureBrevoKeyInSettings())
    .then(() => backfillWithdrawalMaskedNames())
    .then(() => ensureWithdrawalRedeemMethod())
    .then(() => ensureNotificationsCollection())
    .then(() => ensureSessionLogsCollection())
    .then(() => ensureGameScoreCollection())
    .then(() => { startMatchExpirySweeper(); })
    .then(() => ensureIsFlaggedField())
    .then(() => ensureBlacklistFields())
    .then(() => ensureSessionTokenField())
    .then(() => ensureVerificationSchema())
    .then(() => ensureTelegramVerificationsCollection())
    .then(() => ensureReferralHistoryCollection())
    .then(() => ensureTasksCollection())
    .then(() => ensureTaskSubmissionsCollection())
    .then(() => ensureTaskSubmissionsUniqueIndex())
    .then(() => migrateProofScreenshotToFile())
    .then(() => patchTasksCollectionRules())
    .then(() => ensureProxyApiCollection())
    .catch((e) => console.warn("[PB] Startup init failed:", e));

  // ── Security: Network check (VPN / proxy / geo guard verdict) ────────────
  // Whitelisted inside the guard middleware — always returns 200 with the
  // verdict so the client can poll it (boot + every 60 s + app-foreground).
  app.get("/api/app/security/network-check", async (req: Request, res: Response) => {
    try {
      if (!(await isNetworkGuardEnabled())) {
        return res.json({ blocked: false, reason: null });
      }
      const verdict = await checkNetworkAccess(req.ip || "");
      return res.json({ blocked: verdict.blocked, reason: verdict.reason });
    } catch {
      return res.json({ blocked: false, reason: null }); // fail-open
    }
  });

  // ── Security: Flag a device / user as cheating on PocketBase ─────────────
  // Called by SecurityContext when root / emulator / autoclicker is detected.
  // Writes is_flagged=true + flag_reason to the user's PB record so admins
  // can audit flagged accounts from the PocketBase admin dashboard.
  app.post("/api/app/security/flag-device", async (req: Request, res: Response) => {
    try {
      const { pbId, reason } = req.body;
      if (!pbId) return res.status(400).json({ error: "pbId required" });

      const token = await getAdminToken();
      await pbHttp("PATCH", `/api/collections/users/records/${pbId}`, {
        is_flagged:  true,
        flag_reason: String(reason ?? "unknown").slice(0, 64),
      }, token);

      console.warn(`[security] Device flagged: pbId=${pbId} reason=${reason}`);
      return res.json({ flagged: true });
    } catch (e: any) {
      console.warn("[security] flag-device error:", e.message);
      return res.status(500).json({ error: "Failed to flag device" });
    }
  });

  // ── Security: Verify Google Play Integrity token ───────────────────────────
  // The client (lib/playIntegrity.ts) requests an on-device attestation token
  // from Google Play Services and forwards it here for server-side verification.
  //
  // Prerequisites to activate:
  //   1. Enable Play Integrity API in Google Cloud Console.
  //   2. Create an API key and set GOOGLE_PLAY_INTEGRITY_KEY on Railway.
  //   3. Replace PACKAGE_NAME below with your actual bundle identifier.
  //
  // Without GOOGLE_PLAY_INTEGRITY_KEY the endpoint returns pass=true (fail-open)
  // so legitimate users are never blocked while credentials are being set up.
  app.post("/api/app/security/verify-integrity", async (req: Request, res: Response) => {
    try {
      const { token: integrityToken, pbId } = req.body;
      if (!integrityToken) return res.status(400).json({ error: "token required" });

      const apiKey = process.env.GOOGLE_PLAY_INTEGRITY_KEY;
      if (!apiKey) {
        // No credentials yet — fail open so legitimate users are not blocked
        return res.json({ pass: true, verdict: "SKIPPED_NO_CREDENTIALS" });
      }

      // Replace with your actual Android package name:
      const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME ?? "com.shibahit.app";

      const gResp = await fetch(
        `https://playintegrity.googleapis.com/v1/${PACKAGE_NAME}:decodeIntegrityToken?key=${apiKey}`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ integrity_token: integrityToken }),
        },
      );

      if (!gResp.ok) {
        // Google API error — fail open to avoid false-blocking legit users
        console.warn("[integrity] Google API error:", gResp.status);
        return res.json({ pass: true, verdict: "GOOGLE_API_ERROR" });
      }

      const data = await gResp.json();
      const verdicts: string[] =
        data?.tokenPayloadExternal?.deviceIntegrity?.deviceRecognitionVerdict ?? [];

      // Device passes if it meets BASIC or STRONG integrity
      const pass =
        verdicts.includes("MEETS_DEVICE_INTEGRITY") ||
        verdicts.includes("MEETS_STRONG_INTEGRITY") ||
        verdicts.includes("MEETS_BASIC_INTEGRITY");

      if (!pass && pbId) {
        // Fail + flag the user in PocketBase
        const adminTok = await getAdminToken();
        await pbHttp("PATCH", `/api/collections/users/records/${pbId}`, {
          is_flagged:  true,
          flag_reason: "play_integrity",
        }, adminTok).catch(() => {});
        console.warn(`[integrity] FAIL — pbId=${pbId} verdicts=${JSON.stringify(verdicts)}`);
      }

      return res.json({ pass, verdicts });
    } catch (e: any) {
      console.warn("[integrity] verify error:", e.message);
      // Fail open on unexpected errors
      return res.json({ pass: true, error: e.message });
    }
  });

  // ── OTP: Request account-deletion OTP ─────────────────────────────────────
  app.post("/api/auth/request-delete-otp", async (req: Request, res: Response) => {
    try {
      const { pbId, email } = req.body;
      if (!pbId || !email) return res.status(400).json({ error: "pbId and email required" });

      // Verify user exists
      const user = await pbGet(`/api/collections/users/records/${pbId}?fields=id`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      // Delete any existing OTPs for this user
      const existing = await pbGet(
        `/api/collections/otp_codes/records?filter=${encodeURIComponent(`user="${pbId}"`)}&perPage=50`,
      );
      for (const rec of existing.items ?? []) {
        await pbDelete(`/api/collections/otp_codes/records/${rec.id}`).catch(() => {});
      }

      // Generate cryptographically secure 6-digit OTP
      const otp = crypto.randomInt(100000, 1000000).toString();
      // PocketBase date field format: "YYYY-MM-DD HH:MM:SS" (no T, no Z, no ms)
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, "");

      // Store OTP in PocketBase — field names match the manually-created collection:
      //   user (relation → users), code (text), expires_at (date)
      console.log(`[OTP] Storing OTP record for user=${pbId}, expires_at=${expiresAt}`);
      const stored = await pbPost("/api/collections/otp_codes/records", {
        user: pbId,
        code: otp,
        expires_at: expiresAt,
      });
      // PB success: response has "id" and "collectionId". A real error has "status" (HTTP int) or no "id".
      if (!stored.id) {
        console.error("[OTP] PocketBase store failed — full response:", JSON.stringify(stored));
        return res.status(500).json({ error: `Failed to store OTP (PB ${stored.status || "unknown"}: ${stored.message || "unknown"})` });
      }

      // Check daily email limit (300/day) before sending
      const limitCheck = await checkAndIncrementDailyEmailLimit();
      if (!limitCheck.allowed) {
        return res.status(429).json({ error: limitCheck.message });
      }

      // Send email via Brevo SMTP
      try {
        await sendOtpEmail(email, otp);
      } catch (smtpErr: any) {
        console.error("[SMTP] Failed to deliver OTP email:", smtpErr.message, smtpErr.stack);
        // Include smtp_error in response so Railway logs are visible via curl (temporary debug)
        return res.status(500).json({
          error: "Failed to send email. Please try again later.",
          smtp_error: smtpErr?.message || String(smtpErr),
          smtp_code: smtpErr?.responseCode || smtpErr?.code || null,
        });
      }

      console.log(`[OTP] Sent deletion OTP to ${email} for user ${pbId}`);
      res.json({ success: true });
    } catch (e: any) {
      console.error("[/api/auth/request-delete-otp] Unexpected error:", e.message, e.stack);
      res.status(500).json({ error: e.message || "Failed to send OTP." });
    }
  });

  // ── OTP: Confirm deletion with OTP ────────────────────────────────────────
  app.post("/api/auth/confirm-delete", async (req: Request, res: Response) => {
    try {
      const { pbId, code } = req.body;
      if (!pbId || !code) return res.status(400).json({ error: "pbId and code required" });

      // Find OTP record for this user (field is "user" relation, not "user_id")
      const records = await pbGet(
        `/api/collections/otp_codes/records?filter=${encodeURIComponent(`user="${pbId}"`)}&perPage=10`,
      );
      const otpRecord = (records.items ?? []).find((r: any) => r.code === String(code).trim());

      if (!otpRecord) return res.status(400).json({ error: "Invalid OTP. Please try again." });

      // Check expiry
      if (new Date(otpRecord.expires_at) < new Date()) {
        await pbDelete(`/api/collections/otp_codes/records/${otpRecord.id}`).catch(() => {});
        return res.status(400).json({ error: "OTP has expired. Please request a new one." });
      }

      // Delete OTP record immediately (single-use)
      await pbDelete(`/api/collections/otp_codes/records/${otpRecord.id}`).catch(() => {});

      // ── Fraud prevention: fetch user email and blacklist it BEFORE deletion ──
      try {
        const userRecord = await pbGet(`/api/collections/users/records/${pbId}?fields=id,email`);
        if (userRecord?.email) {
          await blacklistEmail(userRecord.email);
        }
      } catch (e: any) {
        console.warn("[confirm-delete] Could not fetch user email for blacklisting:", e.message);
      }

      // Delete user's mining sessions
      try {
        const sessions = await pbGet(
          `/api/collections/mining_sessions/records?filter=${encodeURIComponent(`user="${pbId}"`)}&perPage=200`,
        );
        for (const s of sessions.items ?? []) {
          await pbDelete(`/api/collections/mining_sessions/records/${s.id}`).catch(() => {});
        }
      } catch { /* non-critical */ }

      // Delete the user record from PocketBase
      const deleteUrl = `${PB_URL}/api/collections/users/records/${pbId}`;
      const adminToken = await getAdminToken();
      const delRes = await fetch(deleteUrl, {
        method: "DELETE",
        headers: { Authorization: adminToken },
      });
      if (!delRes.ok && delRes.status !== 204) {
        console.error("[confirm-delete] PB user delete failed:", delRes.status);
        return res.status(500).json({ error: "Failed to delete account" });
      }

      console.log(`[confirm-delete] Account deleted for pbId=${pbId}`);
      res.json({ success: true });
    } catch (e: any) {
      console.error("[/api/auth/confirm-delete]", e.message);
      res.status(500).json({ error: "Account deletion failed. Please try again." });
    }
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  app.get("/api/app/settings", async (_req: Request, res: Response) => {
    try {
      const s = await fetchSettings();
      if (!s) return res.status(503).json({ error: "Settings unavailable" });
      res.json({
        id: s.id,
        miningRatePerSec: s.mining_rate_per_sec,
        powerTokenPerClick: s.power_token_per_click,
        miningDurationMinutes: s.mining_duration_minutes,
        tokensPerRound: s.tokens_per_round,
        boostCosts: {
          "2x": s.boost_2x_cost,
          "4x": s.boost_4x_cost,
          "6x": s.boost_6x_cost,
          "10x": s.boost_10x_cost,
        },
        minWithdrawal1: s.min_withdrawal_1,
        minWithdrawal2: s.min_withdrawal_2,
        minWithdrawal3: s.min_withdrawal_3,
        bep20Fees: Number(s.bep20_fees) > 0 ? Number(s.bep20_fees) : 3680,
        showAds: s.show_ads,
        activeAdNetwork: s.active_ad_network,
        admobUnitId: s.admob_unit_id,
        admobBannerUnitId: s.admob_banner_unit_id,
        admobRewardedId: s.admob_rewarded_id,
        forceUnityOnly: s.force_unity_only ?? false,
        networkGuardEnabled: s.network_guard_enabled ?? false,
        applovinSdkKey: s.applovin_sdk_key,
        applovinRewardedId: s.applovin_rewarded_id,
        unityGameId: s.unity_game_id,
        unityRewardedId: s.unity_rewarded_id,
        unityInterstitialId: s.unity_interstitial_id,
        applovinBannerId: s.applovin_banner_id,
        applovinInterstitialId: s.applovin_interstitial_id,
        appStoreLink: s.app_store_link || '',
        playStoreUrl: s.play_store_url || s.app_store_link || '',
        ratePopupFrequency: s.rate_popup_frequency || 5,
        minimumVersion: s.minimum_version || '',
        dailyRewardDay1Shib: s.daily_reward_day1_shib ?? 1000,
        dailyRewardDay2Pt:   s.daily_reward_day2_pt   ?? 50,
        dailyRewardDay3Shib: s.daily_reward_day3_shib ?? 3000,
        dailyRewardDay4Pt:   s.daily_reward_day4_pt   ?? 100,
        dailyRewardDay5Shib: s.daily_reward_day5_shib ?? 5000,
        dailyRewardDay6Pt:   s.daily_reward_day6_pt   ?? 200,
        dailyRewardDay7Shib: s.daily_reward_day7_shib ?? 10000,
        dailyRewardDay7Pt:   s.daily_reward_day7_pt   ?? 500,
      });
    } catch (e: any) {
      console.error("[/api/app/settings]", e.message);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  // ── Referral: Validate code ────────────────────────────────────────────────
  app.get("/api/app/auth/validate-referral", async (req: Request, res: Response) => {
    try {
      const code = (req.query.code as string || "").trim().toUpperCase();
      if (!code) return res.status(400).json({ valid: false, error: "Code required" });
      const r = await pbGet(
        `/api/collections/users/records?filter=referral_code="${encodeURIComponent(code)}"&perPage=1&fields=id,display_name`,
      );
      const referrer = r.items?.[0];
      if (!referrer) return res.json({ valid: false });
      res.json({ valid: true, referrerName: referrer.display_name || "" });
    } catch (e: any) {
      console.error("[/api/app/auth/validate-referral]", e.message);
      res.status(500).json({ valid: false, error: "Validation failed" });
    }
  });

  // ── Referral: Stats ────────────────────────────────────────────────────────
  app.get("/api/app/user/:pbId/referral-stats", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      const [user, referred] = await Promise.all([
        pbGet(`/api/collections/users/records/${pbId}?fields=id,referral_earnings,referral_balance`),
        pbGet(`/api/collections/users/records?filter=${encodeURIComponent(`referred_by="${pbId}"`)}&perPage=50&fields=id,email,created,total_claims`),
      ]);
      if (user.code) return res.status(404).json({ error: "User not found" });

      res.json({
        referredCount: referred.totalItems || 0,
        totalEarnings: user.referral_earnings || 0,
        referralBalance: user.referral_balance || 0,
        referredUsers: (referred.items || []).map((u: any) => ({
          id: u.id,
          email: u.email ? u.email.replace(/(.{2}).+(@.+)/, "$1***$2") : "***",
          joined: u.created,
          claims: u.total_claims || 0,
        })),
      });
    } catch (e: any) {
      console.error("[/api/app/user/referral-stats]", e.message);
      res.status(500).json({ error: "Failed to fetch referral stats" });
    }
  });

  // ── Referral balance claim ─────────────────────────────────────────────────
  app.post("/api/app/user/:pbId/claim-referral", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      const user = await pbGet(`/api/collections/users/records/${pbId}?fields=id,referral_balance,shib_balance`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const balance = user.referral_balance || 0;
      if (balance <= 0) return res.status(400).json({ error: "No referral rewards to claim" });
      const newShib = (user.shib_balance || 0) + balance;
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        shib_balance: newShib,
        referral_balance: 0,
      });
      res.json({ success: true, claimed: balance, newShibBalance: newShib });
    } catch (e: any) {
      console.error("[/api/app/user/claim-referral]", e.message);
      res.status(500).json({ error: "Failed to claim referral rewards" });
    }
  });

  // ── Delete Account (GDPR / compliance) ────────────────────────────────────
  app.delete("/api/app/user/:pbId/delete-account", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "Missing pbId" });

      // Verify user exists and fetch email for blacklisting
      const user = await pbGet(`/api/collections/users/records/${pbId}?fields=id,email`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      // ── Fraud prevention: blacklist email BEFORE deletion ──
      if (user.email) {
        await blacklistEmail(user.email).catch(() => {});
      }

      // Hard-delete from PocketBase
      const deleteUrl = `${process.env.PB_URL || "https://api.webcod.in"}/api/collections/users/records/${pbId}`;
      const token = await getAdminToken();
      const delRes = await fetch(deleteUrl, {
        method: "DELETE",
        headers: { Authorization: token },
      });

      if (!delRes.ok && delRes.status !== 204) {
        console.error("[delete-account] PB delete failed:", delRes.status);
        return res.status(500).json({ error: "Failed to delete user record" });
      }

      console.log(`[delete-account] Deleted PB user ${pbId}`);
      res.json({ success: true });
    } catch (e: any) {
      console.error("[/api/app/user/:pbId/delete-account]", e.message);
      res.status(500).json({ error: "Account deletion failed" });
    }
  });

  // ── Auth sync ─────────────────────────────────────────────────────────────
  app.post("/api/app/auth/sync", async (req: Request, res: Response) => {
    try {
      const { firebaseUid, email, displayName, referralCode, referredBy } =
        req.body;
      if (!firebaseUid || !email)
        return res.status(400).json({ error: "firebaseUid and email required" });

      // ── Fraud prevention: block deleted emails ──────────────────────────────
      const blocked = await isEmailBlacklisted(email);
      if (blocked) {
        console.warn(`[auth/sync] Blocked attempt from deleted-email blacklist: ${email}`);
        return res.status(403).json({
          error: "An account was previously associated with this email. This email is permanently restricted from new registrations.",
          code: "EMAIL_PERMANENTLY_BANNED",
        });
      }

      // ── Fraud prevention: block fraud_emails ─────────────────────────────────
      const fraudBlocked = await isFraudEmail(email);
      if (fraudBlocked) {
        console.warn(`[auth/sync] Blocked attempt from fraud_emails list: ${email}`);
        return res.status(403).json({
          error: "ACCOUNT_BLOCKED",
          blocked: true,
          message: "This email has been permanently banned due to fraudulent activity.",
        });
      }

      // Try to find existing user
      const existing = await pbGet(
        `/api/collections/users/records?filter=firebase_uid="${encodeURIComponent(firebaseUid)}"&perPage=1`,
      );
      if (existing.items?.[0]) {
        let u = existing.items[0];

        // Login blockade: dual-check — auto-heals accounts with >= 3 strikes but status not yet 'blocked'
        {
          const isBlocked = u.status === "blocked" || (u.fraud_attempts || 0) >= 3;
          if (isBlocked) {
            if (u.status !== "blocked") {
              await pbPatch(`/api/collections/users/records/${u.id}`, { status: "blocked" }).catch(() => {});
              console.warn(`[auth/sync] Auto-blocked user ${u.id} (fraud_attempts=${u.fraud_attempts})`);
            } else {
              console.warn(`[auth/sync] Blocked login attempt from banned user: ${u.id} (${email})`);
            }
            return res.status(403).json({
              error: "ACCOUNT_BLOCKED",
              blocked: true,
              message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts.",
            });
          }
        }

        // Auto-generate referral code if the user was created before this was added
        if (!u.referral_code) {
          const code = generateReferralCode();
          const updated = await pbPatch(`/api/collections/users/records/${u.id}`, {
            referral_code: code,
          });
          if (!updated.code) u = { ...u, referral_code: code };
        }
        return res.json(formatUser(u));
      }

      // Check if referred_by referral code exists
      let referrerPbId: string | undefined;
      if (referredBy) {
        const referrerRes = await pbGet(
          `/api/collections/users/records?filter=referral_code="${encodeURIComponent(referredBy)}"&perPage=1`,
        );
        referrerPbId = referrerRes.items?.[0]?.id;
      }

      // Try to find user by email — filter must be fully URL-encoded so @ in email doesn't break PB parser
      const byEmail = await pbGet(
        `/api/collections/users/records?filter=${encodeURIComponent(`email="${email}"`)}&perPage=1`,
      );
      if (byEmail.items?.[0]) {
        let u = byEmail.items[0];
        // If the existing PB record is NOT verified, delete it so we can create a fresh one.
        // This handles the case where a user signs up, never verifies, then tries to sign up again.
        if (!u.is_verified) {
          await pbDelete(`/api/collections/users/records/${u.id}`).catch(() => {});
          // Fall through to create a new record below
        } else {
          const patches: any = {};
          if (!u.firebase_uid) patches.firebase_uid = firebaseUid;
          if (!u.referral_code) patches.referral_code = referralCode || generateReferralCode();
          if (!u.display_name && displayName) patches.display_name = displayName;
          if (!u.referred_by && referrerPbId) patches.referred_by = referrerPbId;
          if (Object.keys(patches).length > 0) {
            const updated = await pbPatch(`/api/collections/users/records/${u.id}`, patches);
            if (!updated.code) u = { ...u, ...patches };
          }
          return res.json(formatUser(u));
        }
      }

      // Create PB user — is_verified starts false; set to true via /confirm-verified
      const code = referralCode || generateReferralCode();
      const pbPassword = `SHIB_${firebaseUid}_SECURE`;
      const created = await pbPost("/api/collections/users/records", {
        email,
        password: pbPassword,
        passwordConfirm: pbPassword,
        emailVisibility: false,
        firebase_uid: firebaseUid,
        display_name: displayName || email.split("@")[0],
        referral_code: code,
        referred_by: referrerPbId || "",
        shib_balance: 100,      // welcome bonus: 100 SHIB
        power_tokens: 500,      // welcome bonus: 500 Power Tokens
        referral_balance: 0,
        referral_earnings: 0,
        total_claims: 0,
        total_wins: 0,
        fraud_attempts: 0,
        status: "active",
        current_mining_session: "",
        is_verified: false,
      });

      if (created.code) {
        const detail = JSON.stringify({ code: created.code, message: created.message, data: created.data });
        console.error(`[auth/sync] PB user creation FAILED. email=${email} | PB error: ${detail}`);
        return res.status(400).json({ error: created.message, detail: created.data });
      }

      // Register referral code in public_referrals (publicly queryable for APK validation)
      pbHttp("POST", "/api/collections/public_referrals/records", {
        code: code,
        user_id: created.id,
      }).catch(() => {});

      // Give referrer 30 Power Tokens immediately on successful signup
      if (referrerPbId) {
        pbGet(`/api/collections/users/records/${referrerPbId}`).then(async (referrer) => {
          if (referrer?.id) {
            await pbPatch(`/api/collections/users/records/${referrerPbId}`, {
              power_tokens: (referrer.power_tokens || 10) + 30,
            });
          }
        }).catch(() => {});
      }

      return res.json(formatUser(created));
    } catch (e: any) {
      console.error("[/api/app/auth/sync]", e.message);
      res.status(500).json({ error: "Sync failed" });
    }
  });

  // ── Check if email exists in PocketBase (for Forgot Password validation) ─
  app.post("/api/app/auth/check-email", async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "email required" });
      const r = await pbGet(
        `/api/collections/users/records?filter=${encodeURIComponent(`email="${email}"`)}&perPage=1&fields=id,is_verified`,
      );
      const found = !!(r.items?.[0]);
      const verified = found && r.items[0].is_verified;
      return res.json({ found, verified });
    } catch (e: any) {
      console.error("[/api/app/auth/check-email]", e.message);
      return res.status(500).json({ error: "Failed to check email" });
    }
  });

  // ── Firebase Email Verification: Confirm Verified ────────────────────────
  // Called after Firebase emailVerified = true.
  // Finds or creates the PB user and marks is_verified: true.
  app.post("/api/app/auth/confirm-verified", async (req: Request, res: Response) => {
    try {
      const { firebaseUid, email, displayName, referralCode, referredBy } = req.body;
      if (!firebaseUid || !email)
        return res.status(400).json({ error: "firebaseUid and email required" });

      // ── Fraud prevention: block re-registration from a previously deleted email ──
      const confirmedBlocked = await isEmailBlacklisted(email);
      if (confirmedBlocked) {
        console.warn(`[confirm-verified] Blocked from blacklisted email: ${email}`);
        return res.status(403).json({
          error: "This email address is associated with a deleted account and cannot be used to create a new account.",
          code: "EMAIL_PERMANENTLY_BANNED",
        });
      }

      // Try to find by firebase_uid
      const byUid = await pbGet(
        `/api/collections/users/records?filter=firebase_uid="${encodeURIComponent(firebaseUid)}"&perPage=1`,
      );
      if (byUid.items?.[0]) {
        const u = byUid.items[0];
        const updated = await pbPatch(`/api/collections/users/records/${u.id}`, {
          is_verified: true,
        });
        return res.json(formatUser(updated.code ? { ...u, is_verified: true } : updated));
      }

      // Try to find by email — filter must be fully URL-encoded so @ in email doesn't break PB parser
      const byEmail = await pbGet(
        `/api/collections/users/records?filter=${encodeURIComponent(`email="${email}"`)}&perPage=1`,
      );
      if (byEmail.items?.[0]) {
        const u = byEmail.items[0];
        const patches: any = { is_verified: true };
        if (!u.firebase_uid) patches.firebase_uid = firebaseUid;
        if (!u.referral_code && referralCode) patches.referral_code = referralCode;
        if (!u.display_name && displayName) patches.display_name = displayName;
        const updated = await pbPatch(`/api/collections/users/records/${u.id}`, patches);
        return res.json(formatUser(updated.code ? { ...u, ...patches } : updated));
      }

      // Create fresh PB user — already verified via Firebase
      const code = referralCode || generateReferralCode();
      const pbPassword = `SHIB_${firebaseUid}_SECURE`;

      let referrerPbId: string | undefined;
      if (referredBy) {
        const referrerRes = await pbGet(
          `/api/collections/users/records?filter=referral_code="${encodeURIComponent(referredBy)}"&perPage=1`,
        );
        referrerPbId = referrerRes.items?.[0]?.id;
      }

      const created = await pbPost("/api/collections/users/records", {
        email,
        password: pbPassword,
        passwordConfirm: pbPassword,
        emailVisibility: false,
        firebase_uid: firebaseUid,
        display_name: displayName || email.split("@")[0],
        referral_code: code,
        referred_by: referrerPbId || "",
        shib_balance: 100,        // welcome bonus: 100 SHIB
        power_tokens: 500,        // welcome bonus: 500 Power Tokens
        referral_balance: 0,
        referral_earnings: 0,
        total_claims: 0,
        total_wins: 0,
        fraud_attempts: 0,
        status: "active",
        current_mining_session: "",
        is_verified: true,
      });

      if (created.code) {
        const detail = JSON.stringify({ code: created.code, message: created.message, data: created.data });
        console.error(`[confirm-verified] PB user creation FAILED. payload email=${email} displayName=${displayName} | PB error: ${detail}`);
        return res.status(400).json({ error: created.message, detail: created.data });
      }

      // Give referrer 30 Power Tokens immediately on successful signup
      if (referrerPbId) {
        pbGet(`/api/collections/users/records/${referrerPbId}`)
          .then(async (r) => {
            if (r?.id) await pbPatch(`/api/collections/users/records/${referrerPbId}`, {
              power_tokens: (r.power_tokens || 10) + 30,
            });
          }).catch(() => {});
      }

      return res.json(formatUser(created));
    } catch (e: any) {
      console.error("[/api/app/auth/confirm-verified]", e.message);
      res.status(500).json({ error: "Failed to confirm verification" });
    }
  });

  // ── Dev-only status check ─────────────────────────────────────────────────
  if (process.env.NODE_ENV !== "production") {
    app.get("/api/dev/status", (_req: Request, res: Response) => {
      res.json({ env: "development", authMode: "firebase-email-link" });
    });

    // Debug: look up a user in PB by email or firebase_uid (dev only, no auth required)
    app.get("/api/dev/lookup-user", async (req: Request, res: Response) => {
      try {
        const { email, uid } = req.query;
        const results: any = {};

        if (email) {
          const r = await pbGet(`/api/collections/users/records?filter=${encodeURIComponent(`email="${email}"`)}&perPage=1`);
          results.byEmail = r.items?.[0] ? {
            id: r.items[0].id,
            email: r.items[0].email,
            display_name: r.items[0].display_name,
            firebase_uid: r.items[0].firebase_uid,
            is_verified: r.items[0].is_verified,
            shib_balance: r.items[0].shib_balance,
            power_tokens: r.items[0].power_tokens,
            referral_balance: r.items[0].referral_balance,
            referral_earnings: r.items[0].referral_earnings,
            referral_code: r.items[0].referral_code,
          } : null;
        }

        if (uid) {
          const r = await pbGet(`/api/collections/users/records?filter=${encodeURIComponent(`firebase_uid="${uid}"`)}&perPage=1`);
          results.byUid = r.items?.[0] ? {
            id: r.items[0].id,
            email: r.items[0].email,
            display_name: r.items[0].display_name,
            firebase_uid: r.items[0].firebase_uid,
            is_verified: r.items[0].is_verified,
            shib_balance: r.items[0].shib_balance,
            power_tokens: r.items[0].power_tokens,
            referral_balance: r.items[0].referral_balance,
            referral_earnings: r.items[0].referral_earnings,
            referral_code: r.items[0].referral_code,
          } : null;
        }

        res.json(results);
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  // ── Get user by Firebase UID ──────────────────────────────────────────────
  app.get("/api/app/user/:firebaseUid", async (req: Request, res: Response) => {
    try {
      const firebaseUid = String(req.params.firebaseUid);
      const r = await pbGet(
        `/api/collections/users/records?filter=firebase_uid="${encodeURIComponent(firebaseUid)}"&perPage=1`,
      );
      let u = r.items?.[0];
      if (!u) return res.status(404).json({ error: "User not found" });

      // Login blockade: dual-check — auto-heals accounts with >= 3 strikes but status not yet 'blocked'
      {
        const isBlocked = u.status === "blocked" || (u.fraud_attempts || 0) >= 3;
        if (isBlocked) {
          if (u.status !== "blocked") {
            await pbPatch(`/api/collections/users/records/${u.id}`, { status: "blocked" }).catch(() => {});
            console.log(`[getUser] Auto-blocked user ${u.id} (fraud_attempts=${u.fraud_attempts})`);
          }
          return res.status(403).json({
            error: "ACCOUNT_BLOCKED",
            blocked: true,
            message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts.",
          });
        }
      }

      // Auto-generate referral code if missing
      if (!u.referral_code) {
        const code = generateReferralCode();
        const updated = await pbPatch(`/api/collections/users/records/${u.id}`, {
          referral_code: code,
        });
        if (!updated.code) u = { ...u, referral_code: code };
      }

      res.json(formatUser(u));
    } catch (e: any) {
      console.error("[/api/app/user/:id]", e.message);
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });

  // ── Update user balance ───────────────────────────────────────────────────
  app.put(
    "/api/app/user/:pbId/balance",
    async (req: Request, res: Response) => {
      try {
        const { pbId } = req.params;
        const { shibBalance } = req.body;
        const update: any = {};
        if (shibBalance !== undefined) update.shib_balance = shibBalance;
        // power_tokens is intentionally excluded — PT must only be modified via
        // /api/app/game/reward or /api/app/ad/claim (server-enforced with rate limiting).
        const updated = await pbPatch(
          `/api/collections/users/records/${pbId}`,
          update,
        );
        if (updated.code) return res.status(400).json({ error: updated.message });
        res.json(formatUser(updated));
      } catch (e: any) {
        console.error("[/api/app/user/:pbId/balance]", e.message);
        res.status(500).json({ error: "Failed to update balance" });
      }
    },
  );

  // ── Boosters: Activate ────────────────────────────────────────────────────
  app.post("/api/app/boosters/activate", async (req: Request, res: Response) => {
    try {
      const { pbId, multiplier } = req.body;
      if (!pbId || !multiplier)
        return res.status(400).json({ error: "pbId and multiplier required" });

      const [user, settings] = await Promise.all([
        pbGet(`/api/collections/users/records/${pbId}`),
        fetchSettings(),
      ]);

      if (user.code) return res.status(404).json({ error: "User not found" });
      if (!settings) return res.status(503).json({ error: "Settings unavailable" });

      // Determine cost
      const costKey = `boost_${multiplier}x_cost`;
      const cost = settings[costKey];
      if (cost === undefined)
        return res.status(400).json({ error: "Invalid multiplier" });

      if ((user.power_tokens || 0) < cost) {
        return res.status(400).json({ error: "Not enough Power Tokens" });
      }

      const expiresAt = (Date.now() + 3600000).toString();
      const updated = await pbPatch(`/api/collections/users/records/${pbId}`, {
        power_tokens: user.power_tokens - cost,
        active_booster_multiplier: multiplier,
        booster_expires: expiresAt,
      });

      if (updated.code) return res.status(400).json({ error: updated.message });

      res.json({
        success: true,
        multiplier,
        expiresAt,
        newPowerTokens: user.power_tokens - cost,
      });
    } catch (e: any) {
      console.error("[/api/app/boosters/activate]", e.message);
      res.status(500).json({ error: "Failed to activate booster" });
    }
  });

  // ── Boosters: Activate + Start Mining (atomic) ───────────────────────────
  // Combines booster activation and mining start into one round-trip.
  // Deducts boosterCost + miningEntryCost, sets booster fields, creates session.
  app.post("/api/app/boosters/activate-and-mine", async (req: Request, res: Response) => {
    try {
      const { pbId, multiplier } = req.body;
      if (!pbId || !multiplier)
        return res.status(400).json({ error: "pbId and multiplier required" });

      const [user, settings] = await Promise.all([
        pbGet(`/api/collections/users/records/${pbId}`),
        fetchSettings(),
      ]);

      if (user.code) return res.status(404).json({ error: "User not found" });
      if (!settings) return res.status(503).json({ error: "Settings unavailable" });

      // Guard 0: dual-check — status field OR accumulated strikes >= 3 (auto-heals legacy records)
      {
        const isBlocked = user.status === "blocked" || (user.fraud_attempts || 0) >= 3;
        if (isBlocked) {
          if (user.status !== "blocked") {
            await pbPatch(`/api/collections/users/records/${pbId}`, { status: "blocked" }).catch(() => {});
            console.log(`[Guard0/start] Auto-blocked user ${pbId} (fraud_attempts=${user.fraud_attempts})`);
          }
          return res.status(403).json({
            error: "ACCOUNT_BLOCKED",
            blocked: true,
            message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts.",
          });
        }
      }

      // Booster cost
      const costKey = `boost_${multiplier}x_cost`;
      const boosterCost = settings[costKey];
      if (boosterCost === undefined)
        return res.status(400).json({ error: "Invalid multiplier" });

      // Mining entry cost
      const miningCost = settings.power_token_per_click || 24;
      const totalCost = boosterCost + miningCost;

      const currentPT = user.power_tokens || 0;
      if (currentPT < boosterCost)
        return res.status(400).json({ error: `Not enough Power Tokens for booster (need ${boosterCost} PT)`, code: "INSUFFICIENT_PT" });
      if (currentPT < totalCost)
        return res.status(400).json({ error: `Not enough Power Tokens (need ${totalCost} PT: ${boosterCost} PT booster + ${miningCost} PT mining)`, code: "INSUFFICIENT_PT" });

      const boosterExpiresAt = (Date.now() + 3600000).toString();

      // 1. Deduct total cost AND set booster in one PATCH
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        power_tokens: currentPT - totalCost,
        active_booster_multiplier: multiplier,
        booster_expires: boosterExpiresAt,
      });

      // 2. Expire any existing unclaimed sessions
      const existing = await pbGet(
        `/api/collections/mining_sessions/records?filter=${encodeURIComponent(`user="${pbId}" && claimed_amount=0`)}&perPage=50`,
      );
      for (const s of existing.items || []) {
        await pbPatch(`/api/collections/mining_sessions/records/${s.id}`, { claimed_amount: -1 });
      }

      // 3. Create new mining session
      const rate = settings.mining_rate_per_sec || 0.01736;
      const dur = settings.mining_duration_minutes || 60;
      // Lock the user's CURRENT VIP level into this session (like booster_multiplier).
      const lockedVip = normalizeVipLevel(user.vip_level);
      const expectedReward = effectiveRatePerSec(rate, lockedVip) * dur * 60 * multiplier;

      const session = await pbPost("/api/collections/mining_sessions/records", {
        user: pbId,
        start_time: new Date().toISOString().replace("T", " ").replace("Z", ""),
        claimed_amount: 0,
        is_verified: false,
        ip_address: String(req.ip || req.socket?.remoteAddress || ""),
        booster_multiplier: multiplier,
        vip_level: lockedVip,
      });

      if (session.code)
        return res.status(400).json({ error: session.message });

      // Link session to user as the server-side canonical reference for claim validation
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        current_mining_session: session.id,
      });

      const durationMs = dur * 60 * 1000;
      const rawStart = (session.created || session.start_time || "").replace(" ", "T");
      const parsedStart = rawStart.endsWith("Z") ? rawStart : rawStart + "Z";
      const startTimeMs = new Date(parsedStart).getTime();
      const endTimeMs = startTimeMs + durationMs;
      const serverNow = Date.now();

      res.json({
        id: session.id,
        pbId,
        startTimeMs,
        endTimeMs,
        durationMs,
        serverTime: serverNow,
        multiplier,
        expectedReward,
        miningRatePerSec: rate,
        vipLevel: lockedVip,
        boosterExpiresAt,
        ptDeducted: totalCost,
        newPowerTokens: currentPT - totalCost,
        status: "mining",
      });
    } catch (e: any) {
      console.error("[/api/app/boosters/activate-and-mine]", e.message);
      res.status(500).json({ error: "Failed to activate booster and start mining" });
    }
  });

  // ── Boosters: Get active ──────────────────────────────────────────────────
  app.get(
    "/api/app/boosters/active/:pbId",
    async (req: Request, res: Response) => {
      try {
        const { pbId } = req.params;
        const user = await pbGet(`/api/collections/users/records/${pbId}`);
        if (user.code) return res.status(404).json({ error: "User not found" });

        const expires = user.booster_expires ? parseInt(user.booster_expires) : 0;
        if (expires > Date.now()) {
          return res.json({
            multiplier: user.active_booster_multiplier || 1,
            expiresAt: user.booster_expires,
          });
        }

        // Auto-clear expired booster fields if they were set
        if (user.active_booster_multiplier !== 1 || user.booster_expires) {
          await pbPatch(`/api/collections/users/records/${pbId}`, {
            active_booster_multiplier: 1,
            booster_expires: "",
          });
        }

        res.json({ multiplier: 1, expiresAt: null });
      } catch (e: any) {
        console.error("[/api/app/boosters/active]", e.message);
        res.status(500).json({ error: "Failed to fetch booster" });
      }
    },
  );

  // ── Server time — anti-clock-manipulation ─────────────────────────────────
  // Returns server Unix timestamp in ms. Clients use this to compute clock
  // drift so that the countdown timer always tracks server time, not phone time.
  app.get("/api/app/server-time", (_req: Request, res: Response) => {
    res.json({ serverTime: Date.now() });
  });

  // ── Temporary SMTP debug — shows Railway env var state (key masked) ────────
  app.get("/api/debug/smtp-config", (_req: Request, res: Response) => {
    const rawUser = process.env.SMTP_USER || '(not set)';
    const rawPass = process.env.SMTP_KEY  || '(not set)';
    res.json({
      smtp_user:      rawUser,
      smtp_key_set:   rawPass !== '(not set)',
      smtp_key_tail:  rawPass !== '(not set)' ? rawPass.slice(-8) : '(not set)',
      smtp_user_looks_like_key: rawUser.startsWith('xsmtpsib-'),
      node_env:       process.env.NODE_ENV || '(not set)',
    });
  });

  app.post("/api/app/mine/start", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.body;
      if (!pbId)
        return res.status(400).json({ error: "pbId required" });

      // Fetch user and settings in parallel
      const [userRecord, settings] = await Promise.all([
        pbGet(`/api/collections/users/records/${pbId}`),
        fetchSettings(),
      ]);

      if (userRecord.code)
        return res.status(404).json({ error: "User not found" });

      // Guard 0: dual-check — status field OR accumulated strikes >= 3 (auto-heals legacy records)
      {
        const isBlocked = userRecord.status === "blocked" || (userRecord.fraud_attempts || 0) >= 3;
        if (isBlocked) {
          if (userRecord.status !== "blocked") {
            await pbPatch(`/api/collections/users/records/${pbId}`, { status: "blocked" }).catch(() => {});
            console.log(`[Guard0/activate] Auto-blocked user ${pbId} (fraud_attempts=${userRecord.fraud_attempts})`);
          }
          return res.status(403).json({
            error: "ACCOUNT_BLOCKED",
            blocked: true,
            message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts.",
          });
        }
      }

      // Calculate effective booster multiplier
      let activeMultiplier = 1;
      if (userRecord.booster_expires) {
        const expires = parseInt(userRecord.booster_expires);
        if (expires > Date.now()) {
          activeMultiplier = userRecord.active_booster_multiplier || 1;
        }
      }

      // Deduct power_token_per_click as mining entry fee
      const ptCost = settings?.power_token_per_click || 24;
      const currentPT = userRecord.power_tokens || 0;
      if (currentPT < ptCost) {
        return res.status(400).json({
          error: `Not enough Power Tokens. You need ${ptCost} PT to start mining but only have ${currentPT} PT.`,
          code: "INSUFFICIENT_PT",
          required: ptCost,
          current: currentPT,
        });
      }

      await pbPatch(`/api/collections/users/records/${pbId}`, {
        power_tokens: currentPT - ptCost,
      });

      // Expire any existing active sessions
      const existing = await pbGet(
        `/api/collections/mining_sessions/records?filter=user="${pbId}"&perPage=50`,
      );
      for (const s of existing.items || []) {
        if (!s.claimed_amount || s.claimed_amount === 0) {
          await pbPatch(
            `/api/collections/mining_sessions/records/${s.id}`,
            { claimed_amount: -1 },
          );
        }
      }

      const rate = settings?.mining_rate_per_sec || 0.01736;
      const dur = settings?.mining_duration_minutes || 60;
      // Lock the user's CURRENT VIP level into this session (like booster_multiplier)
      // so a mid-session upgrade/downgrade never applies retroactively.
      const lockedVip = normalizeVipLevel(userRecord.vip_level);
      const expectedReward = effectiveRatePerSec(rate, lockedVip) * dur * 60 * activeMultiplier;

      const session = await pbPost("/api/collections/mining_sessions/records", {
        user: pbId,
        start_time: new Date().toISOString().replace("T", " ").replace("Z", ""),
        claimed_amount: 0,
        is_verified: false,
        ip_address: String(req.ip || req.socket?.remoteAddress || ""),
        booster_multiplier: activeMultiplier,
        vip_level: lockedVip,
      });

      if (session.code)
        return res.status(400).json({ error: session.message });

      // Link this session to the user record — server-side source of truth for claim validation
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        current_mining_session: session.id,
      });

      const durationMs = dur * 60 * 1000;
      // Use PocketBase's server-assigned `created` timestamp as the canonical
      // start time. This is set by PB's own clock — completely tamper-proof.
      const rawCreated = (session.created || session.start_time || "").replace(" ", "T");
      const parsedCreated = rawCreated.endsWith("Z") ? rawCreated : rawCreated + "Z";
      const startTimeMs = new Date(parsedCreated).getTime();
      const endTimeMs = startTimeMs + durationMs;
      const serverNow = Date.now();

      res.json({
        id: session.id,
        pbId,
        startTime: session.created || session.start_time,
        startTimeMs,   // derived from PB's created — tamper-proof server time
        endTimeMs,     // explicit deadline
        durationMs,
        serverTime: serverNow,   // client syncs clock drift using this
        multiplier: activeMultiplier,
        expectedReward,
        miningRatePerSec: rate,
        vipLevel: lockedVip,
        ptDeducted: ptCost,
        newPowerTokens: currentPT - ptCost,
        status: "mining",
      });
    } catch (e: any) {
      console.error("[/api/app/mine/start]", e.message);
      res.status(500).json({ error: "Failed to start mining" });
    }
  });

  // ── Mining: Get active session ────────────────────────────────────────────
  app.get(
    "/api/app/mine/active/:pbId",
    async (req: Request, res: Response) => {
      try {
        const { pbId } = req.params;

        // Check account status before returning session data — also fetch fraud_attempts for dual-check
        const userCheck = await pbGet(`/api/collections/users/records/${pbId}?fields=id,status,fraud_attempts`);
        if (!userCheck.code) {
          const isBlocked = userCheck.status === "blocked" || (userCheck.fraud_attempts || 0) >= 3;
          if (isBlocked) {
            if (userCheck.status !== "blocked") {
              await pbPatch(`/api/collections/users/records/${pbId}`, { status: "blocked" }).catch(() => {});
              console.log(`[Guard0/active] Auto-blocked user ${pbId} (fraud_attempts=${userCheck.fraud_attempts})`);
            }
            return res.status(403).json({
              error: "ACCOUNT_BLOCKED",
              blocked: true,
              message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts.",
            });
          }
        }

        const r = await pbGet(
          `/api/collections/mining_sessions/records?filter=${encodeURIComponent(`user="${pbId}" && claimed_amount=0`)}&sort=-start_time&perPage=1`,
        );
        const s = r.items?.[0];
        if (!s) return res.json({ session: null });

        const settings = await fetchSettings();
        const dur = (settings?.mining_duration_minutes || 60) * 60 * 1000;

        // Use PB's server-assigned `created` as canonical start (tamper-proof)
        const rawStart = (s.created || s.start_time || "").replace(" ", "T");
        const parsedStart = rawStart.endsWith("Z") ? rawStart : rawStart + "Z";
        const startTimeMs = new Date(parsedStart).getTime();
        const endTimeMs = startTimeMs + dur;
        const serverNow = Date.now();
        const elapsed = serverNow - startTimeMs;
        const status = elapsed >= dur ? "ready_to_claim" : "mining";

        res.json({
          session: {
            id: s.id,
            startTime: s.created || s.start_time,
            startTimeMs,               // derived from PB's created — tamper-proof
            endTimeMs,                 // Unix-ms deadline
            durationMs: dur,
            serverTime: serverNow,     // client uses this to sync clock drift
            status,
            multiplier: s.booster_multiplier || 1,
          },
        });
      } catch (e: any) {
        console.error("[/api/app/mine/active]", e.message);
        res.status(500).json({ error: "Failed to fetch session" });
      }
    },
  );

  // ── Mining: Claim ─────────────────────────────────────────────────────────
  // 100% server-authoritative. Client sends only sessionId + pbId.
  // Server validates via user.current_mining_session (tamper-proof), not client's sessionId.
  // Reward is calculated exclusively server-side — no client input trusted.
  app.post("/api/app/mine/claim", async (req: Request, res: Response) => {
    try {
      const { sessionId, pbId } = req.body;
      if (!pbId)
        return res.status(400).json({ error: "pbId required" });

      // Fetch user and settings first — user.current_mining_session is the canonical reference
      const [user, settings] = await Promise.all([
        pbGet(`/api/collections/users/records/${pbId}`),
        fetchSettings(),
      ]);

      if (user.code) return res.status(404).json({ error: "User not found" });
      if (!settings) return res.status(503).json({ error: "Settings unavailable" });

      // Guard 0: dual-check — status field OR accumulated strikes >= 3 (auto-heals legacy records)
      {
        const isBlocked = user.status === "blocked" || (user.fraud_attempts || 0) >= 3;
        if (isBlocked) {
          if (user.status !== "blocked") {
            await pbPatch(`/api/collections/users/records/${pbId}`, { status: "blocked" }).catch(() => {});
            console.log(`[Guard0/claim] Auto-blocked user ${pbId} (fraud_attempts=${user.fraud_attempts})`);
          }
          return res.status(403).json({
            error: "ACCOUNT_BLOCKED",
            blocked: true,
            message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts.",
          });
        }
      }

      // Use server's current_mining_session as canonical session ID.
      // Client's sessionId is accepted only as fallback for legacy sessions.
      const canonicalSessionId = user.current_mining_session || sessionId;
      if (!canonicalSessionId)
        return res.status(400).json({ error: "No active mining session found" });

      const session = await pbGet(`/api/collections/mining_sessions/records/${canonicalSessionId}`);
      if (session.code) return res.status(404).json({ error: "Session not found" });

      // Guard 1: session must belong to this user
      if (session.user !== pbId) {
        return res.status(403).json({ error: "Session does not belong to this user" });
      }

      // Guard 2: reject sessions that are already claimed (> 0) OR voided/expired (< 0 i.e. = -1).
      // CRITICAL: must use !== 0 not > 0 — voided sessions have claimed_amount = -1
      // which passes a > 0 check and lets the same dead session trigger fraud repeatedly.
      const claimedAmt = session.claimed_amount ?? 0;
      if (claimedAmt !== 0) {
        // Clear the stale reference so the UI can start fresh
        await pbPatch(`/api/collections/users/records/${pbId}`, {
          current_mining_session: "",
        }).catch(() => {});
        return res.status(400).json({
          error: "SESSION_EXPIRED",
          message: "This mining session has already been used. Please start a new one.",
        });
      }

      // Guard 3: mining time must have actually elapsed (server-authoritative time)
      // Use PB's `created` field — auto-assigned by PocketBase, tamper-proof.
      // Fall back to start_time for legacy sessions created before this change.
      const canonicalStart = session.created || session.start_time;
      const rawStartMs = (canonicalStart || "").replace(" ", "T");
      const parsedStartMs = rawStartMs.endsWith("Z") ? rawStartMs : rawStartMs + "Z";
      const startMs = new Date(parsedStartMs).getTime();
      const durationSec = (settings.mining_duration_minutes || 60) * 60;
      const elapsed = Date.now() - startMs;
      // 5-minute grace so a claim arriving fractionally early due to network delay is accepted.
      // There is no upper bound — late claimers (70 min, 2 hrs, etc.) always get their reward.
      const graceSec = 5 * 60;
      if (elapsed < (durationSec - graceSec) * 1000) {
        // ── 3-strike fraud detection ──────────────────────────────────────────
        // Re-read fraud_attempts fresh to avoid race conditions
        const currentStrikes = user.fraud_attempts || 0;
        const strikes = currentStrikes + 1;
        const isBlocked = strikes >= 3;

        console.log(`[FRAUD] user=${pbId} prev_strikes=${currentStrikes} new_strikes=${strikes} blocked=${isBlocked} elapsed=${Math.round(elapsed/1000)}s required=${durationSec}s`);

        // 1. Expire the fraud session by DELETING it from the collection.
        //    This guarantees no future claim can ever use this session.
        try {
          await pbDelete(`/api/collections/mining_sessions/records/${session.id}`);
          console.log(`[FRAUD] Deleted session ${session.id}`);
        } catch {
          // Fallback: mark as voided if delete fails
          await pbPatch(`/api/collections/mining_sessions/records/${session.id}`, { claimed_amount: -1 });
          console.log(`[FRAUD] Marked session ${session.id} as voided (delete failed)`);
        }

        // 2. Update user: increment strike, wipe current session, block if >= 3 strikes
        await pbPatch(`/api/collections/users/records/${pbId}`, {
          fraud_attempts: strikes,
          current_mining_session: "",
          ...(isBlocked ? { status: "blocked" } : {}),
        });

        console.log(`[FRAUD] Updated user ${pbId}: fraud_attempts=${strikes} blocked=${isBlocked}`);

        // Log fraud attempt for admin analytics
        pbPost("/api/collections/session_logs/records", {
          user:              pbId,
          session_type:      "fraud",
          income:            0,
          booster_multiplier: 0,
          duration_seconds:  durationSec,
        }).catch(() => {});

        // 3. On 3rd strike: save email to fraud_emails so login is blocked with specific message
        if (isBlocked && user.email) {
          await saveFraudEmail(user.email);
        }

        const strikesLeft = 3 - strikes;
        return res.status(isBlocked ? 403 : 400).json({
          error: isBlocked ? "ACCOUNT_BLOCKED" : "FRAUD_DETECTED",
          fraudAttempts: strikes,
          blocked: isBlocked,
          message: isBlocked
            ? "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts."
            : `Strike ${strikes}/3! Cheat detected. Your progress has been reset. ${strikesLeft} more attempt${strikesLeft === 1 ? "" : "s"} and you will be permanently banned.`,
        });
      }

      // Server-side reward — 100% authoritative, no client value accepted
      const boosterMultiplier = session.booster_multiplier || 1;
      const miningRate = settings.mining_rate_per_sec || 0.01736;

      // ── VIP reward: pay at the session-locked tier, capped by CURRENT balance
      //    (anti-drain) and floored at admin_promoted_level. Admin-promoted users
      //    are immune from the cap. Never block the claim — adjust and demote.
      const sessionVip = normalizeVipLevel(session.vip_level);
      const currentVip = normalizeVipLevel(user.vip_level);
      const promoted = !!user.is_admin_promoted;
      const vipFloor = normalizeVipLevel(user.admin_promoted_level);
      const balanceForTier = user.shib_balance || 0;

      let claimVip = sessionVip;
      let newUserVip = currentVip;
      let vipAdjusted = false;
      if (!promoted) {
        claimVip = highestBalanceEligibleTier(balanceForTier, sessionVip, vipFloor);
        newUserVip = highestBalanceEligibleTier(balanceForTier, currentVip, vipFloor);
        vipAdjusted = newUserVip < currentVip;
      }

      const serverReward = effectiveRatePerSec(miningRate, claimVip) * durationSec * boosterMultiplier;

      // Mark session claimed FIRST — any duplicate request now hits Guard 2
      // IMPORTANT: use session.id (from the fetched record), NOT the client-provided sessionId
      console.log(`[mine/claim] Claiming session ${session.id} for user ${pbId} — reward: ${serverReward}`);
      const claimPatch = await pbPatch(`/api/collections/mining_sessions/records/${session.id}`, {
        claimed_amount: serverReward,
        is_verified: true,
      });
      if (claimPatch.code) {
        return res.status(500).json({ error: "Failed to mark session as claimed" });
      }

      const newShib = (user.shib_balance || 0) + serverReward;
      const newClaims = (user.total_claims || 0) + 1;
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        shib_balance: newShib,
        total_claims: newClaims,
        current_mining_session: "",   // nullify — user can now start a fresh session
        fraud_attempts: 0,            // reset strike counter after a legitimate claim
        vip_level: newUserVip,        // persist any anti-drain demotion going forward
      });

      // Log completed session for admin analytics
      pbPost("/api/collections/session_logs/records", {
        user:               pbId,
        session_type:       `${boosterMultiplier}x`,
        income:             serverReward,
        booster_multiplier: boosterMultiplier,
        duration_seconds:   durationSec,
      }).catch(() => {});

      // 10% referral commission → goes into referral_balance (must be claimed)
      if (user.referred_by) {
        (async () => {
          try {
            let referrer: any = null;
            const direct = await pbGet(`/api/collections/users/records/${user.referred_by}`);
            if (!direct.code && direct.id) {
              referrer = direct;
            } else {
              const byCode = await pbGet(
                `/api/collections/users/records?filter=referral_code="${encodeURIComponent(user.referred_by)}"&perPage=1`,
              );
              referrer = byCode.items?.[0] || null;
            }
            if (referrer) {
              const commission = Math.round(serverReward * 0.1);
              if (commission > 0) {
                await pbPatch(`/api/collections/users/records/${referrer.id}`, {
                  referral_balance:   (referrer.referral_balance || 0) + commission,
                  referral_earnings:  (referrer.referral_earnings || 0) + commission,
                });
                // Log referral commission for admin analytics
                pbPost("/api/collections/referral_history/records", {
                  referrer_id:    referrer.id,
                  claimer_id:     pbId,
                  referrer_email: referrer.email || "",
                  claimer_email:  user.email || "",
                  amount:         commission,
                  source:         "mining_claim",
                }).catch(() => {});
              }
            }
          } catch (_) {}
        })();
      }

      res.json({ success: true, newShibBalance: newShib, reward: serverReward, vipLevel: newUserVip, vipAdjusted });
    } catch (e: any) {
      console.error("[/api/app/mine/claim]", e.message);
      res.status(500).json({ error: "Failed to claim reward" });
    }
  });

  // ── Mining history ─────────────────────────────────────────────────────────
  app.get("/api/app/mine/history/:pbId", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const filter = encodeURIComponent(`user="${pbId}" && claimed_amount > 0`);
      const r = await pbGet(
        `/api/collections/mining_sessions/records?filter=${filter}&sort=-created&perPage=20`,
      );
      const sessions = (r.items || []).map((s: any) => ({
        id:                s.id,
        startTime:         s.start_time,
        claimedAmount:     s.claimed_amount,
        boosterMultiplier: s.booster_multiplier || 1,
        created:           s.created,
      }));
      res.json(sessions);
    } catch (e: any) {
      console.error("[/api/app/mine/history]", e.message);
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  // ── Withdrawal tier ───────────────────────────────────────────────────────
  app.get(
    "/api/app/withdrawals/tier/:pbId",
    async (req: Request, res: Response) => {
      try {
        const { pbId } = req.params;
        const settings = await fetchSettings();
        const r = await pbGet(
          `/api/collections/withdrawals/records?filter=${encodeURIComponent(`user="${pbId}" && status="completed"`)}&perPage=200`,
        );
        const count = r.totalItems || 0;
        let minAmount: number;
        if (count === 0) minAmount = settings?.min_withdrawal_1 || 100;
        else if (count === 1) minAmount = settings?.min_withdrawal_2 || 1000;
        else minAmount = settings?.min_withdrawal_3 || 8000;

        res.json({ tier: Math.min(count + 1, 3), minAmount, completedCount: count });
      } catch (e: any) {
        console.error("[/api/app/withdrawals/tier]", e.message);
        res.status(500).json({ error: "Failed to fetch tier" });
      }
    },
  );

  // ═══ KYC VERIFICATION ══════════════════════════════════════════════════════
  // Submit is EXPRESS-ONLY (needs admin-token cross-user duplicate checks that
  // PB rules can never allow a client to run). Status reads fall back to direct
  // PB in the APK (owner listRule on verification_requests + kyc_* on users).

  // Strip characters that could break out of a PB filter string literal
  const kycFilterEsc = (s: string) => String(s || "").replace(/["'\\\n\r]/g, "").trim();

  // ── Submit verification request ───────────────────────────────────────────
  app.post("/api/app/verification/submit", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.body;
      const fullName = String(req.body.fullName || "").trim();
      const country = String(req.body.country || "").trim();
      const phone = String(req.body.phone || "").replace(/\D/g, "");
      const binanceEmailRaw = String(req.body.binanceEmail || "").trim().toLowerCase();
      const bep20Address = String(req.body.bep20Address || "").trim();

      if (!pbId || !fullName || !country || !phone || !bep20Address)
        return res.status(400).json({ error: "All fields are required" });
      if (fullName.length < 3)
        return res.status(400).json({ error: "Please enter your full name" });

      // Country checks — Iran is completely blocked from verification
      if (isKycCountryBlocked(country))
        return res.status(403).json({
          error: "Verification is not available in your country.",
          countryBlocked: true,
        });
      const countryInfo = findKycCountry(country);
      if (!countryInfo)
        return res.status(400).json({ error: "Please select a valid country" });
      const countryCode = countryInfo.dial; // server-authoritative dial code

      if (!validateKycPhone(phone))
        return res.status(400).json({ error: "Invalid phone number" });
      if (!validateBep20Address(bep20Address))
        return res.status(400).json({ error: "Invalid BEP20 wallet address (must be 0x + 40 hex characters)" });

      // Binance email: REQUIRED for Binance-supported countries, ignored otherwise
      const supported = isBinanceSupported(country);
      let binanceEmail = "";
      if (supported) {
        if (!binanceEmailRaw || !validateKycEmail(binanceEmailRaw))
          return res.status(400).json({ error: "Please enter a valid Binance email" });
        binanceEmail = binanceEmailRaw;
      }

      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      const currentStatus = normalizeKycStatus(user.kyc_status);
      if (currentStatus === "verified")
        return res.status(400).json({ error: "Your account is already verified" });
      if (currentStatus === "under_review")
        return res.status(400).json({ error: "Your verification is already under review" });

      // ── Submission limit: maximum 3 attempts per account ──
      const submissionCount = Number(user.submission_count) || 0;
      if (submissionCount >= 3)
        return res.status(429).json({
          error: "You have reached the maximum limit for account verification.",
          limitReached: true,
        });

      // ── Duplicate check vs OTHER users' active (under_review/approved) rows ──
      const orParts = [
        `bep20_address = "${kycFilterEsc(bep20Address)}"`,
        `(country_code = "${kycFilterEsc(countryCode)}" && phone = "${kycFilterEsc(phone)}")`,
      ];
      if (binanceEmail) orParts.push(`binance_email = "${kycFilterEsc(binanceEmail)}"`);
      const dupFilter = encodeURIComponent(
        `user != "${kycFilterEsc(pbId)}" && (status = "${KYC_STATUS_UNDER_REVIEW}" || status = "${KYC_STATUS_VERIFIED}") && (${orParts.join(" || ")})`,
      );
      const dup = await pbGet(
        `/api/collections/verification_requests/records?filter=${dupFilter}&perPage=10&fields=binance_email,bep20_address,phone,country_code`,
      );
      if ((dup?.items || []).length > 0) {
        const fields: string[] = [];
        for (const row of dup.items) {
          if (row.bep20_address === bep20Address && !fields.includes("bep20Address")) fields.push("bep20Address");
          if (row.phone === phone && row.country_code === countryCode && !fields.includes("phone")) fields.push("phone");
          if (binanceEmail && row.binance_email === binanceEmail && !fields.includes("binanceEmail")) fields.push("binanceEmail");
        }
        return res.status(409).json({ error: "Field already in use", duplicate: true, fields });
      }

      // WhatsApp-OTP stamp — wa_verified_phone was written by /verify-otp.
      // SOFT check (older app builds have no OTP flow): absence or mismatch
      // just leaves phone_verified=false for the admin badge, never blocks.
      const expectedDigits = `${countryCode}${phone}`.replace(/\D/g, "");
      const waPhone = String(user.wa_verified_phone || "").replace(/\D/g, "");
      const phoneVerified = !!waPhone && waPhone === expectedDigits;

      // Supersede any previous rejected rows by this user (keeps audit trail,
      // but only ONE active row per user at a time)
      const created = await pbPost("/api/collections/verification_requests/records", {
        user: pbId,
        full_name: fullName,
        country,
        country_code: countryCode,
        phone,
        binance_email: binanceEmail,
        bep20_address: bep20Address,
        phone_verified: phoneVerified,
        status: KYC_STATUS_UNDER_REVIEW, // PB SELECT label
        reject_reason: "",
      });
      if (created.code)
        return res.status(500).json({ error: "Could not submit verification. Try again." });

      await pbPatch(`/api/collections/users/records/${pbId}`, {
        kyc_status: "under_review",
        kyc_reject_reason: "",
        "submission_count+": 1, // atomic increment (no read-modify-write race)
      });

      res.json({
        success: true,
        status: "under_review",
        requestId: created.id,
        submissionsUsed: submissionCount + 1,
        submissionsLimit: 3,
      });
    } catch (e: any) {
      console.error("[/api/app/verification/submit]", e.message);
      res.status(500).json({ error: "Verification submit failed" });
    }
  });

  // ── Telegram "Share Contact" verification ────────────────────────────────
  // Flow: app calls /telegram/start → server mints a one-time token bound to
  // {user, phone} in PB → app deep-links to t.me/<bot>?start=<token> → user
  // taps START in Telegram → bot replies with a request_contact keyboard →
  // user shares their OWN contact → Telegram posts it to our webhook → server
  // compares Telegram's registered number with the phone typed in the app →
  // on an exact match it stamps users.wa_verified_phone (the app's "verified
  // phone" field). The app polls its own users record and flips the green
  // chip automatically. Anti-spoof: Telegram itself attests the number — the
  // contact must belong to the sender (contact.user_id === from.id), and the
  // compared phone is the one bound server-side at /telegram/start.
  const TG_SESSION_TTL_MS = 15 * 60 * 1000; // deep-link token lifetime
  const tgStartGuard = new Map<string, { count: number; windowStart: number; lastSentAt: number }>();

  // Latest PENDING, non-expired verification session matching a PB filter.
  async function tgFindSession(filter: string): Promise<any | null> {
    const r = await pbGet(
      `/api/collections/telegram_verifications/records?filter=${encodeURIComponent(`(${filter}) && status = "pending"`)}&sort=-created&perPage=1`,
    );
    const row = (r?.items || [])[0];
    if (!row) return null;
    if (Date.now() - new Date(row.created).getTime() > TG_SESSION_TTL_MS) return null;
    return row;
  }

  app.post("/api/app/verification/telegram/start", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.body;
      const identifier = String(req.body.identifier || "").replace(/\D/g, "");
      if (!pbId || identifier.length < 8 || identifier.length > 15)
        return res.status(400).json({ error: "Enter a valid phone number first" });

      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      // Light per-user rate limit — every start creates a PB session row.
      const now = Date.now();
      const guard = tgStartGuard.get(pbId) || { count: 0, windowStart: now, lastSentAt: 0 };
      if (now - guard.windowStart > 60 * 60 * 1000) { guard.count = 0; guard.windowStart = now; }
      if (now - guard.lastSentAt < 5 * 1000)
        return res.status(429).json({ error: "Please wait a moment and try again." });
      if (guard.count >= 12)
        return res.status(429).json({ error: "Too many attempts. Try again in an hour." });
      guard.count += 1; guard.lastSentAt = now;
      tgStartGuard.set(pbId, guard);

      const token = crypto.randomBytes(16).toString("hex");
      const created = await pbPost("/api/collections/telegram_verifications/records", {
        token, user: pbId, phone: identifier, status: "pending",
      });
      if (!created?.id) {
        console.error("[telegram/start] session row create failed:", JSON.stringify(created).slice(0, 200));
        return res.status(502).json({ error: "Could not start verification. Try again." });
      }
      console.log(`[telegram/start] user ${pbId} → token ${token.slice(0, 8)}… for ****${identifier.slice(-4)}`);
      res.json({
        success: true,
        token,
        botUsername: TELEGRAM_BOT_USERNAME,
        deepLink: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${token}`,
      });
    } catch (e: any) {
      console.error("[/api/app/verification/telegram/start]", e.message);
      res.status(500).json({ error: "Could not start Telegram verification" });
    }
  });

  // Telegram pushes bot updates here (registered via setWebhook on boot).
  app.post("/api/app/telegram/webhook", async (req: Request, res: Response) => {
    // ALWAYS answer 200 fast — Telegram retries non-200s and replays updates.
    res.json({ ok: true });
    try {
      if (req.get("x-telegram-bot-api-secret-token") !== TELEGRAM_WEBHOOK_SECRET) {
        console.warn("[telegram/webhook] bad secret header — update ignored");
        return;
      }
      const msg = req.body?.message;
      if (!msg?.chat?.id || !msg?.from?.id) return;
      const chatId = msg.chat.id;

      // 1) "/start <token>" — bind this chat to the pending session and ask
      //    for the contact with a request_contact keyboard.
      const text = String(msg.text || "");
      if (text.startsWith("/start")) {
        const tok = (text.split(/\s+/)[1] || "").replace(/[^a-f0-9]/gi, "");
        const row = tok ? await tgFindSession(`token = "${tok}"`) : null;
        if (!row) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: "This verification link is invalid or has expired.\n\nGo back to the Shiba Hit app and tap \"Verify via Telegram\" again.",
          });
          return;
        }
        await pbPatch(`/api/collections/telegram_verifications/records/${row.id}`, {
          chat_id: String(chatId), tg_user_id: String(msg.from.id),
        });
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: `Shiba Hit account verification\n\nTap the button below to share your contact and verify the number ending in ****${String(row.phone).slice(-4)}.`,
          reply_markup: {
            keyboard: [[{ text: "📱 Share Contact to Verify Account", request_contact: true }]],
            resize_keyboard: true, one_time_keyboard: true,
          },
        });
        return;
      }

      // 2) Shared contact — Telegram attests the number. Compare with the
      //    phone bound at /start and stamp the users record on a match.
      if (msg.contact) {
        // Must be the sender's OWN contact — a forwarded contact card carries
        // a different user_id (or none at all).
        if (!msg.contact.user_id || String(msg.contact.user_id) !== String(msg.from.id)) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: "Please use the \"📱 Share Contact\" button to share YOUR OWN contact — forwarded contacts can't be used.",
          });
          return;
        }
        const row = await tgFindSession(`chat_id = "${chatId}" && tg_user_id = "${msg.from.id}"`);
        if (!row) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: "This verification session has expired. Go back to the app and tap \"Verify via Telegram\" again.",
            reply_markup: { remove_keyboard: true },
          });
          return;
        }
        const tgDigits = String(msg.contact.phone_number || "").replace(/\D/g, "");
        const expected = String(row.phone || "").replace(/\D/g, "");
        if (tgDigits && tgDigits === expected) {
          await pbPatch(`/api/collections/users/records/${row.user}`, {
            wa_verified_phone: expected,
            wa_verified_at: new Date().toISOString(),
          });
          await pbPatch(`/api/collections/telegram_verifications/records/${row.id}`, { status: "verified" });
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: "✅ Phone number verified!\n\nReturn to the Shiba Hit app — your verification will appear there automatically.",
            reply_markup: { remove_keyboard: true },
          });
          console.log(`[telegram/webhook] user ${row.user} verified ****${expected.slice(-4)} via Telegram`);
        } else {
          await pbPatch(`/api/collections/telegram_verifications/records/${row.id}`, { status: "mismatch" });
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: `❌ Number mismatch.\n\nThis Telegram account is registered to a number ending in ****${tgDigits.slice(-4)}, but the app form has ****${expected.slice(-4)}. Enter your Telegram number in the app and try again.`,
            reply_markup: { remove_keyboard: true },
          });
          console.log(`[telegram/webhook] user ${row.user} mismatch: tg ****${tgDigits.slice(-4)} vs app ****${expected.slice(-4)}`);
        }
        return;
      }
    } catch (e: any) {
      console.error("[/api/app/telegram/webhook]", e.message);
    }
  });

  // ── Verification status (user) ────────────────────────────────────────────
  app.get("/api/app/verification/status/:pbId", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const latest = await pbGet(
        `/api/collections/verification_requests/records?filter=${encodeURIComponent(`user = "${kycFilterEsc(pbId)}"`)}&sort=-created&perPage=1`,
      );
      const row = (latest?.items || [])[0];
      // ── Self-heal: the verification_requests row is the source of truth. ──
      // If an admin edits row.status directly in the PB dashboard, mirror it
      // onto the users record exactly like the approve/reject routes would,
      // so the app UI reflects the change on the next status fetch.
      let kycStatus = normalizeKycStatus(user.kyc_status);
      let rejectReason = user.kyc_reject_reason || "";
      if (row) {
        const derived = normalizeKycStatus(row.status);
        // Skip the heal when this row was rejected by the admin "unverify"
        // flow — unverify intentionally resets the user to a clean 'none'
        // state, and its internal audit note must not surface to the user
        // as a rejection banner.
        const isUnverifyAudit =
          derived === "rejected" &&
          (row.reject_reason || "") === "Released by admin (unverified)" &&
          kycStatus === "none";
        if (derived !== "none" && derived !== kycStatus && !isUnverifyAudit) {
          const patch: Record<string, unknown> =
            derived === "verified"
              ? {
                  kyc_status: "verified",
                  kyc_reject_reason: "",
                  kyc_full_name: row.full_name,
                  kyc_country: row.country,
                  kyc_country_code: row.country_code,
                  kyc_phone: row.phone,
                  kyc_binance_email: row.binance_email || "",
                  kyc_bep20_address: row.bep20_address,
                }
              : derived === "rejected"
                ? { kyc_status: "rejected", kyc_reject_reason: row.reject_reason || "" }
                : { kyc_status: "under_review", kyc_reject_reason: "" };
          const healed = await pbPatch(`/api/collections/users/records/${pbId}`, patch);
          if (!healed.code) {
            kycStatus = derived;
            rejectReason = String(patch.kyc_reject_reason ?? "");
            console.log(`[verification/status] self-heal: user ${pbId} kyc_status → ${derived} (from request row ${row.id})`);
          } else {
            console.warn("[verification/status] self-heal patch failed:", JSON.stringify(healed).slice(0, 150));
          }
        }
      }
      res.json({
        kycStatus,
        rejectReason,
        request: row
          ? {
              id: row.id,
              fullName: row.full_name,
              country: row.country,
              countryCode: row.country_code,
              phone: row.phone,
              binanceEmail: row.binance_email,
              bep20Address: row.bep20_address,
              phoneVerified: !!row.phone_verified,
              status: row.status,
              rejectReason: row.reject_reason || "",
              created: row.created,
            }
          : null,
      });
    } catch (e: any) {
      console.error("[/api/app/verification/status]", e.message);
      res.status(500).json({ error: "Failed to fetch verification status" });
    }
  });

  // ── Admin: list verification requests ─────────────────────────────────────
  app.get("/api/app/admin/verification", async (req: Request, res: Response) => {
    try {
      // Accept both legacy machine values ('under_review') and SELECT labels
      const q = String(req.query.status || "under_review");
      const status = q === "all" ? "all" : toDbKycStatus(q);
      const filter = status === "all" ? "" : `filter=${encodeURIComponent(`status = "${kycFilterEsc(status)}"`)}&`;
      const r = await pbGet(
        `/api/collections/verification_requests/records?${filter}sort=-created&perPage=100&expand=user`,
      );
      res.json({
        items: (r.items || []).map((v: any) => ({
          id: v.id,
          userId: v.user,
          userEmail: v.expand?.user?.email || "",
          userName: v.expand?.user?.display_name || "",
          fullName: v.full_name,
          country: v.country,
          countryCode: v.country_code,
          phone: v.phone,
          binanceEmail: v.binance_email,
          bep20Address: v.bep20_address,
          phoneVerified: !!v.phone_verified,
          status: v.status,
          rejectReason: v.reject_reason || "",
          created: v.created,
        })),
        totalItems: r.totalItems || 0,
      });
    } catch (e: any) {
      console.error("[/api/app/admin/verification]", e.message);
      res.status(500).json({ error: "Failed to fetch verification requests" });
    }
  });

  // ── Admin: approve request → copy verified destination onto users record ──
  app.post("/api/app/admin/verification/:id/approve", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const row = await pbGet(`/api/collections/verification_requests/records/${id}`);
      if (row.code) return res.status(404).json({ error: "Request not found" });
      if (toDbKycStatus(row.status) !== KYC_STATUS_UNDER_REVIEW)
        return res.status(400).json({ error: `Request is already ${row.status}` });

      await pbPatch(`/api/collections/verification_requests/records/${id}`, {
        status: KYC_STATUS_VERIFIED,
        reject_reason: "",
      });
      await pbPatch(`/api/collections/users/records/${row.user}`, {
        kyc_status: "verified",
        kyc_reject_reason: "",
        kyc_full_name: row.full_name,
        kyc_country: row.country,
        kyc_country_code: row.country_code,
        kyc_phone: row.phone,
        kyc_binance_email: row.binance_email || "",
        kyc_bep20_address: row.bep20_address,
      });
      pbPost("/api/collections/notifications/records", {
        title: "Account Verified ✓",
        message: "Congratulations! Your account verification has been approved. You now have full access to the Wallet and Multiplayer Hub.",
        type: "personal",
        target_user: row.user,
      }).catch((e: any) => console.warn("[verification/approve] Notification failed:", e.message));
      res.json({ success: true });
    } catch (e: any) {
      console.error("[/api/app/admin/verification/approve]", e.message);
      res.status(500).json({ error: "Approve failed" });
    }
  });

  // ── Admin: reject request with a reason (shown on the user's screen) ──────
  app.post("/api/app/admin/verification/:id/reject", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const reason = String(req.body?.reason || "").trim();
      if (!reason) return res.status(400).json({ error: "A rejection reason is required" });
      const row = await pbGet(`/api/collections/verification_requests/records/${id}`);
      if (row.code) return res.status(404).json({ error: "Request not found" });
      if (toDbKycStatus(row.status) !== KYC_STATUS_UNDER_REVIEW)
        return res.status(400).json({ error: `Request is already ${row.status}` });

      await pbPatch(`/api/collections/verification_requests/records/${id}`, {
        status: KYC_STATUS_REJECTED,
        reject_reason: reason,
      });
      await pbPatch(`/api/collections/users/records/${row.user}`, {
        kyc_status: "rejected",
        kyc_reject_reason: reason,
      });
      pbPost("/api/collections/notifications/records", {
        title: "Verification Rejected",
        message: `Your account verification was rejected. Reason: ${reason}. Please review your details and submit again.`,
        type: "personal",
        target_user: row.user,
      }).catch((e: any) => console.warn("[verification/reject] Notification failed:", e.message));
      res.json({ success: true });
    } catch (e: any) {
      console.error("[/api/app/admin/verification/reject]", e.message);
      res.status(500).json({ error: "Reject failed" });
    }
  });

  // ── Admin: manually un-verify a user (frees their identifiers for reuse) ──
  app.post("/api/app/admin/verification/unverify", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.body;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      // Mark this user's active rows 'unverified' so the duplicate check no
      // longer reserves their email/phone/address
      const active = await pbGet(
        `/api/collections/verification_requests/records?filter=${encodeURIComponent(`user = "${kycFilterEsc(pbId)}" && (status = "${KYC_STATUS_VERIFIED}" || status = "${KYC_STATUS_UNDER_REVIEW}")`)}&perPage=50&fields=id`,
      );
      for (const r of active?.items || []) {
        // 'unverified' is not a SELECT option — mark Rejected with an audit note
        await pbPatch(`/api/collections/verification_requests/records/${r.id}`, { status: KYC_STATUS_REJECTED, reject_reason: "Released by admin (unverified)" }).catch(() => {});
      }
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        kyc_status: "none",
        kyc_reject_reason: "",
        kyc_full_name: "",
        kyc_country: "",
        kyc_country_code: "",
        kyc_phone: "",
        kyc_binance_email: "",
        kyc_bep20_address: "",
      });
      res.json({ success: true });
    } catch (e: any) {
      console.error("[/api/app/admin/verification/unverify]", e.message);
      res.status(500).json({ error: "Unverify failed" });
    }
  });

  // ── Withdrawal: Create ────────────────────────────────────────────────────
  app.post("/api/app/withdrawals", async (req: Request, res: Response) => {
    try {
      // NOTE: legacy clients still send addressOrEmail/netAmount — both are now
      // IGNORED. The destination comes from the user's KYC-verified record and
      // the net amount is recomputed server-side, so funds can only ever go to
      // the verified channel (AML compliance).
      const { pbId, method, amount } = req.body;
      if (!pbId || !amount)
        return res.status(400).json({ error: "pbId, amount required" });
      const grossAmount = Number(amount);
      if (!Number.isFinite(grossAmount) || grossAmount <= 0)
        return res.status(400).json({ error: "Invalid withdrawal amount" });

      // Verify user has sufficient balance
      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      // ── KYC gate: only verified users may withdraw ────────────────────────
      if (normalizeKycStatus(user.kyc_status) !== "verified")
        return res.status(403).json({
          error: "Your account is not verified. Please verify to access withdrawals.",
          kycRequired: true,
        });

      // ── Destination pulled from the VERIFIED record (never from the client).
      // Binance Email channel is available ONLY for India; all other countries
      // withdraw via their verified BEP20 address.
      const isIndiaUser = user.kyc_country === BINANCE_WITHDRAW_COUNTRY;
      const resolvedMethod: "Binance Email" | "BEP-20" =
        method === "Binance Email" && isIndiaUser && user.kyc_binance_email
          ? "Binance Email"
          : "BEP-20";
      const destination: string =
        resolvedMethod === "Binance Email" ? user.kyc_binance_email : (user.kyc_bep20_address || "");
      if (!destination)
        return res.status(400).json({
          error: "No verified withdrawal destination on file. Please contact support.",
        });
      if ((user.shib_balance || 0) < amount)
        return res.status(400).json({ error: "Insufficient balance" });

      // VIP wallet lock: the active VIP tier's required SHIB balance is locked and
      // cannot be withdrawn. Available = balance − lockedBalanceForVipLevel(level).
      const lockedBalance = lockedBalanceForVipLevel(user.vip_level);
      const availableBalance = Math.max(0, (Number(user.shib_balance) || 0) - lockedBalance);
      if (grossAmount > availableBalance)
        return res.status(400).json({
          error: `VIP ${normalizeVipLevel(user.vip_level)} locks ${lockedBalance} SHIB in your wallet. You can withdraw up to ${availableBalance} SHIB. Contact support@shibahit.com to remove your VIP tier.`,
        });

      // Get withdrawal tier minimum
      const tierRes = await pbGet(
        `/api/collections/withdrawals/records?filter=${encodeURIComponent(`user="${pbId}" && status="completed"`)}&perPage=200`,
      );
      const settings = await fetchSettings();
      const count = tierRes.totalItems || 0;
      let minAmount: number;
      if (count === 0) minAmount = settings?.min_withdrawal_1 || 100;
      else if (count === 1) minAmount = settings?.min_withdrawal_2 || 1000;
      else minAmount = settings?.min_withdrawal_3 || 8000;

      if (amount < minAmount)
        return res.status(400).json({ error: `Minimum withdrawal is ${minAmount} SHIB` });

      // Net amount recomputed SERVER-SIDE: BEP-20 carries the dynamic network fee
      // from settings.bep20_fees (legacy bep20_fee honored, 3680 built-in default);
      // Binance Email is free.
      const bep20Fee =
        Number(settings?.bep20_fees) > 0
          ? Number(settings.bep20_fees)
          : Number(settings?.bep20_fee) > 0
            ? Number(settings.bep20_fee)
            : 3680;
      const resolvedNet = resolvedMethod === "BEP-20" ? grossAmount - bep20Fee : grossAmount;
      if (resolvedNet <= 0)
        return res.status(400).json({ error: `Amount must exceed the ${bep20Fee} SHIB network fee` });

      // Deduct from balance
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        shib_balance: user.shib_balance - amount,
      });

      // Resolve masked_name from user's display_name for the ticker
      let masked_name: string = user.display_name || user.username || "";
      if (masked_name.includes("@")) masked_name = masked_name.split("@")[0];

      // Create withdrawal record — store the net amount (after fees) as the amount
      const withdrawal = await pbPost(
        "/api/collections/withdrawals/records",
        {
          user: pbId,
          method: resolvedMethod,
          address_or_email: destination,
          amount: resolvedNet,
          status: "pending",
          masked_name,
        },
      );

      if (withdrawal.code) {
        // Rollback balance
        await pbPatch(`/api/collections/users/records/${pbId}`, {
          shib_balance: user.shib_balance,
        });
        return res.status(400).json({ error: withdrawal.message });
      }

      res.json({
        id: withdrawal.id,
        status: "pending",
        amount,
        newBalance: user.shib_balance - amount,
      });
    } catch (e: any) {
      console.error("[/api/app/withdrawals]", e.message);
      res.status(500).json({ error: "Failed to create withdrawal" });
    }
  });

  // ── Withdrawal: Get history ───────────────────────────────────────────────
  app.get(
    "/api/app/withdrawals/:pbId",
    async (req: Request, res: Response) => {
      try {
        const { pbId } = req.params;
        const r = await pbGet(
          `/api/collections/withdrawals/records?filter=user="${pbId}"&sort=-created&perPage=50`,
        );
        res.json(
          (r.items || []).map((w: any) => ({
            id: w.id,
            method: w.method,
            addressOrEmail: w.address_or_email,
            amount: w.amount,
            status: w.status,
            created: w.created,
          })),
        );
      } catch (e: any) {
        console.error("[/api/app/withdrawals/:pbId]", e.message);
        res.status(500).json({ error: "Failed to fetch withdrawals" });
      }
    },
  );

  // ── Leaderboard: Top 100 by shib_balance ─────────────────────────────────
  app.get("/api/app/leaderboard", async (_req: Request, res: Response) => {
    try {
      const r = await pbGet(
        `/api/collections/users/records?sort=-shib_balance&perPage=100&fields=id,display_name,shib_balance`,
      );
      res.json(
        (r.items || []).map((u: any, i: number) => {
          let name: string = u.display_name || "Anonymous";
          // Strip email domain if display_name was stored as email (e.g. "user@gmail.com" → "user")
          if (name.includes("@")) name = name.split("@")[0];
          return {
            rank: i + 1,
            id: u.id,
            displayName: name,
            shibBalance: u.shib_balance || 0,
          };
        }),
      );
    } catch (e: any) {
      console.error("[/api/app/leaderboard]", e.message);
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });

  // ── Leaderboard: User rank ────────────────────────────────────────────────
  app.get("/api/app/leaderboard/rank/:pbId", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      const user = await pbGet(`/api/collections/users/records/${pbId}?fields=id,display_name,shib_balance`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const balance = user.shib_balance || 0;
      // Count users with strictly higher balance
      const ahead = await pbGet(
        `/api/collections/users/records?filter=${encodeURIComponent(`shib_balance>${balance}`)}&perPage=1&fields=id`,
      );
      const rank = (ahead.totalItems || 0) + 1;
      let rankName: string = user.display_name || "You";
      if (rankName.includes("@")) rankName = rankName.split("@")[0];
      res.json({
        rank,
        id: user.id,
        displayName: rankName,
        shibBalance: balance,
      });
    } catch (e: any) {
      console.error("[/api/app/leaderboard/rank]", e.message);
      res.status(500).json({ error: "Failed to fetch rank" });
    }
  });

  // ── Withdrawal ticker: 10 most recent completed withdrawals ───────────────
  app.get("/api/app/withdrawals/approved/recent", async (_req: Request, res: Response) => {
    try {
      const r = await pbGet(
        `/api/collections/withdrawals/records?filter=${encodeURIComponent(`status="completed" || status="approved"`)}&sort=-created&perPage=10&expand=user`,
      );
      const items = (r.items || []).map((w: any) => {
        // Prefer the denormalized masked_name field (backfilled at startup)
        // Fall back to live user expansion (admin-authed, always works on this route)
        let username: string =
          w.masked_name ||
          w.expand?.user?.display_name ||
          w.expand?.user?.username ||
          "";
        if (!username || username.includes("@")) {
          username = username.includes("@") ? username.split("@")[0] : username;
        }
        if (!username) username = "User";
        return {
          id: w.id,
          maskedName: username,
          method: w.method || "BEP-20",
          amount: w.amount || 0,
        };
      });
      res.json(items);
    } catch (e: any) {
      console.error("[/api/app/withdrawals/approved/recent]", e.message);
      res.status(500).json({ error: "Failed to fetch recent withdrawals" });
    }
  });

  // ── Notifications: fetch global + personal for a user ────────────────────
  app.get("/api/app/notifications/:pbId", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const filter = encodeURIComponent(`type = "global" || (type = "personal" && target_user = "${pbId}")`);
      const r = await pbGet(
        `/api/collections/notifications/records?filter=${filter}&sort=-created&perPage=50`
      );
      res.json({
        items: (r.items || []).map((n: any) => ({
          id:      n.id,
          title:   n.title,
          message: n.message,
          type:    n.type,
          created: n.created,
        })),
      });
    } catch (e: any) {
      console.error("[/api/app/notifications]", e.message);
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  });

  // ── Admin: List all users ─────────────────────────────────────────────────
  app.get("/api/app/admin/users", async (req: Request, res: Response) => {
    try {
      const page = parseInt(String(req.query.page || "1"));
      const r = await pbGet(
        `/api/collections/users/records?sort=-created&perPage=50&page=${page}`,
      );
      res.json({
        items: (r.items || []).map(formatUser),
        totalItems: r.totalItems,
        totalPages: r.totalPages,
        page,
      });
    } catch (e: any) {
      console.error("[/api/app/admin/users]", e.message);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // ── Admin: List all withdrawals ───────────────────────────────────────────
  app.get(
    "/api/app/admin/withdrawals",
    async (req: Request, res: Response) => {
      try {
        const status = req.query.status ? `filter=status="${req.query.status}"&` : "";
        const r = await pbGet(
          `/api/collections/withdrawals/records?${status}sort=-created&perPage=100&expand=user`,
        );
        res.json({
          items: (r.items || []).map((w: any) => ({
            id: w.id,
            userId: w.user,
            userEmail: w.expand?.user?.email || "",
            userName: w.expand?.user?.display_name || "",
            method: w.method,
            addressOrEmail: w.address_or_email,
            amount: w.amount,
            status: w.status,
            created: w.created,
          })),
          totalItems: r.totalItems,
        });
      } catch (e: any) {
        console.error("[/api/app/admin/withdrawals]", e.message);
        res.status(500).json({ error: "Failed to fetch withdrawals" });
      }
    },
  );

  // ── Admin: Update withdrawal status ──────────────────────────────────────
  app.put(
    "/api/app/admin/withdrawals/:id",
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { status, reason } = req.body;
        if (!["pending", "completed", "rejected"].includes(status))
          return res.status(400).json({ error: "Invalid status" });

        const patchBody: Record<string, any> = { status };
        if (status === "rejected" && reason) {
          patchBody.cancellation_reason = reason;
        }

        const updated = await pbPatch(
          `/api/collections/withdrawals/records/${id}`,
          patchBody,
        );

        // Auto-create personal notification when status → completed
        if (status === "completed" && updated && !updated.code && updated.user) {
          pbPost("/api/collections/notifications/records", {
            title: "Withdrawal Completed ✓",
            message: "Congratulations! Your withdrawal request has been processed and completed successfully. Please check your wallet/account. Thank you for mining with us!",
            type: "personal",
            target_user: updated.user,
          }).catch((e: any) =>
            console.warn("[withdrawals/complete] Notification failed:", e.message)
          );

          // Referral anti-cheat: if this user is on blacklist tier 1 and the
          // one-time warning has not been sent yet, fire the two warning
          // notifications EXACTLY ONCE on admin approval, then latch the guard.
          try {
            const flaggedUser = await pbGet(
              `/api/collections/users/records/${updated.user}`,
            );
            if (
              flaggedUser && !flaggedUser.code &&
              flaggedUser.is_blacklist_1 && !flaggedUser.blacklist_1_notified
            ) {
              // Latch FIRST to prevent duplicate sends under concurrent approvals.
              await pbPatch(`/api/collections/users/records/${updated.user}`, {
                blacklist_1_notified: true,
                blacklist_1_notified_at: new Date().toISOString(),
              });
              await pbPost("/api/collections/notifications/records", {
                title: "Fraud activity detected",
                message: "Some uneven activity detected like auto clicker. Don't use it.",
                type: "personal",
                target_user: updated.user,
              }).catch(() => {});
              await pbPost("/api/collections/notifications/records", {
                title: "Account ban notification.",
                message: "If you can do it again we will terminate your account permanently.",
                type: "personal",
                target_user: updated.user,
              }).catch(() => {});
            }
          } catch (e: any) {
            console.warn("[withdrawals/complete] Blacklist warning failed:", e.message);
          }
        }

        // If rejected, refund the amount + create cancellation notification
        if (status === "rejected" && updated && !updated.code && updated.user) {
          const withdrawal = updated;
          const user = await pbGet(
            `/api/collections/users/records/${withdrawal.user}`,
          );
          if (user && !user.code) {
            await pbPatch(`/api/collections/users/records/${withdrawal.user}`, {
              shib_balance: (user.shib_balance || 0) + withdrawal.amount,
            });
          }

          const cancelMsg = reason
            ? `Your withdrawal has been cancelled. Reason: ${reason}`
            : "Your withdrawal request has been cancelled. Please contact support if you have any questions.";
          pbPost("/api/collections/notifications/records", {
            title: "Withdrawal Cancelled",
            message: cancelMsg,
            type: "personal",
            target_user: updated.user,
          }).catch((e: any) =>
            console.warn("[withdrawals/rejected] Notification failed:", e.message)
          );
        }

        res.json({ success: true, status });
      } catch (e: any) {
        console.error("[/api/app/admin/withdrawals/:id]", e.message);
        res.status(500).json({ error: "Failed to update withdrawal" });
      }
    },
  );

  // ── Admin: Update settings ────────────────────────────────────────────────
  app.put(
    "/api/app/admin/settings/:id",
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const body = req.body;
        const pbUpdate: any = {};
        if (body.miningRatePerSec !== undefined)
          pbUpdate.mining_rate_per_sec = body.miningRatePerSec;
        if (body.powerTokenPerClick !== undefined)
          pbUpdate.power_token_per_click = body.powerTokenPerClick;
        if (body.miningDurationMinutes !== undefined)
          pbUpdate.mining_duration_minutes = body.miningDurationMinutes;
        if (body.tokensPerRound !== undefined)
          pbUpdate.tokens_per_round = body.tokensPerRound;
        if (body.boostCosts) {
          if (body.boostCosts["2x"] !== undefined)
            pbUpdate.boost_2x_cost = body.boostCosts["2x"];
          if (body.boostCosts["4x"] !== undefined)
            pbUpdate.boost_4x_cost = body.boostCosts["4x"];
          if (body.boostCosts["6x"] !== undefined)
            pbUpdate.boost_6x_cost = body.boostCosts["6x"];
          if (body.boostCosts["10x"] !== undefined)
            pbUpdate.boost_10x_cost = body.boostCosts["10x"];
        }
        if (body.minWithdrawal1 !== undefined)
          pbUpdate.min_withdrawal_1 = body.minWithdrawal1;
        if (body.minWithdrawal2 !== undefined)
          pbUpdate.min_withdrawal_2 = body.minWithdrawal2;
        if (body.minWithdrawal3 !== undefined)
          pbUpdate.min_withdrawal_3 = body.minWithdrawal3;
        if (body.bep20Fees !== undefined)
          pbUpdate.bep20_fees = Math.max(0, Number(body.bep20Fees) || 0);
        if (body.showAds !== undefined) pbUpdate.show_ads = body.showAds;
        if (body.forceUnityOnly !== undefined)
          pbUpdate.force_unity_only = !!body.forceUnityOnly;
        if (body.networkGuardEnabled !== undefined)
          pbUpdate.network_guard_enabled = !!body.networkGuardEnabled;
        if (body.activeAdNetwork !== undefined)
          pbUpdate.active_ad_network = body.activeAdNetwork;
        if (body.admobUnitId !== undefined)
          pbUpdate.admob_unit_id = body.admobUnitId;
        if (body.admobBannerUnitId !== undefined)
          pbUpdate.admob_banner_unit_id = body.admobBannerUnitId;
        if (body.applovinSdkKey !== undefined)
          pbUpdate.applovin_sdk_key = body.applovinSdkKey;
        if (body.applovinRewardedId !== undefined)
          pbUpdate.applovin_rewarded_id = body.applovinRewardedId;
        if (body.unityGameId !== undefined)
          pbUpdate.unity_game_id = body.unityGameId;
        if (body.unityRewardedId !== undefined)
          pbUpdate.unity_rewarded_id = body.unityRewardedId;
        if (body.unityInterstitialId !== undefined)
          pbUpdate.unity_interstitial_id = body.unityInterstitialId;
        if (body.applovinBannerId !== undefined)
          pbUpdate.applovin_banner_id = body.applovinBannerId;
        if (body.applovinInterstitialId !== undefined)
          pbUpdate.applovin_interstitial_id = body.applovinInterstitialId;
        if (body.appStoreLink !== undefined)
          pbUpdate.app_store_link = body.appStoreLink;
        if (body.playStoreUrl !== undefined)
          pbUpdate.play_store_url = body.playStoreUrl;
        if (body.ratePopupFrequency !== undefined)
          pbUpdate.rate_popup_frequency = body.ratePopupFrequency;
        if (body.minimumVersion !== undefined)
          pbUpdate.minimum_version = body.minimumVersion;
        if (body.dailyRewardDay1Shib !== undefined)
          pbUpdate.daily_reward_day1_shib = body.dailyRewardDay1Shib;
        if (body.dailyRewardDay2Pt !== undefined)
          pbUpdate.daily_reward_day2_pt = body.dailyRewardDay2Pt;
        if (body.dailyRewardDay3Shib !== undefined)
          pbUpdate.daily_reward_day3_shib = body.dailyRewardDay3Shib;
        if (body.dailyRewardDay4Pt !== undefined)
          pbUpdate.daily_reward_day4_pt = body.dailyRewardDay4Pt;
        if (body.dailyRewardDay5Shib !== undefined)
          pbUpdate.daily_reward_day5_shib = body.dailyRewardDay5Shib;
        if (body.dailyRewardDay6Pt !== undefined)
          pbUpdate.daily_reward_day6_pt = body.dailyRewardDay6Pt;
        if (body.dailyRewardDay7Shib !== undefined)
          pbUpdate.daily_reward_day7_shib = body.dailyRewardDay7Shib;
        if (body.dailyRewardDay7Pt !== undefined)
          pbUpdate.daily_reward_day7_pt = body.dailyRewardDay7Pt;

        const updated = await pbPatch(
          `/api/collections/settings/records/${id}`,
          pbUpdate,
        );
        if (updated.code)
          return res.status(400).json({ error: updated.message });

        // Bust settings cache
        settingsCache = updated;
        settingsCacheAt = Date.now();

        res.json({ success: true });
      } catch (e: any) {
        console.error("[/api/app/admin/settings/:id]", e.message);
        res.status(500).json({ error: "Failed to update settings" });
      }
    },
  );

  // ── Admin: Stats ──────────────────────────────────────────────────────────
  app.get("/api/app/admin/stats", async (_req: Request, res: Response) => {
    try {
      const [usersRes, sessionsRes, withdrawalsRes] = await Promise.all([
        pbGet("/api/collections/users/records?perPage=1"),
        pbGet("/api/collections/mining_sessions/records?perPage=1"),
        pbGet("/api/collections/withdrawals/records?perPage=1"),
      ]);
      const pendingRes = await pbGet(
        '/api/collections/withdrawals/records?filter=status="pending"&perPage=1',
      );
      res.json({
        totalUsers: usersRes.totalItems || 0,
        totalSessions: sessionsRes.totalItems || 0,
        totalWithdrawals: withdrawalsRes.totalItems || 0,
        pendingWithdrawals: pendingRes.totalItems || 0,
      });
    } catch (e: any) {
      console.error("[/api/app/admin/stats]", e.message);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // ── Shop: ensure purchased_items field, get items, buy knife ─────────────
  (async () => {
    try {
      const token = await getAdminToken();
      const col = await pbHttp("GET", "/api/collections/users", null, token);
      const hasField = (col.schema || []).some((f: any) => f.name === "purchased_items");
      if (!hasField) {
        await pbHttp("PATCH", "/api/collections/users", {
          schema: [...(col.schema || []), { name: "purchased_items", type: "json", required: false, options: {} }],
        }, token);
        console.log("[Schema] Added purchased_items field to users collection");
      }
    } catch (e: any) {
      console.warn("[Schema] purchased_items migration skipped:", e.message);
    }
  })();

  app.get("/api/app/shop/items/:pbId", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      return res.json({ purchasedItems: user.purchased_items || [] });
    } catch (e: any) {
      console.error("[shop/items]", e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/app/shop/buy", async (req: Request, res: Response) => {
    try {
      const { pbId, itemId } = req.body;
      if (!pbId || !itemId) return res.status(400).json({ error: "pbId and itemId required" });
      const KNIFE_PRICE = 200;
      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const purchased: string[] = user.purchased_items || [];
      if (purchased.includes(itemId)) return res.status(400).json({ error: "Already owned" });
      const match = itemId.match(/^knife_(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > 1) {
          const prevId = `knife_${n - 1}`;
          // knife_1 is always free/owned — don't require it in purchased_items
          const prevOwned = prevId === 'knife_1' || purchased.includes(prevId);
          if (!prevOwned) {
            return res.status(400).json({ error: "Unlock previous knife first" });
          }
        }
      }
      if ((user.power_tokens || 0) < KNIFE_PRICE) {
        return res.status(400).json({ error: "Insufficient tokens" });
      }
      const newPT = user.power_tokens - KNIFE_PRICE;
      const newPurchased = [...purchased, itemId];
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        power_tokens: newPT,
        purchased_items: newPurchased,
      });
      return res.json({ success: true, newPowerTokens: newPT, purchasedItems: newPurchased });
    } catch (e: any) {
      console.error("[shop/buy]", e.message);
      return res.status(500).json({ error: "Purchase failed" });
    }
  });

  // ── Game: Fetch user game state (for initial injection into C3) ───────────
  app.get("/api/app/game/data/:pbId", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });

      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      // collected_tomatoes is now a NUMBER field (fixed by admin)
      const data = {
        power_tokens:            Number(user.power_tokens)            || 0,
        collected_tomatoes:      Number(user.collected_tomatoes)      || 0,
        last_session_score:      Number(user.last_session_score)      || 0,
        total_accumulated_score: Number(user.total_accumulated_score) || 0,
      };
      console.log(`[/api/app/game/data/${pbId}]`, JSON.stringify(data));
      res.json(data);
    } catch (e: any) {
      console.error("[/api/app/game/data]", e.message);
      res.status(500).json({ error: "Failed to fetch game data" });
    }
  });

  // ── Game: Sync score on game-over (save last_session_score + collected_tomatoes) ──
  //
  // Server-side score validation constants:
  //   MAX_SCORE_PER_SECOND – the absolute theoretical maximum a human can earn.
  //                          15 = 3 knives/sec × 5 pts each (very generous).
  //   ABSOLUTE_MAX_SCORE   – hard cap for a single session; any higher value is
  //                          rejected outright regardless of session length.
  //   MIN_SESSION_MS       – minimum realistic session duration for a non-zero score.
  const MAX_SCORE_PER_SECOND = 15;
  const ABSOLUTE_MAX_SCORE   = 2000; // 2000-point session cap (4000 for double-reward)
  const MIN_SESSION_MS       = 2000; // 2 s — anything faster is impossible

  app.post("/api/app/game/sync-score", async (req: Request, res: Response) => {
    try {
      const { pbId, score, collected_tomatoes: clientTomatoes, elapsed_ms } = req.body;
      if (!pbId || score === undefined)
        return res.status(400).json({ error: "pbId and score required" });

      // Validate pbId matches X-PB-ID header (double isolation check)
      const headerPbId = req.headers['x-pb-id'] as string | undefined;
      if (headerPbId && headerPbId !== pbId) {
        console.warn(`[/api/app/game/sync-score] MISMATCH: body pbId=${pbId} header X-PB-ID=${headerPbId}`);
        return res.status(403).json({ error: "pbId mismatch between body and header" });
      }

      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      let pts = Math.max(0, Math.round(Number(score) || 0));

      // ── Hard cap: no single session can ever exceed ABSOLUTE_MAX_SCORE ──────
      if (pts > ABSOLUTE_MAX_SCORE) {
        console.warn(`[/api/app/game/sync-score] Score ${pts} exceeds absolute max ${ABSOLUTE_MAX_SCORE}, capping`);
        pts = ABSOLUTE_MAX_SCORE;
      }

      // ── Time-based validation (optional — bridge sends elapsed_ms) ───────────
      if (elapsed_ms !== undefined && elapsed_ms !== null) {
        const elapsedSec = Math.max(0, Number(elapsed_ms) / 1000);
        if (elapsedSec < MIN_SESSION_MS / 1000 && pts > 0) {
          console.warn(`[/api/app/game/sync-score] Session too short (${elapsedSec.toFixed(1)}s) for score ${pts} — rejecting`);
          return res.status(400).json({ error: "Session duration too short for reported score" });
        }
        const maxAllowed = Math.ceil(elapsedSec * MAX_SCORE_PER_SECOND);
        if (pts > maxAllowed) {
          console.warn(`[/api/app/game/sync-score] Score ${pts} impossible in ${elapsedSec.toFixed(1)}s (max=${maxAllowed}), capping`);
          pts = maxAllowed;
        }
      }

      const pts_final = pts;

      // collected_tomatoes:
      //  • If client sent it (bridge computed it) → use client value (already a NUMBER)
      //  • Otherwise → server computes: current DB value + this session's score
      let newTomatoes: number;
      if (clientTomatoes !== undefined && clientTomatoes !== null) {
        // Also cap client-reported tomatoes: can't exceed current DB value + validated pts
        const currentTomatoes = Number(user.collected_tomatoes) || 0;
        const maxTomatoes = currentTomatoes + pts_final;
        newTomatoes = Math.min(Math.max(0, Math.round(Number(clientTomatoes))), maxTomatoes);
        console.log(`[/api/app/game/sync-score] pbId=${pbId} score=${pts_final} tomatoes=client:${newTomatoes}`);
      } else {
        const currentTomatoes = Number(user.collected_tomatoes) || 0;
        newTomatoes = currentTomatoes + pts_final;
        console.log(`[/api/app/game/sync-score] pbId=${pbId} score=${pts_final} tomatoes:${currentTomatoes}→${newTomatoes}`);
      }

      await pbPatch(`/api/collections/users/records/${pbId}`, {
        last_session_score:  pts_final,
        collected_tomatoes:  newTomatoes,
      });
      res.json({ success: true, last_session_score: pts_final, collected_tomatoes: newTomatoes });
    } catch (e: any) {
      console.error("[/api/app/game/sync-score]", e.message);
      res.status(500).json({ error: "Failed to sync score" });
    }
  });

  // ── Ad: Request one-time reward token (call BEFORE showing rewarded ad) ──
  app.post("/api/app/ad/token", async (req: Request, res: Response) => {
    try {
      const { pbId, matchId } = req.body;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      // Bind matchId at issue time — the claim step closes the SAME match the
      // game committed; the client cannot swap in a different matchId later.
      const boundMatchId = typeof matchId === "string" && matchId ? matchId : undefined;
      // HARD GATE 0: forged/tampered match signature → no token issued.
      if (boundMatchId && matchSigState(boundMatchId, pbId) === "invalid") {
        console.warn(`[ad/token] BAD MATCH SIGNATURE (${pbId}): ${boundMatchId.slice(0, 24)}…`);
        return res.status(403).json({ error: "Session verification failed — please play a new game." });
      }
      // ── SERVER-SIDE REWARD BASIS (authoritative, by match_id) ─────────────
      // The game_score row for THIS match holds raw_score, written by the
      // server itself (wsCommitSession) at game over. That row is the payout
      // basis: reward = raw_score × 2 exactly. last_session_score is only a
      // fallback for legacy clients with no matchId — it can be overwritten
      // by a newer game; the row cannot.
      let baseScore = Math.max(0, Math.round(Number(user.last_session_score) || 0));
      if (boundMatchId) {
        try {
          const logRes = await pbGet(
            `/api/collections/game_score/records?filter=${encodeURIComponent(`match_id="${boundMatchId}"`)}&perPage=1`
          );
          const row = logRes?.items?.[0];
          const committedRaw = Math.max(0, Math.round(Number(row?.raw_score) || 0));
          if (row && String(row.match_status || "") !== "completed" && committedRaw > 0) {
            baseScore = committedRaw;
          }
        } catch (rowErr: any) {
          console.warn("[ad/token] game_score lookup failed — using last_session_score:", rowErr.message);
        }
      }
      const reward = Math.min(baseScore * 2, ABSOLUTE_MAX_SCORE * 2);
      const token = crypto.randomUUID();
      // Token expires in 10 minutes — enough time to watch the ad
      adTokenStore.set(token, { pbId, reward, matchId: boundMatchId, expiresAt: Date.now() + 10 * 60_000 });
      console.log(`[ad/token] Issued token for ${pbId}, reward=${reward}PT match=${boundMatchId ?? "none"}`);
      res.json({ token, reward });
    } catch (e: any) {
      console.error("[/api/app/ad/token]", e.message);
      res.status(500).json({ error: "Failed to issue ad token" });
    }
  });

  // ── Ad: Claim PT reward after watching ad (validates one-time token) ──────
  app.post("/api/app/ad/claim", async (req: Request, res: Response) => {
    // Slot-leak guard: if we locked a matchId but crashed before awarding,
    // release the in-memory slot so the player's retry isn't 403'd for hours.
    let lockedMatchId: string | null = null;
    let awarded = false;
    try {
      const { token, pbId } = req.body;
      if (!token || !pbId) return res.status(400).json({ error: "token and pbId required" });
      const entry = adTokenStore.get(token);
      if (!entry) return res.status(400).json({ error: "Invalid or already-used token" });
      if (entry.pbId !== pbId) return res.status(403).json({ error: "Token/user mismatch" });
      if (Date.now() > entry.expiresAt) {
        adTokenStore.delete(token);
        return res.status(400).json({ error: "Token expired — please try again" });
      }
      adTokenStore.delete(token); // single-use: consume immediately

      // ── Match resolution — matchId BOUND AT ISSUE TIME (not the body), with
      // correlation fallback for old clients that never sent one: find the
      // player's newest OPEN match and close THAT row (UPDATE, never INSERT).
      let matchId: string | null = entry.matchId || null;
      let correlatedRecord: any = null;
      if (!matchId) {
        try {
          const openRes = await pbGet(
            `/api/collections/game_score/records?filter=${encodeURIComponent(
              `user="${pbId}" && (match_status="started" || match_status="active")`
            )}&sort=-created&perPage=1`
          );
          const open = openRes?.items?.[0];
          if (open?.match_id) {
            matchId = String(open.match_id);
            correlatedRecord = open;
            console.log(`[ad/claim] no-matchId claim correlated → open match ${matchId.slice(0, 8)} (${pbId})`);
          }
        } catch (corrErr: any) {
          console.warn("[ad/claim] match correlation failed:", corrErr.message);
        }
      }
      let strictMatch = false;
      try { const s: any = await fetchSettings(); strictMatch = !!s?.strict_match_enforcement; } catch {}
      if (strictMatch && !matchId) {
        console.warn(`[ad/claim] NO resolvable match (${pbId}) — rejected (strict)`);
        return res.status(403).json({ error: "Session verification failed — please play a new game." });
      }

      let gameLogId: string | null = null;
      if (matchId) {
        // LAYER 1: in-process replay guard — shared with /api/app/game/reward
        // so the SAME match can never pay out via both the 1× and 2× paths.
        if (claimedMatchIds.has(matchId)) {
          console.warn(`[ad/claim] REPLAY BLOCKED (in-memory): ${matchId} (${pbId})`);
          return res.status(403).json({ error: "Duplicate submission — this session has already been claimed." });
        }
        claimedMatchIds.set(matchId, Date.now());
        lockedMatchId = matchId;

        // LAYER 2: DB-level match lifecycle check
        try {
          const logRes = correlatedRecord
            ? { items: [correlatedRecord] }
            : await pbGet(
                `/api/collections/game_score/records?filter=${encodeURIComponent(`match_id="${matchId}"`)}&perPage=1`
              );
          const logRecord = logRes?.items?.[0];
          if (!logRecord) {
            if (strictMatch) {
              claimedMatchIds.delete(matchId);
              console.warn(`[ad/claim] UNKNOWN matchId ${matchId} (${pbId}) — rejected (strict)`);
              return res.status(403).json({ error: "Invalid session — please play a new game." });
            }
            console.warn(`[ad/claim] unknown matchId ${matchId} (${pbId}) — grace mode, continuing`);
          } else {
            gameLogId = logRecord.id;
            // Row-owner check (layer 2): the match row must belong to the
            // claimant — releases the in-memory slot so the TRUE owner can
            // still claim, then flags the caller's account.
            if (logRecord.user && String(logRecord.user) !== pbId) {
              claimedMatchIds.delete(matchId);
              console.warn(`[ad/claim] OWNER MISMATCH ${matchId}: row-owner=${logRecord.user} claimant=${pbId}`);
              flagUserBlacklist(pbId, `cross-account claim on match ${String(matchId).slice(0, 8)}`).catch(() => {});
              return res.status(403).json({ error: "Session verification failed — please play a new game." });
            }
            const st = String(logRecord.match_status || "");
            if (st === "completed") {
              console.warn(`[ad/claim] REPLAY BLOCKED (db): ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Duplicate submission — this session has already been claimed." });
            }
            if (st === "expired") {
              console.warn(`[ad/claim] EXPIRED match ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Session expired — rewards must be claimed shortly after the game ends." });
            }
            if (st === "blacklisted") {
              console.warn(`[ad/claim] BLACKLISTED match ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Session flagged for suspicious activity — reward denied." });
            }
          }
        } catch (logErr: any) {
          // PB lookup blip — fail open (the in-memory slot still blocks replays)
          console.warn("[ad/claim] game_score lookup failed:", logErr.message);
        }
      }

      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) {
        if (matchId) claimedMatchIds.delete(matchId);
        return res.status(404).json({ error: "User not found" });
      }

      const newPT    = (Number(user.power_tokens) || 0) + entry.reward;
      const newTotal = (Number(user.total_accumulated_score) || 0) + entry.reward;
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        power_tokens:            newPT,
        total_accumulated_score: newTotal,
        last_session_score:      0,
      });
      awarded = true; // PT credited — keep the slot locked even on later errors
      console.log(`[ad/claim] pbId=${pbId} claimed ${entry.reward}PT → newPT=${newPT}`);
      // Close the match atomically (durable replay guard) — UPDATE only.
      if (gameLogId) {
        pbPatch(`/api/collections/game_score/records/${gameLogId}`, {
          match_status: "completed",
          is_double:    true,
          final_tokens: entry.reward,
          user_id:      pbId,
        }).catch(() => {});
      }
      // No resolvable match row → NO game_score write. One game = one row;
      // the old "legacy" INSERT fallback is deliberately removed.
      res.json({ success: true, newPowerTokens: newPT, reward: entry.reward });
    } catch (e: any) {
      // No award happened — release the slot so the player's retry can succeed
      if (lockedMatchId && !awarded) claimedMatchIds.delete(lockedMatchId);
      console.error("[/api/app/ad/claim]", e.message);
      res.status(500).json({ error: "Failed to claim ad reward" });
    }
  });

  // ── Game: Add power tokens ────────────────────────────────────────────────
  app.post("/api/app/game/reward", async (req: Request, res: Response) => {
    // Slot-leak guard: if we locked a matchId but crashed before awarding,
    // release the in-memory slot so the player's retry isn't 403'd for hours.
    let lockedMatchId: string | null = null;
    let awarded = false;
    try {
      const { pbId, amount, type } = req.body;
      if (!pbId || !amount)
        return res.status(400).json({ error: "pbId and amount required" });

      // ── MATCH RESOLUTION — single source of truth ────────────────────────
      // New clients send matchId directly. OLD clients (pre-matchId APK /
      // bridge.js) claim WITHOUT one even though the WebSocket already created
      // this game's row at GAME_START — so we CORRELATE: find the player's
      // newest OPEN match (active/started) and close THAT row. A claim only
      // ever UPDATEs the existing match row; it never INSERTs a second one.
      let matchId: string | null =
        typeof req.body.matchId === "string" && req.body.matchId ? req.body.matchId : null;
      // ── HARD GATE 0: cryptographic match signature ───────────────────────
      // Every server-issued matchId is HMAC-signed ("uuid.sig"). A signed id
      // that fails verification is forged/tampered → reject before ANY other
      // work. Unsigned ids (pre-signature sessions) fall through to the DB
      // row validation below.
      if (matchId && matchSigState(matchId, pbId) === "invalid") {
        console.warn(`[/api/app/game/reward] BAD MATCH SIGNATURE (${pbId}): ${matchId.slice(0, 24)}…`);
        return res.status(403).json({ error: "Session verification failed — please play a new game." });
      }
      let correlatedRecord: any = null;
      if (!matchId) {
        try {
          const openRes = await pbGet(
            `/api/collections/game_score/records?filter=${encodeURIComponent(
              `user="${pbId}" && (match_status="started" || match_status="active")`
            )}&sort=-created&perPage=1`
          );
          const open = openRes?.items?.[0];
          if (open?.match_id) {
            matchId = String(open.match_id);
            correlatedRecord = open;
            console.log(`[/api/app/game/reward] no-matchId claim correlated → open match ${matchId.slice(0, 8)} (${pbId})`);
          }
        } catch (corrErr: any) {
          console.warn("[/api/app/game/reward] match correlation failed:", corrErr.message);
        }
      }

      // ── STRICT MODE (PB settings.strict_match_enforcement, default false) ──
      // Strict: claims with NO resolvable match are rejected outright. Grace
      // (default) still pays the player but writes NOTHING to game_score — a
      // claim that cannot be tied to a real match leaves no row at all.
      let strictMatch = false;
      try { const s: any = await fetchSettings(); strictMatch = !!s?.strict_match_enforcement; } catch {}
      if (strictMatch && !matchId) {
        console.warn(`[/api/app/game/reward] NO resolvable match (${pbId}) — rejected (strict)`);
        return res.status(403).json({ error: "Session verification failed — please play a new game." });
      }

      // ── LAYER 1: In-process replay-attack guard (sub-ms, no DB round-trip) ──
      // Claimed before any async work so concurrent requests for the same matchId
      // can't both slip through the DB check (TOCTOU race condition).
      if (matchId) {
        if (claimedMatchIds.has(matchId)) {
          console.warn(`[/api/app/game/reward] REPLAY BLOCKED (in-memory): ${matchId} (${pbId})`);
          return res.status(403).json({ error: "Duplicate submission — this session has already been claimed." });
        }
        claimedMatchIds.set(matchId, Date.now()); // claim the slot immediately
        lockedMatchId = matchId;
      }

      // Cap incoming amount to prevent inflated rewards from client tampering.
      // ABSOLUTE_MAX_SCORE * 2 covers the double-reward (2×) ad scenario.
      let safeAmount = Math.min(
        Math.max(0, Math.round(Number(amount) || 0)),
        ABSOLUTE_MAX_SCORE * 2
      );
      if (safeAmount !== Number(amount)) {
        console.warn(`[/api/app/game/reward] Amount capped: ${amount} → ${safeAmount}`);
      }

      // Hourly rate limit: max 30 reward claims per user per hour
      if (!checkHourlyRewardLimit(pbId)) {
        console.warn(`[/api/app/game/reward] Rate-limited: ${pbId}`);
        if (matchId) claimedMatchIds.delete(matchId); // release slot on rejection
        return res.status(429).json({ error: "Too many reward requests. Please wait before trying again." });
      }

      // ── LAYER 2: DB-level replay guard + time-to-score check ─────────────
      // Uses the game_score record written by wsCommitSession (match_status="started").
      // If that record is already "completed" → 403 Duplicate Submission.
      let gameLogId: string | null = null;
      let isDoubleClaim = false;
      if (matchId) {
        try {
          const logRes = correlatedRecord
            ? { items: [correlatedRecord] }
            : await pbGet(
                `/api/collections/game_score/records?filter=${encodeURIComponent(`match_id="${matchId}"`)}&perPage=1`
              );
          const logRecord = logRes?.items?.[0];
          if (!logRecord) {
            if (strictMatch) {
              claimedMatchIds.delete(matchId);
              console.warn(`[/api/app/game/reward] UNKNOWN matchId ${matchId} (${pbId}) — rejected (strict)`);
              return res.status(403).json({ error: "Invalid session — please play a new game." });
            }
            console.warn(`[/api/app/game/reward] unknown matchId ${matchId} (${pbId}) — grace mode, continuing`);
          } else {
            gameLogId = logRecord.id;
            // Row-owner check (layer 2): the match row must belong to the
            // claimant — releases the in-memory slot so the TRUE owner can
            // still claim, then flags the caller's account.
            if (logRecord.user && String(logRecord.user) !== pbId) {
              claimedMatchIds.delete(matchId);
              console.warn(`[/api/app/game/reward] OWNER MISMATCH ${matchId}: row-owner=${logRecord.user} claimant=${pbId}`);
              flagUserBlacklist(pbId, `cross-account claim on match ${String(matchId).slice(0, 8)}`).catch(() => {});
              return res.status(403).json({ error: "Session verification failed — please play a new game." });
            }
            const st = String(logRecord.match_status || "");
            if (st === "completed") {
              console.warn(`[/api/app/game/reward] REPLAY BLOCKED (db): ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Duplicate submission — this session has already been claimed." });
            }
            if (st === "expired") {
              console.warn(`[/api/app/game/reward] EXPIRED match ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Session expired — rewards must be claimed shortly after the game ends." });
            }
            if (st === "blacklisted") {
              console.warn(`[/api/app/game/reward] BLACKLISTED match ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Session flagged for suspicious activity — reward denied." });
            }
            if (strictMatch && st === "active") {
              // Game-over commit never happened — a claim without a finished
              // game. In grace mode we let the score caps below handle it.
              console.warn(`[/api/app/game/reward] ACTIVE (unfinished) match ${matchId} (${pbId}) — rejected (strict)`);
              return res.status(403).json({ error: "Session not finished — please finish the game first." });
            }
            // ── SERVER-AUTHORITATIVE PAYOUT (by match_id) ───────────────────
            // wsCommitSession stored the WS-validated raw score on this row
            // (game_score.raw_score) at game over. The client amount is NOT
            // trusted as a payout basis — it is only a 1× vs 2× intent
            // signal. The payout is strictly:
            //   final_tokens = is_double ? raw_score * 2 : raw_score
            //   raw_score 80 → Claim credits 80, 2× credits 160. Never 120.
            const committedPT = Math.max(0, Math.round(Number(logRecord.raw_score) || 0));
            if (committedPT > 0) {
              if (strictMatch && safeAmount > committedPT * 2) {
                // Claiming more than 2× the server-validated score is
                // unambiguous tampering → blacklist the match, deny outright.
                pbPatch(`/api/collections/game_score/records/${logRecord.id}`, {
                  match_status: "blacklisted",
                }).catch(() => {});
                console.warn(
                  `[/api/app/game/reward] BLACKLIST ${matchId}: claim ${safeAmount}PT > 2× committed ${committedPT}PT (${pbId})`
                );
                // Account-level flag: claiming more than 2× the server-
                // validated score is unambiguous tampering.
                flagUserBlacklist(pbId, `claim ${safeAmount}PT > 2× committed ${committedPT}PT`).catch(() => {});
                return res.status(403).json({ error: "Score could not be verified — reward denied." });
              }
              // 1× vs 2× intent: anything above 1.5× the committed score is a
              // double claim (the 2× fallback path sends score × 2).
              // No rounding here — committedPT=1 must still detect amount 2
              // as a double (2 > 1.5).
              isDoubleClaim = safeAmount > committedPT * 1.5;
              const paidPT = isDoubleClaim ? committedPT * 2 : committedPT;
              if (safeAmount !== paidPT) {
                console.warn(
                  `[/api/app/game/reward] client amount ${safeAmount}PT → server-computed ${paidPT}PT (committed=${committedPT}, double=${isDoubleClaim}) (${pbId})`
                );
              }
              safeAmount = paidPT;
            } else if (logRecord.created) {
              // No WS-committed score on the row (grace-mode "active" rows or
              // genuine 0-score games): fall back to a wall-clock CAP only.
              // Never blacklist on this heuristic — it undercounts legit play.
              // game_score rows carry no start_time field — PB's own `created`
              // timestamp (set at GAME_START insert) is the game start.
              const startMs      = new Date(String(logRecord.created).replace(" ", "T")).getTime();
              const durationSec  = (Date.now() - startMs) / 1000;
              const maxPossible  = Math.ceil(durationSec * 5) + 10;
              if (safeAmount > maxPossible) {
                console.warn(
                  `[/api/app/game/reward] Time-score mismatch: ${safeAmount}PT in ${Math.round(durationSec)}s (max ${maxPossible}) — capping`
                );
                safeAmount = maxPossible;
              }
            }
          }
        } catch (logErr: any) {
          // PB lookup blip — fail open (the in-memory slot still blocks replays)
          console.warn("[/api/app/game/reward] game_score lookup failed:", logErr.message);
        }
      }

      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) {
        if (matchId) claimedMatchIds.delete(matchId);
        return res.status(404).json({ error: "User not found" });
      }

      // Anti-cheat: if the server set a validated last_session_score via WebSocket,
      // the claim amount must not exceed 2× that value (2× covers the ad double-reward).
      // If last_session_score is 0 or unset we skip this check to avoid blocking
      // legacy clients that still use the REST-only score path.
      const serverValidatedScore = Number(user.last_session_score) || 0;
      if (serverValidatedScore > 0 && safeAmount > serverValidatedScore * 2) {
        console.warn(
          `[/api/app/game/reward] ${pbId} amount ${safeAmount} > 2× last_session_score ${serverValidatedScore} — capping`
        );
        safeAmount = serverValidatedScore * 2;
      }

      const newPT   = (Number(user.power_tokens) || 0) + safeAmount;
      const newTotal = (Number(user.total_accumulated_score) || 0) + safeAmount;
      const newWins  = type === "game_win"
          ? (user.total_wins || 0) + 1
          : user.total_wins || 0;

      await pbPatch(`/api/collections/users/records/${pbId}`, {
        power_tokens:            newPT,
        total_wins:              newWins,
        total_accumulated_score: newTotal,
        last_session_score:      0,        // reset after claim
      });
      awarded = true; // PT credited — keep the slot locked even on later errors
      console.log(`[/api/app/game/reward] pbId=${pbId} +${safeAmount}PT → newPT=${newPT} totalScore=${newTotal}`);

      // ── LAYER 2 (cont): Flip match_status → "completed" atomically ────────
      // Any future call with the same matchId will be rejected by Layer 1 (in-memory)
      // or caught here (DB check). Using fire-and-forget since the in-memory guard
      // already blocks races; the DB update is the durable audit trail.
      if (gameLogId) {
        pbPatch(`/api/collections/game_score/records/${gameLogId}`, {
          match_status: "completed",
          final_tokens: safeAmount,
          is_double:    isDoubleClaim,
          user_id:      pbId,
        }).catch(() => {});
      }
      // No resolvable match row → NO game_score write. One game = one row;
      // a claim that cannot be tied to a real match must never create rows
      // (the old "legacy" INSERT fallback is deliberately removed).

      // ── NO referral commission on gameplay ──────────────────────────────
      // Referral commission is paid EXCLUSIVELY on a referee's mining rewards
      // (see /api/app/mine/claim). Power tokens / game scores are deliberately
      // EXCLUDED from the referral base so gameplay loops can never trigger a
      // referral payout. Do not re-add a referral credit here.

      res.json({ success: true, newPowerTokens: newPT });
    } catch (e: any) {
      // No award happened — release the slot so the player's retry can succeed
      if (lockedMatchId && !awarded) claimedMatchIds.delete(lockedMatchId);
      console.error("[/api/app/game/reward]", e.message);
      res.status(500).json({ error: "Failed to grant reward" });
    }
  });

  // ── Game: Spend power tokens ──────────────────────────────────────────────
  app.post("/api/app/game/spend", async (req: Request, res: Response) => {
    try {
      const { pbId, amount } = req.body;
      if (!pbId || !amount)
        return res.status(400).json({ error: "pbId and amount required" });

      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      if ((user.power_tokens || 0) < amount)
        return res.json({ success: false, reason: "Insufficient power tokens" });

      const newPT = user.power_tokens - amount;
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        power_tokens: newPT,
      });

      res.json({ success: true, newPowerTokens: newPT });
    } catch (e: any) {
      console.error("[/api/app/game/spend]", e.message);
      res.status(500).json({ error: "Failed to spend tokens" });
    }
  });

  // ── Tasks: list active tasks with user submission status ─────────────────
  app.get("/api/app/tasks", async (req: Request, res: Response) => {
    try {
      const { userId } = req.query as { userId?: string };
      const tasksRes = await pbGet(
        `/api/collections/tasks/records?filter=${encodeURIComponent("is_active=true")}&sort=created&perPage=50`,
      );
      const tasks = tasksRes.items || [];

      let submissionsMap: Record<string, any> = {};
      if (userId) {
        const subsRes = await pbGet(
          `/api/collections/task_submissions/records?filter=${encodeURIComponent(`user_id="${userId}"`)}&perPage=200`,
        );
        for (const sub of (subsRes.items || [])) {
          if (!submissionsMap[sub.task_id] || sub.status === "approved") {
            submissionsMap[sub.task_id] = { id: sub.id, status: sub.status, admin_notes: sub.admin_notes || "" };
          }
        }
      }

      // Return ALL active tasks with their submission status.
      // Previously approved/rejected tasks were filtered out here, which caused a
      // race window: on app restart the stale React Query cache briefly showed
      // "Upload Proof" before the fresh fetch arrived.
      // Now the server always returns the full task list with submission attached —
      // the frontend renders a "Task Locked" / "Already Participated" state instead
      // of hiding the card entirely. The DB unique index + Express duplicate check
      // are the authoritative submission guards; the UI state is informational only.
      res.json(tasks.map((t: any) => ({
        id:            t.id,
        title:         t.title,
        description:   t.description   || "",
        link:          t.link          || "",
        reward_amount: t.reward_amount || 0,
        reward_type:   t.reward_type   || "PT",
        submission:    submissionsMap[t.id] || null,
      })));
    } catch (e: any) {
      console.error("[/api/app/tasks]", e.message);
      res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });

  // ── Tasks: submit proof (multipart — stores real file in PocketBase) ───────
  app.post("/api/app/tasks/submit", upload.single("proof_screenshot"), async (req: Request, res: Response) => {
    try {
      const { pbId, taskId } = req.body;
      if (!pbId || !taskId) return res.status(400).json({ error: "pbId and taskId required" });

      if (!req.file) {
        return res.status(400).json({ error: "Proof screenshot is required — no file received by server. Please try again." });
      }

      const task = await pbGet(`/api/collections/tasks/records/${taskId}`);
      if (task.code) return res.status(404).json({ error: "Task not found" });
      if (!task.is_active) return res.status(400).json({ error: "Task is no longer active" });

      const user = await pbGet(`/api/collections/users/records/${pbId}?fields=id,email`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      // Zero-trust duplicate check: reject ANY existing submission regardless of status.
      // This covers the rejected-then-resubmit exploit — once a record exists for
      // (user_id, task_id), PocketBase's unique index also enforces this at DB level.
      const existing = await pbGet(
        `/api/collections/task_submissions/records?filter=${encodeURIComponent(`user_id="${pbId}" && task_id="${taskId}"`)}&perPage=1`,
      );
      if ((existing.items || []).length > 0) {
        return res.status(409).json({ error: "You have already participated in this task" });
      }

      // Forward to PocketBase as multipart so the image is stored as a real file
      const form = new FormData();
      form.append("user_id",      pbId);
      form.append("task_id",      taskId);
      form.append("task_title",   task.title || "");
      form.append("user_email",   user.email || "");
      form.append("status",       "pending");
      form.append("admin_notes",  "");
      form.append("reward_amount", String(task.reward_amount || 0));
      form.append("reward_type",  task.reward_type || "PT");

      if (req.file) {
        const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "image/jpeg" });
        form.append("proof_screenshot", blob, req.file.originalname || "proof.jpg");
      }

      const sub = await pbFetchMultipart("POST", "/api/collections/task_submissions/records", form);
      if (!sub.id) {
        console.error("[/api/app/tasks/submit] PB error:", JSON.stringify(sub).slice(0, 300));
        return res.status(500).json({ error: "Failed to create submission" });
      }

      res.json({ success: true, submissionId: sub.id });
    } catch (e: any) {
      console.error("[/api/app/tasks/submit]", e.message);
      res.status(500).json({ error: "Failed to submit task" });
    }
  });

  // ── Admin: list all tasks ─────────────────────────────────────────────────
  app.get("/api/admin/tasks", async (_req: Request, res: Response) => {
    try {
      const r = await pbGet(`/api/collections/tasks/records?sort=-created&perPage=100`);
      res.json(r.items || []);
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });

  // ── Admin: create task ────────────────────────────────────────────────────
  app.post("/api/admin/tasks", async (req: Request, res: Response) => {
    try {
      const { title, description, link, reward_amount, reward_type, is_active } = req.body;
      if (!title || !reward_amount || !reward_type) {
        return res.status(400).json({ error: "title, reward_amount, reward_type required" });
      }
      const task = await pbPost("/api/collections/tasks/records", {
        title,
        description: description || "",
        link: link || "",
        reward_amount: Number(reward_amount),
        reward_type,
        is_active: is_active !== false,
      });
      if (!task.id) return res.status(500).json({ error: "Failed to create task" });
      res.json(task);
    } catch (e: any) {
      console.error("[admin/tasks POST]", e.message);
      res.status(500).json({ error: "Failed to create task" });
    }
  });

  // ── Admin: update task (toggle active etc.) ───────────────────────────────
  app.patch("/api/admin/tasks/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await pbPatch(`/api/collections/tasks/records/${id}`, req.body);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  // ── Admin: list task submissions ──────────────────────────────────────────
  app.get("/api/admin/tasks/submissions", async (req: Request, res: Response) => {
    try {
      const { status } = req.query as { status?: string };
      const filter = status ? `status="${status}"` : `status="pending"`;
      const r = await pbGet(
        `/api/collections/task_submissions/records?filter=${encodeURIComponent(filter)}&sort=-created&perPage=100`,
      );
      res.json(r.items || []);
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch submissions" });
    }
  });

  // ── Admin: approve submission + auto-reward ───────────────────────────────
  app.post("/api/admin/tasks/submissions/:id/approve", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;

      const sub = await pbGet(`/api/collections/task_submissions/records/${id}`);
      if (sub.code) return res.status(404).json({ error: "Submission not found" });
      if (sub.status !== "pending") return res.status(400).json({ error: "Already processed" });

      const user = await pbGet(`/api/collections/users/records/${sub.user_id}?fields=id,shib_balance,power_tokens`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      // Apply reward
      const patch: Record<string, number> = {};
      if (sub.reward_type === "SHIB") {
        patch.shib_balance = (user.shib_balance || 0) + (sub.reward_amount || 0);
      } else {
        patch.power_tokens = (user.power_tokens || 0) + (sub.reward_amount || 0);
      }
      await pbPatch(`/api/collections/users/records/${sub.user_id}`, patch);

      // PATCH status to "approved" — do NOT touch the screenshot file.
      // Removing the file while updating status can fail silently in PocketBase,
      // causing the record to look deleted. Screenshot cleanup is deferred.
      const approveForm = new FormData();
      approveForm.append("status",      "approved");
      approveForm.append("admin_notes", notes || "");
      const patchRes = await pbFetchMultipart("PATCH", `/api/collections/task_submissions/records/${id}`, approveForm);
      if (patchRes.code) {
        console.error("[tasks/approve] PB patch failed:", JSON.stringify(patchRes).slice(0, 300));
        return res.status(500).json({ error: "Failed to update submission status" });
      }

      res.json({ success: true });
    } catch (e: any) {
      console.error("[tasks/approve]", e.message);
      res.status(500).json({ error: "Failed to approve submission" });
    }
  });

  // ── Admin: reject submission ──────────────────────────────────────────────
  app.post("/api/admin/tasks/submissions/:id/reject", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;

      const sub = await pbGet(`/api/collections/task_submissions/records/${id}`);
      if (sub.code) return res.status(404).json({ error: "Submission not found" });
      if (sub.status !== "pending") return res.status(400).json({ error: "Already processed" });

      // PATCH status to "rejected" — do NOT touch the screenshot file.
      const rejectForm = new FormData();
      rejectForm.append("status",      "rejected");
      rejectForm.append("admin_notes", notes || "");
      const rejectPatchRes = await pbFetchMultipart("PATCH", `/api/collections/task_submissions/records/${id}`, rejectForm);
      if (rejectPatchRes.code) {
        console.error("[tasks/reject] PB patch failed:", JSON.stringify(rejectPatchRes).slice(0, 300));
        return res.status(500).json({ error: "Failed to update submission status" });
      }

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: "Failed to reject submission" });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // VIP TIER SYSTEM
  // VIP adds a SHIB/hr increment on top of the admin base rate. Upgrades are
  // sequential (current+1) and gated by LIVE metrics (refs, balance, approved
  // tasks, completed withdrawals). Admins can override a user's tier, which sets
  // a permanent floor (admin_promoted_level) and immunity flag (is_admin_promoted).
  // ───────────────────────────────────────────────────────────────────────────
  async function computeVipMetrics(userRecord: any) {
    const pbId = userRecord.id;
    const referralCode = userRecord.referral_code || "";
    const balance = Number(userRecord.shib_balance) || 0;

    // Referrals: users whose referred_by points at this user's referral code OR id.
    let refs = 0;
    try {
      const filter = referralCode
        ? `referred_by="${referralCode}" || referred_by="${pbId}"`
        : `referred_by="${pbId}"`;
      const r = await pbGet(`/api/collections/users/records?filter=${encodeURIComponent(filter)}&perPage=1`);
      refs = Number(r.totalItems) || 0;
    } catch { /* metric stays 0 */ }

    // Approved task submissions.
    let tasks = 0;
    try {
      const r = await pbGet(`/api/collections/task_submissions/records?filter=${encodeURIComponent(`user_id="${pbId}" && status="approved"`)}&perPage=1`);
      tasks = Number(r.totalItems) || 0;
    } catch { /* metric stays 0 */ }

    // Completed withdrawals.
    let withdrawals = 0;
    try {
      const r = await pbGet(`/api/collections/withdrawals/records?filter=${encodeURIComponent(`user="${pbId}" && status="completed"`)}&perPage=1`);
      withdrawals = Number(r.totalItems) || 0;
    } catch { /* metric stays 0 */ }

    // Accumulated referral commission (monotonic; credited via referral pipeline).
    const refIncome = Number(userRecord.referral_earnings) || 0;

    return { refs, balance, refIncome, tasks, withdrawals };
  }

  // GET current VIP state + live metrics
  app.get("/api/app/vip/status/:pbId", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const metrics = await computeVipMetrics(user);
      res.json({
        vipLevel: normalizeVipLevel(user.vip_level),
        isAdminPromoted: !!user.is_admin_promoted,
        adminPromotedLevel: normalizeVipLevel(user.admin_promoted_level),
        metrics,
      });
    } catch (e: any) {
      console.error("[/api/app/vip/status]", e.message);
      res.status(500).json({ error: "Failed to load VIP status" });
    }
  });

  // POST sequential upgrade — current+1, gated by live metrics
  app.post("/api/app/vip/upgrade", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.body || {};
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      const current = normalizeVipLevel(user.vip_level);
      const target = current + 1;
      if (target > MAX_VIP_LEVEL) {
        return res.status(400).json({ error: "Already at maximum VIP level", vipLevel: current });
      }

      const metrics = await computeVipMetrics(user);
      if (!meetsVipRequirements(target, metrics)) {
        return res.status(400).json({
          error: "Requirements not met",
          unmet: unmetVipRequirements(target, metrics),
          metrics,
          vipLevel: current,
        });
      }

      const updated = await pbPatch(`/api/collections/users/records/${pbId}`, { vip_level: target });
      if (updated.code) return res.status(500).json({ error: "Failed to upgrade VIP" });
      res.json({ success: true, vipLevel: target, metrics });
    } catch (e: any) {
      console.error("[/api/app/vip/upgrade]", e.message);
      res.status(500).json({ error: "Failed to upgrade VIP" });
    }
  });

  // POST admin override — sets level + permanent floor + immunity from auto-demote
  app.post("/api/admin/users/vip", async (req: Request, res: Response) => {
    try {
      const { pbId, level } = req.body || {};
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const lvl = normalizeVipLevel(level);
      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const updated = await pbPatch(`/api/collections/users/records/${pbId}`, {
        vip_level: lvl,
        is_admin_promoted: true,
        admin_promoted_level: lvl,
      });
      if (updated.code) return res.status(500).json({ error: "Failed to set VIP" });
      res.json(formatUser(updated));
    } catch (e: any) {
      console.error("[/api/admin/users/vip]", e.message);
      res.status(500).json({ error: "Failed to set VIP" });
    }
  });

  // GET admin user search by email / referral code / display name
  app.get("/api/admin/users/search", async (req: Request, res: Response) => {
    try {
      const q = String(req.query.q || "").trim();
      if (!q) return res.json({ items: [] });
      const filter = `email~"${q}" || referral_code~"${q}" || display_name~"${q}"`;
      const r = await pbGet(`/api/collections/users/records?filter=${encodeURIComponent(filter)}&perPage=20&sort=-created`);
      res.json({ items: (r.items || []).map(formatUser) });
    } catch (e: any) {
      console.error("[/api/admin/users/search]", e.message);
      res.status(500).json({ error: "Failed to search users" });
    }
  });

  const httpServer = createServer(app);
  // ── Daily Rewards: Status ────────────────────────────────────────────────
  app.get("/api/app/daily/status/:pbId", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });

      const u = await pbGet(`/api/collections/users/records/${pbId}?fields=id,daily_streak,last_daily_claim`);
      if (u.code) return res.status(404).json({ error: "User not found" });

      const s = await fetchSettings();
      const streak = Number(u.daily_streak) || 0;
      const lastClaimMs = u.last_daily_claim ? new Date(u.last_daily_claim).getTime() : 0;
      const serverNowMs = Date.now();
      // Anti-cheat: if last_daily_claim is in the future (device-clock exploit artifact),
      // treat it as 0 so the user can claim immediately (resets corrupted state cleanly).
      const effectiveLastMs = (lastClaimMs > 0 && lastClaimMs > serverNowMs) ? 0 : lastClaimMs;
      const diffMs = effectiveLastMs ? serverNowMs - effectiveLastMs : Infinity;
      const H24 = 24 * 3600_000;
      const H48 = 48 * 3600_000;

      let canClaim = false;
      let activeDay = 1;
      let nextClaimAt: string | null = null;

      if (!effectiveLastMs || diffMs >= H48) {
        canClaim = true; activeDay = 1;
      } else if (streak >= 7 && diffMs >= H24) {
        canClaim = true; activeDay = 1;
      } else if (streak >= 7) {
        canClaim = false; activeDay = 7;
        nextClaimAt = new Date(effectiveLastMs + H24).toISOString();
      } else if (diffMs >= H24) {
        canClaim = true; activeDay = streak + 1;
      } else {
        canClaim = false; activeDay = streak + 1;
        nextClaimAt = new Date(effectiveLastMs + H24).toISOString();
      }

      res.json({
        streak,
        activeDay,
        canClaim,
        nextClaimAt,
        serverTime: new Date(serverNowMs).toISOString(),
        rewards: {
          day1Shib: s?.daily_reward_day1_shib ?? 1000,
          day2Pt:   s?.daily_reward_day2_pt   ?? 50,
          day3Shib: s?.daily_reward_day3_shib ?? 3000,
          day4Pt:   s?.daily_reward_day4_pt   ?? 100,
          day5Shib: s?.daily_reward_day5_shib ?? 5000,
          day6Pt:   s?.daily_reward_day6_pt   ?? 200,
          day7Shib: s?.daily_reward_day7_shib ?? 10000,
          day7Pt:   s?.daily_reward_day7_pt   ?? 500,
        },
      });
    } catch (e: any) {
      console.error("[/api/app/daily/status]", e.message);
      res.status(500).json({ error: "Failed to fetch daily status" });
    }
  });

  // ── Daily Claim Settings (admin-configured images + amounts) ────────────
  app.get("/api/app/daily/settings", async (req: Request, res: Response) => {
    try {
      const result = await pbGet('/api/collections/daily_claim_settings/records?perPage=1');
      const rec = result?.items?.[0];
      if (!rec) {
        return res.json({
          id: '', day1ImageUrl: null, day1Amount: 1000,
          day2ImageUrl: null, day2Amount: 50,
          day3ImageUrl: null, day3Amount: 3000,
          day4ImageUrl: null, day4Amount: 100,
          day5ImageUrl: null, day5Amount: 5000,
          day6ImageUrl: null, day6Amount: 200,
          day7ShibImageUrl: null, day7ShibAmount: 10000,
          day7PowerImageUrl: null, day7PowerAmount: 500,
        });
      }
      const BASE = `https://api.webcod.in/api/files/daily_claim_settings/${rec.id}`;
      const fu = (f: string | undefined) => (f ? `${BASE}/${f}` : null);
      res.json({
        id: rec.id,
        day1ImageUrl: fu(rec.day_1_image),       day1Amount: rec.day_1_amount ?? 1000,
        day2ImageUrl: fu(rec.day_2_image),       day2Amount: rec.day_2_amount ?? 50,
        day3ImageUrl: fu(rec.day_3_image),       day3Amount: rec.day_3_amount ?? 3000,
        day4ImageUrl: fu(rec.day_4_image),       day4Amount: rec.day_4_amount ?? 100,
        day5ImageUrl: fu(rec.day_5_image),       day5Amount: rec.day_5_amount ?? 5000,
        day6ImageUrl: fu(rec.day_6_image),       day6Amount: rec.day_6_amount ?? 200,
        day7ShibImageUrl: fu(rec.day_7_shiba_image), day7ShibAmount: rec.day_7_shiba_amount ?? 10000,
        day7PowerImageUrl: fu(rec.day_7_power_image), day7PowerAmount: rec.day_7_power_amount ?? 500,
      });
    } catch (e: any) {
      console.error("[/api/app/daily/settings]", e.message);
      res.status(500).json({ error: "Failed to fetch daily settings" });
    }
  });

  // ── Daily Rewards: Claim ─────────────────────────────────────────────────
  app.post("/api/app/daily/claim/:pbId", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });

      const u = await pbGet(`/api/collections/users/records/${pbId}?fields=id,daily_streak,last_daily_claim,shib_balance,power_tokens`);
      if (u.code) return res.status(404).json({ error: "User not found" });

      const s = await fetchSettings();
      const streak = Number(u.daily_streak) || 0;
      const lastClaimMs = u.last_daily_claim ? new Date(u.last_daily_claim).getTime() : 0;
      const serverNowMs = Date.now();
      // Anti-cheat: if last_daily_claim is in the future (device-clock exploit artifact),
      // treat it as 0 — this resets the corrupted state and allows an immediate claim.
      const effectiveLastMs = (lastClaimMs > 0 && lastClaimMs > serverNowMs) ? 0 : lastClaimMs;
      const diffMs = effectiveLastMs ? serverNowMs - effectiveLastMs : Infinity;
      const H24 = 24 * 3600_000;
      const H48 = 48 * 3600_000;

      let canClaim = false;
      let claimDay = 1;

      if (!effectiveLastMs || diffMs >= H48) {
        canClaim = true; claimDay = 1;
      } else if (streak >= 7 && diffMs >= H24) {
        canClaim = true; claimDay = 1;
      } else if (streak >= 7) {
        canClaim = false;
      } else if (diffMs >= H24) {
        canClaim = true; claimDay = streak + 1;
      }

      if (!canClaim) {
        const nextMs = effectiveLastMs + H24;
        const remainingSec = Math.ceil((nextMs - serverNowMs) / 1000);
        return res.status(429).json({ error: "Not yet eligible", nextClaimAt: new Date(nextMs).toISOString(), remainingSec });
      }

      // Fetch authoritative amounts from daily_claim_settings (primary) → settings (fallback)
      let dsRec: any = null;
      try {
        const dsResult = await pbGet('/api/collections/daily_claim_settings/records?perPage=1');
        dsRec = dsResult?.items?.[0] ?? null;
      } catch { /* ignore */ }

      const rewardMap: Record<number, { shib: number; pt: number }> = dsRec ? {
        1: { shib: dsRec.day_1_amount ?? 1000,  pt: 0 },
        2: { shib: 0,                             pt: dsRec.day_2_amount ?? 50 },
        3: { shib: dsRec.day_3_amount ?? 3000,  pt: 0 },
        4: { shib: 0,                             pt: dsRec.day_4_amount ?? 100 },
        5: { shib: dsRec.day_5_amount ?? 5000,  pt: 0 },
        6: { shib: 0,                             pt: dsRec.day_6_amount ?? 200 },
        7: { shib: dsRec.day_7_shiba_amount ?? 10000, pt: dsRec.day_7_power_amount ?? 500 },
      } : {
        1: { shib: s?.daily_reward_day1_shib ?? 1000,  pt: 0 },
        2: { shib: 0,                                   pt: s?.daily_reward_day2_pt ?? 50 },
        3: { shib: s?.daily_reward_day3_shib ?? 3000,  pt: 0 },
        4: { shib: 0,                                   pt: s?.daily_reward_day4_pt ?? 100 },
        5: { shib: s?.daily_reward_day5_shib ?? 5000,  pt: 0 },
        6: { shib: 0,                                   pt: s?.daily_reward_day6_pt ?? 200 },
        7: { shib: s?.daily_reward_day7_shib ?? 10000, pt: s?.daily_reward_day7_pt ?? 500 },
      };
      const reward = rewardMap[claimDay] ?? { shib: 0, pt: 0 };
      const newStreak = claimDay; // streak = how many consecutive days in current cycle
      const newShibBalance = (Number(u.shib_balance) || 0) + reward.shib;
      const newPt = (Number(u.power_tokens) || 0) + reward.pt;
      const nowIso = new Date(serverNowMs).toISOString();

      const updated = await pbPatch(`/api/collections/users/records/${pbId}`, {
        daily_streak: newStreak,
        last_daily_claim: nowIso,
        shib_balance: newShibBalance,
        power_tokens: newPt,
      });
      if (updated.code) return res.status(500).json({ error: "Failed to update user record" });

      // Audit log (best-effort)
      pbPost("/api/collections/daily_claims/records", {
        user_id: pbId,
        day_number: claimDay,
        reward_shib: reward.shib,
        reward_pt: reward.pt,
      }).catch(() => {});

      const nextClaimAt = new Date(serverNowMs + H24).toISOString();
      res.json({
        success: true,
        claimDay,
        newStreak,
        rewardShib: reward.shib,
        rewardPt: reward.pt,
        newShibBalance,
        newPt,
        nextClaimAt,
        serverTime: nowIso,
      });
    } catch (e: any) {
      console.error("[/api/app/daily/claim]", e.message);
      res.status(500).json({ error: "Claim failed" });
    }
  });

  // ── Tournament: server-time + config ──────────────────────────────────────
  // Returns the current tournament config (including cycle_id) enriched with
  // server-authoritative time. Fully-manual model: the client derives phase
  // (none / prestart / live) from is_active + start_time/end_time + cycle_id.
  app.get('/api/app/tournament/config', async (req: Request, res: Response) => {
    try {
      const serverTime = Date.now();
      try {
        const cfgRes = await pbGet(
          '/api/collections/tournament_config/records?sort=-created&perPage=1',
        );
        const raw = cfgRes?.items?.[0];
        if (!raw) return res.json({ config: null, serverTime });

        // Fully-manual model: the client derives phase (none / prestart / live)
        // from is_active + start_time/end_time + cycle_id. No weekly intermission.
        //
        // IMPORTANT: reward_structure is returned as the RAW JSON STRING exactly as
        // stored in PocketBase. The mobile client runs `JSON.parse(reward_structure)`
        // in TournamentContext.loadConfig. If we pre-parse it into an object here,
        // JSON.parse("[object Object]") throws, the catch swallows it, and every rank
        // prize falls back to 0 — the winning amounts render blank on the leaderboard.
        // This shape MUST stay identical to the PocketBase-direct fallback.
        return res.json({
          config: {
            id:               raw.id,
            cycle_id:         raw.cycle_id || '',
            prize_pool_total: Number(raw.prize_pool_total) || 0,
            winners_count:    Number(raw.winners_count)    || 3,
            reward_structure: raw.reward_structure || '{}',
            banner:           raw.banner     || '',
            banner_url:       raw.banner_url || '',
            week_start:       raw.week_start || '',
            start_time:       raw.start_time || raw.week_start || '',
            end_time:         raw.end_time   || '',
            is_active:        !!raw.is_active,
          },
          serverTime,
        });
      } catch (innerErr: any) {
        return res.json({ config: null, serverTime });
      }
    } catch (e: any) {
      console.error('[/api/app/tournament/config]', e.message);
      res.status(500).json({ error: 'Failed to load tournament config' });
    }
  });

  // ── Tournament: server-side points sync (ANTI-CHEAT) ──────────────────────
  // Called by the APK after each mining claim.
  // Reads mining_sessions directly — the client NEVER pushes point values.
  app.post('/api/app/tournament/sync-points/:pbId', async (req: Request, res: Response) => {
    const { pbId } = req.params;
    if (!pbId) return res.status(400).json({ error: 'pbId required' });
    try {
      const { syncUserTournamentPoints } = await import('./tournament');
      const points = await syncUserTournamentPoints(pbId);
      return res.json({ success: true, points });
    } catch (e: any) {
      console.error('[/api/app/tournament/sync-points]', e.message);
      res.status(500).json({ error: 'Sync failed' });
    }
  });

  // ─── Redeem Hit Tickets → credit the user's WALLET BALANCE (shib_balance) ───
  // Redemption tops up the active balance; it NEVER creates a withdrawal. The user
  // requests a withdrawal from their balance separately via the normal flow.
  app.post('/api/app/hub/redeem', async (req: Request, res: Response) => {
    const { pbId, tickets, token } = req.body ?? {};
    const n = Math.floor(Number(tickets));
    if (!pbId || !Number.isFinite(n)) {
      return res.status(400).json({ error: 'pbId and tickets are required' });
    }
    // Auth — this endpoint runs under the PB admin token, so it MUST verify the caller
    // itself: the supplied PB token has to belong to pbId or a user could redeem
    // another account's tickets. Mirrors the WS hub's verifyToken check.
    try {
      const authUser = await pbHttp('GET', `/api/collections/users/records/${pbId}`, null, token || '');
      if (!authUser?.id || authUser.id !== pbId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    } catch {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const user = await pbGet(`/api/collections/users/records/${pbId}?fields=id,hit_tickets`);
      if (!user?.id) return res.status(404).json({ error: 'User not found' });
      const currentTickets = Number(user.hit_tickets) || 0;
      const check = validateRedeem(n, currentTickets);
      if (!check.ok) return res.status(400).json({ error: check.error });
      const shib = ticketsToShib(n);
      // Single atomic PB write: debit Hit Tickets + credit the SHIB wallet balance together.
      const updated = await pbPatch(`/api/collections/users/records/${pbId}`, {
        'hit_tickets-': n,
        'shib_balance+': shib,
      });
      if (!updated?.id) return res.status(502).json({ error: 'Redemption failed' });
      // TOCTOU guard: if a concurrent redeem over-drew tickets below zero, reverse this
      // write so a stale-read double-redeem can never inflate shib_balance.
      if (Number(updated.hit_tickets) < 0) {
        await pbPatch(`/api/collections/users/records/${pbId}`, {
          'hit_tickets+': n,
          'shib_balance-': shib,
        }).catch(() => {});
        return res.status(409).json({ error: 'Redemption conflict, please retry' });
      }
      return res.json({ success: true, shib });
    } catch (e: any) {
      console.error('[/api/app/hub/redeem]', e?.message);
      return res.status(500).json({ error: 'Redemption failed' });
    }
  });

  return httpServer;
}

// ── Format user helper ─────────────────────────────────────────────────────
function formatUser(u: any) {
  return {
    pbId: u.id,
    firebaseUid: u.firebase_uid,
    email: u.email,
    displayName: u.display_name || u.name || "",
    referralCode: u.referral_code || "",
    referredBy: u.referred_by || "",
    referralEarnings: u.referral_earnings || 0,
    shibBalance: u.shib_balance || 0,
    powerTokens: u.power_tokens || 10,
    totalClaims: u.total_claims || 0,
    totalWins: u.total_wins || 0,
    is_verified: !!u.is_verified,
    isVerified: !!u.is_verified,
    activeBoosterMultiplier: u.active_booster_multiplier || 1,
    boosterExpires: u.booster_expires || "",
    fraudAttempts: u.fraud_attempts || 0,
    status: u.status || "",
    created: u.created,
    vipLevel: normalizeVipLevel(u.vip_level),
    isAdminPromoted: !!u.is_admin_promoted,
    adminPromotedLevel: normalizeVipLevel(u.admin_promoted_level),
    // KYC verification (server-managed)
    kycStatus: normalizeKycStatus(u.kyc_status),
    kycRejectReason: u.kyc_reject_reason || "",
    kycFullName: u.kyc_full_name || "",
    kycCountry: u.kyc_country || "",
    kycCountryCode: u.kyc_country_code || "",
    kycPhone: u.kyc_phone || "",
    kycBinanceEmail: u.kyc_binance_email || "",
    kycBep20Address: u.kyc_bep20_address || "",
  };
}
