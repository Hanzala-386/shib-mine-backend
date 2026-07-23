var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// server/tournament.ts
var tournament_exports = {};
__export(tournament_exports, {
  runEndOfCycle: () => runEndOfCycle,
  setupTournamentSchema: () => setupTournamentSchema,
  startTournamentCron: () => startTournamentCron,
  syncUserTournamentPoints: () => syncUserTournamentPoints
});
import https from "node:https";
import http from "node:http";
function pbHttp(method, path2, body, token) {
  return new Promise((resolve2, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = token;
    if (data) headers["Content-Length"] = String(Buffer.byteLength(data));
    const url = new URL(path2, PB_URL);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers
      },
      (res) => {
        let b = "";
        res.on("data", (d) => b += d);
        res.on("end", () => {
          try {
            resolve2(JSON.parse(b));
          } catch {
            resolve2({ raw: b });
          }
        });
      }
    );
    req.setTimeout(3e4, () => req.destroy(new Error("PB timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
async function getAdminToken() {
  if (_adminToken && Date.now() < _tokenExpiry) return _adminToken;
  const res = await pbHttp("POST", "/api/admins/auth-with-password", {
    identity: process.env.PB_ADMIN_EMAIL,
    password: process.env.PB_ADMIN_PASSWORD
  });
  if (!res.token) throw new Error(`PB admin auth failed: ${JSON.stringify(res)}`);
  _adminToken = res.token;
  _tokenExpiry = Date.now() + 23 * 60 * 60 * 1e3;
  return _adminToken;
}
async function pbGet(path2) {
  return pbHttp("GET", path2, null, await getAdminToken());
}
async function pbPost(path2, body) {
  return pbHttp("POST", path2, body, await getAdminToken());
}
async function pbPatch(path2, body) {
  return pbHttp("PATCH", path2, body, await getAdminToken());
}
async function pbDelete(path2) {
  return pbHttp("DELETE", path2, null, await getAdminToken());
}
function generateCycleId() {
  return `cyc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function cycleKeyOf(cfg) {
  if (cfg?.cycle_id) return String(cfg.cycle_id);
  const iso = cfg?.start_time || cfg?.week_start;
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : `legacy_${d.toISOString().slice(0, 10)}`;
}
async function wipeAllParticipants() {
  const ids = [];
  let page = 1;
  while (true) {
    const batch = await pbGet(`/api/collections/tournament_participants/records?perPage=200&page=${page}&fields=id`).catch(() => null);
    const items = batch?.items ?? [];
    if (!items.length) break;
    for (const r of items) ids.push(r.id);
    if (items.length < 200) break;
    page++;
  }
  for (const id of ids) {
    await pbDelete(`/api/collections/tournament_participants/records/${id}`).catch(() => {
    });
  }
  return ids.length;
}
async function anyParticipantsExist() {
  const batch = await pbGet("/api/collections/tournament_participants/records?perPage=1&fields=id").catch(() => null);
  return (batch?.items?.length ?? 0) > 0;
}
async function ensureField(collectionName, fieldName, fieldDef) {
  try {
    const col = await pbGet(`/api/collections/${collectionName}`);
    if (!col?.id) return;
    if ((col.schema || []).some((f) => f.name === fieldName)) {
      console.log(`[tournament] ${collectionName}.${fieldName} \u2713`);
      return;
    }
    await pbPatch(`/api/collections/${col.id}`, { schema: [...col.schema || [], { name: fieldName, ...fieldDef }] });
    console.log(`[tournament] Added ${collectionName}.${fieldName} \u2713`);
  } catch (e) {
    console.warn(`[tournament] ensureField ${collectionName}.${fieldName}:`, e.message);
  }
}
async function ensureCollection(name, schema, rules = {}) {
  try {
    const existing = await pbGet(`/api/collections/${name}`);
    if (existing?.id) {
      console.log(`[tournament] ${name} \u2713`);
      return existing.id;
    }
  } catch {
  }
  try {
    const res = await pbPost("/api/collections", { name, type: "base", schema, listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null, ...rules });
    console.log(`[tournament] Created ${name} \u2713`);
    return res?.id ?? null;
  } catch (e) {
    console.warn(`[tournament] ensureCollection ${name}:`, e.message);
    return null;
  }
}
async function setupTournamentSchema() {
  try {
    const userTextOpt = { type: "text", required: false, options: { min: null, max: null, pattern: "" } };
    const userNumOpt = { type: "number", required: false, options: { min: null, max: null } };
    const userBoolOpt = { type: "bool", required: false, options: {} };
    const fileOpts = { type: "file", required: false, options: { maxSelect: 1, maxSize: 5242880, mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"], thumbs: ["100x100"], protected: false } };
    await ensureField("users", "tournament_joined", userBoolOpt);
    await ensureField("users", "weekly_tournament_points", userNumOpt);
    await ensureField("users", "avatar", fileOpts);
    await ensureField("users", "avatar2", fileOpts);
    await ensureField("users", "daily_streak", userNumOpt);
    await ensureField("users", "last_daily_claim", userTextOpt);
    for (const f of ["daily_reward_day1_shib", "daily_reward_day2_pt", "daily_reward_day3_shib", "daily_reward_day4_pt", "daily_reward_day5_shib", "daily_reward_day6_pt", "daily_reward_day7_shib", "daily_reward_day7_pt"]) {
      await ensureField("settings", f, userNumOpt);
    }
    const tcExisting = await pbGet("/api/collections/tournament_config").catch(() => null);
    if (!tcExisting?.id) {
      await pbPost("/api/collections", {
        name: "tournament_config",
        type: "base",
        schema: [
          { name: "prize_pool_total", type: "number", required: false, options: { min: null, max: null } },
          { name: "winners_count", type: "number", required: false, options: { min: null, max: null } },
          { name: "reward_structure", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "banner", type: "file", required: false, options: { maxSelect: 1, maxSize: 10485760, mimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"], thumbs: [], protected: false } },
          { name: "banner_url", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "week_start", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "start_time", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "end_time", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "is_active", type: "bool", required: false, options: {} },
          { name: "payout_finalized_bucket", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "cycle_id", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "payout_finalized_cycle", type: "text", required: false, options: { min: null, max: null, pattern: "" } }
        ],
        listRule: "",
        viewRule: "",
        createRule: null,
        updateRule: null,
        deleteRule: null
      });
      console.log("[tournament] tournament_config created (no auto-seed \u2014 manual cycles) \u2713");
    } else {
      await ensureField("tournament_config", "start_time", userTextOpt);
      await ensureField("tournament_config", "end_time", userTextOpt);
      await ensureField("tournament_config", "banner", { type: "file", required: false, options: { maxSelect: 1, maxSize: 10485760, mimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"], thumbs: [], protected: false } });
      await ensureField("tournament_config", "payout_finalized_bucket", userTextOpt);
      await ensureField("tournament_config", "cycle_id", userTextOpt);
      await ensureField("tournament_config", "payout_finalized_cycle", userTextOpt);
    }
    const tpExisting = await pbGet("/api/collections/tournament_participants").catch(() => null);
    if (!tpExisting?.id) {
      await pbPost("/api/collections", {
        name: "tournament_participants",
        type: "base",
        schema: [
          { name: "user_id", type: "text", required: true, options: { min: null, max: null, pattern: "" } },
          { name: "display_name", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "week_start", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "cycle_id", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "joined_at", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "points", type: "number", required: false, options: { min: null, max: null } },
          { name: "registered_during_intermission", type: "bool", required: false, options: {} }
        ],
        // points is NON-AUTHORITATIVE (leaderboard + winners read users.weekly_tournament_points).
        // Self-update lets a client mirror its OWN points into this cosmetic row.
        listRule: "",
        viewRule: "",
        createRule: '@request.auth.id != ""',
        updateRule: "user_id = @request.auth.id",
        deleteRule: null
      });
      console.log("[tournament] tournament_participants created \u2713");
    } else {
      await ensureField("tournament_participants", "registered_during_intermission", userBoolOpt);
      await ensureField("tournament_participants", "cycle_id", userTextOpt);
      try {
        await pbPatch(`/api/collections/${tpExisting.id}`, { updateRule: "user_id = @request.auth.id" });
        console.log("[tournament] tournament_participants.updateRule \u2192 self-update \u2713");
      } catch (e) {
        console.warn("[tournament] could not patch tournament_participants.updateRule:", e?.message);
      }
    }
    await ensureCollection("tournament_history", [
      { name: "week_end", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
      { name: "rank", type: "number", required: false, options: { min: null, max: null } },
      { name: "user_id", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
      { name: "display_name", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
      { name: "points", type: "number", required: false, options: { min: null, max: null } },
      { name: "prize", type: "number", required: false, options: { min: null, max: null } }
    ]);
    await ensureDailyClaimSettingsCollection();
    await ensureDailyClaimsCollection();
    await ensureAppConfigCollection();
    await ensureAnnouncementsCollection();
    console.log("[tournament] setupTournamentSchema complete \u2713");
  } catch (e) {
    console.warn("[tournament] setupTournamentSchema error:", e.message);
  }
}
async function ensureAppConfigCollection() {
  try {
    const existing = await pbGet("/api/collections/app_config").catch(() => null);
    if (!existing?.id) {
      await pbPost("/api/collections", {
        name: "app_config",
        type: "base",
        schema: [
          { name: "current_version", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "min_required_version", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "play_store_url", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "update_message", type: "text", required: false, options: { min: null, max: null, pattern: "" } }
        ],
        listRule: "",
        viewRule: "",
        createRule: null,
        updateRule: null,
        deleteRule: null
      });
      console.log("[app_config] Created app_config \u2713");
    } else {
      console.log("[app_config] app_config \u2713");
    }
    const recs = await pbGet("/api/collections/app_config/records?perPage=1");
    if (!recs?.items?.length) {
      await pbPost("/api/collections/app_config/records", {
        current_version: "1.0.2",
        min_required_version: "1.0.1",
        // SAFE: matches the live build so nobody is locked out
        play_store_url: "https://play.google.com/store/apps/details?id=com.hanzalasha.shibmine",
        update_message: "A critical new update is available. Please update to continue playing!"
      });
      console.log("[app_config] Seeded app_config row (min_required_version=1.0.1) \u2713");
    }
  } catch (e) {
    console.warn("[app_config] ensureAppConfigCollection:", e.message);
  }
}
async function ensureAnnouncementsCollection() {
  try {
    const existing = await pbGet("/api/collections/announcements").catch(() => null);
    if (!existing?.id) {
      await pbPost("/api/collections", {
        name: "announcements",
        type: "base",
        schema: [
          { name: "poster_image", type: "file", required: false, options: { maxSelect: 1, maxSize: 10485760, mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"], thumbs: [], protected: false } },
          { name: "redirect_url", type: "text", required: false, options: { min: null, max: null, pattern: "" } },
          { name: "frequency_limit", type: "number", required: false, options: { min: 0, max: null } },
          { name: "is_active", type: "bool", required: false }
        ],
        listRule: "",
        viewRule: "",
        createRule: null,
        updateRule: null,
        deleteRule: null
      });
      console.log("[announcements] Created announcements \u2713");
    } else {
      await pbPatch(`/api/collections/${existing.id}`, {
        listRule: "",
        viewRule: "",
        createRule: null,
        updateRule: null,
        deleteRule: null
      }).catch(() => {
      });
      console.log("[announcements] announcements \u2713");
    }
  } catch (e) {
    console.warn("[announcements] ensureAnnouncementsCollection:", e.message);
  }
}
async function ensureDailyClaimSettingsCollection() {
  try {
    const existing = await pbGet("/api/collections/daily_claim_settings");
    if (existing?.id) {
      console.log("[daily] daily_claim_settings \u2713");
      return;
    }
    const fileOpts = { maxSelect: 1, maxSize: 5242880, mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"], thumbs: [], protected: false };
    await pbPost("/api/collections", {
      name: "daily_claim_settings",
      type: "base",
      schema: [
        { name: "day_1_image", type: "file", required: false, options: fileOpts },
        { name: "day_1_amount", type: "number", required: false, options: { min: null, max: null } },
        { name: "day_2_image", type: "file", required: false, options: fileOpts },
        { name: "day_2_amount", type: "number", required: false, options: { min: null, max: null } },
        { name: "day_3_image", type: "file", required: false, options: fileOpts },
        { name: "day_3_amount", type: "number", required: false, options: { min: null, max: null } },
        { name: "day_4_image", type: "file", required: false, options: fileOpts },
        { name: "day_4_amount", type: "number", required: false, options: { min: null, max: null } },
        { name: "day_5_image", type: "file", required: false, options: fileOpts },
        { name: "day_5_amount", type: "number", required: false, options: { min: null, max: null } },
        { name: "day_6_image", type: "file", required: false, options: fileOpts },
        { name: "day_6_amount", type: "number", required: false, options: { min: null, max: null } },
        { name: "day_7_shiba_image", type: "file", required: false, options: fileOpts },
        { name: "day_7_shiba_amount", type: "number", required: false, options: { min: null, max: null } },
        { name: "day_7_power_image", type: "file", required: false, options: fileOpts },
        { name: "day_7_power_amount", type: "number", required: false, options: { min: null, max: null } }
      ],
      listRule: "",
      viewRule: "",
      createRule: null,
      updateRule: null,
      deleteRule: null
    });
    await pbPost("/api/collections/daily_claim_settings/records", {
      day_1_amount: 1e3,
      day_2_amount: 50,
      day_3_amount: 3e3,
      day_4_amount: 100,
      day_5_amount: 5e3,
      day_6_amount: 200,
      day_7_shiba_amount: 1e4,
      day_7_power_amount: 500
    });
    console.log("[daily] daily_claim_settings seeded \u2713");
  } catch (e) {
    console.warn("[daily] ensureDailyClaimSettingsCollection:", e.message);
  }
}
async function ensureDailyClaimsCollection() {
  try {
    const existing = await pbGet("/api/collections/daily_claims");
    if (existing?.id) {
      try {
        await pbPatch(`/api/collections/${existing.id}`, { createRule: '@request.auth.id != ""' });
      } catch {
      }
      console.log("[daily] daily_claims \u2713");
      return;
    }
    await pbPost("/api/collections", {
      name: "daily_claims",
      type: "base",
      schema: [
        { name: "user_id", type: "text", required: true, options: { min: null, max: null, pattern: "" } },
        { name: "day_number", type: "number", required: true, options: { min: 1, max: 7 } },
        { name: "reward_shib", type: "number", required: false, options: { min: null, max: null } },
        { name: "reward_pt", type: "number", required: false, options: { min: null, max: null } }
      ],
      listRule: null,
      viewRule: null,
      createRule: '@request.auth.id != ""',
      updateRule: null,
      deleteRule: null
    });
    console.log("[daily] daily_claims created \u2713");
  } catch (e) {
    console.warn("[daily] ensureDailyClaimsCollection:", e.message);
  }
}
async function syncUserTournamentPoints(pbId) {
  try {
    const cfgRes = await pbGet("/api/collections/tournament_config/records?sort=-created&perPage=1");
    const cfg = cfgRes?.items?.[0];
    if (!cfg) return 0;
    const user = await pbGet(`/api/collections/users/records/${pbId}?fields=id,tournament_joined,shib_balance`);
    if (!user?.id || !user.tournament_joined) return 0;
    const weekStart = cfg.start_time || cfg.week_start;
    if (!weekStart) return 0;
    const weekStartFilter = weekStart.replace("T", " ");
    const endMs = cfg.end_time ? new Date(cfg.end_time).getTime() : NaN;
    const endClause = Number.isFinite(endMs) ? ` && updated < "${String(cfg.end_time).replace("T", " ")}"` : "";
    const filter = encodeURIComponent(
      `user = "${pbId}" && claimed_amount > 0 && updated >= "${weekStartFilter}"${endClause}`
    );
    const sessRes = await pbGet(
      `/api/collections/mining_sessions/records?filter=${filter}&perPage=500&fields=claimed_amount`
    );
    const sessions = sessRes?.items ?? [];
    const totalPoints = sessions.reduce((sum, s) => sum + (Number(s.claimed_amount) || 0), 0);
    await pbPatch(`/api/collections/users/records/${pbId}`, {
      weekly_tournament_points: totalPoints
    });
    try {
      const pRes = await pbGet(
        `/api/collections/tournament_participants/records?filter=${encodeURIComponent(
          `user_id = "${pbId}"`
        )}&sort=-created&perPage=1`
      );
      const participant = pRes?.items?.[0];
      if (participant?.id) {
        await pbPatch(`/api/collections/tournament_participants/records/${participant.id}`, {
          points: totalPoints
        });
      }
    } catch (e) {
      console.warn("[tournament] participant points mirror failed:", e?.message);
    }
    console.log(`[tournament] sync-points ${pbId}: ${sessions.length} sessions \u2192 ${totalPoints.toFixed(2)} pts`);
    return totalPoints;
  } catch (e) {
    console.warn("[tournament] syncUserTournamentPoints error:", e.message);
    return 0;
  }
}
async function runEndOfCycle() {
  if (endOfCycleInFlight) {
    console.log("[tournament] runEndOfCycle already running \u2014 joining in-flight run (concurrency lock) \u2713");
    return endOfCycleInFlight;
  }
  endOfCycleInFlight = runEndOfCycleImpl().finally(() => {
    endOfCycleInFlight = null;
  });
  return endOfCycleInFlight;
}
async function runEndOfCycleImpl() {
  console.log("[tournament] \u2500\u2500 Running end-of-cycle: freeze \u2192 payout \u2192 history \u2192 reset \u2192 wipe \u2500\u2500");
  let cfg;
  try {
    const cfgRes = await pbGet("/api/collections/tournament_config/records?sort=-created&perPage=1");
    cfg = cfgRes?.items?.[0];
  } catch (e) {
    console.error("[tournament] runEndOfCycle: could not load config:", e.message);
  }
  if (!cfg) {
    console.log("[tournament] No config \u2014 skipping.");
    return;
  }
  try {
    await pbPatch(`/api/collections/tournament_config/records/${cfg.id}`, { is_active: false });
    console.log("[tournament] Frozen (is_active=false) \u2713");
  } catch (e) {
    console.error("[tournament] runEndOfCycle: freeze failed (continuing):", e.message);
  }
  const cycleKey = cycleKeyOf(cfg);
  const alreadyFinalized = !!cycleKey && cfg.payout_finalized_cycle === cycleKey;
  if (alreadyFinalized) {
    console.log(`[tournament] Payout already finalized for cycle ${cycleKey} \u2014 skipping distribution (double-credit guard) \u2713`);
  } else {
    try {
      let rewardMap = {};
      try {
        rewardMap = JSON.parse(cfg.reward_structure || "{}");
      } catch {
      }
      const winnersCount = Math.max(Number(cfg.winners_count) || 3, 1);
      const filter = encodeURIComponent("tournament_joined=true&&weekly_tournament_points>0");
      const perPage = Math.min(Math.max(winnersCount, 10), 100);
      const usersRes = await pbGet(
        `/api/collections/users/records?sort=-weekly_tournament_points&filter=${filter}&perPage=${perPage}&fields=id,display_name,weekly_tournament_points,shib_balance`
      );
      const topUsers = (usersRes?.items ?? []).slice(0, winnersCount);
      const weekEnd = (/* @__PURE__ */ new Date()).toISOString();
      for (let i = 0; i < topUsers.length; i++) {
        const u = topUsers[i];
        const rank = i + 1;
        const prize = Number(rewardMap[String(rank)]) || 0;
        await pbPost("/api/collections/tournament_history/records", {
          week_end: weekEnd,
          rank,
          user_id: u.id,
          display_name: u.display_name || "Miner",
          points: Number(u.weekly_tournament_points) || 0,
          prize
        }).catch(() => {
        });
      }
      console.log(`[tournament] History exported: ${topUsers.length} winners \u2713`);
      for (let i = 0; i < topUsers.length; i++) {
        const u = topUsers[i];
        const prize = Number(rewardMap[String(i + 1)]) || 0;
        if (prize > 0) {
          await pbPatch(`/api/collections/users/records/${u.id}`, {
            shib_balance: (Number(u.shib_balance) || 0) + prize
          });
          console.log(`[tournament] Rank #${i + 1} (${u.display_name || u.id}): +${prize.toLocaleString()} SHIB`);
        }
      }
      if (cycleKey) {
        await pbPatch(`/api/collections/tournament_config/records/${cfg.id}`, {
          payout_finalized_cycle: cycleKey,
          payout_finalized_bucket: cycleKey
          // keep legacy field mirrored
        });
        console.log(`[tournament] Payout finalized + locked for cycle ${cycleKey} \u2713`);
      } else {
        console.warn("[tournament] Payout ran but cycle key was unresolvable \u2014 lock NOT written (config missing cycle_id/start_time).");
      }
    } catch (e) {
      console.error("[tournament] runEndOfCycle payout/history error (continuing to cleanup):", e.message);
    }
  }
  try {
    let totalReset = 0;
    while (true) {
      const batch = await pbGet(
        `/api/collections/users/records?filter=${encodeURIComponent("tournament_joined=true || weekly_tournament_points>0")}&perPage=100&page=1&fields=id`
      );
      const items = batch?.items ?? [];
      if (!items.length) break;
      const results = await Promise.allSettled(items.map(
        (u) => pbPatch(`/api/collections/users/records/${u.id}`, {
          tournament_joined: false,
          weekly_tournament_points: 0
        })
      ));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      totalReset += ok;
      if (ok === 0) {
        console.error("[tournament] reset: a full batch failed to patch \u2014 aborting drain to avoid an infinite loop.");
        break;
      }
    }
    console.log(`[tournament] All points + joined flags reset \u2713 (${totalReset} users)`);
  } catch (e) {
    console.error("[tournament] runEndOfCycle reset error (continuing to wipe):", e.message);
  }
  try {
    const wiped = await wipeAllParticipants();
    console.log(`[tournament] Participants wiped: ${wiped} \u2713`);
  } catch (e) {
    console.error("[tournament] runEndOfCycle participant wipe error:", e.message);
  }
  console.log("[tournament] \u2500\u2500 End-of-cycle complete \u2014 staying INACTIVE until admin launches next cycle \u2500\u2500");
}
async function reconcileCycleSchedule() {
  let cfg;
  try {
    const cfgRes = await pbGet("/api/collections/tournament_config/records?sort=-created&perPage=1");
    cfg = cfgRes?.items?.[0];
  } catch (e) {
    console.warn("[tournament] reconcile: could not load config:", e?.message);
    return;
  }
  if (!cfg) {
    if (cycleEndTimer) {
      clearTimeout(cycleEndTimer);
      cycleEndTimer = null;
      armedEndMs = null;
    }
    return;
  }
  if (!cfg.is_active) {
    if (cycleEndTimer) {
      clearTimeout(cycleEndTimer);
      cycleEndTimer = null;
      armedEndMs = null;
    }
    if (cfg.cycle_id) {
      const unfinalizedPayout = cfg.payout_finalized_cycle !== cfg.cycle_id;
      let leftoverParticipants = false;
      try {
        leftoverParticipants = await anyParticipantsExist();
      } catch {
      }
      if (unfinalizedPayout || leftoverParticipants) {
        console.log(
          `[tournament] reconcile: detected interrupted finalization (unfinalizedPayout=${unfinalizedPayout}, leftoverParticipants=${leftoverParticipants}) \u2014 retrying runEndOfCycle.`
        );
        await runEndOfCycle();
      }
    }
    return;
  }
  if (!cfg.cycle_id) {
    const newId = generateCycleId();
    try {
      await pbPatch(`/api/collections/tournament_config/records/${cfg.id}`, { cycle_id: newId });
      cfg.cycle_id = newId;
      console.log(`[tournament] reconcile: backfilled cycle_id ${newId} onto live cycle \u2713`);
    } catch (e) {
      console.warn("[tournament] reconcile: cycle_id backfill failed:", e?.message);
    }
  }
  const endMs = cfg.end_time ? new Date(cfg.end_time).getTime() : NaN;
  if (!Number.isFinite(endMs)) {
    if (cycleEndTimer) {
      clearTimeout(cycleEndTimer);
      cycleEndTimer = null;
      armedEndMs = null;
    }
    console.warn("[tournament] reconcile: active cycle has no valid end_time \u2014 no auto-end armed.");
    return;
  }
  const now = Date.now();
  if (now >= endMs) {
    console.log("[tournament] reconcile: end_time reached \u2014 finalizing cycle now.");
    if (cycleEndTimer) {
      clearTimeout(cycleEndTimer);
      cycleEndTimer = null;
      armedEndMs = null;
    }
    await runEndOfCycle();
    return;
  }
  if (armedEndMs === endMs && cycleEndTimer) return;
  if (cycleEndTimer) {
    clearTimeout(cycleEndTimer);
    cycleEndTimer = null;
  }
  const delay = Math.min(endMs - now, MAX_TIMEOUT_MS);
  armedEndMs = endMs;
  cycleEndTimer = setTimeout(() => {
    cycleEndTimer = null;
    armedEndMs = null;
    reconcileCycleSchedule().catch((e) => console.warn("[tournament] reconcile (timer) error:", e?.message));
  }, delay);
  const hrs = (endMs - now) / 36e5;
  console.log(`[tournament] reconcile: cycle "${cfg.cycle_id}" ends in ~${hrs.toFixed(1)}h (${new Date(endMs).toUTCString()})${delay < endMs - now ? " [capped \u2014 will re-arm]" : ""}`);
}
function startTournamentCron() {
  setTimeout(() => {
    reconcileCycleSchedule().catch((e) => console.warn("[tournament] reconcile (boot) error:", e?.message));
    setInterval(() => {
      reconcileCycleSchedule().catch((e) => console.warn("[tournament] reconcile (poll) error:", e?.message));
    }, 6e4);
  }, 15e3);
  console.log("[tournament] Manual-cycle reconciler armed (boot in 15s, poll every 60s) \u2713");
}
var PB_URL, _adminToken, _tokenExpiry, endOfCycleInFlight, MAX_TIMEOUT_MS, cycleEndTimer, armedEndMs;
var init_tournament = __esm({
  "server/tournament.ts"() {
    "use strict";
    PB_URL = "https://api.webcod.in";
    _adminToken = "";
    _tokenExpiry = 0;
    endOfCycleInFlight = null;
    MAX_TIMEOUT_MS = 2e9;
    cycleEndTimer = null;
    armedEndMs = null;
  }
});

// server/index.ts
import express from "express";

// server/routes.ts
import { createServer } from "node:http";
import https2 from "node:https";
import http2 from "node:http";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import multer from "multer";

// shared/vip.ts
var MAX_VIP_LEVEL = 8;
var VIP_INCREMENTS_SHIB_PER_HR = {
  0: 0,
  1: 30,
  2: 60,
  3: 100,
  4: 140,
  5: 200,
  6: 260,
  7: 330,
  8: 427
};
var VIP_REQUIREMENTS = {
  1: { refs: 2, balance: 2e3, refIncome: 2e3, tasks: 0, withdrawals: 0 },
  2: { refs: 5, balance: 5e4, refIncome: 5e3, tasks: 5, withdrawals: 0 },
  3: { refs: 10, balance: 1e5, refIncome: 1e4, tasks: 10, withdrawals: 2 },
  4: { refs: 15, balance: 2e5, refIncome: 15e3, tasks: 15, withdrawals: 5 },
  5: { refs: 20, balance: 4e5, refIncome: 25e3, tasks: 25, withdrawals: 10 },
  6: { refs: 30, balance: 6e5, refIncome: 4e4, tasks: 35, withdrawals: 15 },
  7: { refs: 40, balance: 8e5, refIncome: 7e4, tasks: 45, withdrawals: 20 },
  8: { refs: 50, balance: 1e6, refIncome: 1e5, tasks: 50, withdrawals: 20 }
};
function normalizeVipLevel(level) {
  const n = Math.floor(Number(level) || 0);
  if (n < 0) return 0;
  if (n > MAX_VIP_LEVEL) return MAX_VIP_LEVEL;
  return n;
}
function vipIncrementPerSec(level) {
  const lvl = normalizeVipLevel(level);
  return (VIP_INCREMENTS_SHIB_PER_HR[lvl] || 0) / 3600;
}
function effectiveRatePerSec(baseRatePerSec, level) {
  return (Number(baseRatePerSec) || 0) + vipIncrementPerSec(level);
}
function meetsVipRequirements(targetLevel, m) {
  const req = VIP_REQUIREMENTS[normalizeVipLevel(targetLevel)];
  if (!req) return false;
  return m.refs >= req.refs && m.balance >= req.balance && m.refIncome >= req.refIncome && m.tasks >= req.tasks && m.withdrawals >= req.withdrawals;
}
function unmetVipRequirements(targetLevel, m) {
  const req = VIP_REQUIREMENTS[normalizeVipLevel(targetLevel)];
  if (!req) return [];
  const unmet = [];
  if (m.refs < req.refs) unmet.push("refs");
  if (m.balance < req.balance) unmet.push("balance");
  if (m.refIncome < req.refIncome) unmet.push("refIncome");
  if (m.tasks < req.tasks) unmet.push("tasks");
  if (m.withdrawals < req.withdrawals) unmet.push("withdrawals");
  return unmet;
}
function highestBalanceEligibleTier(balance, cap, floor = 0) {
  const capLvl = normalizeVipLevel(cap);
  const floorLvl = normalizeVipLevel(floor);
  let eligible = 0;
  for (let lvl = 1; lvl <= capLvl; lvl++) {
    const req = VIP_REQUIREMENTS[lvl];
    if (req && balance >= req.balance) eligible = lvl;
    else break;
  }
  return Math.max(eligible, floorLvl);
}
function lockedBalanceForVipLevel(level) {
  const lvl = normalizeVipLevel(level);
  return lvl > 0 ? VIP_REQUIREMENTS[lvl]?.balance || 0 : 0;
}

// shared/gamehub.ts
var POOL_TIERS = [1e3, 5e3, 1e4, 5e4, 1e5];
var COMMISSION_RATE = 0.1;
var PT_PER_TICKET = 100;
var SHIB_PER_TICKET = 10;
var REDEEM_MIN_TICKETS = 50;
var REDEEM_MAX_TICKETS = 5e3;
function computePoolSettlement(entryPT) {
  const totalStakePT = entryPT * 2;
  const grossTickets = totalStakePT / PT_PER_TICKET;
  const commissionTickets = Math.round(grossTickets * COMMISSION_RATE);
  const winnerTickets = Math.round(grossTickets - commissionTickets);
  return { entryPT, totalStakePT, grossTickets, commissionTickets, winnerTickets };
}
function winnerTicketsForTier(entryPT) {
  return computePoolSettlement(entryPT).winnerTickets;
}
function ticketsToShib(tickets) {
  return Math.max(0, Math.floor(tickets)) * SHIB_PER_TICKET;
}
function validateRedeem(tickets, balance) {
  if (!Number.isFinite(tickets) || !Number.isInteger(tickets)) return { ok: false, error: "Whole tickets only" };
  if (tickets < REDEEM_MIN_TICKETS) return { ok: false, error: `Minimum ${REDEEM_MIN_TICKETS} tickets` };
  if (tickets > REDEEM_MAX_TICKETS) return { ok: false, error: `Maximum ${REDEEM_MAX_TICKETS} tickets per transaction` };
  if (tickets > balance) return { ok: false, error: "Not enough Hit Tickets" };
  return { ok: true };
}
function formatPT(n) {
  if (n >= 1e3) return `${n / 1e3}k`;
  return String(n);
}
function tierConfig(entryPT) {
  const winnerTickets = winnerTicketsForTier(entryPT);
  return { entryPT, label: formatPT(entryPT), winnerTickets, winnerShib: ticketsToShib(winnerTickets) };
}
var TIER_CONFIGS = POOL_TIERS.map(tierConfig);

// shared/kyc.ts
var KYC_COUNTRIES = [
  { name: "Afghanistan", dial: "+93", supported: true },
  { name: "Albania", dial: "+355", supported: true },
  { name: "Algeria", dial: "+213", supported: true },
  { name: "Angola", dial: "+244", supported: true },
  { name: "Anguilla", dial: "+1264", supported: true },
  { name: "Antigua and Barbuda", dial: "+1268", supported: true },
  { name: "Argentina", dial: "+54", supported: true },
  { name: "Armenia", dial: "+374", supported: true },
  { name: "Australia", dial: "+61", supported: true },
  { name: "Austria", dial: "+43", supported: true },
  { name: "Azerbaijan", dial: "+994", supported: true },
  { name: "Bahamas (the)", dial: "+1242", supported: true },
  { name: "Bahrain", dial: "+973", supported: true },
  { name: "Bangladesh", dial: "+880", supported: false },
  { name: "Barbados", dial: "+1246", supported: true },
  { name: "Belarus", dial: "+375", supported: true },
  { name: "Belgium", dial: "+32", supported: true },
  { name: "Belize", dial: "+501", supported: true },
  { name: "Benin", dial: "+229", supported: true },
  { name: "Bermuda", dial: "+1441", supported: true },
  { name: "Bhutan", dial: "+975", supported: true },
  { name: "Bolivia (Plurinational State of)", dial: "+591", supported: true },
  { name: "Bosnia and Herzegovina", dial: "+387", supported: true },
  { name: "Botswana", dial: "+267", supported: true },
  { name: "Brazil", dial: "+55", supported: true },
  { name: "Brunei Darussalam", dial: "+673", supported: true },
  { name: "Bulgaria", dial: "+359", supported: true },
  { name: "Burkina Faso", dial: "+226", supported: true },
  { name: "Cabo Verde", dial: "+238", supported: true },
  { name: "Cambodia", dial: "+855", supported: true },
  { name: "Cameroon", dial: "+237", supported: true },
  { name: "Canada", dial: "+1", supported: true },
  { name: "Cayman Islands (the)", dial: "+1345", supported: true },
  { name: "Chad", dial: "+235", supported: true },
  { name: "Chile", dial: "+56", supported: true },
  { name: "China", dial: "+86", supported: false },
  { name: "Colombia", dial: "+57", supported: true },
  { name: "Congo (the Democratic Republic of the)", dial: "+243", supported: true },
  { name: "Congo (the)", dial: "+242", supported: true },
  { name: "Costa Rica", dial: "+506", supported: true },
  { name: "C\xF4te d'Ivoire", dial: "+225", supported: true },
  { name: "Croatia", dial: "+385", supported: true },
  { name: "Cuba", dial: "+53", supported: false },
  { name: "Cyprus", dial: "+357", supported: true },
  { name: "Czechia", dial: "+420", supported: true },
  { name: "Denmark", dial: "+45", supported: true },
  { name: "Dominica", dial: "+1767", supported: true },
  { name: "Dominican Republic (the)", dial: "+1809", supported: true },
  { name: "Ecuador", dial: "+593", supported: true },
  { name: "Egypt", dial: "+20", supported: true },
  { name: "El Salvador", dial: "+503", supported: true },
  { name: "Estonia", dial: "+372", supported: true },
  { name: "Eswatini", dial: "+268", supported: true },
  { name: "Ethiopia", dial: "+251", supported: false },
  { name: "Fiji", dial: "+679", supported: true },
  { name: "Finland", dial: "+358", supported: true },
  { name: "France", dial: "+33", supported: true },
  { name: "Gabon", dial: "+241", supported: true },
  { name: "Gambia (the)", dial: "+220", supported: true },
  { name: "Georgia", dial: "+995", supported: true },
  { name: "Germany", dial: "+49", supported: true },
  { name: "Ghana", dial: "+233", supported: true },
  { name: "Greece", dial: "+30", supported: true },
  { name: "Grenada", dial: "+1473", supported: true },
  { name: "Guatemala", dial: "+502", supported: true },
  { name: "Guinea-Bissau", dial: "+245", supported: true },
  { name: "Guyana", dial: "+592", supported: true },
  { name: "Haiti", dial: "+509", supported: false },
  { name: "Honduras", dial: "+504", supported: true },
  { name: "Hong Kong", dial: "+852", supported: true },
  { name: "Hungary", dial: "+36", supported: true },
  { name: "Iceland", dial: "+354", supported: true },
  { name: "India", dial: "+91", supported: true },
  { name: "Indonesia", dial: "+62", supported: true },
  { name: "Iran", dial: "+98", supported: false, blocked: true },
  { name: "Iraq", dial: "+964", supported: true },
  { name: "Ireland", dial: "+353", supported: true },
  { name: "Israel", dial: "+972", supported: true },
  { name: "Italy", dial: "+39", supported: true },
  { name: "Jamaica", dial: "+1876", supported: true },
  { name: "Japan", dial: "+81", supported: false },
  { name: "Jordan", dial: "+962", supported: true },
  { name: "Kazakhstan", dial: "+7", supported: true },
  { name: "Kenya", dial: "+254", supported: true },
  { name: "Kosovo", dial: "+383", supported: true },
  { name: "Kuwait", dial: "+965", supported: true },
  { name: "Kyrgyzstan", dial: "+996", supported: true },
  { name: "Lao People's Democratic Republic (the)", dial: "+856", supported: true },
  { name: "Latvia", dial: "+371", supported: true },
  { name: "Lebanon", dial: "+961", supported: true },
  { name: "Liberia", dial: "+231", supported: true },
  { name: "Libya", dial: "+218", supported: true },
  { name: "Lithuania", dial: "+370", supported: true },
  { name: "Luxembourg", dial: "+352", supported: true },
  { name: "Macao", dial: "+853", supported: true },
  { name: "Madagascar", dial: "+261", supported: true },
  { name: "Malawi", dial: "+265", supported: true },
  { name: "Malaysia", dial: "+60", supported: false },
  { name: "Maldives", dial: "+960", supported: true },
  { name: "Mali", dial: "+223", supported: true },
  { name: "Malta", dial: "+356", supported: true },
  { name: "Mauritania", dial: "+222", supported: true },
  { name: "Mauritius", dial: "+230", supported: true },
  { name: "Mexico", dial: "+52", supported: true },
  { name: "Micronesia (Federated States of)", dial: "+691", supported: true },
  { name: "Moldova (the Republic of)", dial: "+373", supported: true },
  { name: "Mongolia", dial: "+976", supported: true },
  { name: "Montenegro", dial: "+382", supported: true },
  { name: "Montserrat", dial: "+1664", supported: true },
  { name: "Morocco", dial: "+212", supported: true },
  { name: "Mozambique", dial: "+258", supported: true },
  { name: "Myanmar", dial: "+95", supported: true },
  { name: "Namibia", dial: "+264", supported: true },
  { name: "Nauru", dial: "+674", supported: true },
  { name: "Nepal", dial: "+977", supported: true },
  { name: "Netherlands", dial: "+31", supported: false },
  { name: "New Zealand", dial: "+64", supported: true },
  { name: "Nicaragua", dial: "+505", supported: true },
  { name: "Niger (the)", dial: "+227", supported: true },
  { name: "Nigeria", dial: "+234", supported: true },
  { name: "Norway", dial: "+47", supported: true },
  { name: "Oman", dial: "+968", supported: true },
  { name: "Pakistan", dial: "+92", supported: true },
  { name: "Palau", dial: "+680", supported: true },
  { name: "Panama", dial: "+507", supported: true },
  { name: "Papua New Guinea", dial: "+675", supported: true },
  { name: "Paraguay", dial: "+595", supported: true },
  { name: "Peru", dial: "+51", supported: true },
  { name: "Philippines (the)", dial: "+63", supported: true },
  { name: "Poland", dial: "+48", supported: true },
  { name: "Portugal", dial: "+351", supported: true },
  { name: "Qatar", dial: "+974", supported: true },
  { name: "Republic of North Macedonia", dial: "+389", supported: true },
  { name: "Romania", dial: "+40", supported: true },
  { name: "Russian Federation (the)", dial: "+7", supported: true },
  { name: "Rwanda", dial: "+250", supported: true },
  { name: "Saint Kitts and Nevis", dial: "+1869", supported: true },
  { name: "Saint Lucia", dial: "+1758", supported: true },
  { name: "Saint Vincent and the Grenadines", dial: "+1784", supported: true },
  { name: "Sao Tome and Principe", dial: "+239", supported: true },
  { name: "Saudi Arabia", dial: "+966", supported: true },
  { name: "Senegal", dial: "+221", supported: true },
  { name: "Serbia", dial: "+381", supported: true },
  { name: "Seychelles", dial: "+248", supported: true },
  { name: "Sierra Leone", dial: "+232", supported: true },
  { name: "Singapore", dial: "+65", supported: true },
  { name: "Slovakia", dial: "+421", supported: true },
  { name: "Slovenia", dial: "+386", supported: true },
  { name: "Solomon Islands", dial: "+677", supported: true },
  { name: "Somalia", dial: "+252", supported: false },
  { name: "South Africa", dial: "+27", supported: true },
  { name: "South Korea", dial: "+82", supported: true },
  { name: "Spain", dial: "+34", supported: true },
  { name: "Sri Lanka", dial: "+94", supported: true },
  { name: "Sudan", dial: "+249", supported: false },
  { name: "Suriname", dial: "+597", supported: true },
  { name: "Sweden", dial: "+46", supported: true },
  { name: "Switzerland", dial: "+41", supported: true },
  { name: "Syria", dial: "+963", supported: false },
  { name: "Taiwan", dial: "+886", supported: true },
  { name: "Tajikistan", dial: "+992", supported: true },
  { name: "Tanzania, United Republic of", dial: "+255", supported: true },
  { name: "Thailand", dial: "+66", supported: true },
  { name: "Tonga", dial: "+676", supported: true },
  { name: "Trinidad and Tobago", dial: "+1868", supported: true },
  { name: "Tunisia", dial: "+216", supported: true },
  { name: "Turkey", dial: "+90", supported: true },
  { name: "Turkmenistan", dial: "+993", supported: true },
  { name: "Turks and Caicos Islands (the)", dial: "+1649", supported: true },
  { name: "Uganda", dial: "+256", supported: true },
  { name: "Ukraine", dial: "+380", supported: true },
  { name: "United Arab Emirates (the)", dial: "+971", supported: true },
  { name: "United Kingdom of Great Britain and Northern Ireland (the)", dial: "+44", supported: true },
  { name: "United States of America", dial: "+1", supported: false },
  { name: "Uruguay", dial: "+598", supported: true },
  { name: "Uzbekistan", dial: "+998", supported: true },
  { name: "Vanuatu", dial: "+678", supported: true },
  { name: "Venezuela (Bolivarian Republic of)", dial: "+58", supported: true },
  { name: "Viet Nam", dial: "+84", supported: true },
  { name: "Virgin Islands (British)", dial: "+1284", supported: true },
  { name: "Yemen", dial: "+967", supported: true },
  { name: "Zambia", dial: "+260", supported: true },
  { name: "Zimbabwe", dial: "+263", supported: true }
];
function findKycCountry(name) {
  return KYC_COUNTRIES.find((c) => c.name === name);
}
function isKycCountryBlocked(name) {
  return !!findKycCountry(name)?.blocked;
}
function isBinanceSupported(name) {
  const c = findKycCountry(name);
  return !!c && c.supported && !c.blocked;
}
var BINANCE_WITHDRAW_COUNTRY = "India";
function normalizeKycStatus(v) {
  if (v === "under_review" || v === "verified" || v === "rejected") return v;
  const k = String(v ?? "").trim().toLowerCase().replace(/[\s_]+/g, "_");
  if (k === "under_review" || k === "pending") return "under_review";
  if (k === "verified" || k === "approved") return "verified";
  if (k === "rejected" || k === "unverified") return "rejected";
  return "none";
}
function validateBep20Address(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}
function validateKycEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
function validateKycPhone(phone) {
  return /^[0-9]{5,15}$/.test(phone.trim());
}

