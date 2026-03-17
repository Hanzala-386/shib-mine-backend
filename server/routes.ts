import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";

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
async function pbDelete(path: string) {
  const token = await getAdminToken();
  return pbHttp("DELETE", path, null, token);
}

// ─── Send OTP email via PocketBase's own mailer ────────────────────────────
// Strategy: temporarily patch PB's verification template with the OTP content,
// call /api/settings/test/email (which uses PB's configured Brevo SMTP),
// then restore the original template. This bypasses all Nodemailer/SMTP auth
// issues since PocketBase handles the Brevo connection internally.

let otpEmailLock = false; // simple mutex — only one OTP email send at a time

async function sendOtpEmail(to: string, otp: string) {
  // Wait if another OTP send is in progress (up to 15s)
  const deadline = Date.now() + 15_000;
  while (otpEmailLock && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }
  otpEmailLock = true;

  const token = await getAdminToken();

  // 1. Read current PB settings to save original verification template
  const currentSettings = await pbHttp("GET", "/api/settings", null, token);
  const originalTemplate = currentSettings?.meta?.verificationTemplate ?? {};

  try {
    // 2. Patch verification template with OTP content
    const otpBody = `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#1a1a1a;color:#fff;padding:32px;border-radius:12px;">
  <h2 style="color:#FF6B00;margin:0 0 8px;">SHIB Mine</h2>
  <p style="color:#ccc;margin:0 0 24px;">You requested to delete your account. Enter the code below to confirm.</p>
  <div style="background:#2a2a2a;border-radius:10px;padding:24px;text-align:center;margin-bottom:24px;">
    <p style="color:#aaa;font-size:13px;margin:0 0 8px;text-transform:uppercase;letter-spacing:2px;">Your 6-Digit OTP</p>
    <h1 style="color:#FFD700;font-size:42px;letter-spacing:14px;margin:0;">${otp}</h1>
  </div>
  <p style="color:#888;font-size:13px;margin:0;">This code expires in <strong style="color:#fff;">5 minutes</strong>. If you didn't request this, you can safely ignore this email.</p>
  <hr style="border:none;border-top:1px solid #333;margin:24px 0;"/>
  <p style="color:#666;font-size:12px;margin:0;">SHIB Mine &bull; support@shibahit.com</p>
</div>`;

    await pbHttp("PATCH", "/api/settings", {
      meta: {
        ...currentSettings.meta,
        verificationTemplate: {
          ...originalTemplate,
          subject: "Your SHIB Mine Account Deletion OTP",
          body: otpBody,
          actionUrl: "",
        },
      },
    }, token);

    // 3. Trigger PocketBase to send the email using its own configured SMTP
    const sendResult = await pbHttp("POST", "/api/settings/test/email", {
      template: "verification",
      email: to,
    }, token);

    if (sendResult && sendResult.status >= 400) {
      throw new Error(sendResult.message || "PocketBase failed to send email");
    }

    console.log(`[OTP] Email sent to ${to} via PocketBase mailer`);
  } finally {
    // 4. Always restore the original template
    try {
      await pbHttp("PATCH", "/api/settings", {
        meta: {
          ...currentSettings.meta,
          verificationTemplate: originalTemplate,
        },
      }, token);
    } catch (restoreErr: any) {
      console.warn("[OTP] Failed to restore PB verification template:", restoreErr.message);
    }
    otpEmailLock = false;
  }
}

