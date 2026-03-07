import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import https from "node:https";
import http from "node:http";
import nodemailer from "nodemailer";

const PB_URL = "https://api.webcod.in";

// ─── Temp OTP storage (for new users) ─────────────────────────────────────────
const tempOtpMap = new Map<string, { code: string; expires: number }>();
// Tracks emails that passed OTP but haven't been synced to PB yet
const verifiedEmails = new Set<string>();

// ─── Mailer setup ────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail(to: string, code: string) {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await transporter.sendMail({
        from: `"Shiba Miner" <${process.env.SMTP_USER}>`,
        to,
        subject: "Verification Code",
        text: `Your verification code is: ${code}`,
        html: `<b>Your verification code is: ${code}</b>`,
      });
    } catch (e) {
      console.error("[OTP] Failed to send email via SMTP:", e);
      console.log(`[OTP] code for ${to}: ${code}`);
    }
  } else {
    console.log(`[OTP] code for ${to}: ${code}`);
  }
}

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
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
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

function generateReferralCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// ─── Routes ────────────────────────────────────────────────────────────────
export async function registerRoutes(app: Express): Promise<Server> {
  // Warm up admin token on startup
  getAdminToken().catch((e) => console.warn("[PB] Startup auth failed:", e));

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
        showAds: s.show_ads,
        activeAdNetwork: s.active_ad_network,
        admobUnitId: s.admob_unit_id,
        admobBannerUnitId: s.admob_banner_unit_id,
        applovinSdkKey: s.applovin_sdk_key,
        applovinRewardedId: s.applovin_rewarded_id,
        unityGameId: s.unity_game_id,
        unityRewardedId: s.unity_rewarded_id,
      });
    } catch (e: any) {
      console.error("[/api/app/settings]", e.message);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  // ── Auth sync ─────────────────────────────────────────────────────────────
  app.post("/api/app/auth/sync", async (req: Request, res: Response) => {
    try {
      const { firebaseUid, email, displayName, referralCode, referredBy } =
        req.body;
      if (!firebaseUid || !email)
        return res.status(400).json({ error: "firebaseUid and email required" });

      // Try to find existing user
      const existing = await pbGet(
        `/api/collections/users/records?filter=firebase_uid="${encodeURIComponent(firebaseUid)}"&perPage=1`,
      );
      if (existing.items?.[0]) {
        let u = existing.items[0];
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

      // Try to find user by email (handles manually created accounts with empty firebase_uid)
      const byEmail = await pbGet(
        `/api/collections/users/records?filter=email="${email}"&perPage=1`,
      );
      if (byEmail.items?.[0]) {
        let u = byEmail.items[0];
        const patches: any = {};
        if (!u.firebase_uid) patches.firebase_uid = firebaseUid;
        if (!u.referral_code) patches.referral_code = referralCode || generateReferralCode();
        if (!u.display_name && displayName) patches.display_name = displayName;
        if (!u.referred_by && referredBy) patches.referred_by = referredBy;
        if (Object.keys(patches).length > 0) {
          const updated = await pbPatch(`/api/collections/users/records/${u.id}`, patches);
          if (!updated.code) u = { ...u, ...patches };
        }
        return res.json(formatUser(u));
      }

      // Create PB user (using PB built-in auth)
      const code = referralCode || generateReferralCode();
      const pbPassword = `SHIB_${firebaseUid}_SECURE`;
      // Check if email was already OTP-verified (temp map flow for brand new users)
      const alreadyVerified = verifiedEmails.has(email);
      if (alreadyVerified) verifiedEmails.delete(email);
      const created = await pbPost("/api/collections/users/records", {
        email,
        password: pbPassword,
        passwordConfirm: pbPassword,
        emailVisibility: false,
        firebase_uid: firebaseUid,
        display_name: displayName || email.split("@")[0],
        referral_code: code,
        referred_by: referredBy || "",
        shib_balance: 0,
        power_tokens: 10,
        total_claims: 0,
        total_wins: 0,
        is_verified: alreadyVerified,
      });

      if (created.code) {
        return res.status(400).json({ error: created.message });
      }

      // If referred, give referrer a small welcome bonus
      if (referrerPbId) {
        pbGet(
          `/api/collections/users/records/${referrerPbId}`,
        ).then(async (referrer) => {
          if (referrer?.id) {
            await pbPatch(`/api/collections/users/records/${referrerPbId}`, {
              shib_balance: (referrer.shib_balance || 0) + 5,
            });
          }
        }).catch(() => { });
      }

      return res.json(formatUser(created));
    } catch (e: any) {
      console.error("[/api/app/auth/sync]", e.message);
      res.status(500).json({ error: "Sync failed" });
    }
  });

  // ── OTP: Send ─────────────────────────────────────────────────────────────
  app.post("/api/app/auth/send-otp", async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email required" });

      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = Date.now() + 10 * 60 * 1000;

      // Find user in PB
      const r = await pbGet(
        `/api/collections/users/records?filter=email="${email}"&perPage=1`,
      );
      const u = r.items?.[0];

      if (u) {
        const updated = await pbPatch(`/api/collections/users/records/${u.id}`, {
          otp_code: code,
          otp_expires: expires.toString(),
        });
        if (updated.code) return res.status(400).json({ error: updated.message });
      } else {
        // Temp storage for new users not yet synced
        tempOtpMap.set(email, { code, expires });
      }

      await sendEmail(email, code);
      res.json({ success: true, email });
    } catch (e: any) {
      console.error("[/api/app/auth/send-otp]", e.message);
      res.status(500).json({ error: "Failed to send OTP" });
    }
  });

  // ── OTP: Verify ──────────────────────────────────────────────────────────
  app.post("/api/app/auth/verify-otp", async (req: Request, res: Response) => {
    try {
      const { email, otp } = req.body;
      if (!email || !otp)
        return res.status(400).json({ error: "Email and OTP required" });

      let storedCode: string | undefined;
      let storedExpires: number | undefined;
      let pbUserId: string | undefined;

      // Check PB
      const r = await pbGet(
        `/api/collections/users/records?filter=email="${email}"&perPage=1`,
      );
      const u = r.items?.[0];

      if (u) {
        storedCode = u.otp_code;
        storedExpires = parseInt(u.otp_expires || "0");
        pbUserId = u.id;
      } else {
        // Check temp map
        const temp = tempOtpMap.get(email);
        if (temp) {
          storedCode = temp.code;
          storedExpires = temp.expires;
        }
      }

      if (!storedCode || !storedExpires || Date.now() > storedExpires) {
        return res.status(400).json({ error: "Invalid or expired code" });
      }

      if (storedCode !== otp) {
        return res.status(400).json({ error: "Invalid or expired code" });
      }

      // Valid OTP
      if (pbUserId) {
        await pbPatch(`/api/collections/users/records/${pbUserId}`, {
          is_verified: true,
          otp_code: "",
        });
      }
      // Track verified status for new users not yet in PB
      // syncUser will pick this up and create the user with is_verified: true
      if (!pbUserId) {
        verifiedEmails.add(email);
      }
      tempOtpMap.delete(email);

      res.json({ success: true });
    } catch (e: any) {
      console.error("[/api/app/auth/verify-otp]", e.message);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  // ── Get user by Firebase UID ──────────────────────────────────────────────
  app.get("/api/app/user/:firebaseUid", async (req: Request, res: Response) => {
    try {
      const firebaseUid = String(req.params.firebaseUid);
      const r = await pbGet(
        `/api/collections/users/records?filter=firebase_uid="${encodeURIComponent(firebaseUid)}"&perPage=1`,
      );
      let u = r.items?.[0];
      if (!u) return res.status(404).json({ error: "User not found" });

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
        const { shibBalance, powerTokens } = req.body;
        const update: any = {};
        if (shibBalance !== undefined) update.shib_balance = shibBalance;
        if (powerTokens !== undefined) update.power_tokens = powerTokens;
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

      // Check for existing active booster
      if (user.booster_expires) {
        const expires = parseInt(user.booster_expires);
        if (expires > Date.now()) {
          return res.status(400).json({ error: "A booster is already active" });
        }
      }

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

  // ── Mining: Start ─────────────────────────────────────────────────────────
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
      const expectedReward = rate * dur * 60 * activeMultiplier;

      const session = await pbPost("/api/collections/mining_sessions/records", {
        user: pbId,
        start_time: new Date().toISOString().replace("T", " ").replace("Z", ""),
        claimed_amount: 0,
        is_verified: false,
        ip_address: String(req.ip || req.socket?.remoteAddress || ""),
        booster_multiplier: activeMultiplier,
      });

      if (session.code)
        return res.status(400).json({ error: session.message });

      res.json({
        id: session.id,
        pbId,
        startTime: session.start_time,
        durationMs: dur * 60 * 1000,
        multiplier: activeMultiplier,
        expectedReward,
        miningRatePerSec: rate,
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
        const r = await pbGet(
          `/api/collections/mining_sessions/records?filter=user="${pbId}" && claimed_amount=0&sort=-start_time&perPage=1`,
        );
        const s = r.items?.[0];
        if (!s) return res.json({ session: null });

        const settings = await fetchSettings();
        const dur = (settings?.mining_duration_minutes || 60) * 60 * 1000;
        const startTime = new Date(s.start_time.replace(" ", "T") + "Z").getTime();
        const elapsed = Date.now() - startTime;
        const status = elapsed >= dur ? "ready_to_claim" : "mining";

        res.json({
          session: {
            id: s.id,
            startTime: s.start_time,
            durationMs: dur,
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
  app.post("/api/app/mine/claim", async (req: Request, res: Response) => {
    try {
      const { sessionId, pbId, reward } = req.body;
      if (!sessionId || !pbId || reward === undefined)
        return res.status(400).json({ error: "sessionId, pbId, reward required" });

      // Fetch session and settings
      const [session, settings] = await Promise.all([
        pbGet(`/api/collections/mining_sessions/records/${sessionId}`),
        fetchSettings(),
      ]);

      if (session.code) return res.status(404).json({ error: "Session not found" });
      if (!settings) return res.status(503).json({ error: "Settings unavailable" });

      // Server-side reward calculation
      const boosterMultiplier = session.booster_multiplier || 1;
      const miningRate = settings.mining_rate_per_sec || 0.01736;
      const durationSec = (settings.mining_duration_minutes || 60) * 60;
      const serverReward = miningRate * durationSec * boosterMultiplier;

      // Verify within 5% tolerance
      const diff = Math.abs(serverReward - reward);
      const tolerance = serverReward * 0.05;
      if (diff > tolerance) {
        return res.status(400).json({ error: "Claim verification failed" });
      }

      // Mark session claimed
      await pbPatch(`/api/collections/mining_sessions/records/${sessionId}`, {
        claimed_amount: serverReward,
        is_verified: true,
      });

      // Fetch user, update balance
      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code)
        return res.status(404).json({ error: "User not found" });

      const newShib = (user.shib_balance || 0) + serverReward;
      const newClaims = (user.total_claims || 0) + 1;
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        shib_balance: newShib,
        total_claims: newClaims,
      });

      // 10% referral commission
      if (user.referred_by) {
        pbGet(
          `/api/collections/users/records?filter=referral_code="${encodeURIComponent(user.referred_by)}"&perPage=1`,
        ).then(async (refRes) => {
          const referrer = refRes.items?.[0];
          if (referrer) {
            const commission = Math.round(serverReward * 0.1);
            await pbPatch(`/api/collections/users/records/${referrer.id}`, {
              shib_balance: (referrer.shib_balance || 0) + commission,
            });
          }
        }).catch(() => { });
      }

      res.json({ success: true, newShibBalance: newShib, reward: serverReward });
    } catch (e: any) {
      console.error("[/api/app/mine/claim]", e.message);
      res.status(500).json({ error: "Failed to claim reward" });
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
          `/api/collections/withdrawals/records?filter=user="${pbId}" && status="completed"&perPage=200`,
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

  // ── Withdrawal: Create ────────────────────────────────────────────────────
  app.post("/api/app/withdrawals", async (req: Request, res: Response) => {
    try {
      const { pbId, method, addressOrEmail, amount } = req.body;
      if (!pbId || !method || !addressOrEmail || !amount)
        return res.status(400).json({ error: "pbId, method, addressOrEmail, amount required" });

      // Verify user has sufficient balance
      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      if ((user.shib_balance || 0) < amount)
        return res.status(400).json({ error: "Insufficient balance" });

      // Get withdrawal tier minimum
      const tierRes = await pbGet(
        `/api/collections/withdrawals/records?filter=user="${pbId}" && status="completed"&perPage=200`,
      );
      const settings = await fetchSettings();
      const count = tierRes.totalItems || 0;
      let minAmount: number;
      if (count === 0) minAmount = settings?.min_withdrawal_1 || 100;
      else if (count === 1) minAmount = settings?.min_withdrawal_2 || 1000;
      else minAmount = settings?.min_withdrawal_3 || 8000;

      if (amount < minAmount)
        return res.status(400).json({ error: `Minimum withdrawal is ${minAmount} SHIB` });

      // Deduct from balance
      await pbPatch(`/api/collections/users/records/${pbId}`, {
        shib_balance: user.shib_balance - amount,
      });

      // Create withdrawal record
      const withdrawal = await pbPost(
        "/api/collections/withdrawals/records",
        {
          user: pbId,
          method,
          address_or_email: addressOrEmail,
          amount,
          status: "pending",
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
        const { status } = req.body;
        if (!["pending", "completed", "rejected"].includes(status))
          return res.status(400).json({ error: "Invalid status" });

        const updated = await pbPatch(
          `/api/collections/withdrawals/records/${id}`,
          { status },
        );

        // If rejected, refund the amount
        if (status === "rejected") {
          const withdrawal = updated;
          const user = await pbGet(
            `/api/collections/users/records/${withdrawal.user}`,
          );
          if (user && !user.code) {
            await pbPatch(`/api/collections/users/records/${withdrawal.user}`, {
              shib_balance: (user.shib_balance || 0) + withdrawal.amount,
            });
          }
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
        if (body.showAds !== undefined) pbUpdate.show_ads = body.showAds;
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

  // ── Game: Add power tokens ────────────────────────────────────────────────
  app.post("/api/app/game/reward", async (req: Request, res: Response) => {
    try {
      const { pbId, amount, type } = req.body;
      if (!pbId || !amount)
        return res.status(400).json({ error: "pbId and amount required" });

      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      const newPT = (user.power_tokens || 0) + amount;
      const newWins =
        type === "game_win"
          ? (user.total_wins || 0) + 1
          : user.total_wins || 0;

      await pbPatch(`/api/collections/users/records/${pbId}`, {
        power_tokens: newPT,
        total_wins: newWins,
      });

      res.json({ success: true, newPowerTokens: newPT });
    } catch (e: any) {
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

  const httpServer = createServer(app);
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
    shibBalance: u.shib_balance || 0,
    powerTokens: u.power_tokens || 10,
    totalClaims: u.total_claims || 0,
    totalWins: u.total_wins || 0,
    is_verified: !!u.is_verified,
    isVerified: !!u.is_verified,
    activeBoosterMultiplier: u.active_booster_multiplier || 1,
    boosterExpires: u.booster_expires || "",
    created: u.created,
  };
}