// server/networkGuard.ts
var BLOCKED_COUNTRY_CODES = /* @__PURE__ */ new Set([
  "IR",
  "KP",
  "SY",
  "CU",
  "AF",
  "VE",
  "YE",
  "SO",
  "SD",
  "ZW"
]);
var BLOCKED_REGION_KEYWORDS = [
  "crimea",
  "donetsk",
  "luhansk",
  "lugansk",
  "sevastopol"
];
var NETWORK_BLOCK_MESSAGE = "Access Restricted: Your network configuration is not allowed on this platform. Please disable any VPN or proxy services to continue.";
var VERDICT_TTL_MS = 6 * 36e5;
var FAIL_OPEN_TTL_MS = 5 * 6e4;
var CACHE_MAX_ENTRIES = 2e4;
var verdictCache = /* @__PURE__ */ new Map();
function cacheVerdict(ip, verdict, ttlMs) {
  if (verdictCache.size >= CACHE_MAX_ENTRIES) {
    let n = Math.ceil(CACHE_MAX_ENTRIES / 10);
    for (const key of verdictCache.keys()) {
      verdictCache.delete(key);
      if (--n <= 0) break;
    }
  }
  verdictCache.set(ip, { verdict, expiresAt: Date.now() + ttlMs });
}
function normalizeIp(raw) {
  let ip = (raw || "").trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}
function ipv4ToInt(ip) {
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
function isPrivateOrLocalIp(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip) return true;
  if (ip === "::1" || ip === "localhost") return true;
  const lower = ip.toLowerCase();
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const a = n >>> 24;
  const b = n >>> 16 & 255;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
var CIDR_SOURCES = [
  {
    url: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt",
    reason: "vpn"
  },
  {
    url: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt",
    reason: "hosting"
  }
];
var CIDR_REFRESH_MS = 24 * 36e5;
var cidrRanges = [];
function parseCidrLine(line, reason) {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const [base, bitsStr] = t.split("/");
  const start = ipv4ToInt(base);
  if (start === null) return null;
  const bits = bitsStr === void 0 ? 32 : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = bits === 0 ? 4294967296 : 2 ** (32 - bits);
  const rangeStart = bits === 0 ? 0 : start - start % size >>> 0;
  return { start: rangeStart, end: rangeStart + size - 1, reason };
}
async function refreshCidrLists() {
  const next = [];
  let anySuccess = false;
  for (const src of CIDR_SOURCES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2e4);
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
    } catch (e) {
      console.warn(`[networkGuard] CIDR list fetch failed (${src.reason}):`, e?.message);
    }
  }
  if (anySuccess && next.length > 0) {
    next.sort((x, y) => x.start - y.start);
    const merged = [];
    for (const r of next) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end + 1) {
        if (r.end > last.end) last.end = r.end;
        if (r.reason === "vpn") last.reason = "vpn";
      } else {
        merged.push({ ...r });
      }
    }
    cidrRanges = merged;
    console.log(
      `[networkGuard] CIDR ranges merged: ${next.length} \u2192 ${merged.length}`
    );
  }
}
function cidrLookup(rawIp) {
  const n = ipv4ToInt(normalizeIp(rawIp));
  if (n === null || cidrRanges.length === 0) return null;
  let lo = 0;
  let hi = cidrRanges.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    const r = cidrRanges[mid];
    if (n < r.start) hi = mid - 1;
    else if (n > r.end) lo = mid + 1;
    else return r.reason;
  }
  return null;
}
var keyProvider = null;
function setNetworkGuardKeyProvider(p) {
  keyProvider = p;
}
async function proxycheckLookup(rawIp) {
  const ip = normalizeIp(rawIp);
  let key = "";
  if (keyProvider) {
    try {
      key = await keyProvider.getKey() || "";
    } catch {
    }
  }
  if (!key) key = process.env.PROXYCHECK_API_KEY || "";
  const url = `https://proxycheck.io/v2/${encodeURIComponent(ip)}?vpn=3&asn=1&risk=1${key ? `&key=${encodeURIComponent(key)}` : ""}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4e3);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (key && keyProvider) keyProvider.reportUse(key);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data?.status && data.status !== "ok" && data.status !== "warning") {
      if (key && keyProvider && String(data.status).toLowerCase() === "denied") {
        keyProvider.reportExhausted(key);
      }
      console.warn(`[networkGuard] proxycheck status=${data.status} ${data.message ?? ""}`);
      return null;
    }
    const info = data?.[ip];
    if (!info || typeof info !== "object") return null;
    const iso = String(info.isocode ?? "").toUpperCase();
    if (BLOCKED_COUNTRY_CODES.has(iso)) {
      return { blocked: true, reason: "geo" };
    }
    const regionHaystack = `${info.region ?? ""} ${info.regionname ?? ""} ${info.city ?? ""}`.toLowerCase();
    if (BLOCKED_REGION_KEYWORDS.some((k) => regionHaystack.includes(k))) {
      return { blocked: true, reason: "geo" };
    }
    const proxyFlag = String(info.proxy ?? "").toLowerCase() === "yes";
    const type = String(info.type ?? "").toLowerCase();
    if (proxyFlag || type.includes("vpn")) {
      return { blocked: true, reason: type.includes("vpn") ? "vpn" : "proxy" };
    }
    const hostingFlag = String(info.hosting ?? "").toLowerCase() === "yes" || type === "hosting";
    if (hostingFlag) {
      return { blocked: true, reason: "hosting" };
    }
    return { blocked: false, reason: null };
  } catch (e) {
    console.warn(`[networkGuard] proxycheck lookup failed for ${ip}:`, e?.message);
    return null;
  }
}
var inFlight = /* @__PURE__ */ new Map();
async function checkNetworkAccess(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip || isPrivateOrLocalIp(ip)) return { blocked: false, reason: null };
  const cached = verdictCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.verdict;
  const pending = inFlight.get(ip);
  if (pending) return pending;
  const task = (async () => {
    const cidrHit = cidrLookup(ip);
    if (cidrHit) {
      const verdict = { blocked: true, reason: cidrHit };
      cacheVerdict(ip, verdict, VERDICT_TTL_MS);
      console.warn(`[networkGuard] BLOCKED ${ip} (cidr:${cidrHit})`);
      return verdict;
    }
    const apiVerdict = await proxycheckLookup(ip);
    if (apiVerdict === null) {
      const verdict = { blocked: false, reason: null };
      cacheVerdict(ip, verdict, FAIL_OPEN_TTL_MS);
      return verdict;
    }
    const cidrReady = cidrRanges.length > 0;
    cacheVerdict(
      ip,
      apiVerdict,
      apiVerdict.blocked || cidrReady ? VERDICT_TTL_MS : FAIL_OPEN_TTL_MS
    );
    if (apiVerdict.blocked) {
      console.warn(`[networkGuard] BLOCKED ${ip} (proxycheck:${apiVerdict.reason})`);
    }
    return apiVerdict;
  })().finally(() => inFlight.delete(ip));
  inFlight.set(ip, task);
  return task;
}
var settingsProvider = null;
var enabledCache = null;
function setNetworkGuardSettingsProvider(fn) {
  settingsProvider = fn;
}
async function isNetworkGuardEnabled() {
  if (process.env.NETWORK_GUARD_DISABLED === "1") return false;
  if (process.env.NETWORK_GUARD_FORCE === "1") return true;
  if (!settingsProvider) return false;
  if (enabledCache && Date.now() - enabledCache.at < 6e4) return enabledCache.value;
  try {
    const value = await settingsProvider();
    enabledCache = { value, at: Date.now() };
    return value;
  } catch {
    return enabledCache?.value ?? false;
  }
}
function networkGuardMiddleware() {
  return async (req, res, next) => {
    try {
      if (req.method === "OPTIONS") return next();
      if (req.path.startsWith("/security/network-check")) return next();
      if (!await isNetworkGuardEnabled()) return next();
      const verdict = await checkNetworkAccess(req.ip || "");
      if (!verdict.blocked) return next();
      return res.status(403).json({
        blocked: true,
        code: "NETWORK_BLOCKED",
        reason: verdict.reason,
        error: NETWORK_BLOCK_MESSAGE
      });
    } catch (e) {
      console.warn("[networkGuard] middleware error (fail-open):", e?.message);
      return next();
    }
  };
}
function clientIpFromUpgrade(request) {
  const xff = request.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  if (raw) {
    const parts = String(raw).split(",");
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
  }
  return request.socket?.remoteAddress || "";
}
async function guardWebSocketUpgrade(request, socket) {
  try {
    if (!await isNetworkGuardEnabled()) return true;
    const ip = clientIpFromUpgrade(request);
    const verdict = await checkNetworkAccess(ip);
    if (!verdict.blocked) return true;
    try {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" + JSON.stringify({ blocked: true, code: "NETWORK_BLOCKED", reason: verdict.reason })
      );
    } catch {
    }
    try {
      socket.destroy();
    } catch {
    }
    return false;
  } catch (e) {
    console.warn("[networkGuard] ws guard error (fail-open):", e?.message);
    return true;
  }
}
var initialized = false;
function initNetworkGuard() {
  if (initialized) return;
  initialized = true;
  refreshCidrLists().catch(() => {
  });
  setInterval(() => refreshCidrLists().catch(() => {
  }), CIDR_REFRESH_MS).unref();
  console.log("[networkGuard] initialized (CIDR refresh every 24h, verdict cache 6h)");
}

// server/routes.ts
var ALLOWED_UPLOAD_MIME = /* @__PURE__ */ new Set(["image/jpeg", "image/png"]);
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  // 5 MB max
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_UPLOAD_MIME.has((file.mimetype || "").toLowerCase())) {
      req.fileRejected = true;
      return cb(null, false);
    }
    cb(null, true);
  }
});
var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
function cleanEmail(raw) {
  const e = String(raw ?? "").trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}
function cleanDisplayName(raw) {
  return String(raw ?? "").replace(/[\u0000-\u001F\u007F<>"'`\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}