// ─── Ensure otp_codes collection exists in PocketBase ─────────────────────
async function ensureOtpCollection() {
  try {
    const check = await pbGet("/api/collections/otp_codes");
    if (!check.code) return; // already exists
    const token = await getAdminToken();
    await pbHttp("POST", "/api/collections", {
      name: "otp_codes",
      type: "base",
      fields: [
        { name: "user",       type: "relation", required: true, collectionId: "", options: { collectionId: "users", cascadeDelete: false, maxSelect: 1 } },
        { name: "code",       type: "text",     required: true },
        { name: "expires_at", type: "date",     required: true },
      ],
    }, token);
    console.log("[otp_codes] Collection created in PocketBase");
  } catch (e: any) {
    console.warn("[otp_codes] Could not auto-create collection:", e.message,
      "\n→ Please create it manually in PocketBase admin with fields: user (relation→users), code (text), expires_at (date)");
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

function generateReferralCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// ─── Ensure PB schema has referral_earnings field ──────────────────────────
async function ensureReferralEarningsField() {
  try {
    const token = await getAdminToken();
    const colls = await pbHttp("GET", "/api/collections?perPage=200", null, token);
    const usersCol = (colls.items || []).find((c: any) => c.name === "users");
    if (!usersCol) return;
    const hasField = (usersCol.schema || []).some((f: any) => f.name === "referral_earnings");
    if (hasField) return;
    await pbHttp("PATCH", `/api/collections/${usersCol.id}`, {
      schema: [
        ...(usersCol.schema || []),
        { name: "referral_earnings", type: "number", required: false },
      ],
    }, token);
    console.log("[PB] Added referral_earnings field to users collection");
  } catch (e: any) {
    console.warn("[PB] Schema update skipped:", e.message);
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────
export async function registerRoutes(app: Express): Promise<Server> {
  // Warm up admin token, ensure PB schema on startup
  getAdminToken()
    .then(() => ensureReferralEarningsField())
    .then(() => ensureOtpCollection())
    .catch((e) => console.warn("[PB] Startup init failed:", e));

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

      // Send email via Brevo SMTP
      await sendOtpEmail(email, otp);

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
        showAds: s.show_ads,
        activeAdNetwork: s.active_ad_network,
        admobUnitId: s.admob_unit_id,
        admobBannerUnitId: s.admob_banner_unit_id,
        admobRewardedId: s.admob_rewarded_id,
        applovinSdkKey: s.applovin_sdk_key,
        applovinRewardedId: s.applovin_rewarded_id,
        unityGameId: s.unity_game_id,
        unityRewardedId: s.unity_rewarded_id,
        unityInterstitialId: s.unity_interstitial_id,
        applovinBannerId: s.applovin_banner_id,
        applovinInterstitialId: s.applovin_interstitial_id,
        appStoreLink: s.app_store_link || '',
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
      const user = await pbGet(`/api/collections/users/records/${pbId}?fields=id,referral_earnings`);
      if (user.code) return res.status(404).json({ error: "User not found" });

      const referred = await pbGet(
        `/api/collections/users/records?filter=referred_by="${pbId}"&perPage=1&fields=id`,
      );
      res.json({
        referredCount: referred.totalItems || 0,
        totalEarnings: user.referral_earnings || 0,
      });
    } catch (e: any) {
      console.error("[/api/app/user/referral-stats]", e.message);
      res.status(500).json({ error: "Failed to fetch referral stats" });
    }
  });

  // ── Delete Account (GDPR / compliance) ────────────────────────────────────
  app.delete("/api/app/user/:pbId/delete-account", async (req: Request, res: Response) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "Missing pbId" });

      // Verify user exists first
      const user = await pbGet(`/api/collections/users/records/${pbId}?fields=id`);
      if (user.code) return res.status(404).json({ error: "User not found" });

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
        shib_balance: 100,   // welcome bonus: 100 SHIB
        power_tokens: 500,   // welcome bonus: 500 Power Tokens
        total_claims: 0,
        total_wins: 0,
        is_verified: false,
      });

      if (created.code) {
        return res.status(400).json({ error: created.message });
      }

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

  // ── Firebase Email Verification: Confirm Verified ────────────────────────
  // Called after Firebase emailVerified = true.
  // Finds or creates the PB user and marks is_verified: true.
  app.post("/api/app/auth/confirm-verified", async (req: Request, res: Response) => {
    try {
      const { firebaseUid, email, displayName, referralCode, referredBy } = req.body;
      if (!firebaseUid || !email)
        return res.status(400).json({ error: "firebaseUid and email required" });

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

      // Try to find by email
      const byEmail = await pbGet(
        `/api/collections/users/records?filter=email="${email}"&perPage=1`,
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
        shib_balance: 100,   // welcome bonus: 100 SHIB
        power_tokens: 500,   // welcome bonus: 500 Power Tokens
        total_claims: 0,
        total_wins: 0,
        is_verified: true,
      });

      if (created.code) return res.status(400).json({ error: created.message });

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
        booster_expiry: expiresAt,
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
        booster_expiry: boosterExpiresAt,
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
      const expectedReward = rate * dur * 60 * multiplier;

      const session = await pbPost("/api/collections/mining_sessions/records", {
        user: pbId,
        start_time: new Date().toISOString().replace("T", " ").replace("Z", ""),
        claimed_amount: 0,
        is_verified: false,
        ip_address: String(req.ip || req.socket?.remoteAddress || ""),
        booster_multiplier: multiplier,
      });

      if (session.code)
        return res.status(400).json({ error: session.message });

      const durationMs = dur * 60 * 1000;
      const rawStart = (session.start_time || "").replace(" ", "T");
      const parsedStart = rawStart.endsWith("Z") ? rawStart : rawStart + "Z";
      const startTimeMs = new Date(parsedStart).getTime();
      const endTimeMs = startTimeMs + durationMs;

      res.json({
        id: session.id,
        pbId,
        startTimeMs,
        endTimeMs,
        durationMs,
        multiplier,
        expectedReward,
        miningRatePerSec: rate,
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

        const expires = user.booster_expiry ? parseInt(user.booster_expiry) : 0;
        if (expires > Date.now()) {
          return res.json({
            multiplier: user.active_booster_multiplier || 1,
            expiresAt: user.booster_expiry,
          });
        }

        // Auto-clear expired booster fields if they were set
        if (user.active_booster_multiplier !== 1 || user.booster_expiry) {
          await pbPatch(`/api/collections/users/records/${pbId}`, {
            active_booster_multiplier: 1,
            booster_expiry: "",
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
      if (userRecord.booster_expiry) {
        const expires = parseInt(userRecord.booster_expiry);
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

      const durationMs = dur * 60 * 1000;
      // Parse start_time stored by this server (no-T, no-Z format)
      const rawStart = (session.start_time || "").replace(" ", "T");
      const parsedStart = rawStart.endsWith("Z") ? rawStart : rawStart + "Z";
      const startTimeMs = new Date(parsedStart).getTime();
      const endTimeMs = startTimeMs + durationMs;

      res.json({
        id: session.id,
        pbId,
        startTime: session.start_time,
        startTimeMs,   // explicit Unix-ms — no client-side string parsing needed
        endTimeMs,     // explicit deadline — remaining = endTimeMs - Date.now()
        durationMs,
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
          `/api/collections/mining_sessions/records?filter=${encodeURIComponent(`user="${pbId}" && claimed_amount=0`)}&sort=-start_time&perPage=1`,
        );
        const s = r.items?.[0];
        if (!s) return res.json({ session: null });

        const settings = await fetchSettings();
        const dur = (settings?.mining_duration_minutes || 60) * 60 * 1000;

        // Robust start_time parsing — handle both "2024-03-13 10:30:00.123" and "2024-03-13T10:30:00.123Z"
        const rawStart = (s.start_time || "").replace(" ", "T");
        const parsedStart = rawStart.endsWith("Z") ? rawStart : rawStart + "Z";
        const startTimeMs = new Date(parsedStart).getTime();
        const endTimeMs = startTimeMs + dur;
        const elapsed = Date.now() - startTimeMs;
        const status = elapsed >= dur ? "ready_to_claim" : "mining";

        res.json({
          session: {
            id: s.id,
            startTime: s.start_time,   // kept for legacy compatibility
            startTimeMs,               // explicit Unix-ms start timestamp
            endTimeMs,                 // explicit Unix-ms deadline: remaining = endTimeMs - Date.now()
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
  // 100% server-authoritative. Client sends only sessionId + pbId.
  // Server validates: session ownership, not-yet-claimed, time elapsed.
  // Reward is calculated exclusively server-side — no client input trusted.
  app.post("/api/app/mine/claim", async (req: Request, res: Response) => {
    try {
      const { sessionId, pbId } = req.body;
      if (!sessionId || !pbId)
        return res.status(400).json({ error: "sessionId and pbId required" });

      // Fetch session and settings in parallel
      const [session, settings] = await Promise.all([
        pbGet(`/api/collections/mining_sessions/records/${sessionId}`),
        fetchSettings(),
      ]);

      if (session.code) return res.status(404).json({ error: "Session not found" });
      if (!settings) return res.status(503).json({ error: "Settings unavailable" });

      // Guard 1: session must belong to this user
      if (session.user !== pbId) {
        return res.status(403).json({ error: "Session does not belong to this user" });
      }

      // Guard 2: one session = one claim only
      if (session.claimed_amount && session.claimed_amount > 0) {
        return res.status(409).json({ error: "Session already claimed" });
      }

      // Guard 3: mining time must have actually elapsed
      const startMs = new Date(session.start_time.replace(" ", "T") + "Z").getTime();
      const durationSec = (settings.mining_duration_minutes || 60) * 60;
      const elapsed = Date.now() - startMs;
      if (elapsed < durationSec * 1000) {
        return res.status(400).json({ error: "Mining session not complete yet" });
      }

      // Server-side reward — 100% authoritative, no client value accepted
      const boosterMultiplier = session.booster_multiplier || 1;
      const miningRate = settings.mining_rate_per_sec || 0.01736;
      const serverReward = miningRate * durationSec * boosterMultiplier;

      // Mark session claimed FIRST — any duplicate request now hits Guard 2
      const claimPatch = await pbPatch(`/api/collections/mining_sessions/records/${sessionId}`, {
        claimed_amount: serverReward,
        is_verified: true,
      });
      if (claimPatch.code) {
        return res.status(500).json({ error: "Failed to mark session as claimed" });
      }

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

      // 10% referral commission — try direct PB ID first (new format), fallback to code (old format)
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
              await pbPatch(`/api/collections/users/records/${referrer.id}`, {
                shib_balance: (referrer.shib_balance || 0) + commission,
                referral_earnings: (referrer.referral_earnings || 0) + commission,
              });
            }
          } catch (_) {}
        })();
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

  // ── Leaderboard: Top 100 by shib_balance ─────────────────────────────────
  app.get("/api/app/leaderboard", async (_req: Request, res: Response) => {
    try {
      const r = await pbGet(
        `/api/collections/users/records?sort=-shib_balance&perPage=100&fields=id,display_name,shib_balance`,
      );
      res.json(
        (r.items || []).map((u: any, i: number) => ({
          rank: i + 1,
          id: u.id,
          displayName: u.display_name || "Anonymous",
          shibBalance: u.shib_balance || 0,
        })),
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
      res.json({
        rank,
        id: user.id,
        displayName: user.display_name || "You",
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
        `/api/collections/withdrawals/records?filter=${encodeURIComponent(`status="completed"`)}&sort=-created&perPage=10&expand=user`,
      );
      res.json(
        (r.items || []).map((w: any) => {
          const rawName: string = w.expand?.user?.display_name || "User";
          const visibleLen = Math.min(5, Math.max(1, rawName.length - 2));
          const maskedName = rawName.slice(0, visibleLen) + "***";
          return {
            id: w.id,
            maskedName,
            method: w.method,
            amount: w.amount,
          };
        }),
      );
    } catch (e: any) {
      console.error("[/api/app/withdrawals/approved/recent]", e.message);
      res.status(500).json({ error: "Failed to fetch recent withdrawals" });
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
        if (body.unityInterstitialId !== undefined)
          pbUpdate.unity_interstitial_id = body.unityInterstitialId;
        if (body.applovinBannerId !== undefined)
          pbUpdate.applovin_banner_id = body.applovinBannerId;
        if (body.applovinInterstitialId !== undefined)
          pbUpdate.applovin_interstitial_id = body.applovinInterstitialId;
        if (body.appStoreLink !== undefined)
          pbUpdate.app_store_link = body.appStoreLink;

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

  // ── Game: Add power tokens ────────────────────────────────────────────────
  app.post("/api/app/game/reward", async (req: Request, res: Response) => {
    try {
      const { pbId, amount, type } = req.body;
      if (!pbId || !amount)
        return res.status(400).json({ error: "pbId and amount required" });

      // Cap incoming amount to prevent inflated rewards from client tampering.
      // ABSOLUTE_MAX_SCORE * 2 covers the double-reward (2×) ad scenario.
      const safeAmount = Math.min(
        Math.max(0, Math.round(Number(amount) || 0)),
        ABSOLUTE_MAX_SCORE * 2
      );
      if (safeAmount !== Number(amount)) {
        console.warn(`[/api/app/game/reward] Amount capped: ${amount} → ${safeAmount}`);
      }

      const user = await pbGet(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });

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
      console.log(`[/api/app/game/reward] pbId=${pbId} +${safeAmount}PT → newPT=${newPT} totalScore=${newTotal}`);

      // 10% referral commission on game earnings
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
              const commission = Math.round(safeAmount * 0.1);
              if (commission > 0) {
                await pbPatch(`/api/collections/users/records/${referrer.id}`, {
                  power_tokens: (referrer.power_tokens || 0) + commission,
                  referral_earnings: (referrer.referral_earnings || 0) + commission,
                });
              }
            }
          } catch (_) {}
        })();
      }

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
    referralEarnings: u.referral_earnings || 0,
    shibBalance: u.shib_balance || 0,
    powerTokens: u.power_tokens || 10,
    totalClaims: u.total_claims || 0,
    totalWins: u.total_wins || 0,
    is_verified: !!u.is_verified,
    isVerified: !!u.is_verified,
    activeBoosterMultiplier: u.active_booster_multiplier || 1,
    boosterExpires: u.booster_expiry || "",
    created: u.created,
  };
}