var PB_URL2 = "https://api.webcod.in";
function pbHttp2(method, path2, body, token) {
  return new Promise((resolve2, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      "Content-Type": "application/json"
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (data) headers["Content-Length"] = String(Buffer.byteLength(data));
    const url = new URL(path2, PB_URL2);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https2 : http2;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers
      },
      (res) => {
        let b = "";
        res.on("data", (d) => b += d);
        res.on("end", () => {
          try {
            resolve2(JSON.parse(b));
          } catch {
            resolve2({ raw: b });
          }
        });
      }
    );
    req.setTimeout(3e4, () => {
      req.destroy(new Error("PocketBase request timed out after 30s"));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
async function pbFetchMultipart(method, path2, form) {
  const token = await getAdminToken2();
  const url = new URL(path2, PB_URL2).toString();
  const res = await globalThis.fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  return res.json();
}
var adminToken = "";
var tokenExpiry = 0;
async function getAdminToken2() {
  if (adminToken && Date.now() < tokenExpiry) return adminToken;
  const res = await pbHttp2(
    "POST",
    "/api/admins/auth-with-password",
    {
      identity: process.env.PB_ADMIN_EMAIL,
      password: process.env.PB_ADMIN_PASSWORD
    },
    void 0
  );
  if (!res.token) throw new Error(`PB admin auth failed: ${JSON.stringify(res)}`);
  adminToken = res.token;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1e3;
  return adminToken;
}
var WS_PT_PER_HIT = 5;
var WS_MAX_PT = 2e3;
var WS_MAX_HITS = WS_MAX_PT / WS_PT_PER_HIT;
var WS_MIN_HIT_MS = 280;
var WS_BURST_WINDOW = 5e3;
var WS_BURST_MAX = 18;
var WS_SESSION_MS = 3 * 6e4;
var WS_SESSION_GRACE_MS = 15e3;
var SOLO_GAME_SPECS_DEFAULT = {
  weapon_master: { maxRawScore: 2e3, ptMultiplier: 1, maxPT: 2e3, maxPtPerSec: 15 },
  flappy: { maxRawScore: 120, ptMultiplier: 15, maxPT: 1800, maxPtPerSec: 25 },
  fruitcut: { maxRawScore: 4e3, ptMultiplier: 0.5, maxPT: 2e3, maxPtPerSec: 30 },
  color: { maxRawScore: 100, ptMultiplier: 20, maxPT: 2e3, maxPtPerSec: 25 }
};
var soloGameSpecsCache = { ...SOLO_GAME_SPECS_DEFAULT };
function getSoloGameSpec(gameId) {
  return soloGameSpecsCache[gameId] ?? soloGameSpecsCache.weapon_master ?? SOLO_GAME_SPECS_DEFAULT.weapon_master;
}
async function refreshSoloGameSpecsCache() {
  try {
    const res = await pbGet2("/api/collections/solo_game_config/records?perPage=50&sort=game_id");
    if (!Array.isArray(res.items) || res.items.length === 0) return;
    const fresh = { ...SOLO_GAME_SPECS_DEFAULT };
    for (const row of res.items) {
      const gid = row.game_id;
      if (!gid) continue;
      const def = SOLO_GAME_SPECS_DEFAULT[gid] ?? SOLO_GAME_SPECS_DEFAULT.weapon_master;
      fresh[gid] = {
        maxRawScore: Number(row.max_raw_score) || def.maxRawScore,
        ptMultiplier: Number(row.pt_multiplier) || def.ptMultiplier,
        maxPT: Number(row.max_pt) || def.maxPT,
        maxPtPerSec: Number(row.max_pt_per_sec) || def.maxPtPerSec
      };
    }
    soloGameSpecsCache = fresh;
    console.log(`[solo_game_config] specs refreshed (${res.items.length} games)`);
  } catch (e) {
    console.warn("[solo_game_config] cache refresh failed, keeping last values:", e.message);
  }
}
var wsSessions = /* @__PURE__ */ new Map();
function appVersionAtLeast(v, min) {
  if (typeof v !== "string" || !v.trim()) return false;
  const a = v.trim().split(".").map((n) => parseInt(n, 10));
  const b = min.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = a[i], y = b[i] ?? 0;
    if (!Number.isFinite(x)) return false;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}
var MATCH_SIG_SECRET = process.env.SESSION_SECRET || "shib-match-sig-v1";
if (!process.env.SESSION_SECRET) {
  console.warn("[anti-cheat] SESSION_SECRET is NOT set \u2014 match signatures use the built-in fallback key. Set SESSION_SECRET in this environment for production-grade signing.");
}
function signMatchId(pbId) {
  const id = crypto.randomUUID();
  const sig = crypto.createHmac("sha256", MATCH_SIG_SECRET).update(`${id}:${pbId}`).digest("hex").slice(0, 16);
  return `${id}.${sig}`;
}
function matchSigState(matchId, pbId) {
  const dot = matchId.lastIndexOf(".");
  if (dot < 0) return "unsigned";
  const id = matchId.slice(0, dot);
  const sig = matchId.slice(dot + 1);
  const expected = crypto.createHmac("sha256", MATCH_SIG_SECRET).update(`${id}:${pbId}`).digest("hex").slice(0, 16);
  try {
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}
async function flagUserBlacklist(pbId, reason) {
  try {
    const u = await pbGet2(`/api/collections/users/records/${pbId}?fields=id,is_blacklist_1,is_blacklist_2`);
    if (!u || u.code) return;
    const body = u.is_blacklist_1 ? { is_blacklist_2: true } : { is_blacklist_1: true };
    await pbPatch2(`/api/collections/users/records/${pbId}`, body);
    console.warn(`[anti-cheat] ACCOUNT FLAGGED ${Object.keys(body)[0]} (${pbId}): ${reason}`);
  } catch (e) {
    console.warn(`[anti-cheat] account flag failed (${pbId}):`, e.message);
  }
}
async function wsCommitSession(sid, session) {
  if (session.committed) return;
  session.committed = true;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  const finalPT = session.blacklisted ? 0 : session.serverPT;
  const status = session.blacklisted ? "blacklisted" : "started";
  console.log(`[ws/game] commit ${sid.slice(0, 8)}: ${session.hits} hits = ${finalPT} PT status=${status} (${session.pbId})`);
  try {
    await pbPatch2(`/api/collections/users/records/${session.pbId}`, {
      last_session_score: finalPT
    });
    const logBody = {
      raw_score: finalPT,
      final_tokens: finalPT,
      match_status: status
    };
    if (session.logId) {
      pbPatch2(`/api/collections/game_score/records/${session.logId}`, logBody).catch(() => {
      });
    } else {
      (async () => {
        const found = await pbGet2(
          `/api/collections/game_score/records?filter=${encodeURIComponent(`match_id="${sid}"`)}&perPage=1`
        );
        const row = found?.items?.[0];
        if (row?.id) {
          await pbPatch2(`/api/collections/game_score/records/${row.id}`, logBody);
        } else if (session.legacy) {
          await pbPost2("/api/collections/game_score/records", {
            user: session.pbId,
            user_id: session.pbId,
            is_double: false,
            match_id: sid,
            ...logBody
          });
        }
      })().catch(() => {
      });
    }
  } catch (e) {
    console.error(`[ws/game] commit error (${session.pbId}):`, e.message);
  }
  wsSessions.delete(sid);
}
function setupGameWebSocket(wss) {
  wss.on("connection", (ws) => {
    let sid = null;
    const send2 = (obj) => {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
      }
    };
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case "GAME_START": {
          const { pbId } = msg;
          if (!pbId) {
            send2({ type: "ERROR", reason: "pbId_required" });
            return;
          }
          const gameId = soloGameSpecsCache[msg.gameId] ? msg.gameId : "weapon_master";
          const strictClient = appVersionAtLeast(msg.appVersion, "1.0.3");
          const user = await pbGet2(`/api/collections/users/records/${pbId}?fields=id`);
          if (user.code) {
            send2({ type: "ERROR", reason: "user_not_found" });
            return;
          }
          if (sid) {
            const old = wsSessions.get(sid);
            if (old && !old.committed) {
              old.committed = true;
              if (old.timer) clearTimeout(old.timer);
              wsSessions.delete(sid);
            }
          }
          sid = signMatchId(pbId);
          const session = {
            pbId,
            gameId,
            hits: 0,
            serverPT: 0,
            startMs: Date.now(),
            lastHitMs: 0,
            hitLog: [],
            rejectLog: [],
            committed: false,
            blacklisted: false,
            legacy: !strictClient,
            logId: null,
            timer: null
          };
          const rowBody = {
            user: pbId,
            user_id: pbId,
            raw_score: 0,
            is_double: false,
            final_tokens: 0,
            match_id: sid,
            match_status: "active"
          };
          if (strictClient) {
            let matchRow = null;
            try {
              matchRow = await pbPost2("/api/collections/game_score/records", rowBody);
            } catch {
            }
            if (!matchRow || matchRow.code || !matchRow.id) {
              console.error(`[ws/game] match row create FAILED for ${pbId} \u2014 game start BLOCKED`);
              sid = null;
              send2({ type: "ERROR", reason: "match_create_failed" });
              break;
            }
            session.logId = matchRow.id;
          } else {
            pbPost2("/api/collections/game_score/records", rowBody).then((r) => {
              if (!r || !r.id || r.code) return;
              if (session.committed) {
                pbDelete2(`/api/collections/game_score/records/${r.id}`).catch(() => {
                });
                return;
              }
              session.logId = r.id;
            }).catch(() => {
            });
          }
          session.timer = setTimeout(async () => {
            const s = wsSessions.get(sid);
            if (s) await wsCommitSession(sid, s);
            send2({ type: "GAME_OVER", reason: "time", serverPT: session.serverPT });
          }, WS_SESSION_MS + WS_SESSION_GRACE_MS);
          wsSessions.set(sid, session);
          send2({ type: "SESSION_READY", sessionId: sid });
          console.log(`[ws/game] session ${sid.slice(0, 8)} started for ${pbId}${strictClient ? "" : " (legacy client)"}`);
          break;
        }
        case "KNIFE_HIT": {
          if (!sid) {
            send2({ type: "HIT_REJECTED", reason: "no_session" });
            return;
          }
          const session = wsSessions.get(sid);
          if (!session || session.committed) {
            send2({ type: "HIT_REJECTED", reason: "session_invalid" });
            return;
          }
          const now = Date.now();
          if (session.lastHitMs > 0 && now - session.lastHitMs < WS_MIN_HIT_MS) {
            console.warn(`[ws/game] ${sid.slice(0, 8)} too_fast (${now - session.lastHitMs}ms)`);
            session.rejectLog.push(now);
            session.rejectLog = session.rejectLog.filter((t) => now - t < 3e4);
            if (session.rejectLog.length > 10) {
              console.warn(`[ws/game] ${sid.slice(0, 8)} SHADOW-BLACKLIST candidate: ${session.rejectLog.length} rejected hits/30s (${session.pbId})`);
            }
            send2({ type: "HIT_REJECTED", reason: "too_fast" });
            return;
          }
          session.hitLog = session.hitLog.filter((t) => now - t < WS_BURST_WINDOW);
          if (session.hitLog.length >= WS_BURST_MAX) {
            console.warn(`[ws/game] ${sid.slice(0, 8)} burst (${session.hitLog.length} hits/${WS_BURST_WINDOW}ms)`);
            session.rejectLog.push(now);
            session.rejectLog = session.rejectLog.filter((t) => now - t < 3e4);
            if (session.rejectLog.length > 10) {
              console.warn(`[ws/game] ${sid.slice(0, 8)} SHADOW-BLACKLIST candidate: ${session.rejectLog.length} rejected hits/30s (${session.pbId})`);
            }
            send2({ type: "HIT_REJECTED", reason: "burst_detected" });
            return;
          }
          if (session.hits >= WS_MAX_HITS) {
            await wsCommitSession(sid, session);
            send2({ type: "GAME_OVER", reason: "score_limit", serverPT: session.serverPT });
            return;
          }
          session.hits++;
          session.serverPT += WS_PT_PER_HIT;
          session.lastHitMs = now;
          session.hitLog.push(now);
          send2({ type: "HIT_ACK", serverPT: session.serverPT, serverHits: session.hits });
          break;
        }
        case "GAME_OVER": {
          if (!sid) return;
          const session = wsSessions.get(sid);
          if (!session || session.committed) {
            send2({ type: "COMMITTED", serverPT: session?.serverPT ?? 0 });
            return;
          }
          if (msg.score !== void 0) {
            const rawScore = Math.max(0, Number(msg.score) || 0);
            const spec = getSoloGameSpec(session.gameId);
            const clampedRaw = Math.min(rawScore, spec.maxRawScore);
            const clientPT = Math.min(Math.floor(clampedRaw * spec.ptMultiplier), spec.maxPT);
            const serverElapsed = Date.now() - session.startMs;
            const clientElapsed = Number(msg.elapsed_ms) || 0;
            const elapsedMs = Math.max(1e3, Math.min(Math.max(clientElapsed, serverElapsed), 185e3));
            const maxForTime = Math.ceil(elapsedMs / 1e3 * spec.maxPtPerSec);
            if (clientPT > maxForTime * 1.2 + 20) {
              session.blacklisted = true;
              session.serverPT = 0;
              console.warn(`[ws/game][${session.gameId}] BLACKLIST ${sid.slice(0, 8)}: raw=${rawScore} pt=${clientPT} in ${Math.round(elapsedMs / 1e3)}s (cap=${maxForTime}) (${session.pbId})`);
              flagUserBlacklist(session.pbId, `[${session.gameId}] impossible score raw=${rawScore} pt=${clientPT} in ${Math.round(elapsedMs / 1e3)}s (cap=${maxForTime})`).catch(() => {
              });
            } else {
              session.serverPT = Math.max(session.serverPT, Math.min(clientPT, spec.maxPT, maxForTime));
              console.log(`[ws/game][${session.gameId}] reconciled: raw=${rawScore} pt=${clientPT} perHit=${session.hits * WS_PT_PER_HIT} elapsed=${Math.round(elapsedMs / 1e3)}s cap=${maxForTime} final=${session.serverPT} (${session.pbId})`);
            }
          }
          await wsCommitSession(sid, session);
          send2({ type: "COMMITTED", serverPT: session.serverPT, matchId: sid });
          break;
        }
      }
    });
    ws.on("close", () => {
      if (!sid) return;
      const session = wsSessions.get(sid);
      if (!session || session.committed) return;
      if (session.hits > 0 || session.serverPT > 0) {
        wsCommitSession(sid, session).catch(() => {
        });
      } else {
        if (session.timer) clearTimeout(session.timer);
        session.committed = true;
        if (session.logId) {
          pbPatch2(`/api/collections/game_score/records/${session.logId}`, {
            match_status: "expired"
          }).catch(() => {
          });
        }
        wsSessions.delete(sid);
      }
    });
  });
}
async function pbGet2(path2) {
  const token = await getAdminToken2();
  return pbHttp2("GET", path2, null, token);
}
async function pbPost2(path2, body) {
  const token = await getAdminToken2();
  return pbHttp2("POST", path2, body, token);
}
async function pbPatch2(path2, body) {
  const token = await getAdminToken2();
  return pbHttp2("PATCH", path2, body, token);
}
async function pbDelete2(path2) {
  const token = await getAdminToken2();
  return pbHttp2("DELETE", path2, null, token);
}
async function sendOtpEmail(to, otp) {
  const envUser = process.env.SMTP_USER || "a52a0a001@smtp-brevo.com";
  const envKey = process.env.SMTP_KEY || "";
  if (!envKey) {
    throw new Error("SMTP_KEY environment variable is not set \u2014 cannot send email.");
  }
  const smtpUser = envUser.startsWith("xsmtpsib-") ? "a52a0a001@smtp-brevo.com" : envUser;
  const smtpPass = envUser.startsWith("xsmtpsib-") ? envUser : envKey;
  const htmlBody = `
<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#111;color:#fff;border-radius:16px;">
  <h2 style="color:#FF6B00;margin:0 0 6px;font-size:22px;">Shiba Hit</h2>
  <p style="color:#999;font-size:13px;margin:0 0 28px;">Account Deletion Request</p>
  <p style="color:#ccc;margin:0 0 20px;">Enter the code below inside the app to confirm your account deletion. <strong>Do not click any links</strong> \u2014 just type the digits.</p>
  <div style="background:#1e1e1e;border:1px solid #333;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px;">
    <p style="color:#888;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin:0 0 10px;">Your 6-Digit Code</p>
    <p style="color:#FFD700;font-size:44px;font-weight:bold;letter-spacing:16px;margin:0;font-family:monospace;">${otp}</p>
  </div>
  <p style="color:#888;font-size:13px;margin:0 0 6px;">\u23F1 Expires in <strong style="color:#fff;">5 minutes</strong>.</p>
  <p style="color:#888;font-size:13px;margin:0 0 24px;">If you didn't request this, you can safely ignore this email \u2014 your account is safe.</p>
  <hr style="border:none;border-top:1px solid #222;margin:0 0 16px;"/>
  <p style="color:#555;font-size:12px;margin:0;">Shiba Hit &nbsp;&bull;&nbsp; support@shibahit.com</p>
</div>`;
  const ports = [
    { port: 465, secure: true },
    { port: 587, secure: false },
    { port: 2525, secure: false }
  ];
  let lastErr = null;
  for (const { port, secure } of ports) {
    console.log(`[SMTP] Trying smtp-relay.brevo.com:${port} secure=${secure} user=${smtpUser} key-ends=${smtpPass.slice(-8)} to=${to}`);
    try {
      const transporter = nodemailer.createTransport({
        host: "smtp-relay.brevo.com",
        port,
        secure,
        auth: { user: smtpUser, pass: smtpPass },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 1e4,
        greetingTimeout: 1e4,
        socketTimeout: 15e3
      });
      await transporter.sendMail({
        from: '"Shiba Hit" <support@shibahit.com>',
        to,
        subject: "Your Shiba Hit Account Deletion OTP",
        html: htmlBody,
        text: `Your 6-digit security code is: ${otp}

Expires in 5 minutes. Do not share it.

\u2014 Shiba Hit Team`
      });
      console.log(`[SMTP] Email delivered to ${to} via port ${port} \u2713`);
      return;
    } catch (err) {
      console.warn(`[SMTP] Port ${port} failed: ${err?.message}`);
      lastErr = err;
      if (err?.responseCode === 535) break;
    }
  }
  throw lastErr ?? new Error("All SMTP ports failed");
}
async function backfillWithdrawalMaskedNames() {
  try {
    const col = await pbGet2("/api/collections/withdrawals");
    if (!col.code) {
      const hasField = (col.fields || []).some((f) => f.name === "masked_name");
      const hasReason = (col.fields || []).some((f) => f.name === "cancellation_reason");
      if (!hasField || !hasReason) {
        const token = await getAdminToken2();
        const newFields = [];
        if (!hasField) newFields.push({ name: "masked_name", type: "text", required: false });
        if (!hasReason) newFields.push({ name: "cancellation_reason", type: "text", required: false });
        const updatedFields = [...col.fields || [], ...newFields];
        await pbHttp2("PATCH", `/api/collections/${col.id}`, { fields: updatedFields }, token);
        console.log("[withdrawals] masked_name / cancellation_reason fields added \u2713");
      }
    }
    const statuses = ["completed", "approved"];
    for (const status of statuses) {
      let page = 1;
      while (true) {
        const batch = await pbGet2(
          `/api/collections/withdrawals/records?filter=${encodeURIComponent(`status="${status}" && masked_name=""`)}&expand=user&sort=-created&perPage=50&page=${page}`
        );
        const items = batch.items || [];
        if (!items.length) break;
        for (const w of items) {
          let name = w.expand?.user?.display_name || w.expand?.user?.username || "";
          if (name.includes("@")) name = name.split("@")[0];
          if (!name) continue;
          await pbPatch2(`/api/collections/withdrawals/records/${w.id}`, { masked_name: name }).catch(() => {
          });
        }
        if (batch.totalPages <= page) break;
        page++;
      }
    }
    console.log("[withdrawals] masked_name backfill complete \u2713");
  } catch (e) {
    console.warn("[withdrawals] masked_name backfill failed:", e.message);
  }
}
async function ensureWithdrawalRedeemMethod() {
  try {
    const col = await pbGet2("/api/collections/withdrawals");
    if (col.code) return;
    const usesSchemaKey = Array.isArray(col.schema);
    const schema = col.schema || col.fields || [];
    const methodField = schema.find((f) => f.name === "method");
    if (!methodField) return;
    const holder = Array.isArray(methodField.values) ? methodField : methodField.options && Array.isArray(methodField.options.values) ? methodField.options : null;
    if (!holder) return;
    if (holder.values.includes("Hit Ticket Redeem")) return;
    holder.values = [...holder.values, "Hit Ticket Redeem"];
    const token = await getAdminToken2();
    await pbHttp2("PATCH", `/api/collections/${col.id}`, usesSchemaKey ? { schema } : { fields: schema }, token);
    console.log('[withdrawals] method select \u2192 added "Hit Ticket Redeem" \u2713');
  } catch (e) {
    console.warn("[withdrawals] ensureWithdrawalRedeemMethod failed:", e?.message);
  }
}
async function setupSoloGameConfig() {
  try {
    const token = await getAdminToken2();
    const check = await pbGet2("/api/collections/solo_game_config");
    if (check.code) {
      await pbHttp2("POST", "/api/collections", {
        name: "solo_game_config",
        type: "base",
        fields: [
          { name: "game_id", type: "text", required: true },
          { name: "game_name", type: "text", required: false },
          { name: "pt_multiplier", type: "number", required: true },
          { name: "max_pt", type: "number", required: true },
          { name: "max_raw_score", type: "number", required: true },
          { name: "max_pt_per_sec", type: "number", required: true }
        ],
        listRule: "",
        // public read — client can display multipliers
        viewRule: "",
        createRule: null,
        // admin/server only
        updateRule: null,
        deleteRule: null
      }, token);
      console.log("[solo_game_config] Collection created \u2713");
    } else {
      console.log("[solo_game_config] Collection already exists \u2713");
    }
    const defaults = [
      { game_id: "weapon_master", game_name: "Weapon Master", pt_multiplier: 1, max_pt: 2e3, max_raw_score: 2e3, max_pt_per_sec: 15 },
      { game_id: "flappy", game_name: "Flappy Bounce", pt_multiplier: 15, max_pt: 1800, max_raw_score: 120, max_pt_per_sec: 25 },
      { game_id: "fruitcut", game_name: "Fruit Cut", pt_multiplier: 0.5, max_pt: 2e3, max_raw_score: 4e3, max_pt_per_sec: 30 },
      { game_id: "color", game_name: "Color Rush", pt_multiplier: 20, max_pt: 2e3, max_raw_score: 100, max_pt_per_sec: 25 }
    ];
    for (const row of defaults) {
      const existing = await pbGet2(
        `/api/collections/solo_game_config/records?filter=${encodeURIComponent(`game_id="${row.game_id}"`)}&perPage=1`
      );
      if (!existing.items?.length) {
        await pbPost2("/api/collections/solo_game_config/records", row);
        console.log(`[solo_game_config] Seeded default for ${row.game_id} \u2713`);
      }
    }
    await refreshSoloGameSpecsCache();
    setInterval(refreshSoloGameSpecsCache, 5 * 60 * 1e3);
  } catch (e) {
    console.warn("[solo_game_config] setup failed (using hardcoded defaults):", e.message);
  }
}
async function ensureDailyUsageCollection() {
  try {
    const check = await pbGet2("/api/collections/daily_usage");
    if (!check.code) return;
    const token = await getAdminToken2();
    await pbHttp2("POST", "/api/collections", {
      name: "daily_usage",
      type: "base",
      fields: [
        { name: "date_day", type: "text", required: true },
        { name: "count", type: "number", required: true }
      ]
    }, token);
    console.log("[daily_usage] Collection created in PocketBase");
  } catch (e) {
    console.warn("[daily_usage] Could not auto-create collection:", e.message);
  }
}
async function checkAndIncrementDailyEmailLimit() {
  const today = (/* @__PURE__ */ new Date()).toISOString().substring(0, 10);
  try {
    const result = await pbGet2(
      `/api/collections/daily_usage/records?filter=${encodeURIComponent(`date_day="${today}"`)}&perPage=1`
    );
    if (result.items && result.items.length > 0) {
      const rec = result.items[0];
      if (rec.count >= 300) {
        console.warn(`[daily_usage] Daily OTP limit reached: ${rec.count} emails sent today`);
        return { allowed: false, message: "Daily limit reached. Please try again after 24 hours." };
      }
      await pbPatch2(`/api/collections/daily_usage/records/${rec.id}`, { count: rec.count + 1 });
      console.log(`[daily_usage] Email count for ${today}: ${rec.count + 1}`);
    } else {
      await pbPost2("/api/collections/daily_usage/records", { date_day: today, count: 1 });
      console.log(`[daily_usage] New daily usage record created for ${today}`);
    }
    return { allowed: true };
  } catch (e) {
    console.warn("[daily_usage] Could not check limit (allowing anyway):", e.message);
    return { allowed: true };
  }
}
async function ensureOtpCollection() {
  try {
    const check = await pbGet2("/api/collections/otp_codes");
    const token = await getAdminToken2();
    if (check.code) {
      await pbHttp2("POST", "/api/collections", {
        name: "otp_codes",
        type: "base",
        fields: [
          { name: "user", type: "relation", required: true, options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
          { name: "code", type: "text", required: true },
          { name: "expires_at", type: "date", required: true }
        ],
        listRule: "user = @request.auth.id",
        viewRule: "user = @request.auth.id",
        createRule: '@request.auth.id != ""',
        updateRule: null,
        deleteRule: "user = @request.auth.id"
      }, token);
      console.log("[otp_codes] Collection created with correct API rules");
    } else {
      await pbHttp2("PATCH", `/api/collections/${check.id}`, {
        listRule: "user = @request.auth.id",
        viewRule: "user = @request.auth.id",
        createRule: '@request.auth.id != ""',
        updateRule: null,
        deleteRule: "user = @request.auth.id"
      }, token);
      console.log("[otp_codes] API rules patched \u2014 authenticated users can manage their own OTPs");
    }
  } catch (e) {
    console.warn("[otp_codes] Could not setup collection:", e.message);
  }
}
var ALLOWED_BOOSTER_MULTIPLIERS = /* @__PURE__ */ new Set([2, 4, 6, 10]);
var VALID_SESSION_MULTIPLIERS = /* @__PURE__ */ new Set([1, 2, 4, 6, 10]);
function securityLog(route, msg, extra) {
  console.warn(`[SECURITY] ${route} \u2014 ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
}
async function verifyCallerOwnsPbId(req, pbId) {
  try {
    const raw = String(req.headers.authorization || "");
    const token = raw.replace(/^Bearer\s+/i, "").trim();
    if (!token || !pbId) return false;
    const r = await fetch(
      `${PB_URL2}/api/collections/users/records/${encodeURIComponent(pbId)}?fields=id`,
      { headers: { Authorization: token } }
    );
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return j?.id === pbId;
  } catch {
    return false;
  }
}
async function requireCallerIdentity(req, res, pbId, route) {
  const ok = await verifyCallerOwnsPbId(req, pbId);
  if (!ok) {
    securityLog(route, "identity check failed \u2014 missing/invalid token or token does not own pbId", {
      pbId,
      ip: String(req.ip || req.socket?.remoteAddress || "")
    });
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Session verification failed. Please sign in again (or update the app)."
    });
    return false;
  }
  return true;
}
async function processPendingReferralLog(userId) {
  try {
    const pending = await pbGet2(
      `/api/collections/referral_earnings_log/records?filter=${encodeURIComponent(`referrer_id="${userId}" && processed=false`)}&perPage=200`
    );
    const items = pending.items || [];
    if (!items.length) return;
    const latched = [];
    for (const r of items) {
      const p = await pbPatch2(`/api/collections/referral_earnings_log/records/${r.id}`, { processed: true });
      if (!p.code) latched.push(r);
    }
    const total = latched.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    if (total <= 0) return;
    const u = await pbGet2(`/api/collections/users/records/${userId}?fields=id,referral_balance,referral_earnings`);
    if (u.code) return;
    await pbPatch2(`/api/collections/users/records/${userId}`, {
      referral_balance: (Number(u.referral_balance) || 0) + total,
      referral_earnings: (Number(u.referral_earnings) || 0) + total
    });
    console.log(`[referral_earnings_log] Server-processed ${latched.length} pending entries \u2192 +${total} referral_balance for ${userId}`);
  } catch (e) {
    console.warn("[referral_earnings_log] server-side processing failed:", e.message);
  }
}
async function ensureCollectionRules() {
  try {
    const token = await getAdminToken2();
    const usersCol = await pbGet2("/api/collections/users");
    if (!usersCol.code) {
      await pbHttp2("PATCH", `/api/collections/${usersCol.id}`, {
        // Anyone authenticated can list (needed for leaderboard)
        listRule: '@request.auth.id != ""',
        // A user can view their own record — needed so pbGetSelf() works in APK
        viewRule: "@request.auth.id = id",
        // Public creation kept for APK signup when Express is unreachable, BUT
        // every economic field is now value-capped: money fields may only be
        // the exact starter values (or omitted); server-managed fields must be
        // omitted entirely. An attacker can no longer create a pre-loaded account.
        createRule: '(@request.data.shib_balance:isset = false || @request.data.shib_balance = 100) && (@request.data.power_tokens:isset = false || @request.data.power_tokens = 500) && (@request.data.referral_balance:isset = false || @request.data.referral_balance = 0) && (@request.data.referral_earnings:isset = false || @request.data.referral_earnings = 0) && (@request.data.total_claims:isset = false || @request.data.total_claims = 0) && (@request.data.total_wins:isset = false || @request.data.total_wins = 0) && (@request.data.fraud_attempts:isset = false || @request.data.fraud_attempts = 0) && (@request.data.status:isset = false || @request.data.status = "active") && @request.data.vip_level:isset = false && @request.data.hit_tickets:isset = false && @request.data.active_booster_multiplier:isset = false && @request.data.booster_expires:isset = false && @request.data.current_mining_session:isset = false && @request.data.daily_streak:isset = false && @request.data.last_daily_claim:isset = false && @request.data.weekly_tournament_points:isset = false && @request.data.is_admin_promoted:isset = false && @request.data.admin_promoted_level:isset = false && @request.data.kyc_status:isset = false && @request.data.is_blacklist_1:isset = false && @request.data.is_blacklist_2:isset = false',
        // SECURITY LOCKDOWN: a user may update their own record, but every
        // money/progression field is server-managed ONLY (`:isset = false`
        // guards). This closes the attack where a stolen/derived PB user token
        // wrote shib_balance / vip_level / booster fields directly.
        // Money now moves EXCLUSIVELY through Express routes (admin token).
        //
        // Referral commissions: the server credits the referrer directly on
        // mine/claim, and pending referral_earnings_log entries are processed
        // server-side on login (processPendingReferralLog).
        updateRule: "@request.auth.id = id && @request.data.kyc_status:isset = false && @request.data.kyc_country:isset = false && @request.data.kyc_country_code:isset = false && @request.data.kyc_full_name:isset = false && @request.data.kyc_phone:isset = false && @request.data.kyc_binance_email:isset = false && @request.data.kyc_bep20_address:isset = false && @request.data.kyc_reject_reason:isset = false && @request.data.submission_count:isset = false && @request.data.wa_verified_phone:isset = false && @request.data.wa_verified_at:isset = false && @request.data.hit_tickets:isset = false && @request.data.shib_balance:isset = false && @request.data.power_tokens:isset = false && @request.data.vip_level:isset = false && @request.data.referral_balance:isset = false && @request.data.referral_earnings:isset = false && @request.data.active_booster_multiplier:isset = false && @request.data.booster_expires:isset = false && @request.data.current_mining_session:isset = false && @request.data.total_claims:isset = false && @request.data.total_wins:isset = false && @request.data.daily_streak:isset = false && @request.data.last_daily_claim:isset = false && @request.data.weekly_tournament_points:isset = false && @request.data.fraud_attempts:isset = false && @request.data.status:isset = false && @request.data.is_admin_promoted:isset = false && @request.data.admin_promoted_level:isset = false && @request.data.is_blacklist_1:isset = false && @request.data.is_blacklist_2:isset = false && @request.data.blacklist_1_notified:isset = false && @request.data.blacklist_1_notified_at:isset = false",
        // Allow a user to delete ONLY their own record (needed for APK account deletion flow)
        deleteRule: "@request.auth.id = id"
      }, token);
      console.log("[users] listRule + viewRule + createRule + updateRule + deleteRule patched \u2014 APK self-CRUD enabled");
    }
    const deCol = await pbGet2("/api/collections/deleted_emails");
    if (!deCol.code) {
      await pbHttp2("PATCH", `/api/collections/${deCol.id}`, {
        listRule: "",
        // public read — APK can check at sign-up without a PB session
        viewRule: "",
        createRule: '@request.auth.id != ""',
        updateRule: null,
        deleteRule: null
      }, token);
      console.log("[deleted_emails] rules patched \u2014 public read, authenticated create");
    }
    const feCol = await pbGet2("/api/collections/fraud_emails");
    if (!feCol.code) {
      await pbHttp2("PATCH", `/api/collections/${feCol.id}`, {
        listRule: "",
        viewRule: "",
        createRule: '@request.auth.id != ""',
        updateRule: null,
        deleteRule: null
      }, token);
      console.log("[fraud_emails] rules patched \u2014 public read, authenticated create");
    }
  } catch (e) {
    console.warn("[ensureCollectionRules] Patch failed:", e.message);
  }
}
async function ensureMiningSessionsRules() {
  try {
    const token = await getAdminToken2();
    const col = await pbGet2("/api/collections/mining_sessions");
    if (col.code) {
      console.warn("[mining_sessions] Collection not found \u2014 skipping rules patch");
      return;
    }
    const sessSchema = col.schema || [];
    if (!sessSchema.find((f) => f.name === "vip_level")) {
      sessSchema.push({ name: "vip_level", type: "number", required: false });
      await pbHttp2("PATCH", `/api/collections/${col.id}`, { schema: sessSchema }, token);
      console.log("[mining_sessions] Added vip_level field");
    }
    await pbHttp2("PATCH", `/api/collections/${col.id}`, {
      // User can list/view only their own sessions
      listRule: "user = @request.auth.id",
      viewRule: "user = @request.auth.id",
      // SECURITY LOCKDOWN: sessions are created and claimed EXCLUSIVELY by the
      // Express server (admin token). The old client-writable rules let an
      // attacker inject sessions with booster_multiplier=100000000 and forge
      // claimed_amount directly. createRule/updateRule = null closes both.
      createRule: null,
      updateRule: null,
      // No user deletion — sessions are permanent audit records
      deleteRule: null
    }, token);
    console.log("[mining_sessions] Rules locked down \u2014 server-only create/update \u2713");
  } catch (e) {
    console.warn("[mining_sessions] Rules patch failed:", e.message);
  }
}
async function ensureReferralEarningsLogCollection() {
  try {
    const token = await getAdminToken2();
    const check = await pbGet2("/api/collections/referral_earnings_log");
    if (!check.code) {
      const patchRes2 = await pbHttp2("PATCH", `/api/collections/${check.id}`, {
        listRule: "referrer_id = @request.auth.id",
        viewRule: "referrer_id = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null
      }, token);
      if (!patchRes2.code) {
        console.log("[referral_earnings_log] Rules locked down \u2014 server-only writes \u2713");
      }
      return;
    }
    const created = await pbHttp2("POST", "/api/collections", {
      name: "referral_earnings_log",
      type: "base",
      schema: [
        { name: "referrer_id", type: "text", required: true },
        { name: "claimer_id", type: "text", required: true },
        { name: "amount", type: "number", required: true },
        { name: "processed", type: "bool", required: false }
      ]
    }, token);
    if (created.code) {
      console.warn("[referral_earnings_log] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    console.log("[referral_earnings_log] Collection created \u2014 patching rules...");
    const patchRes = await pbHttp2("PATCH", `/api/collections/${created.id}`, {
      listRule: "referrer_id = @request.auth.id",
      viewRule: "referrer_id = @request.auth.id",
      createRule: null,
      updateRule: null,
      deleteRule: null
    }, token);
    if (patchRes.code) {
      console.warn("[referral_earnings_log] Rules patch failed:", JSON.stringify(patchRes).slice(0, 200));
    } else {
      console.log("[referral_earnings_log] Secure referral payout pipeline active (server-only writes)");
    }
  } catch (e) {
    console.warn("[referral_earnings_log] Setup failed:", e.message);
  }
}
async function ensureSessionLogsCollection() {
  try {
    const token = await getAdminToken2();
    const check = await pbGet2("/api/collections/session_logs");
    if (!check.code) {
      console.log("[session_logs] Collection already exists \u2713");
      return;
    }
    const created = await pbHttp2("POST", "/api/collections", {
      name: "session_logs",
      type: "base",
      schema: [
        { name: "user", type: "text", required: true },
        { name: "session_type", type: "text", required: true },
        { name: "income", type: "number", required: false },
        { name: "booster_multiplier", type: "number", required: false },
        { name: "duration_seconds", type: "number", required: false }
      ]
    }, token);
    if (created.code) {
      console.warn("[session_logs] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    await pbHttp2("PATCH", `/api/collections/${created.id}`, {
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null
    }, token);
    console.log("[session_logs] Collection created \u2713");
  } catch (e) {
    console.warn("[session_logs] Setup failed:", e.message);
  }
}
async function ensurePerfLogsCollection() {
  try {
    const token = await getAdminToken2();
    const check = await pbGet2("/api/collections/perf_logs");
    if (!check.code) {
      console.log("[perf_logs] Collection already exists \u2713");
      return;
    }
    const created = await pbHttp2("POST", "/api/collections", {
      name: "perf_logs",
      type: "base",
      schema: [
        { name: "user", type: "text", required: true },
        { name: "game_id", type: "text", required: true },
        { name: "session_kind", type: "text", required: false },
        // 'match' | 'practice'
        { name: "device_model", type: "text", required: false },
        { name: "os", type: "text", required: false },
        { name: "avg_fps", type: "number", required: false },
        { name: "min_fps", type: "number", required: false },
        { name: "render_scale", type: "number", required: false }
      ]
    }, token);
    if (created.code) {
      console.warn("[perf_logs] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    await pbHttp2("PATCH", `/api/collections/${created.id}`, {
      listRule: null,
      viewRule: null,
      createRule: '@request.auth.id != ""',
      updateRule: null,
      deleteRule: null
    }, token);
    console.log("[perf_logs] Collection created \u2713");
  } catch (e) {
    console.warn("[perf_logs] Setup failed:", e.message);
  }
}
async function ensureGameScoreCollection() {
  try {
    const token = await getAdminToken2();
    const check = await pbGet2("/api/collections/game_score");
    if (!check.code) {
      console.log("[game_score] Collection already exists \u2713");
      const existingNames = (check.schema || check.fields || []).map((f) => f.name);
      if (!existingNames.includes("user_id")) {
        const updatedSchema = [
          ...check.schema || check.fields || [],
          { name: "user_id", type: "text", required: false }
        ];
        await pbHttp2("PATCH", `/api/collections/${check.id}`, { schema: updatedSchema }, token);
        console.log("[game_score] user_id field added \u2713");
      } else {
        console.log("[game_score] user_id field already present \u2713");
      }
      return;
    }
    const usersColl = await pbGet2("/api/collections/users");
    if (usersColl.code || !usersColl.id) {
      console.warn("[game_score] users collection lookup failed \u2014 cannot create");
      return;
    }
    const created = await pbHttp2("POST", "/api/collections", {
      name: "game_score",
      type: "base",
      schema: [
        {
          name: "user",
          type: "relation",
          required: true,
          options: { collectionId: usersColl.id, maxSelect: 1, cascadeDelete: false }
        },
        { name: "user_id", type: "text", required: false },
        { name: "match_id", type: "text", required: false },
        { name: "raw_score", type: "number", required: false },
        { name: "final_tokens", type: "number", required: false },
        { name: "is_double", type: "bool", required: false },
        { name: "match_status", type: "text", required: false }
      ]
    }, token);
    if (created.code) {
      console.warn("[game_score] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    await pbHttp2("PATCH", `/api/collections/${created.id}`, {
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null
    }, token);
    console.log("[game_score] Collection created \u2713");
  } catch (e) {
    console.warn("[game_score] Setup failed:", e.message);
  }
}
async function ensureGameHistoryCollection() {
  try {
    const token = await getAdminToken2();
    const rules = {
      listRule: "user = @request.auth.id",
      viewRule: "user = @request.auth.id",
      createRule: '@request.auth.id != "" && user = @request.auth.id',
      updateRule: null,
      // Delete is self-scoped so the client can prune its own rolling-100
      // match window (history is cosmetic — no money logic reads it).
      deleteRule: "user = @request.auth.id"
    };
    const check = await pbGet2("/api/collections/game_history");
    if (!check.code) {
      await pbHttp2("PATCH", `/api/collections/${check.id}`, rules, token);
      console.log("[game_history] Collection already exists \u2713 (rules re-asserted)");
      return;
    }
    const usersColl = await pbGet2("/api/collections/users");
    if (usersColl.code || !usersColl.id) {
      console.warn("[game_history] users collection lookup failed \u2014 cannot create");
      return;
    }
    const created = await pbHttp2("POST", "/api/collections", {
      name: "game_history",
      type: "base",
      schema: [
        {
          name: "user",
          type: "relation",
          required: true,
          options: { collectionId: usersColl.id, maxSelect: 1, cascadeDelete: false }
        },
        { name: "game", type: "text", required: false },
        // display name e.g. "Tower Stack"
        { name: "outcome", type: "text", required: false },
        // win | loss | draw | redeem
        { name: "tickets_won", type: "number", required: false },
        // Hit Tickets credited (win)
        { name: "tokens_lost", type: "number", required: false },
        // PT stake lost (loss) / tickets spent (redeem)
        { name: "pt_won", type: "number", required: false },
        // Power Tokens earned (solo claim)
        { name: "shib_won", type: "number", required: false }
        // SHIB credited (redeem)
      ]
    }, token);
    if (created.code) {
      console.warn("[game_history] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    await pbHttp2("PATCH", `/api/collections/${created.id}`, rules, token);
    console.log("[game_history] Collection created \u2713");
  } catch (e) {
    console.warn("[game_history] Setup failed:", e.message);
  }
}
var MATCH_CLAIM_WINDOW_MS = 10 * 6e4;
function startMatchExpirySweeper() {
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - MATCH_CLAIM_WINDOW_MS).toISOString().replace("T", " ");
      const filter = encodeURIComponent(
        `(match_status="active" || match_status="started") && updated < "${cutoff}"`
      );
      const page = await pbGet2(`/api/collections/game_score/records?filter=${filter}&perPage=50&fields=id`);
      const ids = (page?.items || []).map((r) => r.id);
      for (const id of ids) {
        await pbPatch2(`/api/collections/game_score/records/${id}`, { match_status: "expired" }).catch(() => {
        });
      }
      if (ids.length) console.log(`[game_score] sweeper: expired ${ids.length} stale match(es)`);
    } catch {
    }
  }, 6e4).unref();
}
async function ensureIsFlaggedField() {
  try {
    const token = await getAdminToken2();
    const coll = await pbGet2("/api/collections/users");
    if (coll.code) return;
    const existingNames = (coll.schema || coll.fields || []).map((f) => f.name);
    if (existingNames.includes("is_flagged")) {
      console.log("[users] is_flagged / flag_reason already present \u2713");
      return;
    }
    const updatedSchema = [
      ...coll.schema || coll.fields || [],
      { name: "is_flagged", type: "bool", required: false },
      { name: "flag_reason", type: "text", required: false }
    ];
    await pbHttp2("PATCH", `/api/collections/${coll.id}`, { schema: updatedSchema }, token);
    console.log("[users] is_flagged + flag_reason fields added \u2713");
  } catch (e) {
    console.warn("[users] is_flagged migration failed:", e.message);
  }
}
async function ensureBlacklistFields() {
  try {
    const token = await getAdminToken2();
    const coll = await pbGet2("/api/collections/users");
    if (coll.code) return;
    const existingNames = (coll.schema || coll.fields || []).map((f) => f.name);
    if (existingNames.includes("is_blacklist_1")) {
      console.log("[users] blacklist tier fields already present \u2713");
      return;
    }
    const updatedSchema = [
      ...coll.schema || coll.fields || [],
      { name: "is_blacklist_1", type: "bool", required: false },
      { name: "is_blacklist_2", type: "bool", required: false },
      { name: "blacklist_1_notified", type: "bool", required: false },
      { name: "blacklist_1_notified_at", type: "text", required: false }
    ];
    await pbHttp2("PATCH", `/api/collections/${coll.id}`, { schema: updatedSchema }, token);
    console.log("[users] blacklist tier fields added \u2713");
  } catch (e) {
    console.warn("[users] blacklist migration failed:", e.message);
  }
}
async function ensureSessionTokenField() {
  try {
    const token = await getAdminToken2();
    const coll = await pbGet2("/api/collections/users");
    if (coll.code) return;
    const existingNames = (coll.schema || coll.fields || []).map((f) => f.name);
    if (existingNames.includes("session_token")) {
      console.log("[users] session_token field already present \u2713");
      return;
    }
    const updatedSchema = [
      ...coll.schema || coll.fields || [],
      { name: "session_token", type: "text", required: false }
    ];
    await pbHttp2("PATCH", `/api/collections/${coll.id}`, { schema: updatedSchema }, token);
    console.log("[users] session_token field added \u2713 (single-session enforcement)");
  } catch (e) {
    console.warn("[users] session_token migration failed:", e.message);
  }
}
var KYC_STATUS_UNDER_REVIEW = "Under Review";
var KYC_STATUS_VERIFIED = "Verified";
var KYC_STATUS_REJECTED = "Rejected";
var KYC_STATUS_OPTIONS = [KYC_STATUS_UNDER_REVIEW, KYC_STATUS_VERIFIED, KYC_STATUS_REJECTED];
var TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
var TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "Shibahit_Bot";
var TELEGRAM_WEBHOOK_SECRET = crypto.createHash("sha256").update(`shibahit-tg-${TELEGRAM_BOT_TOKEN}`).digest("hex").slice(0, 40);
async function tgApi(method, body) {
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return resp.json();
}
async function ensureTelegramVerificationsCollection() {
  try {
    const token = await getAdminToken2();
    const check = await pbGet2("/api/collections/telegram_verifications");
    if (check.code) {
      const created = await pbHttp2("POST", "/api/collections", {
        name: "telegram_verifications",
        type: "base",
        schema: [
          { name: "token", type: "text", required: true },
          { name: "user", type: "text", required: true },
          { name: "phone", type: "text", required: true },
          { name: "status", type: "text", required: false },
          { name: "chat_id", type: "text", required: false },
          { name: "tg_user_id", type: "text", required: false }
        ],
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null
      }, token);
      if (created.code) {
        console.warn("[telegram] collection create FAILED:", JSON.stringify(created).slice(0, 200));
      } else {
        console.log("[telegram] telegram_verifications collection created \u2713");
      }
    } else {
      console.log("[telegram] telegram_verifications \u2713");
    }
  } catch (e) {
    console.warn("[telegram] Could not ensure telegram_verifications:", e.message);
  }
  registerTelegramWebhook().catch((e) => console.warn("[telegram] webhook registration failed:", e.message));
}
async function registerTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set \u2014 webhook registration skipped, phone verification disabled");
    return;
  }
  if (process.env.REPLIT_DEV_DOMAIN && !process.env.TELEGRAM_WEBHOOK_BASE && process.env.TELEGRAM_DEV_WEBHOOK !== "1") {
    console.log("[telegram] dev sandbox \u2014 webhook registration skipped (prod owns the webhook; set TELEGRAM_DEV_WEBHOOK=1 to test locally)");
    return;
  }
  const base = process.env.TELEGRAM_WEBHOOK_BASE || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "https://backend.webcod.in");
  const r = await tgApi("setWebhook", {
    url: `${base}/api/app/telegram/webhook`,
    secret_token: TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"]
  });
  if (r?.ok) console.log(`[telegram] webhook registered \u2192 ${base}/api/app/telegram/webhook \u2713`);
  else console.warn("[telegram] setWebhook failed:", JSON.stringify(r).slice(0, 200));
}
function toDbKycStatus(v) {
  const k = String(v ?? "").trim().toLowerCase().replace(/[\s_]+/g, "_");
  if (k === "under_review" || k === "pending") return KYC_STATUS_UNDER_REVIEW;
  if (k === "verified" || k === "approved") return KYC_STATUS_VERIFIED;
  if (k === "rejected" || k === "unverified") return KYC_STATUS_REJECTED;
  return String(v ?? "");
}
async function ensureVerificationSchema() {
  try {
    const token = await getAdminToken2();
    const coll = await pbGet2("/api/collections/users");
    if (!coll.code) {
      const existingNames = (coll.schema || coll.fields || []).map((f) => f.name);
      const wanted = [
        "kyc_status",
        "kyc_reject_reason",
        "kyc_full_name",
        "kyc_country",
        "kyc_country_code",
        "kyc_phone",
        "kyc_binance_email",
        "kyc_bep20_address",
        // Verified phone (Telegram share-contact): proven number + when
        "wa_verified_phone",
        "wa_verified_at"
      ];
      const missing = wanted.filter((n) => !existingNames.includes(n));
      const needsCount = !existingNames.includes("submission_count");
      if (missing.length || needsCount) {
        const updatedSchema = [
          ...coll.schema || coll.fields || [],
          ...missing.map((name) => ({ name, type: "text", required: false })),
          ...needsCount ? [{ name: "submission_count", type: "number", required: false }] : []
        ];
        await pbHttp2("PATCH", `/api/collections/${coll.id}`, { schema: updatedSchema }, token);
        console.log(`[users] KYC fields added: ${[...missing, ...needsCount ? ["submission_count"] : []].join(", ")} \u2713`);
      } else {
        console.log("[users] KYC fields already present \u2713");
      }
    }
    const check = await pbGet2("/api/collections/verification_requests");
    if (!check.code) {
      console.log("[verification_requests] Collection already exists \u2713");
      await ensureKycStatusSelectField(check, token);
      await ensureRequestPhoneVerifiedField(token);
      return;
    }
    const usersColl = await pbGet2("/api/collections/users");
    if (usersColl.code || !usersColl.id) {
      console.warn("[verification_requests] users collection lookup failed \u2014 cannot create");
      return;
    }
    const created = await pbHttp2("POST", "/api/collections", {
      name: "verification_requests",
      type: "base",
      schema: [
        {
          name: "user",
          type: "relation",
          required: true,
          options: { collectionId: usersColl.id, maxSelect: 1, cascadeDelete: false }
        },
        { name: "full_name", type: "text", required: false },
        { name: "country", type: "text", required: false },
        { name: "country_code", type: "text", required: false },
        { name: "phone", type: "text", required: false },
        { name: "binance_email", type: "text", required: false },
        { name: "bep20_address", type: "text", required: false },
        // true when the submitted number matched the user's WhatsApp-OTP-verified number
        { name: "phone_verified", type: "bool", required: false },
        // PB SELECT — 'Under Review' | 'Verified' | 'Rejected'
        {
          name: "status",
          type: "select",
          required: false,
          options: { maxSelect: 1, values: KYC_STATUS_OPTIONS }
        },
        { name: "reject_reason", type: "text", required: false }
      ]
    }, token);
    if (created.code) {
      console.warn("[verification_requests] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    await pbHttp2("PATCH", `/api/collections/${created.id}`, {
      listRule: "user = @request.auth.id",
      viewRule: "user = @request.auth.id",
      createRule: null,
      updateRule: null,
      deleteRule: null
    }, token);
    console.log("[verification_requests] Collection created \u2713");
  } catch (e) {
    console.warn("[verification_requests] Setup failed:", e.message);
  }
}
async function ensureRequestPhoneVerifiedField(token) {
  try {
    const coll = await pbGet2("/api/collections/verification_requests");
    if (coll.code) return;
    const fields = coll.schema || coll.fields || [];
    if (fields.some((f) => f.name === "phone_verified")) {
      console.log("[verification_requests] phone_verified field present \u2713");
      return;
    }
    await pbHttp2("PATCH", `/api/collections/${coll.id}`, {
      schema: [...fields, { name: "phone_verified", type: "bool", required: false }]
    }, token);
    console.log("[verification_requests] phone_verified field added \u2713");
  } catch (e) {
    console.warn("[verification_requests] phone_verified ensure failed:", e.message);
  }
}
async function ensureKycStatusSelectField(coll, token) {
  try {
    const fields = coll.schema || coll.fields || [];
    const statusField = fields.find((f) => f.name === "status");
    if (!statusField) {
      console.warn("[verification_requests] no status field found \u2014 skipping SELECT conversion");
      return;
    }
    const values = statusField?.options?.values || statusField?.values || [];
    const alreadyCorrect = statusField.type === "select" && values.length === KYC_STATUS_OPTIONS.length && KYC_STATUS_OPTIONS.every((v) => values.includes(v));
    if (alreadyCorrect) {
      console.log("[verification_requests] status SELECT field OK \u2713");
      return;
    }
    const TMP = "status_select";
    if (!fields.find((f) => f.name === TMP)) {
      const addUpd = await pbHttp2("PATCH", `/api/collections/${coll.id}`, {
        schema: [
          ...fields,
          {
            name: TMP,
            type: "select",
            required: false,
            options: { maxSelect: 1, values: KYC_STATUS_OPTIONS }
          }
        ]
      }, token);
      if (addUpd.code) {
        console.warn("[verification_requests] temp SELECT field add FAILED:", JSON.stringify(addUpd).slice(0, 200));
        return;
      }
    }
    const rows = [];
    let page = 1;
    for (; ; ) {
      const r = await pbGet2(
        `/api/collections/verification_requests/records?page=${page}&perPage=200&fields=id,status,${TMP}`
      );
      rows.push(...r?.items || []);
      if (!r || page >= (r.totalPages || 1)) break;
      page++;
    }
    let migrated = 0;
    for (const row of rows) {
      const mapped = toDbKycStatus(row.status);
      if (!KYC_STATUS_OPTIONS.includes(mapped)) continue;
      if (row[TMP] === mapped) continue;
      const p = await pbHttp2(
        "PATCH",
        `/api/collections/verification_requests/records/${row.id}`,
        { [TMP]: mapped },
        token
      );
      if (!p.code) migrated++;
      else console.warn(`[verification_requests] row ${row.id} status copy failed:`, JSON.stringify(p).slice(0, 150));
    }
    const fresh = await pbGet2("/api/collections/verification_requests");
    const curFields = fresh.schema || fresh.fields || [];
    if (!curFields.length) {
      console.warn("[verification_requests] re-fetch for swap returned no fields \u2014 aborting");
      return;
    }
    const swapped = curFields.filter((f) => !(f.name === "status" && f.type !== "select")).map((f) => f.name === TMP ? { ...f, name: "status" } : f);
    const upd = await pbHttp2("PATCH", `/api/collections/${coll.id}`, { schema: swapped }, token);
    if (upd.code) {
      console.warn("[verification_requests] status \u2192 SELECT swap FAILED:", JSON.stringify(upd).slice(0, 200));
    } else {
      console.log(`[verification_requests] status \u2192 SELECT ['Under Review','Verified','Rejected'] \u2713 (migrated ${migrated} row value${migrated === 1 ? "" : "s"})`);
    }
  } catch (e) {
    console.warn("[verification_requests] status SELECT setup failed:", e.message);
  }
}
async function ensureReferralHistoryCollection() {
  try {
    const token = await getAdminToken2();
    const check = await pbGet2("/api/collections/referral_history");
    if (!check.code) {
      console.log("[referral_history] Collection already exists \u2713");
      return;
    }
    const created = await pbHttp2("POST", "/api/collections", {
      name: "referral_history",
      type: "base",
      schema: [
        { name: "referrer_id", type: "text", required: true },
        { name: "claimer_id", type: "text", required: true },
        { name: "referrer_email", type: "text", required: false },
        { name: "claimer_email", type: "text", required: false },
        { name: "amount", type: "number", required: true },
        { name: "source", type: "text", required: false }
        // "mining_claim" | "game_reward"
      ]
    }, token);
    if (created.code) {
      console.warn("[referral_history] Could not create collection:", JSON.stringify(created).slice(0, 200));
      return;
    }
    await pbHttp2("PATCH", `/api/collections/${created.id}`, {
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null
    }, token);
    console.log("[referral_history] Collection created \u2713");
  } catch (e) {
    console.warn("[referral_history] Setup failed:", e.message);
  }
}
async function ensureTasksCollection() {
  try {
    const token = await getAdminToken2();
    const check = await pbGet2("/api/collections/tasks");
    if (!check.code) {
      console.log("[tasks] Collection already exists \u2713");
      return;
    }
    const created = await pbHttp2("POST", "/api/collections", {
      name: "tasks",
      type: "base",
      schema: [
        { name: "title", type: "text", required: true },
        { name: "description", type: "text", required: false },
        { name: "link", type: "url", required: false },
        { name: "reward_amount", type: "number", required: true },
        { name: "reward_type", type: "text", required: true },
        { name: "is_active", type: "bool", required: false }
      ]
    }, token);
    if (created.code) {
      console.warn("[tasks] Could not create:", JSON.stringify(created).slice(0, 200));
      return;
    }
    await pbHttp2("PATCH", `/api/collections/${created.id}`, { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null }, token);
    console.log("[tasks] Collection created \u2713");
  } catch (e) {
    console.warn("[tasks] Setup failed:", e.message);
  }
}
async function ensureTaskSubmissionsCollection() {
  try {
    const token = await getAdminToken2();
    const check = await pbGet2("/api/collections/task_submissions");
    if (!check.code) {
      console.log("[task_submissions] Collection already exists \u2713");
      return;
    }
    const created = await pbHttp2("POST", "/api/collections", {
      name: "task_submissions",
      type: "base",
      schema: [
        { name: "user_id", type: "text", required: true },
        { name: "task_id", type: "text", required: true },
        { name: "task_title", type: "text", required: false },
        { name: "user_email", type: "text", required: false },
        { name: "proof_screenshot", type: "text", required: false },
        { name: "status", type: "text", required: true },
        { name: "admin_notes", type: "text", required: false },
        { name: "reward_amount", type: "number", required: false },
        { name: "reward_type", type: "text", required: false }
      ]
    }, token);
    if (created.code) {
      console.warn("[task_submissions] Could not create:", JSON.stringify(created).slice(0, 200));
      return;
    }
    await pbHttp2("PATCH", `/api/collections/${created.id}`, { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null }, token);
    console.log("[task_submissions] Collection created \u2713");
  } catch (e) {
    console.warn("[task_submissions] Setup failed:", e.message);
  }
}
async function ensureTaskSubmissionsUniqueIndex() {
  try {
    const token = await getAdminToken2();
    const col = await pbGet2("/api/collections/task_submissions");
    if (col.code) {
      console.log("[task_submissions] Collection not found \u2014 skip index");
      return;
    }
    const UNIQUE_IDX = "CREATE UNIQUE INDEX `idx_user_task` ON `task_submissions` (`user_id`, `task_id`)";
    const existingIndexes = col.indexes || [];
    if (existingIndexes.some((s) => s.includes("idx_user_task"))) {
      console.log("[task_submissions] unique index idx_user_task already present \u2713");
      return;
    }
    const r = await pbHttp2("PATCH", `/api/collections/${col.id}`, {
      indexes: [...existingIndexes, UNIQUE_IDX]
    }, token);
    if (!r.code) {
      console.log("[task_submissions] unique composite index (user_id, task_id) created \u2713");
    } else {
      console.warn("[task_submissions] Index creation failed:", JSON.stringify(r).slice(0, 200));
    }
  } catch (e) {
    console.warn("[task_submissions] Index migration failed:", e.message);
  }
}
async function migrateProofScreenshotToFile() {
  try {
    const token = await getAdminToken2();
    const col = await pbGet2("/api/collections/task_submissions");
    if (col.code) {
      console.log("[task_submissions] Collection not found \u2014 skip migration");
      return;
    }
    const schema = col.schema || col.fields || [];
    const field = schema.find((f) => f.name === "proof_screenshot");
    if (!field) {
      console.log("[task_submissions] proof_screenshot field not found \u2014 skip");
      return;
    }
    if (field.type === "file") {
      console.log("[task_submissions] proof_screenshot already file type \u2713");
      return;
    }
    const updatedSchema = schema.map(
      (f) => f.name === "proof_screenshot" ? {
        name: "proof_screenshot",
        type: "file",
        required: false,
        options: { maxSelect: 1, maxSize: 5242880, mimeTypes: ["image/jpeg", "image/png", "image/webp"] }
      } : f
    );
    let r = await pbHttp2("PATCH", `/api/collections/${col.id}`, { schema: updatedSchema }, token);
    if (r.code) {
      r = await pbHttp2("PATCH", `/api/collections/${col.id}`, { fields: updatedSchema }, token);
    }
    if (!r.code) {
      console.log("[task_submissions] proof_screenshot migrated text\u2192file \u2713");
    } else {
      console.warn("[task_submissions] Field migration failed:", JSON.stringify(r).slice(0, 300));
    }
  } catch (e) {
    console.warn("[task_submissions] Migration error:", e.message);
  }
}
async function patchTasksCollectionRules() {
  try {
    const token = await getAdminToken2();
    const [tasksCol, subsCol] = await Promise.all([
      pbGet2("/api/collections/tasks"),
      pbGet2("/api/collections/task_submissions")
    ]);
    if (!tasksCol.code) {
      await pbHttp2("PATCH", `/api/collections/${tasksCol.id}`, { listRule: "", viewRule: "" }, token);
      console.log("[tasks] listRule/viewRule patched \u2192 public read \u2713");
    }
    if (!subsCol.code) {
      await pbHttp2("PATCH", `/api/collections/${subsCol.id}`, {
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: "@request.auth.id != ''"
      }, token);
      console.log("[task_submissions] listRule/viewRule/createRule patched \u2192 authenticated read+create \u2713");
    }
  } catch (e) {
    console.warn("[tasks/task_submissions] Rule patch failed:", e.message);
  }
}
async function ensureNotificationsCollection() {
  try {
    const token = await getAdminToken2();
    const check = await pbGet2("/api/collections/notifications");
    if (!check.code) {
      await pbHttp2("PATCH", `/api/collections/${check.id}`, {
        listRule: "",
        viewRule: "",
        createRule: null,
        updateRule: null,
        deleteRule: null
      }, token);
      console.log("[notifications] Collection rules verified \u2713");
      return;
    }
    const created = await pbHttp2("POST", "/api/collections", {
      name: "notifications",
      type: "base",
      schema: [
        { name: "title", type: "text", required: true, options: {} },
        { name: "message", type: "text", required: true, options: {} },
        { name: "type", type: "select", required: true, options: { values: ["global", "personal"], maxSelect: 1 } },
        { name: "target_user", type: "relation", required: false, options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } }
      ]
    }, token);
    if (created.code) {
      console.warn("[notifications] Could not create collection:", JSON.stringify(created).slice(0, 300));
      return;
    }
    await pbHttp2("PATCH", `/api/collections/${created.id}`, {
      listRule: "",
      viewRule: "",
      createRule: null,
      updateRule: null,
      deleteRule: null
    }, token);
    console.log("[notifications] Collection created \u2713");
  } catch (e) {
    console.warn("[notifications] Collection setup failed:", e.message);
  }
}
async function ensureDeletedEmailsCollection() {
  try {
    const check = await pbGet2("/api/collections/deleted_emails");
    if (!check.code) return;
    const token = await getAdminToken2();
    const res = await pbHttp2("POST", "/api/collections", {
      name: "deleted_emails",
      type: "base",
      // IMPORTANT: this PocketBase version uses "schema" (not "fields") for collection creation
      schema: [
        { name: "email", type: "text", required: true, options: {} },
        { name: "reason", type: "text", required: false, options: {} }
      ],
      listRule: "",
      viewRule: "",
      createRule: '@request.auth.id != ""',
      updateRule: null,
      deleteRule: null
    }, token);
    if (res.code) throw new Error(`PB rejected creation: ${JSON.stringify(res)}`);
    console.log("[deleted_emails] Collection created in PocketBase");
  } catch (e) {
    console.warn("[deleted_emails] Could not auto-create collection:", e.message);
  }
}
async function ensureFraudEmailsCollection() {
  try {
    const check = await pbGet2("/api/collections/fraud_emails");
    if (!check.code) {
      const token2 = await getAdminToken2();
      await pbHttp2("PATCH", `/api/collections/${check.id}`, {
        listRule: "",
        viewRule: "",
        createRule: '@request.auth.id != ""',
        updateRule: null,
        deleteRule: null
      }, token2);
      console.log("[fraud_emails] Collection already exists \u2014 rules confirmed");
      return;
    }
    const token = await getAdminToken2();
    const res = await pbHttp2("POST", "/api/collections", {
      name: "fraud_emails",
      type: "base",
      // IMPORTANT: this PocketBase version uses "schema" (not "fields") for collection creation
      schema: [
        { name: "email", type: "text", required: true, options: {} },
        { name: "reason", type: "text", required: false, options: {} }
      ],
      listRule: "",
      viewRule: "",
      createRule: '@request.auth.id != ""',
      updateRule: null,
      deleteRule: null
    }, token);
    if (res.code) throw new Error(`PB rejected creation: ${JSON.stringify(res)}`);
    console.log("[fraud_emails] Collection created in PocketBase \u2713");
  } catch (e) {
    console.warn("[fraud_emails] Could not auto-create collection:", e.message);
  }
}
async function blacklistEmail(email) {
  if (!email) return;
  try {
    const normalised = email.toLowerCase().trim();
    const existing = await pbGet2(
      `/api/collections/deleted_emails/records?filter=${encodeURIComponent(`email="${normalised}"`)}&perPage=1`
    );
    if (existing.items?.[0]) {
      console.log(`[deleted_emails] Email already blacklisted: ${normalised}`);
      return;
    }
    await pbPost2("/api/collections/deleted_emails/records", { email: normalised });
    console.log(`[deleted_emails] Email blacklisted: ${normalised}`);
  } catch (e) {
    console.warn(`[deleted_emails] Failed to blacklist email ${email}:`, e.message);
  }
}
async function ensurePublicReferralsCollection() {
  try {
    const token = await getAdminToken2();
    const check = await pbGet2("/api/collections/public_referrals");
    if (check.code) {
      await pbHttp2("POST", "/api/collections", {
        name: "public_referrals",
        type: "base",
        schema: [
          { name: "code", type: "text", required: true, options: {} },
          { name: "user_id", type: "text", required: true, options: {} }
        ],
        listRule: "",
        viewRule: "",
        createRule: "",
        updateRule: null,
        deleteRule: null
      }, token);
      console.log("[public_referrals] Collection created with public rules");
    }
    const col = await pbGet2("/api/collections/public_referrals");
    if (!col.code) {
      await pbHttp2("PATCH", `/api/collections/${col.id}`, {
        listRule: "",
        // public — anyone can query referral codes
        viewRule: "",
        createRule: "",
        // public — APK fallback can insert without auth
        updateRule: null,
        deleteRule: null
      }, token);
      console.log("[public_referrals] Rules patched \u2014 public list/create enabled");
    }
    const existing = await pbGet2(
      `/api/collections/users/records?perPage=200&fields=id,referral_code`
    );
    const items = existing.items || [];
    let backfilled = 0;
    for (const u of items) {
      if (!u.referral_code) continue;
      const dup = await pbGet2(
        `/api/collections/public_referrals/records?filter=${encodeURIComponent(`code="${u.referral_code}"`)}&perPage=1`,
        token
      );
      if (!dup.items?.[0]) {
        await pbHttp2("POST", "/api/collections/public_referrals/records", {
          code: u.referral_code,
          user_id: u.id
        }, token).catch(() => {
        });
        backfilled++;
      }
    }
    if (backfilled > 0) console.log(`[public_referrals] Backfilled ${backfilled} existing users`);
  } catch (e) {
    console.warn("[public_referrals] Setup failed:", e.message);
  }
}
async function isEmailBlacklisted(email) {
  try {
    const normalised = email.toLowerCase().trim();
    const res = await pbGet2(
      `/api/collections/deleted_emails/records?filter=${encodeURIComponent(`email="${normalised}"`)}&perPage=1`
    );
    return !!res.items?.[0];
  } catch {
    return false;
  }
}
async function isFraudEmail(email) {
  try {
    const normalised = email.toLowerCase().trim();
    const res = await pbGet2(
      `/api/collections/fraud_emails/records?filter=${encodeURIComponent(`email="${normalised}"`)}&perPage=1`
    );
    return !!res.items?.[0];
  } catch {
    return false;
  }
}
async function saveFraudEmail(email) {
  const normalised = email.toLowerCase().trim();
  if (!normalised) return;
  try {
    const token = await getAdminToken2();
    if (!token) {
      console.error(`[fraud_emails] CRITICAL: No admin token \u2014 PB_ADMIN_EMAIL/PB_ADMIN_PASSWORD missing in Railway Variables. Cannot save fraud email: ${normalised}`);
      return;
    }
    const existing = await pbGet2(
      `/api/collections/fraud_emails/records?filter=${encodeURIComponent(`email="${normalised}"`)}&perPage=1`
    );
    if (existing.items?.[0]) {
      console.log(`[fraud_emails] Already in blacklist: ${normalised}`);
      return;
    }
    const res = await pbPost2("/api/collections/fraud_emails/records", { email: normalised });
    if (!res.id) {
      console.error(`[fraud_emails] PocketBase rejected write \u2014 full response: ${JSON.stringify(res)}`);
      return;
    }
    console.log(`[fraud_emails] \u2713 Fraud email saved to PocketBase: ${normalised} (id=${res.id})`);
  } catch (e) {
    console.error(`[fraud_emails] FAILED to save ${normalised}:`, e.message, e.stack?.split("\n")[1] || "");
  }
}
var settingsCache = null;
var settingsCacheAt = 0;
var SETTINGS_TTL = 5 * 60 * 1e3;
async function fetchSettings() {
  if (settingsCache && Date.now() - settingsCacheAt < SETTINGS_TTL)
    return settingsCache;
  const res = await pbGet2("/api/collections/settings/records?perPage=1");
  const s = res.items?.[0];
  if (s) {
    settingsCache = s;
    settingsCacheAt = Date.now();
  }
  return settingsCache;
}
setNetworkGuardSettingsProvider(async () => {
  const s = await fetchSettings();
  return !!s?.network_guard_enabled;
});
var PROXY_KEY_DAILY_LIMIT = 900;
var PROXY_KEYS_TTL = 6e4;
var proxyKeysCache = [];
var proxyKeysCacheAt = 0;
var lastServedProxyKey = null;
function pbNowDate() {
  return (/* @__PURE__ */ new Date()).toISOString().replace("T", " ");
}
async function refreshProxyKeys() {
  const token = await getAdminToken2();
  const res = await pbHttp2(
    "GET",
    "/api/collections/proxy_api/records?perPage=200&sort=created",
    null,
    token
  );
  const items = (res.items || []).map((r) => ({
    id: r.id,
    api_key: String(r.api_key || "").trim(),
    is_active: !!r.is_active,
    usage_count: Number(r.usage_count) || 0,
    last_used: String(r.last_used || "")
  }));
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  for (const rec of items) {
    if (rec.usage_count > 0 && rec.last_used && rec.last_used.slice(0, 10) < today) {
      rec.usage_count = 0;
      pbHttp2(
        "PATCH",
        `/api/collections/proxy_api/records/${rec.id}`,
        { usage_count: 0 },
        token
      ).then(() => console.log(`[proxy_api] daily reset: ${rec.api_key.slice(0, 6)}\u2026`)).catch((e) => console.warn("[proxy_api] daily reset failed:", e?.message));
    }
  }
  proxyKeysCache = items;
  proxyKeysCacheAt = Date.now();
}
async function getProxyApiKey() {
  if (Date.now() - proxyKeysCacheAt > PROXY_KEYS_TTL) {
    try {
      await refreshProxyKeys();
    } catch (e) {
      console.warn("[proxy_api] key refresh failed:", e?.message);
      proxyKeysCacheAt = Date.now();
    }
  }
  const active = proxyKeysCache.filter((k) => k.is_active && k.api_key);
  if (active.length === 0) return null;
  const available = active.find((k) => k.usage_count < PROXY_KEY_DAILY_LIMIT);
  if (available) {
    if (available.api_key !== lastServedProxyKey) {
      console.log(
        `[proxy_api] serving key ${available.api_key.slice(0, 6)}\u2026 (used ${available.usage_count}/${PROXY_KEY_DAILY_LIMIT})`
      );
    }
    lastServedProxyKey = available.api_key;
    return available.api_key;
  }
  const fallback = active.find((k) => k.api_key === lastServedProxyKey) || active[0];
  lastServedProxyKey = fallback.api_key;
  console.warn(
    `[proxy_api] all ${active.length} active keys \u2265${PROXY_KEY_DAILY_LIMIT} today \u2014 reusing ${fallback.api_key.slice(0, 6)}\u2026 to avoid downtime`
  );
  return fallback.api_key;
}
function flushProxyKeyUsage(rec, body) {
  getAdminToken2().then(
    (token) => pbHttp2("PATCH", `/api/collections/proxy_api/records/${rec.id}`, body, token)
  ).catch((e) => console.warn("[proxy_api] usage flush failed:", e?.message));
}
function reportProxyKeyUse(key) {
  const rec = proxyKeysCache.find((k) => k.api_key === key);
  if (!rec) return;
  rec.usage_count += 1;
  rec.last_used = pbNowDate();
  flushProxyKeyUsage(rec, { "usage_count+": 1, last_used: rec.last_used });
}
function reportProxyKeyExhausted(key) {
  const rec = proxyKeysCache.find((k) => k.api_key === key);
  if (!rec) return;
  if (rec.usage_count < PROXY_KEY_DAILY_LIMIT) {
    rec.usage_count = PROXY_KEY_DAILY_LIMIT;
    rec.last_used = pbNowDate();
    console.warn(`[proxy_api] key ${key.slice(0, 6)}\u2026 denied by proxycheck \u2014 marked exhausted, rotating`);
    flushProxyKeyUsage(rec, {
      usage_count: PROXY_KEY_DAILY_LIMIT,
      last_used: rec.last_used
    });
  }
}
setNetworkGuardKeyProvider({
  getKey: getProxyApiKey,
  reportUse: reportProxyKeyUse,
  reportExhausted: reportProxyKeyExhausted
});
async function ensureProxyApiCollection() {
  try {
    const token = await getAdminToken2();
    const colls = await pbHttp2("GET", "/api/collections?perPage=200", null, token);
    if ((colls.items || []).find((c) => c.name === "proxy_api")) {
      console.log("[proxy_api] collection present \u2713");
      return;
    }
    await pbHttp2(
      "POST",
      "/api/collections",
      {
        name: "proxy_api",
        type: "base",
        schema: [
          { name: "api_key", type: "text", required: false },
          { name: "is_active", type: "bool", required: false },
          { name: "usage_count", type: "number", required: false },
          { name: "last_used", type: "date", required: false }
        ],
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null
      },
      token
    );
    console.log("[proxy_api] collection created (admin-only rules) \u2713");
  } catch (e) {
    console.warn("[proxy_api] ensure collection skipped:", e?.message);
  }
}
function generateReferralCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}
async function ensureUserSchema() {
  const REQUIRED_FIELDS = [
    { name: "firebase_uid", type: "text" },
    { name: "display_name", type: "text" },
    { name: "referral_code", type: "text" },
    { name: "referred_by", type: "text" },
    { name: "is_verified", type: "bool" },
    { name: "shib_balance", type: "number" },
    { name: "power_tokens", type: "number" },
    { name: "referral_balance", type: "number" },
    { name: "referral_earnings", type: "number" },
    { name: "total_claims", type: "number" },
    { name: "total_wins", type: "number" },
    { name: "fraud_attempts", type: "number" },
    { name: "status", type: "text" },
    { name: "current_mining_session", type: "text" },
    // VIP system
    { name: "vip_level", type: "number" },
    // current VIP tier 0-8
    { name: "is_admin_promoted", type: "bool" },
    // true → immune to auto-downgrade
    { name: "admin_promoted_level", type: "number" }
    // immutable demotion floor set by admin
  ];
  try {
    const token = await getAdminToken2();
    const colls = await pbHttp2("GET", "/api/collections?perPage=200", null, token);
    const usersCol = (colls.items || []).find((c) => c.name === "users");
    if (!usersCol) return;
    const schema = usersCol.schema || [];
    let changed = false;
    for (const desired of REQUIRED_FIELDS) {
      const existing = schema.find((f) => f.name === desired.name);
      if (!existing) {
        schema.push({ name: desired.name, type: desired.type, required: false });
        changed = true;
      } else if (existing.required === true) {
        existing.required = false;
        changed = true;
      }
    }
    if (!changed) return;
    await pbHttp2("PATCH", `/api/collections/${usersCol.id}`, { schema }, token);
    console.log("[PB] users schema updated \u2014 all app fields are now optional");
  } catch (e) {
    console.warn("[PB] Schema update skipped:", e.message);
  }
}
async function ensureBrevoKeyInSettings() {
  try {
    const token = await getAdminToken2();
    const colls = await pbHttp2("GET", "/api/collections?perPage=200", null, token);
    const settingsCol = (colls.items || []).find(
      (c) => c.name === "settings" || c.name === "app_settings"
    );
    if (!settingsCol) {
      console.warn("[settings] Settings collection not found \u2014 skipping brevo_api_key patch");
      return;
    }
    const schema = settingsCol.schema || [];
    let changed = false;
    if (!schema.find((f) => f.name === "brevo_api_key")) {
      schema.push({ name: "brevo_api_key", type: "text", required: false });
      changed = true;
      console.log(`[${settingsCol.name}] brevo_api_key field added \u2014 set value in PocketBase admin panel`);
    } else {
      console.log(`[${settingsCol.name}] brevo_api_key field already present \u2713`);
    }
    if (!schema.find((f) => f.name === "force_unity_only")) {
      schema.push({ name: "force_unity_only", type: "bool", required: false });
      changed = true;
      console.log(`[${settingsCol.name}] force_unity_only field added (default false) \u2713`);
    } else {
      console.log(`[${settingsCol.name}] force_unity_only field already present \u2713`);
    }
    if (!schema.find((f) => f.name === "network_guard_enabled")) {
      schema.push({ name: "network_guard_enabled", type: "bool", required: false });
      changed = true;
      console.log(`[${settingsCol.name}] network_guard_enabled field added (default false) \u2713`);
    } else {
      console.log(`[${settingsCol.name}] network_guard_enabled field already present \u2713`);
    }
    if (!schema.find((f) => f.name === "strict_match_enforcement")) {
      schema.push({ name: "strict_match_enforcement", type: "bool", required: false });
      changed = true;
      console.log(`[${settingsCol.name}] strict_match_enforcement field added (default false) \u2713`);
    } else {
      console.log(`[${settingsCol.name}] strict_match_enforcement field already present \u2713`);
    }
    let bep20FeesAdded = false;
    if (!schema.find((f) => f.name === "bep20_fees")) {
      schema.push({ name: "bep20_fees", type: "number", required: false });
      changed = true;
      bep20FeesAdded = true;
      console.log(`[${settingsCol.name}] bep20_fees field added \u2713`);
    } else {
      console.log(`[${settingsCol.name}] bep20_fees field already present \u2713`);
    }
    if (changed) {
      await pbHttp2("PATCH", `/api/collections/${settingsCol.id}`, { schema }, token);
    }
    if (bep20FeesAdded) {
      try {
        const rec = await pbHttp2("GET", `/api/collections/${settingsCol.name}/records?perPage=1`, null, token);
        const row = rec.items?.[0];
        if (row && !(Number(row.bep20_fees) > 0)) {
          await pbHttp2("PATCH", `/api/collections/${settingsCol.name}/records/${row.id}`, { bep20_fees: 3680 }, token);
          console.log(`[${settingsCol.name}] bep20_fees seeded to 3680 \u2713`);
        }
      } catch (e) {
        console.warn("[settings] bep20_fees seed skipped:", e.message);
      }
    }
  } catch (e) {
    console.warn("[settings] brevo_api_key patch skipped:", e.message);
  }
}
var gameRewardHourly = /* @__PURE__ */ new Map();
var adTokenStore = /* @__PURE__ */ new Map();
var claimedMatchIds = /* @__PURE__ */ new Map();
setInterval(() => {
  const cutoff = Date.now() - 6 * 36e5;
  for (const [id, ts] of claimedMatchIds) {
    if (ts < cutoff) claimedMatchIds.delete(id);
  }
}, 36e5).unref();
function checkHourlyRewardLimit(pbId) {
  const MAX = 30;
  const now = Date.now();
  const e = gameRewardHourly.get(pbId);
  if (!e || now - e.windowStart > 36e5) {
    gameRewardHourly.set(pbId, { count: 1, windowStart: now });
    return true;
  }
  if (e.count >= MAX) return false;
  e.count++;
  return true;
}
function validateEnv() {
  const REQUIRED = ["PB_ADMIN_EMAIL", "PB_ADMIN_PASSWORD"];
  const RECOMMENDED = ["SMTP_USER", "SMTP_KEY"];
  const missing = REQUIRED.filter((k) => !process.env[k]);
  const missingRec = RECOMMENDED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[ENV] \u274C CRITICAL \u2014 Missing required variables: ${missing.join(", ")}`);
    console.error("[ENV]    PocketBase admin operations WILL FAIL (fraud email save, OTP store, etc.)");
    console.error("[ENV]    Add these in Railway \u2192 Variables tab immediately.");
  } else {
    console.log("[ENV] \u2713 PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are set");
  }
  if (missingRec.length) {
    console.warn(`[ENV] \u26A0  Missing recommended variables: ${missingRec.join(", ")}`);
    console.warn("[ENV]    OTP email will fall back to hardcoded Brevo credentials (may fail on Railway).");
    console.warn("[ENV]    Add SMTP_USER + SMTP_KEY in Railway \u2192 Variables tab to fix email delivery.");
  } else {
    console.log("[ENV] \u2713 SMTP_USER and SMTP_KEY are set \u2014 OTP email will use env credentials");
  }
}
async function registerRoutes(app2) {
  validateEnv();
  getAdminToken2().then(() => ensureUserSchema()).then(() => ensureOtpCollection()).then(() => setupSoloGameConfig()).then(() => ensureDailyUsageCollection()).then(() => ensureDeletedEmailsCollection()).then(() => ensureFraudEmailsCollection()).then(() => ensureCollectionRules()).then(() => ensurePublicReferralsCollection()).then(() => ensureMiningSessionsRules()).then(() => ensureReferralEarningsLogCollection()).then(() => ensureBrevoKeyInSettings()).then(() => backfillWithdrawalMaskedNames()).then(() => ensureWithdrawalRedeemMethod()).then(() => ensureNotificationsCollection()).then(() => ensureSessionLogsCollection()).then(() => ensurePerfLogsCollection()).then(() => ensureGameScoreCollection()).then(() => ensureGameHistoryCollection()).then(() => {
    startMatchExpirySweeper();
  }).then(() => ensureIsFlaggedField()).then(() => ensureBlacklistFields()).then(() => ensureSessionTokenField()).then(() => ensureVerificationSchema()).then(() => ensureTelegramVerificationsCollection()).then(() => ensureReferralHistoryCollection()).then(() => ensureTasksCollection()).then(() => ensureTaskSubmissionsCollection()).then(() => ensureTaskSubmissionsUniqueIndex()).then(() => migrateProofScreenshotToFile()).then(() => patchTasksCollectionRules()).then(() => ensureProxyApiCollection()).catch((e) => console.warn("[PB] Startup init failed:", e));
  app2.get("/api/app/security/network-check", async (req, res) => {
    try {
      if (!await isNetworkGuardEnabled()) {
        return res.json({ blocked: false, reason: null });
      }
      const verdict = await checkNetworkAccess(req.ip || "");
      return res.json({ blocked: verdict.blocked, reason: verdict.reason });
    } catch {
      return res.json({ blocked: false, reason: null });
    }
  });
  app2.post("/api/app/security/flag-device", async (req, res) => {
    try {
      const { pbId, reason } = req.body;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const token = await getAdminToken2();
      await pbHttp2("PATCH", `/api/collections/users/records/${pbId}`, {
        is_flagged: true,
        flag_reason: String(reason ?? "unknown").slice(0, 64)
      }, token);
      console.warn(`[security] Device flagged: pbId=${pbId} reason=${reason}`);
      return res.json({ flagged: true });
    } catch (e) {
      console.warn("[security] flag-device error:", e.message);
      return res.status(500).json({ error: "Failed to flag device" });
    }
  });
  app2.post("/api/app/security/verify-integrity", async (req, res) => {
    try {
      const { token: integrityToken, pbId } = req.body;
      if (!integrityToken) return res.status(400).json({ error: "token required" });
      const apiKey = process.env.GOOGLE_PLAY_INTEGRITY_KEY;
      if (!apiKey) {
        return res.json({ pass: true, verdict: "SKIPPED_NO_CREDENTIALS" });
      }
      const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME ?? "com.shibahit.app";
      const gResp = await fetch(
        `https://playintegrity.googleapis.com/v1/${PACKAGE_NAME}:decodeIntegrityToken?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ integrity_token: integrityToken })
        }
      );
      if (!gResp.ok) {
        console.warn("[integrity] Google API error:", gResp.status);
        return res.json({ pass: true, verdict: "GOOGLE_API_ERROR" });
      }
      const data = await gResp.json();
      const verdicts = data?.tokenPayloadExternal?.deviceIntegrity?.deviceRecognitionVerdict ?? [];
      const pass = verdicts.includes("MEETS_DEVICE_INTEGRITY") || verdicts.includes("MEETS_STRONG_INTEGRITY") || verdicts.includes("MEETS_BASIC_INTEGRITY");
      if (!pass && pbId) {
        const adminTok = await getAdminToken2();
        await pbHttp2("PATCH", `/api/collections/users/records/${pbId}`, {
          is_flagged: true,
          flag_reason: "play_integrity"
        }, adminTok).catch(() => {
        });
        console.warn(`[integrity] FAIL \u2014 pbId=${pbId} verdicts=${JSON.stringify(verdicts)}`);
      }
      return res.json({ pass, verdicts });
    } catch (e) {
      console.warn("[integrity] verify error:", e.message);
      return res.json({ pass: true, error: e.message });
    }
  });
  app2.post("/api/auth/request-delete-otp", async (req, res) => {
    try {
      const { pbId } = req.body;
      const email = cleanEmail(req.body.email);
      if (!pbId || !email) return res.status(400).json({ error: "pbId and a valid email are required" });
      const user = await pbGet2(`/api/collections/users/records/${pbId}?fields=id`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const existing = await pbGet2(
        `/api/collections/otp_codes/records?filter=${encodeURIComponent(`user="${pbId}"`)}&perPage=50`
      );
      for (const rec of existing.items ?? []) {
        await pbDelete2(`/api/collections/otp_codes/records/${rec.id}`).catch(() => {
        });
      }
      const otp = crypto.randomInt(1e5, 1e6).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1e3).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
      console.log(`[OTP] Storing OTP record for user=${pbId}, expires_at=${expiresAt}`);
      const stored = await pbPost2("/api/collections/otp_codes/records", {
        user: pbId,
        code: otp,
        expires_at: expiresAt
      });
      if (!stored.id) {
        console.error("[OTP] PocketBase store failed \u2014 full response:", JSON.stringify(stored));
        return res.status(500).json({ error: `Failed to store OTP (PB ${stored.status || "unknown"}: ${stored.message || "unknown"})` });
      }
      const limitCheck = await checkAndIncrementDailyEmailLimit();
      if (!limitCheck.allowed) {
        return res.status(429).json({ error: limitCheck.message });
      }
      try {
        await sendOtpEmail(email, otp);
      } catch (smtpErr) {
        console.error("[SMTP] Failed to deliver OTP email:", smtpErr.message, smtpErr.stack);
        return res.status(500).json({
          error: "Failed to send email. Please try again later.",
          smtp_error: smtpErr?.message || String(smtpErr),
          smtp_code: smtpErr?.responseCode || smtpErr?.code || null
        });
      }
      console.log(`[OTP] Sent deletion OTP to ${email} for user ${pbId}`);
      res.json({ success: true });
    } catch (e) {
      console.error("[/api/auth/request-delete-otp] Unexpected error:", e.message, e.stack);
      res.status(500).json({ error: e.message || "Failed to send OTP." });
    }
  });
  app2.post("/api/auth/confirm-delete", async (req, res) => {
    try {
      const { pbId, code } = req.body;
      if (!pbId || !code) return res.status(400).json({ error: "pbId and code required" });
      const records = await pbGet2(
        `/api/collections/otp_codes/records?filter=${encodeURIComponent(`user="${pbId}"`)}&perPage=10`
      );
      const otpRecord = (records.items ?? []).find((r) => r.code === String(code).trim());
      if (!otpRecord) return res.status(400).json({ error: "Invalid OTP. Please try again." });
      if (new Date(otpRecord.expires_at) < /* @__PURE__ */ new Date()) {
        await pbDelete2(`/api/collections/otp_codes/records/${otpRecord.id}`).catch(() => {
        });
        return res.status(400).json({ error: "OTP has expired. Please request a new one." });
      }
      await pbDelete2(`/api/collections/otp_codes/records/${otpRecord.id}`).catch(() => {
      });
      try {
        const userRecord = await pbGet2(`/api/collections/users/records/${pbId}?fields=id,email`);
        if (userRecord?.email) {
          await blacklistEmail(userRecord.email);
        }
      } catch (e) {
        console.warn("[confirm-delete] Could not fetch user email for blacklisting:", e.message);
      }
      try {
        const sessions = await pbGet2(
          `/api/collections/mining_sessions/records?filter=${encodeURIComponent(`user="${pbId}"`)}&perPage=200`
        );
        for (const s of sessions.items ?? []) {
          await pbDelete2(`/api/collections/mining_sessions/records/${s.id}`).catch(() => {
          });
        }
      } catch {
      }
      const deleteUrl = `${PB_URL2}/api/collections/users/records/${pbId}`;
      const adminToken2 = await getAdminToken2();
      const delRes = await fetch(deleteUrl, {
        method: "DELETE",
        headers: { Authorization: adminToken2 }
      });
      if (!delRes.ok && delRes.status !== 204) {
        console.error("[confirm-delete] PB user delete failed:", delRes.status);
        return res.status(500).json({ error: "Failed to delete account" });
      }
      console.log(`[confirm-delete] Account deleted for pbId=${pbId}`);
      res.json({ success: true });
    } catch (e) {
      console.error("[/api/auth/confirm-delete]", e.message);
      res.status(500).json({ error: "Account deletion failed. Please try again." });
    }
  });
  app2.get("/api/app/settings", async (_req, res) => {
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
          "10x": s.boost_10x_cost
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
        appStoreLink: s.app_store_link || "",
        playStoreUrl: s.play_store_url || s.app_store_link || "",
        ratePopupFrequency: s.rate_popup_frequency || 5,
        minimumVersion: s.minimum_version || "",
        dailyRewardDay1Shib: s.daily_reward_day1_shib ?? 1e3,
        dailyRewardDay2Pt: s.daily_reward_day2_pt ?? 50,
        dailyRewardDay3Shib: s.daily_reward_day3_shib ?? 3e3,
        dailyRewardDay4Pt: s.daily_reward_day4_pt ?? 100,
        dailyRewardDay5Shib: s.daily_reward_day5_shib ?? 5e3,
        dailyRewardDay6Pt: s.daily_reward_day6_pt ?? 200,
        dailyRewardDay7Shib: s.daily_reward_day7_shib ?? 1e4,
        dailyRewardDay7Pt: s.daily_reward_day7_pt ?? 500
      });
    } catch (e) {
      console.error("[/api/app/settings]", e.message);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });
  app2.get("/api/app/auth/validate-referral", async (req, res) => {
    try {
      const code = (req.query.code || "").trim().toUpperCase();
      if (!code) return res.status(400).json({ valid: false, error: "Code required" });
      const r = await pbGet2(
        `/api/collections/users/records?filter=referral_code="${encodeURIComponent(code)}"&perPage=1&fields=id,display_name`
      );
      const referrer = r.items?.[0];
      if (!referrer) return res.json({ valid: false });
      res.json({ valid: true, referrerName: referrer.display_name || "" });
    } catch (e) {
      console.error("[/api/app/auth/validate-referral]", e.message);
      res.status(500).json({ valid: false, error: "Validation failed" });
    }
  });
  app2.get("/api/app/user/:pbId/referral-stats", async (req, res) => {
    try {
      const { pbId } = req.params;
      const [user, referred] = await Promise.all([
        pbGet2(`/api/collections/users/records/${pbId}?fields=id,referral_earnings,referral_balance`),
        pbGet2(`/api/collections/users/records?filter=${encodeURIComponent(`referred_by="${pbId}"`)}&perPage=50&fields=id,email,created,total_claims`)
      ]);
      if (user.code) return res.status(404).json({ error: "User not found" });
      res.json({
        referredCount: referred.totalItems || 0,
        totalEarnings: user.referral_earnings || 0,
        referralBalance: user.referral_balance || 0,
        referredUsers: (referred.items || []).map((u) => ({
          id: u.id,
          email: u.email ? u.email.replace(/(.{2}).+(@.+)/, "$1***$2") : "***",
          joined: u.created,
          claims: u.total_claims || 0
        }))
      });
    } catch (e) {
      console.error("[/api/app/user/referral-stats]", e.message);
      res.status(500).json({ error: "Failed to fetch referral stats" });
    }
  });
  app2.post("/api/app/user/:pbId/claim-referral", async (req, res) => {
    try {
      const { pbId } = req.params;
      if (!await requireCallerIdentity(req, res, pbId, "claim-referral")) return;
      await processPendingReferralLog(pbId);
      const user = await pbGet2(`/api/collections/users/records/${pbId}?fields=id,referral_balance,shib_balance,is_blacklist_1,is_blacklist_2`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const balance = user.referral_balance || 0;
      if (balance <= 0) return res.status(400).json({ error: "No referral rewards to claim" });
      try {
        const logs = await pbGet2(
          `/api/collections/referral_earnings_log/records?filter=${encodeURIComponent(`referrer_id="${pbId}"`)}&sort=-created&perPage=100`
        );
        const entries = logs.items || [];
        if (entries.length) {
          const bigAmount = entries.some((r) => (Number(r.amount) || 0) > 200);
          const minuteBuckets = {};
          for (const r of entries) {
            const k = String(r.created || "").slice(0, 16);
            if (k) minuteBuckets[k] = (minuteBuckets[k] || 0) + 1;
          }
          const burst = Object.values(minuteBuckets).some((n) => n >= 5);
          if ((bigAmount || burst) && !user.is_blacklist_2) {
            await pbPatch2(
              `/api/collections/users/records/${pbId}`,
              user.is_blacklist_1 ? { is_blacklist_2: true } : { is_blacklist_1: true }
            ).catch(() => {
            });
            securityLog("claim-referral", "referral infraction flagged", { pbId, bigAmount, burst });
          }
        }
      } catch {
      }
      const newShib = (user.shib_balance || 0) + balance;
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        shib_balance: newShib,
        referral_balance: 0
      });
      res.json({ success: true, claimed: balance, newShibBalance: newShib });
    } catch (e) {
      console.error("[/api/app/user/claim-referral]", e.message);
      res.status(500).json({ error: "Failed to claim referral rewards" });
    }
  });
  app2.delete("/api/app/user/:pbId/delete-account", async (req, res) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "Missing pbId" });
      const user = await pbGet2(`/api/collections/users/records/${pbId}?fields=id,email`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      if (user.email) {
        await blacklistEmail(user.email).catch(() => {
        });
      }
      const deleteUrl = `${process.env.PB_URL || "https://api.webcod.in"}/api/collections/users/records/${pbId}`;
      const token = await getAdminToken2();
      const delRes = await fetch(deleteUrl, {
        method: "DELETE",
        headers: { Authorization: token }
      });
      if (!delRes.ok && delRes.status !== 204) {
        console.error("[delete-account] PB delete failed:", delRes.status);
        return res.status(500).json({ error: "Failed to delete user record" });
      }
      console.log(`[delete-account] Deleted PB user ${pbId}`);
      res.json({ success: true });
    } catch (e) {
      console.error("[/api/app/user/:pbId/delete-account]", e.message);
      res.status(500).json({ error: "Account deletion failed" });
    }
  });
  app2.post("/api/app/auth/sync", async (req, res) => {
    try {
      const { firebaseUid, referralCode, referredBy } = req.body;
      const email = cleanEmail(req.body.email);
      const displayName = cleanDisplayName(req.body.displayName);
      if (!firebaseUid || !email)
        return res.status(400).json({ error: "firebaseUid and a valid email are required" });
      const blocked = await isEmailBlacklisted(email);
      if (blocked) {
        console.warn(`[auth/sync] Blocked attempt from deleted-email blacklist: ${email}`);
        return res.status(403).json({
          error: "An account was previously associated with this email. This email is permanently restricted from new registrations.",
          code: "EMAIL_PERMANENTLY_BANNED"
        });
      }
      const fraudBlocked = await isFraudEmail(email);
      if (fraudBlocked) {
        console.warn(`[auth/sync] Blocked attempt from fraud_emails list: ${email}`);
        return res.status(403).json({
          error: "ACCOUNT_BLOCKED",
          blocked: true,
          message: "This email has been permanently banned due to fraudulent activity."
        });
      }
      const existing = await pbGet2(
        `/api/collections/users/records?filter=firebase_uid="${encodeURIComponent(firebaseUid)}"&perPage=1`
      );
      if (existing.items?.[0]) {
        let u = existing.items[0];
        {
          const isBlocked = u.status === "blocked" || (u.fraud_attempts || 0) >= 3;
          if (isBlocked) {
            if (u.status !== "blocked") {
              await pbPatch2(`/api/collections/users/records/${u.id}`, { status: "blocked" }).catch(() => {
              });
              console.warn(`[auth/sync] Auto-blocked user ${u.id} (fraud_attempts=${u.fraud_attempts})`);
            } else {
              console.warn(`[auth/sync] Blocked login attempt from banned user: ${u.id} (${email})`);
            }
            return res.status(403).json({
              error: "ACCOUNT_BLOCKED",
              blocked: true,
              message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts."
            });
          }
        }
        if (!u.referral_code) {
          const code2 = generateReferralCode();
          const updated = await pbPatch2(`/api/collections/users/records/${u.id}`, {
            referral_code: code2
          });
          if (!updated.code) u = { ...u, referral_code: code2 };
        }
        processPendingReferralLog(u.id).catch(() => {
        });
        return res.json(formatUser(u));
      }
      let referrerPbId;
      if (referredBy) {
        const referrerRes = await pbGet2(
          `/api/collections/users/records?filter=referral_code="${encodeURIComponent(referredBy)}"&perPage=1`
        );
        referrerPbId = referrerRes.items?.[0]?.id;
      }
      const byEmail = await pbGet2(
        `/api/collections/users/records?filter=${encodeURIComponent(`email="${email}"`)}&perPage=1`
      );
      if (byEmail.items?.[0]) {
        let u = byEmail.items[0];
        if (!u.is_verified) {
          await pbDelete2(`/api/collections/users/records/${u.id}`).catch(() => {
          });
        } else {
          const patches = {};
          if (!u.firebase_uid) patches.firebase_uid = firebaseUid;
          if (!u.referral_code) patches.referral_code = referralCode || generateReferralCode();
          if (!u.display_name && displayName) patches.display_name = displayName;
          if (!u.referred_by && referrerPbId) patches.referred_by = referrerPbId;
          if (Object.keys(patches).length > 0) {
            const updated = await pbPatch2(`/api/collections/users/records/${u.id}`, patches);
            if (!updated.code) u = { ...u, ...patches };
          }
          return res.json(formatUser(u));
        }
      }
      const code = referralCode || generateReferralCode();
      const pbPassword = `SHIB_${firebaseUid}_SECURE`;
      const created = await pbPost2("/api/collections/users/records", {
        email,
        password: pbPassword,
        passwordConfirm: pbPassword,
        emailVisibility: false,
        firebase_uid: firebaseUid,
        display_name: displayName || email.split("@")[0],
        referral_code: code,
        referred_by: referrerPbId || "",
        shib_balance: 100,
        // welcome bonus: 100 SHIB
        power_tokens: 500,
        // welcome bonus: 500 Power Tokens
        referral_balance: 0,
        referral_earnings: 0,
        total_claims: 0,
        total_wins: 0,
        fraud_attempts: 0,
        status: "active",
        current_mining_session: "",
        is_verified: false
      });
      if (created.code) {
        const detail = JSON.stringify({ code: created.code, message: created.message, data: created.data });
        console.error(`[auth/sync] PB user creation FAILED. email=${email} | PB error: ${detail}`);
        return res.status(400).json({ error: created.message, detail: created.data });
      }
      pbHttp2("POST", "/api/collections/public_referrals/records", {
        code,
        user_id: created.id
      }).catch(() => {
      });
      if (referrerPbId) {
        pbGet2(`/api/collections/users/records/${referrerPbId}`).then(async (referrer) => {
          if (referrer?.id) {
            await pbPatch2(`/api/collections/users/records/${referrerPbId}`, {
              power_tokens: (referrer.power_tokens || 10) + 30
            });
          }
        }).catch(() => {
        });
      }
      return res.json(formatUser(created));
    } catch (e) {
      console.error("[/api/app/auth/sync]", e.message);
      res.status(500).json({ error: "Sync failed" });
    }
  });
  app2.post("/api/app/auth/check-email", async (req, res) => {
    try {
      const email = cleanEmail(req.body.email);
      if (!email) return res.status(400).json({ error: "A valid email is required" });
      const r = await pbGet2(
        `/api/collections/users/records?filter=${encodeURIComponent(`email="${email}"`)}&perPage=1&fields=id,is_verified`
      );
      const found = !!r.items?.[0];
      const verified = found && r.items[0].is_verified;
      return res.json({ found, verified });
    } catch (e) {
      console.error("[/api/app/auth/check-email]", e.message);
      return res.status(500).json({ error: "Failed to check email" });
    }
  });
  app2.post("/api/app/auth/confirm-verified", async (req, res) => {
    try {
      const { firebaseUid, referralCode, referredBy } = req.body;
      const email = cleanEmail(req.body.email);
      const displayName = cleanDisplayName(req.body.displayName);
      if (!firebaseUid || !email)
        return res.status(400).json({ error: "firebaseUid and a valid email are required" });
      const confirmedBlocked = await isEmailBlacklisted(email);
      if (confirmedBlocked) {
        console.warn(`[confirm-verified] Blocked from blacklisted email: ${email}`);
        return res.status(403).json({
          error: "This email address is associated with a deleted account and cannot be used to create a new account.",
          code: "EMAIL_PERMANENTLY_BANNED"
        });
      }
      const byUid = await pbGet2(
        `/api/collections/users/records?filter=firebase_uid="${encodeURIComponent(firebaseUid)}"&perPage=1`
      );
      if (byUid.items?.[0]) {
        const u = byUid.items[0];
        const updated = await pbPatch2(`/api/collections/users/records/${u.id}`, {
          is_verified: true
        });
        return res.json(formatUser(updated.code ? { ...u, is_verified: true } : updated));
      }
      const byEmail = await pbGet2(
        `/api/collections/users/records?filter=${encodeURIComponent(`email="${email}"`)}&perPage=1`
      );
      if (byEmail.items?.[0]) {
        const u = byEmail.items[0];
        const patches = { is_verified: true };
        if (!u.firebase_uid) patches.firebase_uid = firebaseUid;
        if (!u.referral_code && referralCode) patches.referral_code = referralCode;
        if (!u.display_name && displayName) patches.display_name = displayName;
        const updated = await pbPatch2(`/api/collections/users/records/${u.id}`, patches);
        return res.json(formatUser(updated.code ? { ...u, ...patches } : updated));
      }
      const code = referralCode || generateReferralCode();
      const pbPassword = `SHIB_${firebaseUid}_SECURE`;
      let referrerPbId;
      if (referredBy) {
        const referrerRes = await pbGet2(
          `/api/collections/users/records?filter=referral_code="${encodeURIComponent(referredBy)}"&perPage=1`
        );
        referrerPbId = referrerRes.items?.[0]?.id;
      }
      const created = await pbPost2("/api/collections/users/records", {
        email,
        password: pbPassword,
        passwordConfirm: pbPassword,
        emailVisibility: false,
        firebase_uid: firebaseUid,
        display_name: displayName || email.split("@")[0],
        referral_code: code,
        referred_by: referrerPbId || "",
        shib_balance: 100,
        // welcome bonus: 100 SHIB
        power_tokens: 500,
        // welcome bonus: 500 Power Tokens
        referral_balance: 0,
        referral_earnings: 0,
        total_claims: 0,
        total_wins: 0,
        fraud_attempts: 0,
        status: "active",
        current_mining_session: "",
        is_verified: true
      });
      if (created.code) {
        const detail = JSON.stringify({ code: created.code, message: created.message, data: created.data });
        console.error(`[confirm-verified] PB user creation FAILED. payload email=${email} displayName=${displayName} | PB error: ${detail}`);
        return res.status(400).json({ error: created.message, detail: created.data });
      }
      if (referrerPbId) {
        pbGet2(`/api/collections/users/records/${referrerPbId}`).then(async (r) => {
          if (r?.id) await pbPatch2(`/api/collections/users/records/${referrerPbId}`, {
            power_tokens: (r.power_tokens || 10) + 30
          });
        }).catch(() => {
        });
      }
      return res.json(formatUser(created));
    } catch (e) {
      console.error("[/api/app/auth/confirm-verified]", e.message);
      res.status(500).json({ error: "Failed to confirm verification" });
    }
  });
  if (process.env.NODE_ENV !== "production") {
    app2.get("/api/dev/status", (_req, res) => {
      res.json({ env: "development", authMode: "firebase-email-link" });
    });
    app2.get("/api/dev/lookup-user", async (req, res) => {
      try {
        const { email, uid } = req.query;
        const results = {};
        if (email) {
          const r = await pbGet2(`/api/collections/users/records?filter=${encodeURIComponent(`email="${email}"`)}&perPage=1`);
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
            referral_code: r.items[0].referral_code
          } : null;
        }
        if (uid) {
          const r = await pbGet2(`/api/collections/users/records?filter=${encodeURIComponent(`firebase_uid="${uid}"`)}&perPage=1`);
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
            referral_code: r.items[0].referral_code
          } : null;
        }
        res.json(results);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }
  app2.get("/api/app/user/:firebaseUid", async (req, res) => {
    try {
      const firebaseUid = String(req.params.firebaseUid);
      const r = await pbGet2(
        `/api/collections/users/records?filter=firebase_uid="${encodeURIComponent(firebaseUid)}"&perPage=1`
      );
      let u = r.items?.[0];
      if (!u) return res.status(404).json({ error: "User not found" });
      {
        const isBlocked = u.status === "blocked" || (u.fraud_attempts || 0) >= 3;
        if (isBlocked) {
          if (u.status !== "blocked") {
            await pbPatch2(`/api/collections/users/records/${u.id}`, { status: "blocked" }).catch(() => {
            });
            console.log(`[getUser] Auto-blocked user ${u.id} (fraud_attempts=${u.fraud_attempts})`);
          }
          return res.status(403).json({
            error: "ACCOUNT_BLOCKED",
            blocked: true,
            message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts."
          });
        }
      }
      if (!u.referral_code) {
        const code = generateReferralCode();
        const updated = await pbPatch2(`/api/collections/users/records/${u.id}`, {
          referral_code: code
        });
        if (!updated.code) u = { ...u, referral_code: code };
      }
      processPendingReferralLog(u.id).catch(() => {
      });
      res.json(formatUser(u));
    } catch (e) {
      console.error("[/api/app/user/:id]", e.message);
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });
  app2.put(
    "/api/app/user/:pbId/balance",
    async (req, res) => {
      securityLog("user/balance", "blocked call to disabled direct-balance route", {
        pbId: String(req.params.pbId || ""),
        ip: String(req.ip || req.socket?.remoteAddress || "")
      });
      res.status(410).json({ error: "This endpoint has been permanently disabled." });
    }
  );
  app2.post("/api/app/boosters/activate", async (req, res) => {
    try {
      const { pbId, multiplier } = req.body;
      if (!pbId || !multiplier)
        return res.status(400).json({ error: "pbId and multiplier required" });
      const boosterMult = Number(multiplier);
      if (!Number.isInteger(boosterMult) || !ALLOWED_BOOSTER_MULTIPLIERS.has(boosterMult)) {
        securityLog("boosters/activate", "rejected non-whitelisted multiplier", { pbId, multiplier, ip: String(req.ip || "") });
        return res.status(400).json({ error: "Invalid multiplier" });
      }
      if (!await requireCallerIdentity(req, res, pbId, "boosters/activate")) return;
      const [user, settings] = await Promise.all([
        pbGet2(`/api/collections/users/records/${pbId}`),
        fetchSettings()
      ]);
      if (user.code) return res.status(404).json({ error: "User not found" });
      if (!settings) return res.status(503).json({ error: "Settings unavailable" });
      const costKey = `boost_${boosterMult}x_cost`;
      const cost = settings[costKey];
      if (cost === void 0)
        return res.status(400).json({ error: "Invalid multiplier" });
      if ((user.power_tokens || 0) < cost) {
        return res.status(400).json({ error: "Not enough Power Tokens" });
      }
      const expiresAt = (Date.now() + 36e5).toString();
      const updated = await pbPatch2(`/api/collections/users/records/${pbId}`, {
        power_tokens: user.power_tokens - cost,
        active_booster_multiplier: boosterMult,
        booster_expires: expiresAt
      });
      if (updated.code) return res.status(400).json({ error: updated.message });
      res.json({
        success: true,
        multiplier: boosterMult,
        expiresAt,
        newPowerTokens: user.power_tokens - cost
      });
    } catch (e) {
      console.error("[/api/app/boosters/activate]", e.message);
      res.status(500).json({ error: "Failed to activate booster" });
    }
  });
  app2.post("/api/app/boosters/activate-and-mine", async (req, res) => {
    try {
      const { pbId, multiplier } = req.body;
      if (!pbId || !multiplier)
        return res.status(400).json({ error: "pbId and multiplier required" });
      const boosterMult = Number(multiplier);
      if (!Number.isInteger(boosterMult) || !ALLOWED_BOOSTER_MULTIPLIERS.has(boosterMult)) {
        securityLog("boosters/activate-and-mine", "rejected non-whitelisted multiplier", { pbId, multiplier, ip: String(req.ip || "") });
        return res.status(400).json({ error: "Invalid multiplier" });
      }
      if (!await requireCallerIdentity(req, res, pbId, "boosters/activate-and-mine")) return;
      const [user, settings] = await Promise.all([
        pbGet2(`/api/collections/users/records/${pbId}`),
        fetchSettings()
      ]);
      if (user.code) return res.status(404).json({ error: "User not found" });
      if (!settings) return res.status(503).json({ error: "Settings unavailable" });
      {
        const isBlocked = user.status === "blocked" || (user.fraud_attempts || 0) >= 3;
        if (isBlocked) {
          if (user.status !== "blocked") {
            await pbPatch2(`/api/collections/users/records/${pbId}`, { status: "blocked" }).catch(() => {
            });
            console.log(`[Guard0/start] Auto-blocked user ${pbId} (fraud_attempts=${user.fraud_attempts})`);
          }
          return res.status(403).json({
            error: "ACCOUNT_BLOCKED",
            blocked: true,
            message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts."
          });
        }
      }
      const costKey = `boost_${boosterMult}x_cost`;
      const boosterCost = settings[costKey];
      if (boosterCost === void 0)
        return res.status(400).json({ error: "Invalid multiplier" });
      const miningCost = settings.power_token_per_click || 24;
      const totalCost = boosterCost + miningCost;
      const currentPT = user.power_tokens || 0;
      if (currentPT < boosterCost)
        return res.status(400).json({ error: `Not enough Power Tokens for booster (need ${boosterCost} PT)`, code: "INSUFFICIENT_PT" });
      if (currentPT < totalCost)
        return res.status(400).json({ error: `Not enough Power Tokens (need ${totalCost} PT: ${boosterCost} PT booster + ${miningCost} PT mining)`, code: "INSUFFICIENT_PT" });
      const boosterExpiresAt = (Date.now() + 36e5).toString();
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        power_tokens: currentPT - totalCost,
        active_booster_multiplier: boosterMult,
        booster_expires: boosterExpiresAt
      });
      const existing = await pbGet2(
        `/api/collections/mining_sessions/records?filter=${encodeURIComponent(`user="${pbId}" && claimed_amount=0`)}&perPage=50`
      );
      for (const s of existing.items || []) {
        await pbPatch2(`/api/collections/mining_sessions/records/${s.id}`, { claimed_amount: -1 });
      }
      const rate = settings.mining_rate_per_sec || 0.01736;
      const dur = settings.mining_duration_minutes || 60;
      const lockedVip = normalizeVipLevel(user.vip_level);
      const expectedReward = effectiveRatePerSec(rate, lockedVip) * dur * 60 * boosterMult;
      const session = await pbPost2("/api/collections/mining_sessions/records", {
        user: pbId,
        start_time: (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").replace("Z", ""),
        claimed_amount: 0,
        is_verified: false,
        ip_address: String(req.ip || req.socket?.remoteAddress || ""),
        booster_multiplier: boosterMult,
        vip_level: lockedVip
      });
      if (session.code)
        return res.status(400).json({ error: session.message });
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        current_mining_session: session.id
      });
      const durationMs = dur * 60 * 1e3;
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
        multiplier: boosterMult,
        expectedReward,
        miningRatePerSec: rate,
        vipLevel: lockedVip,
        boosterExpiresAt,
        ptDeducted: totalCost,
        newPowerTokens: currentPT - totalCost,
        status: "mining"
      });
    } catch (e) {
      console.error("[/api/app/boosters/activate-and-mine]", e.message);
      res.status(500).json({ error: "Failed to activate booster and start mining" });
    }
  });
  app2.get(
    "/api/app/boosters/active/:pbId",
    async (req, res) => {
      try {
        const { pbId } = req.params;
        const user = await pbGet2(`/api/collections/users/records/${pbId}`);
        if (user.code) return res.status(404).json({ error: "User not found" });
        const expires = user.booster_expires ? parseInt(user.booster_expires) : 0;
        if (expires > Date.now()) {
          return res.json({
            multiplier: user.active_booster_multiplier || 1,
            expiresAt: user.booster_expires
          });
        }
        if (user.active_booster_multiplier !== 1 || user.booster_expires) {
          await pbPatch2(`/api/collections/users/records/${pbId}`, {
            active_booster_multiplier: 1,
            booster_expires: ""
          });
        }
        res.json({ multiplier: 1, expiresAt: null });
      } catch (e) {
        console.error("[/api/app/boosters/active]", e.message);
        res.status(500).json({ error: "Failed to fetch booster" });
      }
    }
  );
  app2.get("/api/app/server-time", (_req, res) => {
    res.json({ serverTime: Date.now() });
  });
  app2.get("/api/debug/smtp-config", (_req, res) => {
    const rawUser = process.env.SMTP_USER || "(not set)";
    const rawPass = process.env.SMTP_KEY || "(not set)";
    res.json({
      smtp_user: rawUser,
      smtp_key_set: rawPass !== "(not set)",
      smtp_key_tail: rawPass !== "(not set)" ? rawPass.slice(-8) : "(not set)",
      smtp_user_looks_like_key: rawUser.startsWith("xsmtpsib-"),
      node_env: process.env.NODE_ENV || "(not set)"
    });
  });
  app2.post("/api/app/mine/start", async (req, res) => {
    try {
      const { pbId } = req.body;
      if (!pbId)
        return res.status(400).json({ error: "pbId required" });
      if (!await requireCallerIdentity(req, res, pbId, "mine/start")) return;
      const [userRecord, settings] = await Promise.all([
        pbGet2(`/api/collections/users/records/${pbId}`),
        fetchSettings()
      ]);
      if (userRecord.code)
        return res.status(404).json({ error: "User not found" });
      {
        const isBlocked = userRecord.status === "blocked" || (userRecord.fraud_attempts || 0) >= 3;
        if (isBlocked) {
          if (userRecord.status !== "blocked") {
            await pbPatch2(`/api/collections/users/records/${pbId}`, { status: "blocked" }).catch(() => {
            });
            console.log(`[Guard0/activate] Auto-blocked user ${pbId} (fraud_attempts=${userRecord.fraud_attempts})`);
          }
          return res.status(403).json({
            error: "ACCOUNT_BLOCKED",
            blocked: true,
            message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts."
          });
        }
      }
      let activeMultiplier = 1;
      if (userRecord.booster_expires) {
        const expires = parseInt(userRecord.booster_expires);
        if (expires > Date.now()) {
          activeMultiplier = Number(userRecord.active_booster_multiplier) || 1;
        }
      }
      if (!VALID_SESSION_MULTIPLIERS.has(activeMultiplier)) {
        securityLog("mine/start", "non-whitelisted stored booster multiplier \u2014 clamped to 1", { pbId, activeMultiplier });
        activeMultiplier = 1;
      }
      const ptCost = settings?.power_token_per_click || 24;
      const currentPT = userRecord.power_tokens || 0;
      if (currentPT < ptCost) {
        return res.status(400).json({
          error: `Not enough Power Tokens. You need ${ptCost} PT to start mining but only have ${currentPT} PT.`,
          code: "INSUFFICIENT_PT",
          required: ptCost,
          current: currentPT
        });
      }
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        power_tokens: currentPT - ptCost
      });
      const existing = await pbGet2(
        `/api/collections/mining_sessions/records?filter=${encodeURIComponent(`user="${pbId}"`)}&perPage=50`
      );
      for (const s of existing.items || []) {
        if (!s.claimed_amount || s.claimed_amount === 0) {
          await pbPatch2(
            `/api/collections/mining_sessions/records/${s.id}`,
            { claimed_amount: -1 }
          );
        }
      }
      const rate = settings?.mining_rate_per_sec || 0.01736;
      const dur = settings?.mining_duration_minutes || 60;
      const lockedVip = normalizeVipLevel(userRecord.vip_level);
      const expectedReward = effectiveRatePerSec(rate, lockedVip) * dur * 60 * activeMultiplier;
      const session = await pbPost2("/api/collections/mining_sessions/records", {
        user: pbId,
        start_time: (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").replace("Z", ""),
        claimed_amount: 0,
        is_verified: false,
        ip_address: String(req.ip || req.socket?.remoteAddress || ""),
        booster_multiplier: activeMultiplier,
        vip_level: lockedVip
      });
      if (session.code)
        return res.status(400).json({ error: session.message });
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        current_mining_session: session.id
      });
      const durationMs = dur * 60 * 1e3;
      const rawCreated = (session.created || session.start_time || "").replace(" ", "T");
      const parsedCreated = rawCreated.endsWith("Z") ? rawCreated : rawCreated + "Z";
      const startTimeMs = new Date(parsedCreated).getTime();
      const endTimeMs = startTimeMs + durationMs;
      const serverNow = Date.now();
      res.json({
        id: session.id,
        pbId,
        startTime: session.created || session.start_time,
        startTimeMs,
        // derived from PB's created — tamper-proof server time
        endTimeMs,
        // explicit deadline
        durationMs,
        serverTime: serverNow,
        // client syncs clock drift using this
        multiplier: activeMultiplier,
        expectedReward,
        miningRatePerSec: rate,
        vipLevel: lockedVip,
        ptDeducted: ptCost,
        newPowerTokens: currentPT - ptCost,
        status: "mining"
      });
    } catch (e) {
      console.error("[/api/app/mine/start]", e.message);
      res.status(500).json({ error: "Failed to start mining" });
    }
  });
  app2.get(
    "/api/app/mine/active/:pbId",
    async (req, res) => {
      try {
        const { pbId } = req.params;
        const userCheck = await pbGet2(`/api/collections/users/records/${pbId}?fields=id,status,fraud_attempts`);
        if (!userCheck.code) {
          const isBlocked = userCheck.status === "blocked" || (userCheck.fraud_attempts || 0) >= 3;
          if (isBlocked) {
            if (userCheck.status !== "blocked") {
              await pbPatch2(`/api/collections/users/records/${pbId}`, { status: "blocked" }).catch(() => {
              });
              console.log(`[Guard0/active] Auto-blocked user ${pbId} (fraud_attempts=${userCheck.fraud_attempts})`);
            }
            return res.status(403).json({
              error: "ACCOUNT_BLOCKED",
              blocked: true,
              message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts."
            });
          }
        }
        const r = await pbGet2(
          `/api/collections/mining_sessions/records?filter=${encodeURIComponent(`user="${pbId}" && claimed_amount=0`)}&sort=-start_time&perPage=1`
        );
        const s = r.items?.[0];
        if (!s) return res.json({ session: null });
        const settings = await fetchSettings();
        const dur = (settings?.mining_duration_minutes || 60) * 60 * 1e3;
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
            startTimeMs,
            // derived from PB's created — tamper-proof
            endTimeMs,
            // Unix-ms deadline
            durationMs: dur,
            serverTime: serverNow,
            // client uses this to sync clock drift
            status,
            multiplier: s.booster_multiplier || 1
          }
        });
      } catch (e) {
        console.error("[/api/app/mine/active]", e.message);
        res.status(500).json({ error: "Failed to fetch session" });
      }
    }
  );
  app2.post("/api/app/mine/claim", async (req, res) => {
    try {
      const { sessionId, pbId } = req.body;
      if (!pbId)
        return res.status(400).json({ error: "pbId required" });
      if (!await requireCallerIdentity(req, res, pbId, "mine/claim")) return;
      const [user, settings] = await Promise.all([
        pbGet2(`/api/collections/users/records/${pbId}`),
        fetchSettings()
      ]);
      if (user.code) return res.status(404).json({ error: "User not found" });
      if (!settings) return res.status(503).json({ error: "Settings unavailable" });
      {
        const isBlocked = user.status === "blocked" || (user.fraud_attempts || 0) >= 3;
        if (isBlocked) {
          if (user.status !== "blocked") {
            await pbPatch2(`/api/collections/users/records/${pbId}`, { status: "blocked" }).catch(() => {
            });
            console.log(`[Guard0/claim] Auto-blocked user ${pbId} (fraud_attempts=${user.fraud_attempts})`);
          }
          return res.status(403).json({
            error: "ACCOUNT_BLOCKED",
            blocked: true,
            message: "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts."
          });
        }
      }
      const canonicalSessionId = user.current_mining_session || sessionId;
      if (!canonicalSessionId)
        return res.status(400).json({ error: "No active mining session found" });
      const session = await pbGet2(`/api/collections/mining_sessions/records/${canonicalSessionId}`);
      if (session.code) return res.status(404).json({ error: "Session not found" });
      if (session.user !== pbId) {
        return res.status(403).json({ error: "Session does not belong to this user" });
      }
      const claimedAmt = session.claimed_amount ?? 0;
      if (claimedAmt !== 0) {
        await pbPatch2(`/api/collections/users/records/${pbId}`, {
          current_mining_session: ""
        }).catch(() => {
        });
        return res.status(400).json({
          error: "SESSION_EXPIRED",
          message: "This mining session has already been used. Please start a new one."
        });
      }
      const canonicalStart = session.created || session.start_time;
      const rawStartMs = (canonicalStart || "").replace(" ", "T");
      const parsedStartMs = rawStartMs.endsWith("Z") ? rawStartMs : rawStartMs + "Z";
      const startMs = new Date(parsedStartMs).getTime();
      const durationSec = (settings.mining_duration_minutes || 60) * 60;
      const elapsed = Date.now() - startMs;
      const graceSec = 5 * 60;
      if (elapsed < (durationSec - graceSec) * 1e3) {
        const currentStrikes = user.fraud_attempts || 0;
        const strikes = currentStrikes + 1;
        const isBlocked = strikes >= 3;
        console.log(`[FRAUD] user=${pbId} prev_strikes=${currentStrikes} new_strikes=${strikes} blocked=${isBlocked} elapsed=${Math.round(elapsed / 1e3)}s required=${durationSec}s`);
        try {
          await pbDelete2(`/api/collections/mining_sessions/records/${session.id}`);
          console.log(`[FRAUD] Deleted session ${session.id}`);
        } catch {
          await pbPatch2(`/api/collections/mining_sessions/records/${session.id}`, { claimed_amount: -1 });
          console.log(`[FRAUD] Marked session ${session.id} as voided (delete failed)`);
        }
        await pbPatch2(`/api/collections/users/records/${pbId}`, {
          fraud_attempts: strikes,
          current_mining_session: "",
          ...isBlocked ? { status: "blocked" } : {}
        });
        console.log(`[FRAUD] Updated user ${pbId}: fraud_attempts=${strikes} blocked=${isBlocked}`);
        pbPost2("/api/collections/session_logs/records", {
          user: pbId,
          session_type: "fraud",
          income: 0,
          booster_multiplier: 0,
          duration_seconds: durationSec
        }).catch(() => {
        });
        if (isBlocked && user.email) {
          await saveFraudEmail(user.email);
        }
        const strikesLeft = 3 - strikes;
        return res.status(isBlocked ? 403 : 400).json({
          error: isBlocked ? "ACCOUNT_BLOCKED" : "FRAUD_DETECTED",
          fraudAttempts: strikes,
          blocked: isBlocked,
          message: isBlocked ? "ACCOUNT BANNED! Your account has been permanently disabled due to multiple fraud attempts." : `Strike ${strikes}/3! Cheat detected. Your progress has been reset. ${strikesLeft} more attempt${strikesLeft === 1 ? "" : "s"} and you will be permanently banned.`
        });
      }
      const boosterMultiplier = Number(session.booster_multiplier) || 1;
      if (!VALID_SESSION_MULTIPLIERS.has(boosterMultiplier)) {
        securityLog("mine/claim", "session has non-whitelisted booster_multiplier \u2014 voiding session", {
          pbId,
          sessionId: session.id,
          boosterMultiplier
        });
        await pbPatch2(`/api/collections/mining_sessions/records/${session.id}`, { claimed_amount: -1 }).catch(() => {
        });
        await pbPatch2(`/api/collections/users/records/${pbId}`, { current_mining_session: "" }).catch(() => {
        });
        return res.status(400).json({
          error: "INVALID_SESSION",
          message: "This mining session is invalid. Please start a new one."
        });
      }
      const miningRate = settings.mining_rate_per_sec || 0.01736;
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
      console.log(`[mine/claim] Claiming session ${session.id} for user ${pbId} \u2014 reward: ${serverReward}`);
      const claimPatch = await pbPatch2(`/api/collections/mining_sessions/records/${session.id}`, {
        claimed_amount: serverReward,
        is_verified: true
      });
      if (claimPatch.code) {
        return res.status(500).json({ error: "Failed to mark session as claimed" });
      }
      const newShib = (user.shib_balance || 0) + serverReward;
      const newClaims = (user.total_claims || 0) + 1;
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        shib_balance: newShib,
        total_claims: newClaims,
        current_mining_session: "",
        // nullify — user can now start a fresh session
        fraud_attempts: 0,
        // reset strike counter after a legitimate claim
        vip_level: newUserVip
        // persist any anti-drain demotion going forward
      });
      (async () => {
        try {
          const { syncUserTournamentPoints: syncUserTournamentPoints2 } = await Promise.resolve().then(() => (init_tournament(), tournament_exports));
          const points = await syncUserTournamentPoints2(pbId);
          if (points > 0) console.log(`[mine/claim] synced ${points.toFixed(2)} tournament pts for ${pbId}`);
        } catch (e) {
          console.warn("[mine/claim] tournament sync failed:", e.message);
        }
      })();
      pbPost2("/api/collections/session_logs/records", {
        user: pbId,
        session_type: `${boosterMultiplier}x`,
        income: serverReward,
        booster_multiplier: boosterMultiplier,
        duration_seconds: durationSec
      }).catch(() => {
      });
      if (user.referred_by) {
        (async () => {
          try {
            let referrer = null;
            const direct = await pbGet2(`/api/collections/users/records/${user.referred_by}`);
            if (!direct.code && direct.id) {
              referrer = direct;
            } else {
              const byCode = await pbGet2(
                `/api/collections/users/records?filter=referral_code="${encodeURIComponent(user.referred_by)}"&perPage=1`
              );
              referrer = byCode.items?.[0] || null;
            }
            if (referrer) {
              const commission = Math.round(serverReward * 0.1);
              if (commission > 0) {
                await pbPatch2(`/api/collections/users/records/${referrer.id}`, {
                  referral_balance: (referrer.referral_balance || 0) + commission,
                  referral_earnings: (referrer.referral_earnings || 0) + commission
                });
                pbPost2("/api/collections/referral_history/records", {
                  referrer_id: referrer.id,
                  claimer_id: pbId,
                  referrer_email: referrer.email || "",
                  claimer_email: user.email || "",
                  amount: commission,
                  source: "mining_claim"
                }).catch(() => {
                });
              }
            }
          } catch (_) {
          }
        })();
      }
      res.json({ success: true, newShibBalance: newShib, reward: serverReward, vipLevel: newUserVip, vipAdjusted });
    } catch (e) {
      console.error("[/api/app/mine/claim]", e.message);
      res.status(500).json({ error: "Failed to claim reward" });
    }
  });
  app2.get("/api/app/mine/history/:pbId", async (req, res) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const filter = encodeURIComponent(`user="${pbId}" && claimed_amount > 0`);
      const r = await pbGet2(
        `/api/collections/mining_sessions/records?filter=${filter}&sort=-created&perPage=20`
      );
      const sessions = (r.items || []).map((s) => ({
        id: s.id,
        startTime: s.start_time,
        claimedAmount: s.claimed_amount,
        boosterMultiplier: s.booster_multiplier || 1,
        created: s.created
      }));
      res.json(sessions);
    } catch (e) {
      console.error("[/api/app/mine/history]", e.message);
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });
  app2.get(
    "/api/app/withdrawals/tier/:pbId",
    async (req, res) => {
      try {
        const { pbId } = req.params;
        const settings = await fetchSettings();
        const r = await pbGet2(
          `/api/collections/withdrawals/records?filter=${encodeURIComponent(`user="${pbId}" && status="completed"`)}&perPage=200`
        );
        const count = r.totalItems || 0;
        let minAmount;
        if (count === 0) minAmount = settings?.min_withdrawal_1 || 100;
        else if (count === 1) minAmount = settings?.min_withdrawal_2 || 1e3;
        else minAmount = settings?.min_withdrawal_3 || 8e3;
        res.json({ tier: Math.min(count + 1, 3), minAmount, completedCount: count });
      } catch (e) {
        console.error("[/api/app/withdrawals/tier]", e.message);
        res.status(500).json({ error: "Failed to fetch tier" });
      }
    }
  );
  const kycFilterEsc = (s) => String(s || "").replace(/["'\\\n\r]/g, "").trim();
  app2.post("/api/app/verification/submit", async (req, res) => {
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
      if (isKycCountryBlocked(country))
        return res.status(403).json({
          error: "Verification is not available in your country.",
          countryBlocked: true
        });
      const countryInfo = findKycCountry(country);
      if (!countryInfo)
        return res.status(400).json({ error: "Please select a valid country" });
      const countryCode = countryInfo.dial;
      if (!validateKycPhone(phone))
        return res.status(400).json({ error: "Invalid phone number" });
      if (!validateBep20Address(bep20Address))
        return res.status(400).json({ error: "Invalid BEP20 wallet address (must be 0x + 40 hex characters)" });
      const supported = isBinanceSupported(country);
      let binanceEmail = "";
      if (supported) {
        if (!binanceEmailRaw || !validateKycEmail(binanceEmailRaw))
          return res.status(400).json({ error: "Please enter a valid Binance email" });
        binanceEmail = binanceEmailRaw;
      }
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const currentStatus = normalizeKycStatus(user.kyc_status);
      if (currentStatus === "verified")
        return res.status(400).json({ error: "Your account is already verified" });
      if (currentStatus === "under_review")
        return res.status(400).json({ error: "Your verification is already under review" });
      const submissionCount = Number(user.submission_count) || 0;
      if (submissionCount >= 3)
        return res.status(429).json({
          error: "You have reached the maximum limit for account verification.",
          limitReached: true
        });
      const orParts = [
        `bep20_address = "${kycFilterEsc(bep20Address)}"`,
        `(country_code = "${kycFilterEsc(countryCode)}" && phone = "${kycFilterEsc(phone)}")`
      ];
      if (binanceEmail) orParts.push(`binance_email = "${kycFilterEsc(binanceEmail)}"`);
      const dupFilter = encodeURIComponent(
        `user != "${kycFilterEsc(pbId)}" && (status = "${KYC_STATUS_UNDER_REVIEW}" || status = "${KYC_STATUS_VERIFIED}") && (${orParts.join(" || ")})`
      );
      const dup = await pbGet2(
        `/api/collections/verification_requests/records?filter=${dupFilter}&perPage=10&fields=binance_email,bep20_address,phone,country_code`
      );
      if ((dup?.items || []).length > 0) {
        const fields = [];
        for (const row of dup.items) {
          if (row.bep20_address === bep20Address && !fields.includes("bep20Address")) fields.push("bep20Address");
          if (row.phone === phone && row.country_code === countryCode && !fields.includes("phone")) fields.push("phone");
          if (binanceEmail && row.binance_email === binanceEmail && !fields.includes("binanceEmail")) fields.push("binanceEmail");
        }
        return res.status(409).json({ error: "Field already in use", duplicate: true, fields });
      }
      const expectedDigits = `${countryCode}${phone}`.replace(/\D/g, "");
      const waPhone = String(user.wa_verified_phone || "").replace(/\D/g, "");
      const phoneVerified = !!waPhone && waPhone === expectedDigits;
      const created = await pbPost2("/api/collections/verification_requests/records", {
        user: pbId,
        full_name: fullName,
        country,
        country_code: countryCode,
        phone,
        binance_email: binanceEmail,
        bep20_address: bep20Address,
        phone_verified: phoneVerified,
        status: KYC_STATUS_UNDER_REVIEW,
        // PB SELECT label
        reject_reason: ""
      });
      if (created.code)
        return res.status(500).json({ error: "Could not submit verification. Try again." });
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        kyc_status: "under_review",
        kyc_reject_reason: "",
        "submission_count+": 1
        // atomic increment (no read-modify-write race)
      });
      res.json({
        success: true,
        status: "under_review",
        requestId: created.id,
        submissionsUsed: submissionCount + 1,
        submissionsLimit: 3
      });
    } catch (e) {
      console.error("[/api/app/verification/submit]", e.message);
      res.status(500).json({ error: "Verification submit failed" });
    }
  });
  const TG_SESSION_TTL_MS = 15 * 60 * 1e3;
  const tgStartGuard = /* @__PURE__ */ new Map();
  async function tgFindSession(filter) {
    const r = await pbGet2(
      `/api/collections/telegram_verifications/records?filter=${encodeURIComponent(`(${filter}) && status = "pending"`)}&sort=-created&perPage=1`
    );
    const row = (r?.items || [])[0];
    if (!row) return null;
    if (Date.now() - new Date(row.created).getTime() > TG_SESSION_TTL_MS) return null;
    return row;
  }
  app2.post("/api/app/verification/telegram/start", async (req, res) => {
    try {
      const { pbId } = req.body;
      const identifier = String(req.body.identifier || "").replace(/\D/g, "");
      if (!pbId || identifier.length < 8 || identifier.length > 15)
        return res.status(400).json({ error: "Enter a valid phone number first" });
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const now = Date.now();
      const guard = tgStartGuard.get(pbId) || { count: 0, windowStart: now, lastSentAt: 0 };
      if (now - guard.windowStart > 60 * 60 * 1e3) {
        guard.count = 0;
        guard.windowStart = now;
      }
      if (now - guard.lastSentAt < 5 * 1e3)
        return res.status(429).json({ error: "Please wait a moment and try again." });
      if (guard.count >= 12)
        return res.status(429).json({ error: "Too many attempts. Try again in an hour." });
      guard.count += 1;
      guard.lastSentAt = now;
      tgStartGuard.set(pbId, guard);
      const token = crypto.randomBytes(16).toString("hex");
      const created = await pbPost2("/api/collections/telegram_verifications/records", {
        token,
        user: pbId,
        phone: identifier,
        status: "pending"
      });
      if (!created?.id) {
        console.error("[telegram/start] session row create failed:", JSON.stringify(created).slice(0, 200));
        return res.status(502).json({ error: "Could not start verification. Try again." });
      }
      console.log(`[telegram/start] user ${pbId} \u2192 token ${token.slice(0, 8)}\u2026 for ****${identifier.slice(-4)}`);
      res.json({
        success: true,
        token,
        botUsername: TELEGRAM_BOT_USERNAME,
        deepLink: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${token}`
      });
    } catch (e) {
      console.error("[/api/app/verification/telegram/start]", e.message);
      res.status(500).json({ error: "Could not start Telegram verification" });
    }
  });
  app2.post("/api/app/telegram/webhook", async (req, res) => {
    res.json({ ok: true });
    try {
      if (req.get("x-telegram-bot-api-secret-token") !== TELEGRAM_WEBHOOK_SECRET) {
        console.warn("[telegram/webhook] bad secret header \u2014 update ignored");
        return;
      }
      const msg = req.body?.message;
      if (!msg?.chat?.id || !msg?.from?.id) return;
      const chatId = msg.chat.id;
      const text = String(msg.text || "");
      if (text.startsWith("/start")) {
        const tok = (text.split(/\s+/)[1] || "").replace(/[^a-f0-9]/gi, "");
        const row = tok ? await tgFindSession(`token = "${tok}"`) : null;
        if (!row) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: 'This verification link is invalid or has expired.\n\nGo back to the Shiba Hit app and tap "Verify via Telegram" again.'
          });
          return;
        }
        await pbPatch2(`/api/collections/telegram_verifications/records/${row.id}`, {
          chat_id: String(chatId),
          tg_user_id: String(msg.from.id)
        });
        await tgApi("sendMessage", {
          chat_id: chatId,
          text: `Shiba Hit account verification

Tap the button below to share your contact and verify the number ending in ****${String(row.phone).slice(-4)}.`,
          reply_markup: {
            keyboard: [[{ text: "\u{1F4F1} Share Contact to Verify Account", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        });
        return;
      }
      if (msg.contact) {
        if (!msg.contact.user_id || String(msg.contact.user_id) !== String(msg.from.id)) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: `Please use the "\u{1F4F1} Share Contact" button to share YOUR OWN contact \u2014 forwarded contacts can't be used.`
          });
          return;
        }
        const row = await tgFindSession(`chat_id = "${chatId}" && tg_user_id = "${msg.from.id}"`);
        if (!row) {
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: 'This verification session has expired. Go back to the app and tap "Verify via Telegram" again.',
            reply_markup: { remove_keyboard: true }
          });
          return;
        }
        const tgDigits = String(msg.contact.phone_number || "").replace(/\D/g, "");
        const expected = String(row.phone || "").replace(/\D/g, "");
        if (tgDigits && tgDigits === expected) {
          await pbPatch2(`/api/collections/users/records/${row.user}`, {
            wa_verified_phone: expected,
            wa_verified_at: (/* @__PURE__ */ new Date()).toISOString()
          });
          await pbPatch2(`/api/collections/telegram_verifications/records/${row.id}`, { status: "verified" });
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: "\u2705 Phone number verified!\n\nReturn to the Shiba Hit app \u2014 your verification will appear there automatically.",
            reply_markup: { remove_keyboard: true }
          });
          console.log(`[telegram/webhook] user ${row.user} verified ****${expected.slice(-4)} via Telegram`);
        } else {
          await pbPatch2(`/api/collections/telegram_verifications/records/${row.id}`, { status: "mismatch" });
          await tgApi("sendMessage", {
            chat_id: chatId,
            text: `\u274C Number mismatch.

This Telegram account is registered to a number ending in ****${tgDigits.slice(-4)}, but the app form has ****${expected.slice(-4)}. Enter your Telegram number in the app and try again.`,
            reply_markup: { remove_keyboard: true }
          });
          console.log(`[telegram/webhook] user ${row.user} mismatch: tg ****${tgDigits.slice(-4)} vs app ****${expected.slice(-4)}`);
        }
        return;
      }
    } catch (e) {
      console.error("[/api/app/telegram/webhook]", e.message);
    }
  });
  app2.get("/api/app/verification/status/:pbId", async (req, res) => {
    try {
      const { pbId } = req.params;
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const latest = await pbGet2(
        `/api/collections/verification_requests/records?filter=${encodeURIComponent(`user = "${kycFilterEsc(pbId)}"`)}&sort=-created&perPage=1`
      );
      const row = (latest?.items || [])[0];
      let kycStatus = normalizeKycStatus(user.kyc_status);
      let rejectReason = user.kyc_reject_reason || "";
      if (row) {
        const derived = normalizeKycStatus(row.status);
        const isUnverifyAudit = derived === "rejected" && (row.reject_reason || "") === "Released by admin (unverified)" && kycStatus === "none";
        if (derived !== "none" && derived !== kycStatus && !isUnverifyAudit) {
          const patch = derived === "verified" ? {
            kyc_status: "verified",
            kyc_reject_reason: "",
            kyc_full_name: row.full_name,
            kyc_country: row.country,
            kyc_country_code: row.country_code,
            kyc_phone: row.phone,
            kyc_binance_email: row.binance_email || "",
            kyc_bep20_address: row.bep20_address
          } : derived === "rejected" ? { kyc_status: "rejected", kyc_reject_reason: row.reject_reason || "" } : { kyc_status: "under_review", kyc_reject_reason: "" };
          const healed = await pbPatch2(`/api/collections/users/records/${pbId}`, patch);
          if (!healed.code) {
            kycStatus = derived;
            rejectReason = String(patch.kyc_reject_reason ?? "");
            console.log(`[verification/status] self-heal: user ${pbId} kyc_status \u2192 ${derived} (from request row ${row.id})`);
          } else {
            console.warn("[verification/status] self-heal patch failed:", JSON.stringify(healed).slice(0, 150));
          }
        }
      }
      res.json({
        kycStatus,
        rejectReason,
        request: row ? {
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
          created: row.created
        } : null
      });
    } catch (e) {
      console.error("[/api/app/verification/status]", e.message);
      res.status(500).json({ error: "Failed to fetch verification status" });
    }
  });
  app2.get("/api/app/admin/verification", async (req, res) => {
    try {
      const q = String(req.query.status || "under_review");
      const status = q === "all" ? "all" : toDbKycStatus(q);
      const filter = status === "all" ? "" : `filter=${encodeURIComponent(`status = "${kycFilterEsc(status)}"`)}&`;
      const r = await pbGet2(
        `/api/collections/verification_requests/records?${filter}sort=-created&perPage=100&expand=user`
      );
      res.json({
        items: (r.items || []).map((v) => ({
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
          created: v.created
        })),
        totalItems: r.totalItems || 0
      });
    } catch (e) {
      console.error("[/api/app/admin/verification]", e.message);
      res.status(500).json({ error: "Failed to fetch verification requests" });
    }
  });
  app2.post("/api/app/admin/verification/:id/approve", async (req, res) => {
    try {
      const { id } = req.params;
      const row = await pbGet2(`/api/collections/verification_requests/records/${id}`);
      if (row.code) return res.status(404).json({ error: "Request not found" });
      if (toDbKycStatus(row.status) !== KYC_STATUS_UNDER_REVIEW)
        return res.status(400).json({ error: `Request is already ${row.status}` });
      await pbPatch2(`/api/collections/verification_requests/records/${id}`, {
        status: KYC_STATUS_VERIFIED,
        reject_reason: ""
      });
      await pbPatch2(`/api/collections/users/records/${row.user}`, {
        kyc_status: "verified",
        kyc_reject_reason: "",
        kyc_full_name: row.full_name,
        kyc_country: row.country,
        kyc_country_code: row.country_code,
        kyc_phone: row.phone,
        kyc_binance_email: row.binance_email || "",
        kyc_bep20_address: row.bep20_address
      });
      pbPost2("/api/collections/notifications/records", {
        title: "Account Verified \u2713",
        message: "Congratulations! Your account verification has been approved. You now have full access to the Wallet and Multiplayer Hub.",
        type: "personal",
        target_user: row.user
      }).catch((e) => console.warn("[verification/approve] Notification failed:", e.message));
      res.json({ success: true });
    } catch (e) {
      console.error("[/api/app/admin/verification/approve]", e.message);
      res.status(500).json({ error: "Approve failed" });
    }
  });
  app2.post("/api/app/admin/verification/:id/reject", async (req, res) => {
    try {
      const { id } = req.params;
      const reason = String(req.body?.reason || "").trim();
      if (!reason) return res.status(400).json({ error: "A rejection reason is required" });
      const row = await pbGet2(`/api/collections/verification_requests/records/${id}`);
      if (row.code) return res.status(404).json({ error: "Request not found" });
      if (toDbKycStatus(row.status) !== KYC_STATUS_UNDER_REVIEW)
        return res.status(400).json({ error: `Request is already ${row.status}` });
      await pbPatch2(`/api/collections/verification_requests/records/${id}`, {
        status: KYC_STATUS_REJECTED,
        reject_reason: reason
      });
      await pbPatch2(`/api/collections/users/records/${row.user}`, {
        kyc_status: "rejected",
        kyc_reject_reason: reason
      });
      pbPost2("/api/collections/notifications/records", {
        title: "Verification Rejected",
        message: `Your account verification was rejected. Reason: ${reason}. Please review your details and submit again.`,
        type: "personal",
        target_user: row.user
      }).catch((e) => console.warn("[verification/reject] Notification failed:", e.message));
      res.json({ success: true });
    } catch (e) {
      console.error("[/api/app/admin/verification/reject]", e.message);
      res.status(500).json({ error: "Reject failed" });
    }
  });
  app2.post("/api/app/admin/verification/unverify", async (req, res) => {
    try {
      const { pbId } = req.body;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const active = await pbGet2(
        `/api/collections/verification_requests/records?filter=${encodeURIComponent(`user = "${kycFilterEsc(pbId)}" && (status = "${KYC_STATUS_VERIFIED}" || status = "${KYC_STATUS_UNDER_REVIEW}")`)}&perPage=50&fields=id`
      );
      for (const r of active?.items || []) {
        await pbPatch2(`/api/collections/verification_requests/records/${r.id}`, { status: KYC_STATUS_REJECTED, reject_reason: "Released by admin (unverified)" }).catch(() => {
        });
      }
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        kyc_status: "none",
        kyc_reject_reason: "",
        kyc_full_name: "",
        kyc_country: "",
        kyc_country_code: "",
        kyc_phone: "",
        kyc_binance_email: "",
        kyc_bep20_address: ""
      });
      res.json({ success: true });
    } catch (e) {
      console.error("[/api/app/admin/verification/unverify]", e.message);
      res.status(500).json({ error: "Unverify failed" });
    }
  });
  app2.post("/api/app/withdrawals", async (req, res) => {
    try {
      const { pbId, method, amount } = req.body;
      if (!pbId || !amount)
        return res.status(400).json({ error: "pbId, amount required" });
      const grossAmount = Number(amount);
      if (!Number.isFinite(grossAmount) || grossAmount <= 0)
        return res.status(400).json({ error: "Invalid withdrawal amount" });
      if (!await requireCallerIdentity(req, res, pbId, "withdrawals")) return;
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      if (normalizeKycStatus(user.kyc_status) !== "verified")
        return res.status(403).json({
          error: "Your account is not verified. Please verify to access withdrawals.",
          kycRequired: true
        });
      const isIndiaUser = user.kyc_country === BINANCE_WITHDRAW_COUNTRY;
      const resolvedMethod = method === "Binance Email" && isIndiaUser && user.kyc_binance_email ? "Binance Email" : "BEP-20";
      const destination = resolvedMethod === "Binance Email" ? user.kyc_binance_email : user.kyc_bep20_address || "";
      if (!destination)
        return res.status(400).json({
          error: "No verified withdrawal destination on file. Please contact support."
        });
      if ((user.shib_balance || 0) < amount)
        return res.status(400).json({ error: "Insufficient balance" });
      const lockedBalance = lockedBalanceForVipLevel(user.vip_level);
      const availableBalance = Math.max(0, (Number(user.shib_balance) || 0) - lockedBalance);
      if (grossAmount > availableBalance)
        return res.status(400).json({
          error: `VIP ${normalizeVipLevel(user.vip_level)} locks ${lockedBalance} SHIB in your wallet. You can withdraw up to ${availableBalance} SHIB. Contact support@shibahit.com to remove your VIP tier.`
        });
      const tierRes = await pbGet2(
        `/api/collections/withdrawals/records?filter=${encodeURIComponent(`user="${pbId}" && status="completed"`)}&perPage=200`
      );
      const settings = await fetchSettings();
      const count = tierRes.totalItems || 0;
      let minAmount;
      if (count === 0) minAmount = settings?.min_withdrawal_1 || 100;
      else if (count === 1) minAmount = settings?.min_withdrawal_2 || 1e3;
      else minAmount = settings?.min_withdrawal_3 || 8e3;
      if (amount < minAmount)
        return res.status(400).json({ error: `Minimum withdrawal is ${minAmount} SHIB` });
      const bep20Fee = Number(settings?.bep20_fees) > 0 ? Number(settings.bep20_fees) : Number(settings?.bep20_fee) > 0 ? Number(settings.bep20_fee) : 3680;
      const resolvedNet = resolvedMethod === "BEP-20" ? grossAmount - bep20Fee : grossAmount;
      if (resolvedNet <= 0)
        return res.status(400).json({ error: `Amount must exceed the ${bep20Fee} SHIB network fee` });
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        shib_balance: user.shib_balance - amount
      });
      let masked_name = user.display_name || user.username || "";
      if (masked_name.includes("@")) masked_name = masked_name.split("@")[0];
      const withdrawal = await pbPost2(
        "/api/collections/withdrawals/records",
        {
          user: pbId,
          method: resolvedMethod,
          address_or_email: destination,
          amount: resolvedNet,
          status: "pending",
          masked_name
        }
      );
      if (withdrawal.code) {
        await pbPatch2(`/api/collections/users/records/${pbId}`, {
          shib_balance: user.shib_balance
        });
        return res.status(400).json({ error: withdrawal.message });
      }
      res.json({
        id: withdrawal.id,
        status: "pending",
        amount,
        newBalance: user.shib_balance - amount
      });
    } catch (e) {
      console.error("[/api/app/withdrawals]", e.message);
      res.status(500).json({ error: "Failed to create withdrawal" });
    }
  });
  app2.get(
    "/api/app/withdrawals/:pbId",
    async (req, res) => {
      try {
        const { pbId } = req.params;
        const r = await pbGet2(
          `/api/collections/withdrawals/records?filter=${encodeURIComponent(`user="${pbId}"`)}&sort=-created&perPage=50`
        );
        res.json(
          (r.items || []).map((w) => ({
            id: w.id,
            method: w.method,
            addressOrEmail: w.address_or_email,
            amount: w.amount,
            status: w.status,
            created: w.created
          }))
        );
      } catch (e) {
        console.error("[/api/app/withdrawals/:pbId]", e.message);
        res.status(500).json({ error: "Failed to fetch withdrawals" });
      }
    }
  );
  app2.get("/api/app/leaderboard", async (_req, res) => {
    try {
      const r = await pbGet2(
        `/api/collections/users/records?sort=-shib_balance&perPage=100&fields=id,display_name,shib_balance`
      );
      res.json(
        (r.items || []).map((u, i) => {
          let name = u.display_name || "Anonymous";
          if (name.includes("@")) name = name.split("@")[0];
          return {
            rank: i + 1,
            id: u.id,
            displayName: name,
            shibBalance: u.shib_balance || 0
          };
        })
      );
    } catch (e) {
      console.error("[/api/app/leaderboard]", e.message);
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });
  app2.get("/api/app/leaderboard/rank/:pbId", async (req, res) => {
    try {
      const { pbId } = req.params;
      const user = await pbGet2(`/api/collections/users/records/${pbId}?fields=id,display_name,shib_balance`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const balance = user.shib_balance || 0;
      const ahead = await pbGet2(
        `/api/collections/users/records?filter=${encodeURIComponent(`shib_balance>${balance}`)}&perPage=1&fields=id`
      );
      const rank = (ahead.totalItems || 0) + 1;
      let rankName = user.display_name || "You";
      if (rankName.includes("@")) rankName = rankName.split("@")[0];
      res.json({
        rank,
        id: user.id,
        displayName: rankName,
        shibBalance: balance
      });
    } catch (e) {
      console.error("[/api/app/leaderboard/rank]", e.message);
      res.status(500).json({ error: "Failed to fetch rank" });
    }
  });
  app2.get("/api/app/withdrawals/approved/recent", async (_req, res) => {
    try {
      const r = await pbGet2(
        `/api/collections/withdrawals/records?filter=${encodeURIComponent(`status="completed" || status="approved"`)}&sort=-created&perPage=10&expand=user`
      );
      const items = (r.items || []).map((w) => {
        let username = w.masked_name || w.expand?.user?.display_name || w.expand?.user?.username || "";
        if (!username || username.includes("@")) {
          username = username.includes("@") ? username.split("@")[0] : username;
        }
        if (!username) username = "User";
        return {
          id: w.id,
          maskedName: username,
          method: w.method || "BEP-20",
          amount: w.amount || 0
        };
      });
      res.json(items);
    } catch (e) {
      console.error("[/api/app/withdrawals/approved/recent]", e.message);
      res.status(500).json({ error: "Failed to fetch recent withdrawals" });
    }
  });
  app2.get("/api/app/notifications/:pbId", async (req, res) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const filter = encodeURIComponent(`type = "global" || (type = "personal" && target_user = "${pbId}")`);
      const r = await pbGet2(
        `/api/collections/notifications/records?filter=${filter}&sort=-created&perPage=50`
      );
      res.json({
        items: (r.items || []).map((n) => ({
          id: n.id,
          title: n.title,
          message: n.message,
          type: n.type,
          created: n.created
        }))
      });
    } catch (e) {
      console.error("[/api/app/notifications]", e.message);
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  });
  app2.get("/api/app/admin/users", async (req, res) => {
    try {
      const page = parseInt(String(req.query.page || "1"));
      const r = await pbGet2(
        `/api/collections/users/records?sort=-created&perPage=50&page=${page}`
      );
      res.json({
        items: (r.items || []).map(formatUser),
        totalItems: r.totalItems,
        totalPages: r.totalPages,
        page
      });
    } catch (e) {
      console.error("[/api/app/admin/users]", e.message);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });
  app2.get(
    "/api/app/admin/withdrawals",
    async (req, res) => {
      try {
        const status = req.query.status ? `filter=status="${req.query.status}"&` : "";
        const r = await pbGet2(
          `/api/collections/withdrawals/records?${status}sort=-created&perPage=100&expand=user`
        );
        res.json({
          items: (r.items || []).map((w) => ({
            id: w.id,
            userId: w.user,
            userEmail: w.expand?.user?.email || "",
            userName: w.expand?.user?.display_name || "",
            method: w.method,
            addressOrEmail: w.address_or_email,
            amount: w.amount,
            status: w.status,
            created: w.created
          })),
          totalItems: r.totalItems
        });
      } catch (e) {
        console.error("[/api/app/admin/withdrawals]", e.message);
        res.status(500).json({ error: "Failed to fetch withdrawals" });
      }
    }
  );
  app2.put(
    "/api/app/admin/withdrawals/:id",
    async (req, res) => {
      try {
        const { id } = req.params;
        const { status, reason } = req.body;
        if (!["pending", "completed", "rejected"].includes(status))
          return res.status(400).json({ error: "Invalid status" });
        const patchBody = { status };
        if (status === "rejected" && reason) {
          patchBody.cancellation_reason = reason;
        }
        const updated = await pbPatch2(
          `/api/collections/withdrawals/records/${id}`,
          patchBody
        );
        if (status === "completed" && updated && !updated.code && updated.user) {
          pbPost2("/api/collections/notifications/records", {
            title: "Withdrawal Completed \u2713",
            message: "Congratulations! Your withdrawal request has been processed and completed successfully. Please check your wallet/account. Thank you for mining with us!",
            type: "personal",
            target_user: updated.user
          }).catch(
            (e) => console.warn("[withdrawals/complete] Notification failed:", e.message)
          );
          try {
            const flaggedUser = await pbGet2(
              `/api/collections/users/records/${updated.user}`
            );
            if (flaggedUser && !flaggedUser.code && flaggedUser.is_blacklist_1 && !flaggedUser.blacklist_1_notified) {
              await pbPatch2(`/api/collections/users/records/${updated.user}`, {
                blacklist_1_notified: true,
                blacklist_1_notified_at: (/* @__PURE__ */ new Date()).toISOString()
              });
              await pbPost2("/api/collections/notifications/records", {
                title: "Fraud activity detected",
                message: "Some uneven activity detected like auto clicker. Don't use it.",
                type: "personal",
                target_user: updated.user
              }).catch(() => {
              });
              await pbPost2("/api/collections/notifications/records", {
                title: "Account ban notification.",
                message: "If you can do it again we will terminate your account permanently.",
                type: "personal",
                target_user: updated.user
              }).catch(() => {
              });
            }
          } catch (e) {
            console.warn("[withdrawals/complete] Blacklist warning failed:", e.message);
          }
        }
        if (status === "rejected" && updated && !updated.code && updated.user) {
          const withdrawal = updated;
          const user = await pbGet2(
            `/api/collections/users/records/${withdrawal.user}`
          );
          if (user && !user.code) {
            await pbPatch2(`/api/collections/users/records/${withdrawal.user}`, {
              shib_balance: (user.shib_balance || 0) + withdrawal.amount
            });
          }
          const cancelMsg = reason ? `Your withdrawal has been cancelled. Reason: ${reason}` : "Your withdrawal request has been cancelled. Please contact support if you have any questions.";
          pbPost2("/api/collections/notifications/records", {
            title: "Withdrawal Cancelled",
            message: cancelMsg,
            type: "personal",
            target_user: updated.user
          }).catch(
            (e) => console.warn("[withdrawals/rejected] Notification failed:", e.message)
          );
        }
        res.json({ success: true, status });
      } catch (e) {
        console.error("[/api/app/admin/withdrawals/:id]", e.message);
        res.status(500).json({ error: "Failed to update withdrawal" });
      }
    }
  );
  app2.put(
    "/api/app/admin/settings/:id",
    async (req, res) => {
      try {
        const { id } = req.params;
        const body = req.body;
        const pbUpdate = {};
        if (body.miningRatePerSec !== void 0)
          pbUpdate.mining_rate_per_sec = body.miningRatePerSec;
        if (body.powerTokenPerClick !== void 0)
          pbUpdate.power_token_per_click = body.powerTokenPerClick;
        if (body.miningDurationMinutes !== void 0)
          pbUpdate.mining_duration_minutes = body.miningDurationMinutes;
        if (body.tokensPerRound !== void 0)
          pbUpdate.tokens_per_round = body.tokensPerRound;
        if (body.boostCosts) {
          if (body.boostCosts["2x"] !== void 0)
            pbUpdate.boost_2x_cost = body.boostCosts["2x"];
          if (body.boostCosts["4x"] !== void 0)
            pbUpdate.boost_4x_cost = body.boostCosts["4x"];
          if (body.boostCosts["6x"] !== void 0)
            pbUpdate.boost_6x_cost = body.boostCosts["6x"];
          if (body.boostCosts["10x"] !== void 0)
            pbUpdate.boost_10x_cost = body.boostCosts["10x"];
        }
        if (body.minWithdrawal1 !== void 0)
          pbUpdate.min_withdrawal_1 = body.minWithdrawal1;
        if (body.minWithdrawal2 !== void 0)
          pbUpdate.min_withdrawal_2 = body.minWithdrawal2;
        if (body.minWithdrawal3 !== void 0)
          pbUpdate.min_withdrawal_3 = body.minWithdrawal3;
        if (body.bep20Fees !== void 0)
          pbUpdate.bep20_fees = Math.max(0, Number(body.bep20Fees) || 0);
        if (body.showAds !== void 0) pbUpdate.show_ads = body.showAds;
        if (body.forceUnityOnly !== void 0)
          pbUpdate.force_unity_only = !!body.forceUnityOnly;
        if (body.networkGuardEnabled !== void 0)
          pbUpdate.network_guard_enabled = !!body.networkGuardEnabled;
        if (body.activeAdNetwork !== void 0)
          pbUpdate.active_ad_network = body.activeAdNetwork;
        if (body.admobUnitId !== void 0)
          pbUpdate.admob_unit_id = body.admobUnitId;
        if (body.admobBannerUnitId !== void 0)
          pbUpdate.admob_banner_unit_id = body.admobBannerUnitId;
        if (body.applovinSdkKey !== void 0)
          pbUpdate.applovin_sdk_key = body.applovinSdkKey;
        if (body.applovinRewardedId !== void 0)
          pbUpdate.applovin_rewarded_id = body.applovinRewardedId;
        if (body.unityGameId !== void 0)
          pbUpdate.unity_game_id = body.unityGameId;
        if (body.unityRewardedId !== void 0)
          pbUpdate.unity_rewarded_id = body.unityRewardedId;
        if (body.unityInterstitialId !== void 0)
          pbUpdate.unity_interstitial_id = body.unityInterstitialId;
        if (body.applovinBannerId !== void 0)
          pbUpdate.applovin_banner_id = body.applovinBannerId;
        if (body.applovinInterstitialId !== void 0)
          pbUpdate.applovin_interstitial_id = body.applovinInterstitialId;
        if (body.appStoreLink !== void 0)
          pbUpdate.app_store_link = body.appStoreLink;
        if (body.playStoreUrl !== void 0)
          pbUpdate.play_store_url = body.playStoreUrl;
        if (body.ratePopupFrequency !== void 0)
          pbUpdate.rate_popup_frequency = body.ratePopupFrequency;
        if (body.minimumVersion !== void 0)
          pbUpdate.minimum_version = body.minimumVersion;
        if (body.dailyRewardDay1Shib !== void 0)
          pbUpdate.daily_reward_day1_shib = body.dailyRewardDay1Shib;
        if (body.dailyRewardDay2Pt !== void 0)
          pbUpdate.daily_reward_day2_pt = body.dailyRewardDay2Pt;
        if (body.dailyRewardDay3Shib !== void 0)
          pbUpdate.daily_reward_day3_shib = body.dailyRewardDay3Shib;
        if (body.dailyRewardDay4Pt !== void 0)
          pbUpdate.daily_reward_day4_pt = body.dailyRewardDay4Pt;
        if (body.dailyRewardDay5Shib !== void 0)
          pbUpdate.daily_reward_day5_shib = body.dailyRewardDay5Shib;
        if (body.dailyRewardDay6Pt !== void 0)
          pbUpdate.daily_reward_day6_pt = body.dailyRewardDay6Pt;
        if (body.dailyRewardDay7Shib !== void 0)
          pbUpdate.daily_reward_day7_shib = body.dailyRewardDay7Shib;
        if (body.dailyRewardDay7Pt !== void 0)
          pbUpdate.daily_reward_day7_pt = body.dailyRewardDay7Pt;
        const updated = await pbPatch2(
          `/api/collections/settings/records/${id}`,
          pbUpdate
        );
        if (updated.code)
          return res.status(400).json({ error: updated.message });
        settingsCache = updated;
        settingsCacheAt = Date.now();
        res.json({ success: true });
      } catch (e) {
        console.error("[/api/app/admin/settings/:id]", e.message);
        res.status(500).json({ error: "Failed to update settings" });
      }
    }
  );
  app2.get("/api/app/admin/stats", async (_req, res) => {
    try {
      const [usersRes, sessionsRes, withdrawalsRes] = await Promise.all([
        pbGet2("/api/collections/users/records?perPage=1"),
        pbGet2("/api/collections/mining_sessions/records?perPage=1"),
        pbGet2("/api/collections/withdrawals/records?perPage=1")
      ]);
      const pendingRes = await pbGet2(
        '/api/collections/withdrawals/records?filter=status="pending"&perPage=1'
      );
      res.json({
        totalUsers: usersRes.totalItems || 0,
        totalSessions: sessionsRes.totalItems || 0,
        totalWithdrawals: withdrawalsRes.totalItems || 0,
        pendingWithdrawals: pendingRes.totalItems || 0
      });
    } catch (e) {
      console.error("[/api/app/admin/stats]", e.message);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });
  (async () => {
    try {
      const token = await getAdminToken2();
      const col = await pbHttp2("GET", "/api/collections/users", null, token);
      const hasField = (col.schema || []).some((f) => f.name === "purchased_items");
      if (!hasField) {
        await pbHttp2("PATCH", "/api/collections/users", {
          schema: [...col.schema || [], { name: "purchased_items", type: "json", required: false, options: {} }]
        }, token);
        console.log("[Schema] Added purchased_items field to users collection");
      }
    } catch (e) {
      console.warn("[Schema] purchased_items migration skipped:", e.message);
    }
  })();
  app2.get("/api/app/shop/items/:pbId", async (req, res) => {
    try {
      const { pbId } = req.params;
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      return res.json({ purchasedItems: user.purchased_items || [] });
    } catch (e) {
      console.error("[shop/items]", e.message);
      return res.status(500).json({ error: e.message });
    }
  });
  app2.post("/api/app/shop/buy", async (req, res) => {
    try {
      const { pbId, itemId } = req.body;
      if (!pbId || !itemId) return res.status(400).json({ error: "pbId and itemId required" });
      const KNIFE_PRICE = 200;
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const purchased = user.purchased_items || [];
      if (purchased.includes(itemId)) return res.status(400).json({ error: "Already owned" });
      const match = itemId.match(/^knife_(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > 1) {
          const prevId = `knife_${n - 1}`;
          const prevOwned = prevId === "knife_1" || purchased.includes(prevId);
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
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        power_tokens: newPT,
        purchased_items: newPurchased
      });
      return res.json({ success: true, newPowerTokens: newPT, purchasedItems: newPurchased });
    } catch (e) {
      console.error("[shop/buy]", e.message);
      return res.status(500).json({ error: "Purchase failed" });
    }
  });
  app2.get("/api/app/game/data/:pbId", async (req, res) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const data = {
        power_tokens: Number(user.power_tokens) || 0,
        collected_tomatoes: Number(user.collected_tomatoes) || 0,
        last_session_score: Number(user.last_session_score) || 0,
        total_accumulated_score: Number(user.total_accumulated_score) || 0
      };
      console.log(`[/api/app/game/data/${pbId}]`, JSON.stringify(data));
      res.json(data);
    } catch (e) {
      console.error("[/api/app/game/data]", e.message);
      res.status(500).json({ error: "Failed to fetch game data" });
    }
  });
  const MAX_SCORE_PER_SECOND = 15;
  const ABSOLUTE_MAX_SCORE = 2e3;
  const MIN_SESSION_MS = 2e3;
  app2.post("/api/app/game/sync-score", async (req, res) => {
    try {
      const { pbId, score, collected_tomatoes: clientTomatoes, elapsed_ms } = req.body;
      if (!pbId || score === void 0)
        return res.status(400).json({ error: "pbId and score required" });
      const headerPbId = req.headers["x-pb-id"];
      if (headerPbId && headerPbId !== pbId) {
        console.warn(`[/api/app/game/sync-score] MISMATCH: body pbId=${pbId} header X-PB-ID=${headerPbId}`);
        return res.status(403).json({ error: "pbId mismatch between body and header" });
      }
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      let pts = Math.max(0, Math.round(Number(score) || 0));
      if (pts > ABSOLUTE_MAX_SCORE) {
        console.warn(`[/api/app/game/sync-score] Score ${pts} exceeds absolute max ${ABSOLUTE_MAX_SCORE}, capping`);
        pts = ABSOLUTE_MAX_SCORE;
      }
      if (elapsed_ms !== void 0 && elapsed_ms !== null) {
        const elapsedSec = Math.max(0, Number(elapsed_ms) / 1e3);
        if (elapsedSec < MIN_SESSION_MS / 1e3 && pts > 0) {
          console.warn(`[/api/app/game/sync-score] Session too short (${elapsedSec.toFixed(1)}s) for score ${pts} \u2014 rejecting`);
          return res.status(400).json({ error: "Session duration too short for reported score" });
        }
        const maxAllowed = Math.ceil(elapsedSec * MAX_SCORE_PER_SECOND);
        if (pts > maxAllowed) {
          console.warn(`[/api/app/game/sync-score] Score ${pts} impossible in ${elapsedSec.toFixed(1)}s (max=${maxAllowed}), capping`);
          pts = maxAllowed;
        }
      }
      const pts_final = pts;
      let newTomatoes;
      if (clientTomatoes !== void 0 && clientTomatoes !== null) {
        const currentTomatoes = Number(user.collected_tomatoes) || 0;
        const maxTomatoes = currentTomatoes + pts_final;
        newTomatoes = Math.min(Math.max(0, Math.round(Number(clientTomatoes))), maxTomatoes);
        console.log(`[/api/app/game/sync-score] pbId=${pbId} score=${pts_final} tomatoes=client:${newTomatoes}`);
      } else {
        const currentTomatoes = Number(user.collected_tomatoes) || 0;
        newTomatoes = currentTomatoes + pts_final;
        console.log(`[/api/app/game/sync-score] pbId=${pbId} score=${pts_final} tomatoes:${currentTomatoes}\u2192${newTomatoes}`);
      }
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        last_session_score: pts_final,
        collected_tomatoes: newTomatoes
      });
      res.json({ success: true, last_session_score: pts_final, collected_tomatoes: newTomatoes });
    } catch (e) {
      console.error("[/api/app/game/sync-score]", e.message);
      res.status(500).json({ error: "Failed to sync score" });
    }
  });
  app2.post("/api/app/ad/token", async (req, res) => {
    try {
      const { pbId, matchId } = req.body;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const boundMatchId = typeof matchId === "string" && matchId ? matchId : void 0;
      if (boundMatchId && matchSigState(boundMatchId, pbId) === "invalid") {
        console.warn(`[ad/token] BAD MATCH SIGNATURE (${pbId}): ${boundMatchId.slice(0, 24)}\u2026`);
        return res.status(403).json({ error: "Session verification failed \u2014 please play a new game." });
      }
      let baseScore = Math.max(0, Math.round(Number(user.last_session_score) || 0));
      if (boundMatchId) {
        try {
          const logRes = await pbGet2(
            `/api/collections/game_score/records?filter=${encodeURIComponent(`match_id="${boundMatchId}"`)}&perPage=1`
          );
          const row = logRes?.items?.[0];
          const committedRaw = Math.max(0, Math.round(Number(row?.raw_score) || 0));
          if (row && String(row.match_status || "") !== "completed" && committedRaw > 0) {
            baseScore = committedRaw;
          }
        } catch (rowErr) {
          console.warn("[ad/token] game_score lookup failed \u2014 using last_session_score:", rowErr.message);
        }
      }
      const reward = Math.min(baseScore * 2, ABSOLUTE_MAX_SCORE * 2);
      const token = crypto.randomUUID();
      adTokenStore.set(token, { pbId, reward, matchId: boundMatchId, expiresAt: Date.now() + 10 * 6e4 });
      console.log(`[ad/token] Issued token for ${pbId}, reward=${reward}PT match=${boundMatchId ?? "none"}`);
      res.json({ token, reward });
    } catch (e) {
      console.error("[/api/app/ad/token]", e.message);
      res.status(500).json({ error: "Failed to issue ad token" });
    }
  });
  app2.post("/api/app/ad/claim", async (req, res) => {
    let lockedMatchId = null;
    let awarded = false;
    try {
      const { token, pbId } = req.body;
      if (!token || !pbId) return res.status(400).json({ error: "token and pbId required" });
      const entry = adTokenStore.get(token);
      if (!entry) return res.status(400).json({ error: "Invalid or already-used token" });
      if (entry.pbId !== pbId) return res.status(403).json({ error: "Token/user mismatch" });
      if (Date.now() > entry.expiresAt) {
        adTokenStore.delete(token);
        return res.status(400).json({ error: "Token expired \u2014 please try again" });
      }
      adTokenStore.delete(token);
      let matchId = entry.matchId || null;
      let correlatedRecord = null;
      if (!matchId) {
        try {
          const openRes = await pbGet2(
            `/api/collections/game_score/records?filter=${encodeURIComponent(
              `user="${pbId}" && (match_status="started" || match_status="active")`
            )}&sort=-created&perPage=1`
          );
          const open = openRes?.items?.[0];
          if (open?.match_id) {
            matchId = String(open.match_id);
            correlatedRecord = open;
            console.log(`[ad/claim] no-matchId claim correlated \u2192 open match ${matchId.slice(0, 8)} (${pbId})`);
          }
        } catch (corrErr) {
          console.warn("[ad/claim] match correlation failed:", corrErr.message);
        }
      }
      let strictMatch = false;
      try {
        const s = await fetchSettings();
        strictMatch = !!s?.strict_match_enforcement;
      } catch {
      }
      if (strictMatch && !matchId) {
        console.warn(`[ad/claim] NO resolvable match (${pbId}) \u2014 rejected (strict)`);
        return res.status(403).json({ error: "Session verification failed \u2014 please play a new game." });
      }
      let gameLogId = null;
      if (matchId) {
        if (claimedMatchIds.has(matchId)) {
          console.warn(`[ad/claim] REPLAY BLOCKED (in-memory): ${matchId} (${pbId})`);
          return res.status(403).json({ error: "Duplicate submission \u2014 this session has already been claimed." });
        }
        claimedMatchIds.set(matchId, Date.now());
        lockedMatchId = matchId;
        try {
          const logRes = correlatedRecord ? { items: [correlatedRecord] } : await pbGet2(
            `/api/collections/game_score/records?filter=${encodeURIComponent(`match_id="${matchId}"`)}&perPage=1`
          );
          const logRecord = logRes?.items?.[0];
          if (!logRecord) {
            if (strictMatch) {
              claimedMatchIds.delete(matchId);
              console.warn(`[ad/claim] UNKNOWN matchId ${matchId} (${pbId}) \u2014 rejected (strict)`);
              return res.status(403).json({ error: "Invalid session \u2014 please play a new game." });
            }
            console.warn(`[ad/claim] unknown matchId ${matchId} (${pbId}) \u2014 grace mode, continuing`);
          } else {
            gameLogId = logRecord.id;
            if (logRecord.user && String(logRecord.user) !== pbId) {
              claimedMatchIds.delete(matchId);
              console.warn(`[ad/claim] OWNER MISMATCH ${matchId}: row-owner=${logRecord.user} claimant=${pbId}`);
              flagUserBlacklist(pbId, `cross-account claim on match ${String(matchId).slice(0, 8)}`).catch(() => {
              });
              return res.status(403).json({ error: "Session verification failed \u2014 please play a new game." });
            }
            const st = String(logRecord.match_status || "");
            if (st === "completed") {
              console.warn(`[ad/claim] REPLAY BLOCKED (db): ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Duplicate submission \u2014 this session has already been claimed." });
            }
            if (st === "expired") {
              console.warn(`[ad/claim] EXPIRED match ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Session expired \u2014 rewards must be claimed shortly after the game ends." });
            }
            if (st === "blacklisted") {
              console.warn(`[ad/claim] BLACKLISTED match ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Session flagged for suspicious activity \u2014 reward denied." });
            }
          }
        } catch (logErr) {
          console.warn("[ad/claim] game_score lookup failed:", logErr.message);
        }
      }
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) {
        if (matchId) claimedMatchIds.delete(matchId);
        return res.status(404).json({ error: "User not found" });
      }
      const newPT = (Number(user.power_tokens) || 0) + entry.reward;
      const newTotal = (Number(user.total_accumulated_score) || 0) + entry.reward;
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        power_tokens: newPT,
        total_accumulated_score: newTotal,
        last_session_score: 0
      });
      awarded = true;
      console.log(`[ad/claim] pbId=${pbId} claimed ${entry.reward}PT \u2192 newPT=${newPT}`);
      if (gameLogId) {
        pbPatch2(`/api/collections/game_score/records/${gameLogId}`, {
          match_status: "completed",
          is_double: true,
          final_tokens: entry.reward,
          user_id: pbId
        }).catch(() => {
        });
      }
      res.json({ success: true, newPowerTokens: newPT, reward: entry.reward });
    } catch (e) {
      if (lockedMatchId && !awarded) claimedMatchIds.delete(lockedMatchId);
      console.error("[/api/app/ad/claim]", e.message);
      res.status(500).json({ error: "Failed to claim ad reward" });
    }
  });
  app2.post("/api/app/game/reward", async (req, res) => {
    let lockedMatchId = null;
    let awarded = false;
    try {
      const { pbId, amount, type } = req.body;
      if (!pbId || !amount)
        return res.status(400).json({ error: "pbId and amount required" });
      if (!await requireCallerIdentity(req, res, pbId, "game/reward")) return;
      let matchId = typeof req.body.matchId === "string" && req.body.matchId ? req.body.matchId : null;
      if (matchId && matchSigState(matchId, pbId) === "invalid") {
        console.warn(`[/api/app/game/reward] BAD MATCH SIGNATURE (${pbId}): ${matchId.slice(0, 24)}\u2026`);
        return res.status(403).json({ error: "Session verification failed \u2014 please play a new game." });
      }
      let correlatedRecord = null;
      if (!matchId) {
        try {
          const openRes = await pbGet2(
            `/api/collections/game_score/records?filter=${encodeURIComponent(
              `user="${pbId}" && (match_status="started" || match_status="active")`
            )}&sort=-created&perPage=1`
          );
          const open = openRes?.items?.[0];
          if (open?.match_id) {
            matchId = String(open.match_id);
            correlatedRecord = open;
            console.log(`[/api/app/game/reward] no-matchId claim correlated \u2192 open match ${matchId.slice(0, 8)} (${pbId})`);
          }
        } catch (corrErr) {
          console.warn("[/api/app/game/reward] match correlation failed:", corrErr.message);
        }
      }
      let strictMatch = false;
      try {
        const s = await fetchSettings();
        strictMatch = !!s?.strict_match_enforcement;
      } catch {
      }
      if (strictMatch && !matchId) {
        console.warn(`[/api/app/game/reward] NO resolvable match (${pbId}) \u2014 rejected (strict)`);
        return res.status(403).json({ error: "Session verification failed \u2014 please play a new game." });
      }
      if (matchId) {
        if (claimedMatchIds.has(matchId)) {
          console.warn(`[/api/app/game/reward] REPLAY BLOCKED (in-memory): ${matchId} (${pbId})`);
          return res.status(403).json({ error: "Duplicate submission \u2014 this session has already been claimed." });
        }
        claimedMatchIds.set(matchId, Date.now());
        lockedMatchId = matchId;
      }
      let safeAmount = Math.min(
        Math.max(0, Math.round(Number(amount) || 0)),
        ABSOLUTE_MAX_SCORE * 2
      );
      if (safeAmount !== Number(amount)) {
        console.warn(`[/api/app/game/reward] Amount capped: ${amount} \u2192 ${safeAmount}`);
      }
      if (!checkHourlyRewardLimit(pbId)) {
        console.warn(`[/api/app/game/reward] Rate-limited: ${pbId}`);
        if (matchId) claimedMatchIds.delete(matchId);
        return res.status(429).json({ error: "Too many reward requests. Please wait before trying again." });
      }
      let gameLogId = null;
      let isDoubleClaim = false;
      if (matchId) {
        try {
          const logRes = correlatedRecord ? { items: [correlatedRecord] } : await pbGet2(
            `/api/collections/game_score/records?filter=${encodeURIComponent(`match_id="${matchId}"`)}&perPage=1`
          );
          const logRecord = logRes?.items?.[0];
          if (!logRecord) {
            if (strictMatch) {
              claimedMatchIds.delete(matchId);
              console.warn(`[/api/app/game/reward] UNKNOWN matchId ${matchId} (${pbId}) \u2014 rejected (strict)`);
              return res.status(403).json({ error: "Invalid session \u2014 please play a new game." });
            }
            console.warn(`[/api/app/game/reward] unknown matchId ${matchId} (${pbId}) \u2014 grace mode, continuing`);
          } else {
            gameLogId = logRecord.id;
            if (logRecord.user && String(logRecord.user) !== pbId) {
              claimedMatchIds.delete(matchId);
              console.warn(`[/api/app/game/reward] OWNER MISMATCH ${matchId}: row-owner=${logRecord.user} claimant=${pbId}`);
              flagUserBlacklist(pbId, `cross-account claim on match ${String(matchId).slice(0, 8)}`).catch(() => {
              });
              return res.status(403).json({ error: "Session verification failed \u2014 please play a new game." });
            }
            const st = String(logRecord.match_status || "");
            if (st === "completed") {
              console.warn(`[/api/app/game/reward] REPLAY BLOCKED (db): ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Duplicate submission \u2014 this session has already been claimed." });
            }
            if (st === "expired") {
              console.warn(`[/api/app/game/reward] EXPIRED match ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Session expired \u2014 rewards must be claimed shortly after the game ends." });
            }
            if (st === "blacklisted") {
              console.warn(`[/api/app/game/reward] BLACKLISTED match ${matchId} (${pbId})`);
              return res.status(403).json({ error: "Session flagged for suspicious activity \u2014 reward denied." });
            }
            if (strictMatch && st === "active") {
              console.warn(`[/api/app/game/reward] ACTIVE (unfinished) match ${matchId} (${pbId}) \u2014 rejected (strict)`);
              return res.status(403).json({ error: "Session not finished \u2014 please finish the game first." });
            }
            const committedPT = Math.max(0, Math.round(Number(logRecord.raw_score) || 0));
            if (committedPT > 0) {
              if (strictMatch && safeAmount > committedPT * 2) {
                pbPatch2(`/api/collections/game_score/records/${logRecord.id}`, {
                  match_status: "blacklisted"
                }).catch(() => {
                });
                console.warn(
                  `[/api/app/game/reward] BLACKLIST ${matchId}: claim ${safeAmount}PT > 2\xD7 committed ${committedPT}PT (${pbId})`
                );
                flagUserBlacklist(pbId, `claim ${safeAmount}PT > 2\xD7 committed ${committedPT}PT`).catch(() => {
                });
                return res.status(403).json({ error: "Score could not be verified \u2014 reward denied." });
              }
              isDoubleClaim = safeAmount > committedPT * 1.5;
              const paidPT = isDoubleClaim ? committedPT * 2 : committedPT;
              if (safeAmount !== paidPT) {
                console.warn(
                  `[/api/app/game/reward] client amount ${safeAmount}PT \u2192 server-computed ${paidPT}PT (committed=${committedPT}, double=${isDoubleClaim}) (${pbId})`
                );
              }
              safeAmount = paidPT;
            } else if (logRecord.created) {
              const startMs = new Date(String(logRecord.created).replace(" ", "T")).getTime();
              const durationSec = (Date.now() - startMs) / 1e3;
              const maxPossible = Math.ceil(durationSec * 5) + 10;
              if (safeAmount > maxPossible) {
                console.warn(
                  `[/api/app/game/reward] Time-score mismatch: ${safeAmount}PT in ${Math.round(durationSec)}s (max ${maxPossible}) \u2014 capping`
                );
                safeAmount = maxPossible;
              }
            }
          }
        } catch (logErr) {
          console.warn("[/api/app/game/reward] game_score lookup failed:", logErr.message);
        }
      }
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) {
        if (matchId) claimedMatchIds.delete(matchId);
        return res.status(404).json({ error: "User not found" });
      }
      const serverValidatedScore = Number(user.last_session_score) || 0;
      if (serverValidatedScore > 0 && safeAmount > serverValidatedScore * 2) {
        console.warn(
          `[/api/app/game/reward] ${pbId} amount ${safeAmount} > 2\xD7 last_session_score ${serverValidatedScore} \u2014 capping`
        );
        safeAmount = serverValidatedScore * 2;
      }
      const newPT = (Number(user.power_tokens) || 0) + safeAmount;
      const newTotal = (Number(user.total_accumulated_score) || 0) + safeAmount;
      const newWins = type === "game_win" ? (user.total_wins || 0) + 1 : user.total_wins || 0;
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        power_tokens: newPT,
        total_wins: newWins,
        total_accumulated_score: newTotal,
        last_session_score: 0
        // reset after claim
      });
      awarded = true;
      console.log(`[/api/app/game/reward] pbId=${pbId} +${safeAmount}PT \u2192 newPT=${newPT} totalScore=${newTotal}`);
      if (gameLogId) {
        pbPatch2(`/api/collections/game_score/records/${gameLogId}`, {
          match_status: "completed",
          final_tokens: safeAmount,
          is_double: isDoubleClaim,
          user_id: pbId
        }).catch(() => {
        });
      }
      res.json({ success: true, newPowerTokens: newPT });
    } catch (e) {
      if (lockedMatchId && !awarded) claimedMatchIds.delete(lockedMatchId);
      console.error("[/api/app/game/reward]", e.message);
      res.status(500).json({ error: "Failed to grant reward" });
    }
  });
  app2.post("/api/app/game/spend", async (req, res) => {
    try {
      const { pbId, amount } = req.body;
      if (!pbId || !amount)
        return res.status(400).json({ error: "pbId and amount required" });
      const spendAmt = Number(amount);
      if (!Number.isFinite(spendAmt) || spendAmt <= 0 || spendAmt > 1e6) {
        securityLog("game/spend", "rejected invalid spend amount", { pbId, amount });
        return res.status(400).json({ error: "Invalid amount" });
      }
      if (!await requireCallerIdentity(req, res, pbId, "game/spend")) return;
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      if ((user.power_tokens || 0) < spendAmt)
        return res.json({ success: false, reason: "Insufficient power tokens" });
      const newPT = user.power_tokens - spendAmt;
      await pbPatch2(`/api/collections/users/records/${pbId}`, {
        power_tokens: newPT
      });
      res.json({ success: true, newPowerTokens: newPT });
    } catch (e) {
      console.error("[/api/app/game/spend]", e.message);
      res.status(500).json({ error: "Failed to spend tokens" });
    }
  });
  app2.get("/api/app/tasks", async (req, res) => {
    try {
      const { userId } = req.query;
      const tasksRes = await pbGet2(
        `/api/collections/tasks/records?filter=${encodeURIComponent("is_active=true")}&sort=created&perPage=50`
      );
      const tasks = tasksRes.items || [];
      let submissionsMap = {};
      if (userId) {
        const subsRes = await pbGet2(
          `/api/collections/task_submissions/records?filter=${encodeURIComponent(`user_id="${userId}"`)}&perPage=200`
        );
        for (const sub of subsRes.items || []) {
          if (!submissionsMap[sub.task_id] || sub.status === "approved") {
            submissionsMap[sub.task_id] = { id: sub.id, status: sub.status, admin_notes: sub.admin_notes || "" };
          }
        }
      }
      res.json(tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description || "",
        link: t.link || "",
        reward_amount: t.reward_amount || 0,
        reward_type: t.reward_type || "PT",
        submission: submissionsMap[t.id] || null
      })));
    } catch (e) {
      console.error("[/api/app/tasks]", e.message);
      res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });
  app2.post("/api/app/tasks/submit", upload.single("proof_screenshot"), async (req, res) => {
    try {
      const { pbId, taskId } = req.body;
      if (!pbId || !taskId) return res.status(400).json({ error: "pbId and taskId required" });
      if (req.fileRejected) {
        return res.status(400).json({ error: "Only JPG or PNG images are allowed." });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Proof screenshot is required \u2014 no file received by server. Please try again." });
      }
      const buf = req.file.buffer;
      const looksJpg = buf.length > 2 && buf[0] === 255 && buf[1] === 216;
      const looksPng = buf.length > 4 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71;
      if (!looksJpg && !looksPng) {
        return res.status(400).json({ error: "Only JPG or PNG images are allowed." });
      }
      const task = await pbGet2(`/api/collections/tasks/records/${taskId}`);
      if (task.code) return res.status(404).json({ error: "Task not found" });
      if (!task.is_active) return res.status(400).json({ error: "Task is no longer active" });
      const user = await pbGet2(`/api/collections/users/records/${pbId}?fields=id,email`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const existing = await pbGet2(
        `/api/collections/task_submissions/records?filter=${encodeURIComponent(`user_id="${pbId}" && task_id="${taskId}"`)}&perPage=1`
      );
      if ((existing.items || []).length > 0) {
        return res.status(409).json({ error: "You have already participated in this task" });
      }
      const form = new FormData();
      form.append("user_id", pbId);
      form.append("task_id", taskId);
      form.append("task_title", task.title || "");
      form.append("user_email", user.email || "");
      form.append("status", "pending");
      form.append("admin_notes", "");
      form.append("reward_amount", String(task.reward_amount || 0));
      form.append("reward_type", task.reward_type || "PT");
      if (req.file) {
        const safeExt = req.file.mimetype === "image/png" ? "png" : "jpg";
        const safeName = `proof_${String(pbId).replace(/[^a-zA-Z0-9_-]/g, "")}_${Date.now()}.${safeExt}`;
        const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "image/jpeg" });
        form.append("proof_screenshot", blob, safeName);
      }
      const sub = await pbFetchMultipart("POST", "/api/collections/task_submissions/records", form);
      if (!sub.id) {
        console.error("[/api/app/tasks/submit] PB error:", JSON.stringify(sub).slice(0, 300));
        return res.status(500).json({ error: "Failed to create submission" });
      }
      res.json({ success: true, submissionId: sub.id });
    } catch (e) {
      console.error("[/api/app/tasks/submit]", e.message);
      res.status(500).json({ error: "Failed to submit task" });
    }
  });
  app2.get("/api/admin/tasks", async (_req, res) => {
    try {
      const r = await pbGet2(`/api/collections/tasks/records?sort=-created&perPage=100`);
      res.json(r.items || []);
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });
  app2.post("/api/admin/tasks", async (req, res) => {
    try {
      const { title, description, link, reward_amount, reward_type, is_active } = req.body;
      if (!title || !reward_amount || !reward_type) {
        return res.status(400).json({ error: "title, reward_amount, reward_type required" });
      }
      const task = await pbPost2("/api/collections/tasks/records", {
        title,
        description: description || "",
        link: link || "",
        reward_amount: Number(reward_amount),
        reward_type,
        is_active: is_active !== false
      });
      if (!task.id) return res.status(500).json({ error: "Failed to create task" });
      res.json(task);
    } catch (e) {
      console.error("[admin/tasks POST]", e.message);
      res.status(500).json({ error: "Failed to create task" });
    }
  });
  app2.patch("/api/admin/tasks/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pbPatch2(`/api/collections/tasks/records/${id}`, req.body);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: "Failed to update task" });
    }
  });
  app2.get("/api/admin/tasks/submissions", async (req, res) => {
    try {
      const { status } = req.query;
      const filter = status ? `status="${status}"` : `status="pending"`;
      const r = await pbGet2(
        `/api/collections/task_submissions/records?filter=${encodeURIComponent(filter)}&sort=-created&perPage=100`
      );
      res.json(r.items || []);
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch submissions" });
    }
  });
  app2.post("/api/admin/tasks/submissions/:id/approve", async (req, res) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;
      const sub = await pbGet2(`/api/collections/task_submissions/records/${id}`);
      if (sub.code) return res.status(404).json({ error: "Submission not found" });
      if (sub.status !== "pending") return res.status(400).json({ error: "Already processed" });
      const user = await pbGet2(`/api/collections/users/records/${sub.user_id}?fields=id,shib_balance,power_tokens`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const patch = {};
      if (sub.reward_type === "SHIB") {
        patch.shib_balance = (user.shib_balance || 0) + (sub.reward_amount || 0);
      } else {
        patch.power_tokens = (user.power_tokens || 0) + (sub.reward_amount || 0);
      }
      await pbPatch2(`/api/collections/users/records/${sub.user_id}`, patch);
      const approveForm = new FormData();
      approveForm.append("status", "approved");
      approveForm.append("admin_notes", notes || "");
      const patchRes = await pbFetchMultipart("PATCH", `/api/collections/task_submissions/records/${id}`, approveForm);
      if (patchRes.code) {
        console.error("[tasks/approve] PB patch failed:", JSON.stringify(patchRes).slice(0, 300));
        return res.status(500).json({ error: "Failed to update submission status" });
      }
      res.json({ success: true });
    } catch (e) {
      console.error("[tasks/approve]", e.message);
      res.status(500).json({ error: "Failed to approve submission" });
    }
  });
  app2.post("/api/admin/tasks/submissions/:id/reject", async (req, res) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;
      const sub = await pbGet2(`/api/collections/task_submissions/records/${id}`);
      if (sub.code) return res.status(404).json({ error: "Submission not found" });
      if (sub.status !== "pending") return res.status(400).json({ error: "Already processed" });
      const rejectForm = new FormData();
      rejectForm.append("status", "rejected");
      rejectForm.append("admin_notes", notes || "");
      const rejectPatchRes = await pbFetchMultipart("PATCH", `/api/collections/task_submissions/records/${id}`, rejectForm);
      if (rejectPatchRes.code) {
        console.error("[tasks/reject] PB patch failed:", JSON.stringify(rejectPatchRes).slice(0, 300));
        return res.status(500).json({ error: "Failed to update submission status" });
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to reject submission" });
    }
  });
  async function computeVipMetrics(userRecord) {
    const pbId = userRecord.id;
    const referralCode = userRecord.referral_code || "";
    const balance = Number(userRecord.shib_balance) || 0;
    let refs = 0;
    try {
      const filter = referralCode ? `referred_by="${referralCode}" || referred_by="${pbId}"` : `referred_by="${pbId}"`;
      const r = await pbGet2(`/api/collections/users/records?filter=${encodeURIComponent(filter)}&perPage=1`);
      refs = Number(r.totalItems) || 0;
    } catch {
    }
    let tasks = 0;
    try {
      const r = await pbGet2(`/api/collections/task_submissions/records?filter=${encodeURIComponent(`user_id="${pbId}" && status="approved"`)}&perPage=1`);
      tasks = Number(r.totalItems) || 0;
    } catch {
    }
    let withdrawals = 0;
    try {
      const r = await pbGet2(`/api/collections/withdrawals/records?filter=${encodeURIComponent(`user="${pbId}" && status="completed"`)}&perPage=1`);
      withdrawals = Number(r.totalItems) || 0;
    } catch {
    }
    const refIncome = Number(userRecord.referral_earnings) || 0;
    return { refs, balance, refIncome, tasks, withdrawals };
  }
  app2.get("/api/app/vip/status/:pbId", async (req, res) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const metrics = await computeVipMetrics(user);
      res.json({
        vipLevel: normalizeVipLevel(user.vip_level),
        isAdminPromoted: !!user.is_admin_promoted,
        adminPromotedLevel: normalizeVipLevel(user.admin_promoted_level),
        metrics
      });
    } catch (e) {
      console.error("[/api/app/vip/status]", e.message);
      res.status(500).json({ error: "Failed to load VIP status" });
    }
  });
  app2.post("/api/app/vip/upgrade", async (req, res) => {
    try {
      const { pbId } = req.body || {};
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      if (!await requireCallerIdentity(req, res, pbId, "vip/upgrade")) return;
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
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
          vipLevel: current
        });
      }
      const updated = await pbPatch2(`/api/collections/users/records/${pbId}`, { vip_level: target });
      if (updated.code) return res.status(500).json({ error: "Failed to upgrade VIP" });
      res.json({ success: true, vipLevel: target, metrics });
    } catch (e) {
      console.error("[/api/app/vip/upgrade]", e.message);
      res.status(500).json({ error: "Failed to upgrade VIP" });
    }
  });
  app2.post("/api/admin/users/vip", async (req, res) => {
    try {
      const { pbId, level } = req.body || {};
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const lvl = normalizeVipLevel(level);
      const user = await pbGet2(`/api/collections/users/records/${pbId}`);
      if (user.code) return res.status(404).json({ error: "User not found" });
      const updated = await pbPatch2(`/api/collections/users/records/${pbId}`, {
        vip_level: lvl,
        is_admin_promoted: true,
        admin_promoted_level: lvl
      });
      if (updated.code) return res.status(500).json({ error: "Failed to set VIP" });
      res.json(formatUser(updated));
    } catch (e) {
      console.error("[/api/admin/users/vip]", e.message);
      res.status(500).json({ error: "Failed to set VIP" });
    }
  });
  app2.get("/api/admin/users/search", async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (!q) return res.json({ items: [] });
      const filter = `email~"${q}" || referral_code~"${q}" || display_name~"${q}"`;
      const r = await pbGet2(`/api/collections/users/records?filter=${encodeURIComponent(filter)}&perPage=20&sort=-created`);
      res.json({ items: (r.items || []).map(formatUser) });
    } catch (e) {
      console.error("[/api/admin/users/search]", e.message);
      res.status(500).json({ error: "Failed to search users" });
    }
  });
  const httpServer = createServer(app2);
  app2.get("/api/app/daily/status/:pbId", async (req, res) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      const u = await pbGet2(`/api/collections/users/records/${pbId}?fields=id,daily_streak,last_daily_claim`);
      if (u.code) return res.status(404).json({ error: "User not found" });
      const s = await fetchSettings();
      const streak = Number(u.daily_streak) || 0;
      const lastClaimMs = u.last_daily_claim ? new Date(u.last_daily_claim).getTime() : 0;
      const serverNowMs = Date.now();
      const effectiveLastMs = lastClaimMs > 0 && lastClaimMs > serverNowMs ? 0 : lastClaimMs;
      const diffMs = effectiveLastMs ? serverNowMs - effectiveLastMs : Infinity;
      const H24 = 24 * 36e5;
      const H48 = 48 * 36e5;
      let canClaim = false;
      let activeDay = 1;
      let nextClaimAt = null;
      if (!effectiveLastMs || diffMs >= H48) {
        canClaim = true;
        activeDay = 1;
      } else if (streak >= 7 && diffMs >= H24) {
        canClaim = true;
        activeDay = 1;
      } else if (streak >= 7) {
        canClaim = false;
        activeDay = 7;
        nextClaimAt = new Date(effectiveLastMs + H24).toISOString();
      } else if (diffMs >= H24) {
        canClaim = true;
        activeDay = streak + 1;
      } else {
        canClaim = false;
        activeDay = streak + 1;
        nextClaimAt = new Date(effectiveLastMs + H24).toISOString();
      }
      res.json({
        streak,
        activeDay,
        canClaim,
        nextClaimAt,
        serverTime: new Date(serverNowMs).toISOString(),
        rewards: {
          day1Shib: s?.daily_reward_day1_shib ?? 1e3,
          day2Pt: s?.daily_reward_day2_pt ?? 50,
          day3Shib: s?.daily_reward_day3_shib ?? 3e3,
          day4Pt: s?.daily_reward_day4_pt ?? 100,
          day5Shib: s?.daily_reward_day5_shib ?? 5e3,
          day6Pt: s?.daily_reward_day6_pt ?? 200,
          day7Shib: s?.daily_reward_day7_shib ?? 1e4,
          day7Pt: s?.daily_reward_day7_pt ?? 500
        }
      });
    } catch (e) {
      console.error("[/api/app/daily/status]", e.message);
      res.status(500).json({ error: "Failed to fetch daily status" });
    }
  });
  app2.get("/api/app/daily/settings", async (req, res) => {
    try {
      const result = await pbGet2("/api/collections/daily_claim_settings/records?perPage=1");
      const rec = result?.items?.[0];
      if (!rec) {
        return res.json({
          id: "",
          day1ImageUrl: null,
          day1Amount: 1e3,
          day2ImageUrl: null,
          day2Amount: 50,
          day3ImageUrl: null,
          day3Amount: 3e3,
          day4ImageUrl: null,
          day4Amount: 100,
          day5ImageUrl: null,
          day5Amount: 5e3,
          day6ImageUrl: null,
          day6Amount: 200,
          day7ShibImageUrl: null,
          day7ShibAmount: 1e4,
          day7PowerImageUrl: null,
          day7PowerAmount: 500
        });
      }
      const BASE = `https://api.webcod.in/api/files/daily_claim_settings/${rec.id}`;
      const fu = (f) => f ? `${BASE}/${f}` : null;
      res.json({
        id: rec.id,
        day1ImageUrl: fu(rec.day_1_image),
        day1Amount: rec.day_1_amount ?? 1e3,
        day2ImageUrl: fu(rec.day_2_image),
        day2Amount: rec.day_2_amount ?? 50,
        day3ImageUrl: fu(rec.day_3_image),
        day3Amount: rec.day_3_amount ?? 3e3,
        day4ImageUrl: fu(rec.day_4_image),
        day4Amount: rec.day_4_amount ?? 100,
        day5ImageUrl: fu(rec.day_5_image),
        day5Amount: rec.day_5_amount ?? 5e3,
        day6ImageUrl: fu(rec.day_6_image),
        day6Amount: rec.day_6_amount ?? 200,
        day7ShibImageUrl: fu(rec.day_7_shiba_image),
        day7ShibAmount: rec.day_7_shiba_amount ?? 1e4,
        day7PowerImageUrl: fu(rec.day_7_power_image),
        day7PowerAmount: rec.day_7_power_amount ?? 500
      });
    } catch (e) {
      console.error("[/api/app/daily/settings]", e.message);
      res.status(500).json({ error: "Failed to fetch daily settings" });
    }
  });
  app2.post("/api/app/daily/claim/:pbId", async (req, res) => {
    try {
      const { pbId } = req.params;
      if (!pbId) return res.status(400).json({ error: "pbId required" });
      if (!await requireCallerIdentity(req, res, pbId, "daily/claim")) return;
      const u = await pbGet2(`/api/collections/users/records/${pbId}?fields=id,daily_streak,last_daily_claim,shib_balance,power_tokens`);
      if (u.code) return res.status(404).json({ error: "User not found" });
      const s = await fetchSettings();
      const streak = Number(u.daily_streak) || 0;
      const lastClaimMs = u.last_daily_claim ? new Date(u.last_daily_claim).getTime() : 0;
      const serverNowMs = Date.now();
      const effectiveLastMs = lastClaimMs > 0 && lastClaimMs > serverNowMs ? 0 : lastClaimMs;
      const diffMs = effectiveLastMs ? serverNowMs - effectiveLastMs : Infinity;
      const H24 = 24 * 36e5;
      const H48 = 48 * 36e5;
      let canClaim = false;
      let claimDay = 1;
      if (!effectiveLastMs || diffMs >= H48) {
        canClaim = true;
        claimDay = 1;
      } else if (streak >= 7 && diffMs >= H24) {
        canClaim = true;
        claimDay = 1;
      } else if (streak >= 7) {
        canClaim = false;
      } else if (diffMs >= H24) {
        canClaim = true;
        claimDay = streak + 1;
      }
      if (!canClaim) {
        const nextMs = effectiveLastMs + H24;
        const remainingSec = Math.ceil((nextMs - serverNowMs) / 1e3);
        return res.status(429).json({ error: "Not yet eligible", nextClaimAt: new Date(nextMs).toISOString(), remainingSec });
      }
      let dsRec = null;
      try {
        const dsResult = await pbGet2("/api/collections/daily_claim_settings/records?perPage=1");
        dsRec = dsResult?.items?.[0] ?? null;
      } catch {
      }
      const rewardMap = dsRec ? {
        1: { shib: dsRec.day_1_amount ?? 1e3, pt: 0 },
        2: { shib: 0, pt: dsRec.day_2_amount ?? 50 },
        3: { shib: dsRec.day_3_amount ?? 3e3, pt: 0 },
        4: { shib: 0, pt: dsRec.day_4_amount ?? 100 },
        5: { shib: dsRec.day_5_amount ?? 5e3, pt: 0 },
        6: { shib: 0, pt: dsRec.day_6_amount ?? 200 },
        7: { shib: dsRec.day_7_shiba_amount ?? 1e4, pt: dsRec.day_7_power_amount ?? 500 }
      } : {
        1: { shib: s?.daily_reward_day1_shib ?? 1e3, pt: 0 },
        2: { shib: 0, pt: s?.daily_reward_day2_pt ?? 50 },
        3: { shib: s?.daily_reward_day3_shib ?? 3e3, pt: 0 },
        4: { shib: 0, pt: s?.daily_reward_day4_pt ?? 100 },
        5: { shib: s?.daily_reward_day5_shib ?? 5e3, pt: 0 },
        6: { shib: 0, pt: s?.daily_reward_day6_pt ?? 200 },
        7: { shib: s?.daily_reward_day7_shib ?? 1e4, pt: s?.daily_reward_day7_pt ?? 500 }
      };
      const reward = rewardMap[claimDay] ?? { shib: 0, pt: 0 };
      const newStreak = claimDay;
      const newShibBalance = (Number(u.shib_balance) || 0) + reward.shib;
      const newPt = (Number(u.power_tokens) || 0) + reward.pt;
      const nowIso = new Date(serverNowMs).toISOString();
      const updated = await pbPatch2(`/api/collections/users/records/${pbId}`, {
        daily_streak: newStreak,
        last_daily_claim: nowIso,
        shib_balance: newShibBalance,
        power_tokens: newPt
      });
      if (updated.code) return res.status(500).json({ error: "Failed to update user record" });
      pbPost2("/api/collections/daily_claims/records", {
        user_id: pbId,
        day_number: claimDay,
        reward_shib: reward.shib,
        reward_pt: reward.pt
      }).catch(() => {
      });
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
        serverTime: nowIso
      });
    } catch (e) {
      console.error("[/api/app/daily/claim]", e.message);
      res.status(500).json({ error: "Claim failed" });
    }
  });
  app2.get("/api/app/tournament/config", async (req, res) => {
    try {
      const serverTime = Date.now();
      try {
        const cfgRes = await pbGet2(
          "/api/collections/tournament_config/records?sort=-created&perPage=1"
        );
        const raw = cfgRes?.items?.[0];
        if (!raw) return res.json({ config: null, serverTime });
        return res.json({
          config: {
            id: raw.id,
            cycle_id: raw.cycle_id || "",
            prize_pool_total: Number(raw.prize_pool_total) || 0,
            winners_count: Number(raw.winners_count) || 3,
            reward_structure: raw.reward_structure || "{}",
            banner: raw.banner || "",
            banner_url: raw.banner_url || "",
            week_start: raw.week_start || "",
            start_time: raw.start_time || raw.week_start || "",
            end_time: raw.end_time || "",
            is_active: !!raw.is_active
          },
          serverTime
        });
      } catch (innerErr) {
        return res.json({ config: null, serverTime });
      }
    } catch (e) {
      console.error("[/api/app/tournament/config]", e.message);
      res.status(500).json({ error: "Failed to load tournament config" });
    }
  });
  app2.post("/api/app/tournament/sync-points/:pbId", async (req, res) => {
    const { pbId } = req.params;
    if (!pbId) return res.status(400).json({ error: "pbId required" });
    try {
      const { syncUserTournamentPoints: syncUserTournamentPoints2 } = await Promise.resolve().then(() => (init_tournament(), tournament_exports));
      const points = await syncUserTournamentPoints2(pbId);
      return res.json({ success: true, points });
    } catch (e) {
      console.error("[/api/app/tournament/sync-points]", e.message);
      res.status(500).json({ error: "Sync failed" });
    }
  });
  app2.post("/api/app/hub/redeem", async (req, res) => {
    const { pbId, tickets, token } = req.body ?? {};
    const n = Math.floor(Number(tickets));
    if (!pbId || !Number.isFinite(n)) {
      return res.status(400).json({ error: "pbId and tickets are required" });
    }
    try {
      const authUser = await pbHttp2("GET", `/api/collections/users/records/${pbId}`, null, token || "");
      if (!authUser?.id || authUser.id !== pbId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const user = await pbGet2(`/api/collections/users/records/${pbId}?fields=id,hit_tickets`);
      if (!user?.id) return res.status(404).json({ error: "User not found" });
      const currentTickets = Number(user.hit_tickets) || 0;
      const check = validateRedeem(n, currentTickets);
      if (!check.ok) return res.status(400).json({ error: check.error });
      const shib = ticketsToShib(n);
      const updated = await pbPatch2(`/api/collections/users/records/${pbId}`, {
        "hit_tickets-": n,
        "shib_balance+": shib
      });
      if (!updated?.id) return res.status(502).json({ error: "Redemption failed" });
      if (Number(updated.hit_tickets) < 0) {
        await pbPatch2(`/api/collections/users/records/${pbId}`, {
          "hit_tickets+": n,
          "shib_balance-": shib
        }).catch(() => {
        });
        return res.status(409).json({ error: "Redemption conflict, please retry" });
      }
      return res.json({ success: true, shib });
    } catch (e) {
      console.error("[/api/app/hub/redeem]", e?.message);
      return res.status(500).json({ error: "Redemption failed" });
    }
  });
  return httpServer;
}
function formatUser(u) {
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
    kycBep20Address: u.kyc_bep20_address || ""
  };
}

// server/gamehub.ts
import https3 from "node:https";
import http3 from "node:http";

// shared/pool/physics.ts
var TABLE = {
  PLAY_W: 800,
  PLAY_H: 400,
  BALL_R: 11,
  CORNER_POCKET_R: 24,
  MID_POCKET_R: 20
};
var POCKETS = [
  { x: 0, y: 0, r: TABLE.CORNER_POCKET_R },
  // top-left
  { x: TABLE.PLAY_W / 2, y: 0, r: TABLE.MID_POCKET_R },
  // top-mid
  { x: TABLE.PLAY_W, y: 0, r: TABLE.CORNER_POCKET_R },
  // top-right
  { x: 0, y: TABLE.PLAY_H, r: TABLE.CORNER_POCKET_R },
  // bottom-left
  { x: TABLE.PLAY_W / 2, y: TABLE.PLAY_H, r: TABLE.MID_POCKET_R },
  // bottom-mid
  { x: TABLE.PLAY_W, y: TABLE.PLAY_H, r: TABLE.CORNER_POCKET_R }
  // bottom-right
];
var DT = 1 / 240;
var MAX_STEPS = 240 * 20;
var R = TABLE.BALL_R;
var R2 = R * 2;

// server/gamehub.ts
var PB_URL3 = "https://api.webcod.in";
function pbHttp3(method, path2, body, token) {
  return new Promise((resolve2, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = token;
    if (data) headers["Content-Length"] = String(Buffer.byteLength(data));
    const url = new URL(path2, PB_URL3);
    const lib = url.protocol === "https:" ? https3 : http3;
    const req = lib.request(
      { hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search, method, headers },
      (res) => {
        let b = "";
        res.on("data", (d) => b += d);
        res.on("end", () => {
          try {
            resolve2(JSON.parse(b));
          } catch {
            resolve2({ raw: b });
          }
        });
      }
    );
    req.setTimeout(3e4, () => req.destroy(new Error("PB timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
var _adminToken2 = "";
var _tokenExpiry2 = 0;
async function getAdminToken3() {
  if (_adminToken2 && Date.now() < _tokenExpiry2) return _adminToken2;
  const res = await pbHttp3("POST", "/api/admins/auth-with-password", {
    identity: process.env.PB_ADMIN_EMAIL,
    password: process.env.PB_ADMIN_PASSWORD
  });
  if (!res.token) throw new Error(`PB admin auth failed: ${JSON.stringify(res)}`);
  _adminToken2 = res.token;
  _tokenExpiry2 = Date.now() + 23 * 60 * 60 * 1e3;
  return _adminToken2;
}
async function pbGet3(path2) {
  return pbHttp3("GET", path2, null, await getAdminToken3());
}
async function pbPost3(path2, body) {
  return pbHttp3("POST", path2, body, await getAdminToken3());
}
async function pbPatch3(path2, body) {
  return pbHttp3("PATCH", path2, body, await getAdminToken3());
}
async function fetchUser(pbId) {
  try {
    const r = await pbGet3(`/api/collections/users/records/${pbId}`);
    if (!r?.id) return null;
    return { id: r.id, power_tokens: Number(r.power_tokens) || 0, hit_tickets: Number(r.hit_tickets) || 0, display_name: r.display_name || "Player" };
  } catch {
    return null;
  }
}
async function verifyToken(token, pbId) {
  try {
    const r = await pbHttp3("GET", `/api/collections/users/records/${pbId}`, null, token);
    return r?.id === pbId;
  } catch {
    return false;
  }
}
async function pbPatchChecked(path2, body) {
  const r = await pbPatch3(path2, body);
  if (!r || r.code || !r.id) throw new Error(`PB PATCH failed (${path2}): ${JSON.stringify(r).slice(0, 200)}`);
  return r;
}
async function pbDelete3(path2) {
  return pbHttp3("DELETE", path2, null, await getAdminToken3());
}
async function pbDeleteChecked(path2) {
  const r = await pbDelete3(path2);
  if (r && (r.code || typeof r.raw === "string" && r.raw !== "")) {
    throw new Error(`PB DELETE failed (${path2}): ${JSON.stringify(r).slice(0, 200)}`);
  }
}
async function debitPT(pbId, amount) {
  const u = await fetchUser(pbId);
  if (!u || u.power_tokens < amount) return false;
  await pbPatchChecked(`/api/collections/users/records/${pbId}`, { "power_tokens-": amount });
  return true;
}
async function creditPT(pbId, amount) {
  await pbPatchChecked(`/api/collections/users/records/${pbId}`, { "power_tokens+": amount });
}
async function creditTickets(pbId, amount) {
  await pbPatchChecked(`/api/collections/users/records/${pbId}`, { "hit_tickets+": amount });
}
async function safeRefund(pbId, amount, ctx) {
  try {
    await creditPT(pbId, amount);
    console.log(`[gamehub] refunded ${amount} PT \u2192 ${pbId} (${ctx})`);
  } catch (e) {
    console.error(`[gamehub] CRITICAL refund FAILED ${amount} PT \u2192 ${pbId} (${ctx}):`, e?.message);
  }
}

// shared/arcade.ts
var ARCADE_TIERS = POOL_TIERS;
var ARCADE_GAMES = {
  flappy: {
    gameId: "flappy",
    name: "Flappy Bounce",
    path: "flappy",
    // PvP is 1-life sudden death (server-authoritative; sent in MATCH_START).
    // Offline/practice mode keeps 3 lives client-side (see script.js MAX_LIVES).
    lives: 1,
    maxScore: 999999,
    // Flappy spawns a scoring pipe roughly every ~1.5s and only ever scores +1.
    scoreDelta: { maxIncrement: 1, minIntervalMs: 1200 },
    timerSeconds: null,
    readyAfkSeconds: 45
  },
  fruitcut: {
    gameId: "fruitcut",
    name: "Fruit Cut",
    path: "fruitcut",
    // Matches the game's native NUM_LIVES (3): a missed fruit costs a life,
    // slicing a bomb is an instant game over regardless of lives left.
    lives: 3,
    maxScore: 999999,
    // Fruit waves launch every ~3s (up to 10 fruits at max difficulty); each fruit
    // scores 10–40 and combos add +10×n. The game adapter reports the CUMULATIVE
    // score throttled to one message per ~600ms, so with 500ms windows every
    // message earns ≥1 window. 120/window ≈ 240 pts/s budget — comfortably above
    // the ~170 pts/s theoretical honest peak, and a 3s quiet gap banks 6 windows
    // (720) so a monster multi-slice never gets clamped.
    scoreDelta: { maxIncrement: 120, minIntervalMs: 500 },
    timerSeconds: null,
    readyAfkSeconds: 47
  },
  stack: {
    gameId: "stack",
    name: "Tower Stack",
    path: "stack",
    // No lives concept — one collapse (or the 5:00 timer) ends the run.
    lives: 1,
    // A block lands every ~1–2s scoring ~+10 (with perfect-drop combo bonuses on
    // top — live matches show ~7–10 pts/s honest pace). Uncapped by product
    // decision (Jul 2026): the scoreDelta rate clamp is the cheat bound now.
    maxScore: 999999,
    // Adapter reports the CUMULATIVE score throttled to one message per ~600ms
    // (same recipe as Fruit Cut). Real per-block gain is ~10 pts (NOT +1 — the
    // C3 template multiplies score_to_add), with combo spikes above that.
    // 60/window (~120 pts/s budget) gives honest play ~10x headroom — the old
    // 5/window budget sat BELOW the honest rate, so the server-accepted score
    // (which both the opponent display AND settlement use) crawled behind the
    // real score and produced wrong on-screen totals / unfair settles. A
    // scripted teleport is still bounded (maxScore in ~8s) and always flagged.
    scoreDelta: { maxIncrement: 60, minIntervalMs: 500 },
    // Two-stage client-enforced timing (adapter overlay). Stage 2: a 5-minute
    // active-match countdown armed on the FIRST gameplay tap; at 0:00 the
    // adapter triggers the native game-over and reports PLAYER_OUT — the normal
    // both-out settle picks the higher locked score. The server still has no
    // gameplay timer.
    timerSeconds: 300,
    // Stage 1 backstop: the adapter forfeits at 45s pre-game (menu + TAP-TO-
    // START), the RN client at 50s — this server backstop MUST sit above both
    // plus first-score latency (server clears AFK only on the first SCORE).
    readyAfkSeconds: 60
  },
  "2048": {
    gameId: "2048",
    name: "2048",
    path: "2048",
    // One board, no lives — the 5:00 match timer (client-enforced) ends the run.
    lives: 1,
    // Uncapped by product decision (Jul 2026) — scores must support arbitrary
    // integers. NOTE the tradeoff: acceptScore never flags a drip at exactly
    // the allowed rate, so with the ceiling gone the scoreDelta rate clamp
    // (1024/500ms) is the only bound on a scripted client. Both seats face the
    // same clamp and settlement is relative, so match fairness is preserved.
    maxScore: 999999,
    // Merges can jump a lot in a single swipe (1024+1024 = +2048). The adapter
    // reports the CUMULATIVE score throttled to one message per ~600ms; the
    // clamp banks quiet windows (merges always follow non-scoring setup swipes)
    // so 1024/window covers the biggest common merge in one window and a rare
    // +2048 catches up within ~2 windows of continued reporting.
    scoreDelta: { maxIncrement: 1024, minIntervalMs: 500 },
    // Single-stage: the board is immediately playable, so the 5:00 match timer
    // arms on match start (not on a Play tap). At 0:00 the adapter freezes the
    // board and locks the final score; the normal both-out settle picks higher.
    timerSeconds: 300,
    // No adapter pre-game AFK (no menu). The RN client (50s) and this backstop
    // cover a seat that never moves; both clear on the first SCORE, which the
    // adapter emits (onScore(0)) on the first genuine gameplay tap.
    readyAfkSeconds: 60
  },
  iceblock: {
    gameId: "iceblock",
    name: "Ice Block Puzzle",
    path: "iceblock",
    // One board, no lives — the 5:00 match timer (client-enforced) ends the run.
    lives: 1,
    // Line-clear puzzle. Uncapped by product decision (Jul 2026); the
    // scoreDelta rate clamp is the cheat bound.
    maxScore: 999999,
    // Score jumps per line-clear / combo. Adapter reports CUMULATIVE score
    // throttled to ~600ms; 150/window with quiet-window banking covers a big
    // multi-line combo. (De-risk 150 with a practice run logging Score deltas.)
    scoreDelta: { maxIncrement: 150, minIntervalMs: 500 },
    // Two-stage client-enforced timing (identical to Tower Stack): Stage 1 = 45s
    // pre-game AFK armed on match start (menu + Play screen); Stage 2 = 5:00
    // active match armed on the first gameplay tap. Server has no gameplay timer.
    timerSeconds: 300,
    // Stage 1 backstop: adapter forfeits at 45s pre-game, RN at 50s — this MUST
    // sit above both plus first-score latency (server clears AFK on first SCORE,
    // which the adapter emits onScore(0) on the first gameplay tap).
    readyAfkSeconds: 60
  },
  color: {
    gameId: "color",
    name: "Color Rush",
    path: "color",
    // Sudden death — one wrong-colour collision ends the endless run.
    lives: 1,
    // Endless +1-per-ball game. Uncapped by product decision (Jul 2026); the
    // scoreDelta rate clamp is the cheat bound.
    maxScore: 999999,
    // Scores +1 per same-colour ball collected, but balls arrive in clusters,
    // so 5/window (~10 pts/s budget vs ~2–3 honest) never clamps honest play
    // while still catching a scripted drip. Cumulative report throttled ~600ms.
    scoreDelta: { maxIncrement: 5, minIntervalMs: 500 },
    // ENDLESS: no gameplay match timer (like Flappy/Fruit Cut). The run ends on
    // the first wrong-colour hit → PLAYER_OUT; the higher locked score wins.
    timerSeconds: null,
    // Stage 1 pre-game AFK: adapter forfeits at 45s on the start screen, RN at
    // 50s — this backstop MUST sit above both (ordering invariant), cleared by
    // the first SCORE (adapter emits onScore(0) on the Play tap).
    readyAfkSeconds: 60
  }
};
function getGameSpec(gameId) {
  return ARCADE_GAMES[gameId] ?? null;
}
var ARCADE_GAME_LIST = Object.values(ARCADE_GAMES);
var ARCADE_GRACE_SECONDS = 30;
var ARCADE_MAX_MATCH_MS = 10 * 60 * 1e3;
var ARCADE_WAITING_IDLE_MS = 45 * 1e3;

// server/arcadehub.ts
async function ensureSuspiciousUsersCollection() {
  try {
    const existing = await pbGet3("/api/collections/suspicious_users");
    if (existing?.id) {
      console.log("[arcade] suspicious_users \u2713");
      return;
    }
    await pbPost3("/api/collections", {
      name: "suspicious_users",
      type: "base",
      schema: [
        { name: "pb_user", type: "text", required: false },
        { name: "display_name", type: "text", required: false },
        { name: "reason", type: "text", required: false },
        { name: "evidence", type: "json", required: false }
      ],
      // Admin-only: the app never reads or writes this from the client.
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null
    });
    console.log("[arcade] created suspicious_users \u2713");
  } catch (e) {
    console.warn("[arcade] ensureSuspiciousUsersCollection failed:", e?.message);
  }
}
function flagSuspicious(pbId, name, reason, evidence) {
  pbPost3("/api/collections/suspicious_users/records", {
    pb_user: pbId,
    display_name: name,
    reason,
    evidence
  }).catch(() => {
  });
}
async function ensureArcadeEscrowCollection() {
  try {
    const existing = await pbGet3("/api/collections/arcade_escrow");
    if (existing?.id) {
      console.log("[arcade] arcade_escrow \u2713");
      return;
    }
    await pbPost3("/api/collections", {
      name: "arcade_escrow",
      type: "base",
      schema: [
        { name: "match_id", type: "text", required: true },
        { name: "a_id", type: "text", required: true },
        { name: "b_id", type: "text", required: true },
        { name: "stake", type: "number", required: true },
        { name: "resolved", type: "bool", required: false }
      ],
      // Admin-only: written and reconciled solely by the authoritative server.
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null
    });
    console.log("[arcade] created arcade_escrow \u2713");
  } catch (e) {
    console.warn("[arcade] ensureArcadeEscrowCollection failed:", e?.message);
  }
}
async function journalEscrow(m) {
  try {
    const rec = await pbPost3("/api/collections/arcade_escrow/records", {
      match_id: m.id,
      a_id: m.players.A.pbId,
      b_id: m.players.B.pbId,
      stake: m.tier,
      resolved: false
    });
    if (!rec?.id) {
      console.warn(`[arcade] journalEscrow: PB rejected escrow for match ${m.id} \u2014 NO crash safety net:`, JSON.stringify(rec).slice(0, 150));
      return;
    }
    m.escrowId = rec.id;
  } catch (e) {
    console.warn("[arcade] journalEscrow failed:", e?.message);
  }
}
function resolveEscrow(m) {
  (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        let rid = m.escrowId;
        if (!rid) {
          const found = await pbGet3(`/api/collections/arcade_escrow/records?perPage=1&filter=${encodeURIComponent(`match_id="${m.id}"`)}`);
          rid = found?.items?.[0]?.id;
        }
        if (!rid) return;
        await pbPatchChecked(`/api/collections/arcade_escrow/records/${rid}`, { resolved: true });
        return;
      } catch (e) {
        if (attempt === 3) console.error(`[arcade] resolveEscrow failed for match ${m.id} \u2014 a later boot may re-refund a settled match:`, e?.message);
        else await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  })();
}
async function reconcileOrphanedEscrow() {
  try {
    const cutoff = new Date(Date.now() - (ARCADE_MAX_MATCH_MS + 6e4)).toISOString().slice(0, 19).replace("T", " ");
    const filter = encodeURIComponent(`resolved=false && created<"${cutoff}"`);
    const res = await pbGet3(`/api/collections/arcade_escrow/records?perPage=200&filter=${filter}`);
    const items = res?.items ?? [];
    if (!items.length) return;
    console.log(`[arcade] reconciling ${items.length} orphaned escrow(s) from a previous run`);
    for (const it of items) {
      try {
        await pbDeleteChecked(`/api/collections/arcade_escrow/records/${it.id}`);
      } catch {
        continue;
      }
      const stake = Number(it.stake) || 0;
      if (stake > 0) {
        await safeRefund(it.a_id, stake, `arcade_orphan_${it.match_id}`);
        await safeRefund(it.b_id, stake, `arcade_orphan_${it.match_id}`);
      }
    }
  } catch (e) {
    console.warn("[arcade] reconcileOrphanedEscrow failed:", e?.message);
  }
}
var queues = /* @__PURE__ */ new Map();
var matches = /* @__PURE__ */ new Map();
var ctxOf = /* @__PURE__ */ new WeakMap();
var other = (s) => s === "A" ? "B" : "A";
var qKey = (gameId, tier) => `${gameId}:${tier}`;
function getArcadeLiveCounts() {
  const games = {};
  const rooms = {};
  const add = (gameId, tier, n) => {
    if (n <= 0) return;
    games[gameId] = (games[gameId] ?? 0) + n;
    const k = qKey(gameId, tier);
    rooms[k] = (rooms[k] ?? 0) + n;
  };
  for (const entries of queues.values()) {
    for (const e of entries) {
      if (e.ws && e.ws.readyState === 1) add(e.gameId, e.tier, 1);
    }
  }
  for (const m of matches.values()) {
    if (m.settled) continue;
    let n = 0;
    for (const seat of ["A", "B"]) {
      const p = m.players[seat];
      if (p && (p.connected || p.alive)) n++;
    }
    add(m.gameId, m.tier, n);
  }
  return { games, rooms };
}
function send(ws, msg) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  } catch {
  }
}
function acceptScore(m, p, raw) {
  const now = Date.now();
  const spec = m.spec.scoreDelta;
  const s = Math.floor(Number(raw));
  if (!Number.isFinite(s) || s <= p.score) return p.score;
  const delta = s - p.score;
  const elapsed = p.lastScoreAt ? now - p.lastScoreAt : spec.minIntervalMs;
  const windows = Math.floor(elapsed / spec.minIntervalMs);
  const allowedDelta = Math.max(0, windows) * spec.maxIncrement;
  const nextLastScoreAt = p.lastScoreAt ? p.lastScoreAt + windows * spec.minIntervalMs : now;
  const violations = [];
  if (delta > allowedDelta) {
    violations.push(`delta ${delta}>allowed ${allowedDelta} (elapsed ${elapsed}ms, ${windows} window(s))`);
  }
  if (s > m.spec.maxScore) {
    violations.push(`score ${s}>${m.spec.maxScore}`);
  }
  if (violations.length) {
    p.violations += 1;
    flagSuspicious(p.pbId, p.name, "arcade_score_anomaly", {
      gameId: m.gameId,
      matchId: m.id,
      reported: raw,
      prevScore: p.score,
      delta,
      allowedDelta,
      intervalMs: p.lastScoreAt ? now - p.lastScoreAt : null,
      detail: violations.join("; ")
    });
  }
  let accepted = p.score + Math.min(delta, allowedDelta);
  if (accepted > m.spec.maxScore) accepted = m.spec.maxScore;
  if (accepted <= p.score) return p.score;
  p.score = accepted;
  p.lastScoreAt = nextLastScoreAt;
  return accepted;
}
var readyAfkMs = (spec) => (Number(spec.readyAfkSeconds) > 0 ? Number(spec.readyAfkSeconds) : 45) * 1e3;
function lockSeat(m, seat) {
  if (m.settled) return;
  const p = m.players[seat];
  if (p.locked) return;
  const at = m.afkTimer[seat];
  if (at) {
    clearTimeout(at);
    delete m.afkTimer[seat];
  }
  const it = m.idleTimer[seat];
  if (it) {
    clearTimeout(it);
    delete m.idleTimer[seat];
  }
  p.alive = false;
  p.locked = true;
  const opp = m.players[other(seat)];
  if (!opp.locked) send(opp.ws, { type: "OPPONENT_OUT", matchId: m.id, score: p.score });
  checkSettlement(m);
  if (!m.settled) armIdleLock(m, other(seat));
}
function armIdleLock(m, seat) {
  if (m.settled) return;
  if (m.players[seat].locked) return;
  const prev = m.idleTimer[seat];
  if (prev) clearTimeout(prev);
  m.idleTimer[seat] = setTimeout(() => {
    delete m.idleTimer[seat];
    lockSeat(m, seat);
  }, ARCADE_WAITING_IDLE_MS);
}
function clearMatchTimers(m) {
  for (const s of ["A", "B"]) {
    const t = m.graceTimer[s];
    if (t) {
      clearTimeout(t);
      delete m.graceTimer[s];
    }
    const a = m.afkTimer[s];
    if (a) {
      clearTimeout(a);
      delete m.afkTimer[s];
    }
    const i = m.idleTimer[s];
    if (i) {
      clearTimeout(i);
      delete m.idleTimer[s];
    }
  }
  if (m.lifetimeTimer) {
    clearTimeout(m.lifetimeTimer);
    m.lifetimeTimer = null;
  }
}
function sendResult(m, seat, outcome, reason, winnerTickets, refundPT) {
  const me = m.players[seat];
  const opp = m.players[other(seat)];
  send(me.ws, {
    type: "MATCH_RESULT",
    matchId: m.id,
    outcome,
    reason,
    yourScore: me.score,
    opponentScore: opp.score,
    winnerTickets,
    refundPT
  });
}
async function settleMatch(m, winner, reason) {
  if (m.settled) return;
  m.settled = true;
  clearMatchTimers(m);
  resolveEscrow(m);
  const tier = m.tier;
  if (winner === null) {
    await safeRefund(m.players.A.pbId, tier, `arcade_draw_${m.id}`);
    await safeRefund(m.players.B.pbId, tier, `arcade_draw_${m.id}`);
    sendResult(m, "A", "draw", reason, 0, tier);
    sendResult(m, "B", "draw", reason, 0, tier);
    console.log(`[arcade] match ${m.id.slice(0, 8)} DRAW (${reason}) \u2014 refunded ${tier} PT \xD7 2`);
  } else {
    const settlement = computePoolSettlement(tier);
    const winnerId = m.players[winner].pbId;
    let credited = false;
    for (let attempt = 1; attempt <= 3 && !credited; attempt++) {
      try {
        await creditTickets(winnerId, settlement.winnerTickets);
        credited = true;
        console.log(`[arcade] match ${m.id.slice(0, 8)} settled: winner=${winner} reason=${reason} +${settlement.winnerTickets} tickets \u2192 ${winnerId}`);
      } catch (e) {
        console.error(`[arcade] settlement credit attempt ${attempt}/3 failed (${winnerId}):`, e?.message);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    if (!credited) {
      console.error(`[arcade] CRITICAL: winner ${winnerId} NOT credited ${settlement.winnerTickets} tickets \u2014 match ${m.id} tier ${tier} \u2014 manual reconciliation required`);
    }
    sendResult(m, winner, "win", reason, settlement.winnerTickets, 0);
    sendResult(m, other(winner), "lose", reason, 0, 0);
  }
  setTimeout(() => matches.delete(m.id), 15e3);
}
function checkSettlement(m) {
  if (m.settled) return;
  const A = m.players.A, B = m.players.B;
  if (A.locked && B.locked) {
    if (A.score > B.score) settleMatch(m, "A", "both_out");
    else if (B.score > A.score) settleMatch(m, "B", "both_out");
    else settleMatch(m, null, "draw");
    return;
  }
  if (A.locked && !B.locked && B.score > A.score) {
    send(B.ws, { type: "FREEZE_INPUT", matchId: m.id, reason: "early_win" });
    settleMatch(m, "B", "early_win");
    return;
  }
  if (B.locked && !A.locked && A.score > B.score) {
    send(A.ws, { type: "FREEZE_INPUT", matchId: m.id, reason: "early_win" });
    settleMatch(m, "A", "early_win");
  }
}
function onLifetimeCap(m) {
  if (m.settled) return;
  const A = m.players.A, B = m.players.B;
  if (A.score > B.score) settleMatch(m, "A", "timeout");
  else if (B.score > A.score) settleMatch(m, "B", "timeout");
  else settleMatch(m, null, "timeout");
}
async function handleJoinQueue(ws, msg) {
  const spec = getGameSpec(msg.gameId);
  if (!spec) {
    send(ws, { type: "ERROR", code: "bad_game", message: "Unsupported game" });
    return;
  }
  if (!ARCADE_TIERS.includes(msg.tier)) {
    send(ws, { type: "ERROR", code: "bad_tier", message: "Invalid tier" });
    return;
  }
  const ok = await verifyToken(msg.token, msg.pbId);
  if (!ok) {
    send(ws, { type: "ERROR", code: "auth", message: "Authentication failed" });
    return;
  }
  const u = await fetchUser(msg.pbId);
  if (!u) {
    send(ws, { type: "ERROR", code: "no_user", message: "User not found" });
    return;
  }
  if (u.power_tokens < msg.tier) {
    send(ws, { type: "ERROR", code: "insufficient_pt", message: "Not enough Power Tokens for this tier" });
    return;
  }
  for (const m of matches.values()) {
    if (!m.settled && (m.players.A.pbId === msg.pbId || m.players.B.pbId === msg.pbId)) {
      send(ws, { type: "ERROR", code: "already_in_match", message: "You are already in a match" });
      return;
    }
  }
  const key = qKey(msg.gameId, msg.tier);
  const q = queues.get(key) ?? [];
  const cleaned = q.filter((e) => e.pbId !== msg.pbId && e.ws.readyState === 1);
  const opponentIdx = cleaned.findIndex((e) => e.pbId !== msg.pbId);
  if (opponentIdx >= 0) {
    const opp = cleaned.splice(opponentIdx, 1)[0];
    queues.set(key, cleaned);
    ctxOf.set(ws, { pbId: msg.pbId });
    await createMatch(spec, msg.tier, { ws: opp.ws, pbId: opp.pbId, name: opp.name }, { ws, pbId: msg.pbId, name: u.display_name });
    return;
  }
  cleaned.push({ ws, pbId: msg.pbId, name: u.display_name, gameId: msg.gameId, tier: msg.tier });
  queues.set(key, cleaned);
  ctxOf.set(ws, { pbId: msg.pbId });
  send(ws, { type: "QUEUED", gameId: msg.gameId, tier: msg.tier });
}
function leaveQueue(ws) {
  for (const [key, q] of queues) {
    const next = q.filter((e) => e.ws !== ws);
    if (next.length !== q.length) queues.set(key, next);
  }
}
function newPlayer(seat, pbId, name, ws) {
  return { seat, pbId, name, ws, connected: true, alive: true, locked: false, score: 0, lastScoreAt: 0, violations: 0 };
}
async function createMatch(spec, tier, a, b) {
  const key = qKey(spec.gameId, tier);
  const requeue = (side) => {
    const q = queues.get(key) ?? [];
    q.unshift({ ws: side.ws, pbId: side.pbId, name: side.name, gameId: spec.gameId, tier });
    queues.set(key, q);
    send(side.ws, { type: "QUEUED", gameId: spec.gameId, tier });
  };
  let debitedA = false;
  try {
    debitedA = await debitPT(a.pbId, tier);
  } catch (e) {
    console.error("[arcade] debit A failed:", e?.message);
    send(a.ws, { type: "ERROR", code: "debit_failed", message: "Could not start match, please retry" });
    requeue(b);
    return;
  }
  if (!debitedA) {
    send(a.ws, { type: "ERROR", code: "insufficient_pt", message: "Not enough Power Tokens" });
    requeue(b);
    return;
  }
  let debitedB = false;
  try {
    debitedB = await debitPT(b.pbId, tier);
  } catch (e) {
    console.error("[arcade] debit B failed \u2014 refunding A:", e?.message);
    await safeRefund(a.pbId, tier, "arcade_debitB_threw");
    send(a.ws, { type: "REFUND", matchId: "", reason: "opponent_unavailable", amountPT: tier });
    send(b.ws, { type: "ERROR", code: "debit_failed", message: "Could not start match, please retry" });
    return;
  }
  if (!debitedB) {
    await safeRefund(a.pbId, tier, "arcade_debitB_insufficient");
    send(a.ws, { type: "REFUND", matchId: "", reason: "opponent_unavailable", amountPT: tier });
    send(b.ws, { type: "ERROR", code: "insufficient_pt", message: "Not enough Power Tokens" });
    return;
  }
  const id = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const m = {
    id,
    gameId: spec.gameId,
    tier,
    spec,
    players: { A: newPlayer("A", a.pbId, a.name, a.ws), B: newPlayer("B", b.pbId, b.name, b.ws) },
    settled: false,
    startedAt: Date.now(),
    graceTimer: {},
    afkTimer: {},
    idleTimer: {},
    lifetimeTimer: null
  };
  matches.set(id, m);
  ctxOf.set(a.ws, { pbId: a.pbId, matchId: id });
  ctxOf.set(b.ws, { pbId: b.pbId, matchId: id });
  journalEscrow(m);
  const startAt = Date.now() + 1500;
  send(a.ws, { type: "MATCH_START", matchId: id, gameId: spec.gameId, tier, youAre: "A", opponent: { name: b.name }, lives: spec.lives, startAt });
  send(b.ws, { type: "MATCH_START", matchId: id, gameId: spec.gameId, tier, youAre: "B", opponent: { name: a.name }, lives: spec.lives, startAt });
  m.lifetimeTimer = setTimeout(() => onLifetimeCap(m), ARCADE_MAX_MATCH_MS);
  ["A", "B"].forEach((s) => {
    m.afkTimer[s] = setTimeout(() => lockSeat(m, s), readyAfkMs(spec));
  });
}
function seatOf(m, ws) {
  if (m.players.A.ws === ws) return "A";
  if (m.players.B.ws === ws) return "B";
  return null;
}
function handleScore(ws, msg) {
  const m = matches.get(msg.matchId);
  if (!m || m.settled) return;
  const seat = seatOf(m, ws);
  if (!seat) return;
  const p = m.players[seat];
  if (!p.alive || p.locked) return;
  const at = m.afkTimer[seat];
  if (at) {
    clearTimeout(at);
    delete m.afkTimer[seat];
  }
  const before = p.score;
  const accepted = acceptScore(m, p, msg.score);
  if (accepted > before && m.idleTimer[seat]) armIdleLock(m, seat);
  send(m.players[other(seat)].ws, { type: "OPPONENT_SCORE", matchId: m.id, score: accepted });
  checkSettlement(m);
}
function handlePlayerOut(ws, msg) {
  const m = matches.get(msg.matchId);
  if (!m || m.settled) return;
  const seat = seatOf(m, ws);
  if (!seat) return;
  const p = m.players[seat];
  if (p.locked) return;
  acceptScore(m, p, msg.score);
  lockSeat(m, seat);
}
async function handleResume(ws, msg) {
  const ok = await verifyToken(msg.token, msg.pbId);
  if (!ok) {
    send(ws, { type: "ERROR", code: "auth", message: "Authentication failed" });
    return;
  }
  const m = matches.get(msg.matchId);
  if (!m || m.settled) {
    send(ws, { type: "ERROR", code: "no_match", message: "Match no longer available" });
    return;
  }
  const seat = ["A", "B"].find((s) => m.players[s].pbId === msg.pbId);
  if (!seat) {
    send(ws, { type: "ERROR", code: "not_in_match", message: "Not a player in this match" });
    return;
  }
  const p = m.players[seat];
  p.ws = ws;
  p.connected = true;
  const g = m.graceTimer[seat];
  if (g) {
    clearTimeout(g);
    delete m.graceTimer[seat];
  }
  ctxOf.set(ws, { pbId: msg.pbId, matchId: m.id });
  const opp = m.players[other(seat)];
  send(ws, { type: "MATCH_START", matchId: m.id, gameId: m.gameId, tier: m.tier, youAre: seat, opponent: { name: opp.name }, lives: m.spec.lives, startAt: Date.now() });
  if (opp.locked) {
    send(ws, { type: "OPPONENT_OUT", matchId: m.id, score: opp.score });
    armIdleLock(m, seat);
  } else {
    send(ws, { type: "OPPONENT_SCORE", matchId: m.id, score: opp.score });
  }
  send(opp.ws, { type: "OPPONENT_BACK", matchId: m.id });
}
function handleDisconnect(ws) {
  leaveQueue(ws);
  const ctx = ctxOf.get(ws);
  if (!ctx?.matchId) return;
  const m = matches.get(ctx.matchId);
  if (!m || m.settled) return;
  const seat = ["A", "B"].find((s) => m.players[s].ws === ws);
  if (!seat) return;
  const p = m.players[seat];
  p.connected = false;
  p.ws = null;
  if (p.locked) return;
  const oppNow = m.players[other(seat)];
  if (oppNow.locked) {
    lockSeat(m, seat);
    return;
  }
  send(oppNow.ws, { type: "OPPONENT_LEFT", matchId: m.id, graceMs: ARCADE_GRACE_SECONDS * 1e3 });
  const t = setTimeout(() => {
    if (m.settled) return;
    const pp = m.players[seat];
    if (pp.connected || pp.locked) return;
    lockSeat(m, seat);
  }, ARCADE_GRACE_SECONDS * 1e3);
  m.graceTimer[seat] = t;
}
function setupArcadeHubWebSocket(wss) {
  ensureArcadeEscrowCollection().then(reconcileOrphanedEscrow).catch(() => {
  });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      switch (msg?.type) {
        case "JOIN_QUEUE":
          handleJoinQueue(ws, msg).catch((e) => console.error("[arcade] join error:", e?.message));
          break;
        case "LEAVE_QUEUE":
          leaveQueue(ws);
          break;
        case "RESUME":
          handleResume(ws, msg).catch((e) => console.error("[arcade] resume error:", e?.message));
          break;
        case "SCORE":
          handleScore(ws, msg);
          break;
        case "PLAYER_OUT":
          handlePlayerOut(ws, msg);
          break;
        case "PING":
          send(ws, { type: "PONG" });
          break;
        default:
          break;
      }
    });
    ws.on("close", () => handleDisconnect(ws));
    ws.on("error", () => handleDisconnect(ws));
  });
  console.log("[arcade] hub WebSocket ready (/api/ws/hub-arcade)");
}

// server/index.ts
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer } from "ws";

// server/rateLimiter.ts
var WINDOW_MS = 6e4;
var MAX_PER_USER = 240;
var MAX_PER_IP = 300;
var CLEANUP_MS = 5 * 6e4;
var buckets = /* @__PURE__ */ new Map();
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}
var PB_ID_SEGMENT = /^[a-zA-Z0-9]{15}$/;
function limiterKey(req) {
  let pbId = req.body && typeof req.body === "object" && req.body.pbId || req.query && req.query.pbId;
  if (!(typeof pbId === "string" && /^[a-zA-Z0-9_-]{5,32}$/.test(pbId))) {
    pbId = void 0;
    for (const seg of req.path.split("/")) {
      if (PB_ID_SEGMENT.test(seg)) {
        pbId = seg;
        break;
      }
    }
  }
  if (typeof pbId === "string" && pbId.length > 0) {
    return { key: `u:${pbId}`, max: MAX_PER_USER };
  }
  return { key: `ip:${clientIp(req)}`, max: MAX_PER_IP };
}
var sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.windowStart > WINDOW_MS * 2) buckets.delete(k);
  }
}, CLEANUP_MS);
if (typeof sweeper?.unref === "function") sweeper.unref();
function apiRateLimiter() {
  return (req, res, next) => {
    const { key, max } = limiterKey(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.windowStart >= WINDOW_MS) {
      b = { count: 0, windowStart: now };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - now) / 1e3));
      res.setHeader("Retry-After", String(retryAfterSec));
      if (b.count === max + 1) {
        console.warn(`[rateLimiter] 429 for ${key} (${b.count} req in window)`);
      }
      return res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
    }
    next();
  };
}

// server/inputGuard.ts
var ID_FIELDS = [
  "pbId",
  "taskId",
  "userId",
  "sessionId",
  "matchId",
  "firebaseUid",
  "referredBy",
  "referralCode",
  "code"
];
var ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
var PATH_META = /["'\\()<>|&=\s]/;
function badIdField(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const f of ID_FIELDS) {
    const v = obj[f];
    if (v === void 0 || v === null || v === "") continue;
    if (typeof v !== "string" || !ID_PATTERN.test(v)) return f;
  }
  return null;
}
function inputGuard() {
  return (req, res, next) => {
    const bad = badIdField(req.body) || badIdField(req.query);
    if (bad) {
      return res.status(400).json({ error: `Invalid ${bad} format.` });
    }
    for (const seg of req.path.split("/")) {
      if (!seg) continue;
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        return res.status(400).json({ error: "Malformed request path." });
      }
      if (PATH_META.test(decoded)) {
        return res.status(400).json({ error: "Invalid characters in request path." });
      }
    }
    next();
  };
}

// server/index.ts
import { createProxyMiddleware } from "http-proxy-middleware";
var app = express();
var log = console.log;
app.set("trust proxy", 1);
function setupCors(app2) {
  app2.use((req, res, next) => {
    const isAppApi = req.path.startsWith("/api/app/");
    if (isAppApi) {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") return res.sendStatus(200);
      return next();
    }
    const origins = /* @__PURE__ */ new Set();
    if (process.env.REPLIT_DEV_DOMAIN) {
      origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    }
    if (process.env.REPLIT_DOMAINS) {
      process.env.REPLIT_DOMAINS.split(",").forEach((d) => {
        origins.add(`https://${d.trim()}`);
      });
    }
    const origin = req.header("origin");
    const isLocalhost = origin?.startsWith("http://localhost:") || origin?.startsWith("http://127.0.0.1:");
    if (origin && (origins.has(origin) || isLocalhost)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      res.header("Access-Control-Allow-Headers", "Content-Type");
      res.header("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });
}
function setupBodyParsing(app2) {
  app2.use(
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  app2.use(express.urlencoded({ extended: false, limit: "10mb" }));
}
function setupRequestLogging(app2) {
  app2.use((req, res, next) => {
    const start = Date.now();
    const path2 = req.path;
    let capturedJsonResponse = void 0;
    const originalResJson = res.json;
    res.json = function(bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };
    res.on("finish", () => {
      if (!path2.startsWith("/api")) return;
      const duration = Date.now() - start;
      let logLine = `${req.method} ${path2} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "\u2026";
      }
      log(logLine);
    });
    next();
  });
}
function getAppName() {
  try {
    const appJsonPath = path.resolve(process.cwd(), "app.json");
    const appJsonContent = fs.readFileSync(appJsonPath, "utf-8");
    const appJson = JSON.parse(appJsonContent);
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}
function serveExpoManifest(platform, res) {
  const manifestPath = path.resolve(
    process.cwd(),
    "static-build",
    platform,
    "manifest.json"
  );
  if (!fs.existsSync(manifestPath)) {
    return res.status(404).json({ error: `Manifest not found for platform: ${platform}` });
  }
  res.setHeader("expo-protocol-version", "1");
  res.setHeader("expo-sfv-version", "0");
  res.setHeader("content-type", "application/json");
  const manifest = fs.readFileSync(manifestPath, "utf-8");
  res.send(manifest);
}
function serveLandingPage({
  req,
  res,
  landingPageTemplate,
  appName
}) {
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const forwardedHost = req.header("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;
  log(`baseUrl`, baseUrl);
  log(`expsUrl`, expsUrl);
  const html = landingPageTemplate.replace(/BASE_URL_PLACEHOLDER/g, baseUrl).replace(/EXPS_URL_PLACEHOLDER/g, expsUrl).replace(/APP_NAME_PLACEHOLDER/g, appName);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
function configureExpoAndLanding(app2) {
  if (process.env.NODE_ENV !== "production") {
    log("Dev mode: Metro proxy handles web requests \u2014 skipping landing page");
    return;
  }
  const templatePath = path.resolve(
    process.cwd(),
    "server",
    "templates",
    "landing-page.html"
  );
  const landingPageTemplate = fs.readFileSync(templatePath, "utf-8");
  const appName = getAppName();
  log("Serving static Expo files with dynamic manifest routing");
  app2.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next();
    }
    if (req.path !== "/" && req.path !== "/manifest") {
      return next();
    }
    const platform = req.header("expo-platform");
    if (platform && (platform === "ios" || platform === "android")) {
      return serveExpoManifest(platform, res);
    }
    if (req.path === "/") {
      return serveLandingPage({
        req,
        res,
        landingPageTemplate,
        appName
      });
    }
    next();
  });
  app2.use("/assets", express.static(path.resolve(process.cwd(), "assets")));
  app2.use("/game", express.static(path.resolve(process.cwd(), "public/game/Knife hit Template")));
  app2.use("/arcade", express.static(path.resolve(process.cwd(), "public/arcade")));
  app2.use(express.static(path.resolve(process.cwd(), "static-build")));
  log("Expo routing: Checking expo-platform header on / and /manifest");
}
function setupErrorHandler(app2) {
  app2.use((err, _req, res, next) => {
    const error = err;
    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) {
      return next(err);
    }
    return res.status(status).json({ message });
  });
}
(async () => {
  app.use("/game", express.static(path.resolve(process.cwd(), "public/game/Knife hit Template")));
  app.use("/arcade", express.static(path.resolve(process.cwd(), "public/arcade")));
  if (process.env.NODE_ENV !== "production") {
    const metroProxy = createProxyMiddleware({
      target: "http://localhost:8081",
      changeOrigin: true,
      ws: true,
      pathFilter: (pathname) => !pathname.startsWith("/api") && // Match /game and /game/* only — NOT /game-history (an app route).
      pathname !== "/game" && !pathname.startsWith("/game/") && !pathname.startsWith("/arcade"),
      on: {
        error: (_err, _req, res) => {
          if (res && "status" in res) {
            res.status(502).send("Metro bundler not ready \u2014 wait a moment and refresh.");
          }
        }
      }
    });
    app.use(metroProxy);
    log("Dev proxy: Metro on :8081 registered (excludes /api, /game, /arcade)");
  }
  setupCors(app);
  setupBodyParsing(app);
  setupRequestLogging(app);
  configureExpoAndLanding(app);
  app.use("/api", apiRateLimiter());
  app.use("/api", inputGuard());
  initNetworkGuard();
  app.use("/api/app", networkGuardMiddleware());
  const server = await registerRoutes(app);
  setupErrorHandler(app);
  const gameWss = new WebSocketServer({ noServer: true });
  setupGameWebSocket(gameWss);
  const arcadeWss = new WebSocketServer({ noServer: true });
  setupArcadeHubWebSocket(arcadeWss);
  ensureSuspiciousUsersCollection().catch(
    (e) => console.warn("[arcade] suspicious_users setup failed:", e?.message)
  );
  app.get("/api/app/arcade/live-counts", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(getArcadeLiveCounts());
  });
  server.on("upgrade", async (request, socket, head) => {
    const url = request.url || "";
    if (url.startsWith("/api/ws/")) {
      const allowed = await guardWebSocketUpgrade(request, socket);
      if (!allowed) return;
    }
    if (url.startsWith("/api/ws/hub-arcade")) {
      arcadeWss.handleUpgrade(request, socket, head, (ws) => {
        arcadeWss.emit("connection", ws, request);
      });
    } else if (url.startsWith("/api/ws/game")) {
      gameWss.handleUpgrade(request, socket, head, (ws) => {
        gameWss.emit("connection", ws, request);
      });
    }
  });
  const port = parseInt(process.env.SERVER_PORT || process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true
    },
    () => {
      log(`express server serving on port ${port}`);
    }
  );
})();
