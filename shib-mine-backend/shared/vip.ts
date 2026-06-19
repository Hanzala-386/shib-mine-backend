// ─────────────────────────────────────────────────────────────────────────────
// Shared VIP tier configuration.
//
// Imported by the client (lib/api.ts, context/*, app/vip.tsx, …), the local
// Express server (server/routes.ts), and MIRRORED verbatim into the Railway
// backend (shib-mine-backend/shared/vip.ts). Keep all three identical.
//
// PURE constants + helpers only — NO runtime dependencies — so the same module
// works under Node (tsx) and React Native.
//
// VIP adds a SHIB-per-hour increment ON TOP of the admin-configured base mining
// rate. Final speed = (base_rate_per_sec + vipIncrementPerSec(level)) × booster.
// The admin-controlled base rate is never replaced, so changing it scales every
// user (all VIP levels) up or down together.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_VIP_LEVEL = 8;

// SHIB-per-hour bonus added on top of the base mining rate, indexed by VIP level.
export const VIP_INCREMENTS_SHIB_PER_HR: Record<number, number> = {
  0: 0,
  1: 30,
  2: 60,
  3: 100,
  4: 140,
  5: 200,
  6: 260,
  7: 330,
  8: 427,
};

export interface VipRequirement {
  refs: number;        // count of users referred by this user
  balance: number;     // shib_balance
  refIncome: number;   // accumulated referral commission (users.referral_earnings)
  tasks: number;       // approved task_submissions
  withdrawals: number; // completed withdrawals
}

// Requirements to upgrade TO the given level. Level 0 is the default (no req).
// Balance requirements are monotonically increasing — relied upon by
// highestBalanceEligibleTier() below.
export const VIP_REQUIREMENTS: Record<number, VipRequirement> = {
  1: { refs: 2,  balance: 2000,    refIncome: 2000,   tasks: 0,  withdrawals: 0  },
  2: { refs: 5,  balance: 50000,   refIncome: 5000,   tasks: 5,  withdrawals: 0  },
  3: { refs: 10, balance: 100000,  refIncome: 10000,  tasks: 10, withdrawals: 2  },
  4: { refs: 15, balance: 200000,  refIncome: 15000,  tasks: 15, withdrawals: 5  },
  5: { refs: 20, balance: 400000,  refIncome: 25000,  tasks: 25, withdrawals: 10 },
  6: { refs: 30, balance: 600000,  refIncome: 40000,  tasks: 35, withdrawals: 15 },
  7: { refs: 40, balance: 800000,  refIncome: 70000,  tasks: 45, withdrawals: 20 },
  8: { refs: 50, balance: 1000000, refIncome: 100000, tasks: 50, withdrawals: 20 },
};

export interface VipMetrics {
  refs: number;
  balance: number;
  refIncome: number;
  tasks: number;
  withdrawals: number;
}

// Clamp any value to a valid VIP level (0..MAX_VIP_LEVEL).
export function normalizeVipLevel(level: any): number {
  const n = Math.floor(Number(level) || 0);
  if (n < 0) return 0;
  if (n > MAX_VIP_LEVEL) return MAX_VIP_LEVEL;
  return n;
}

// Per-second SHIB increment for a VIP level (SHIB/hr ÷ 3600).
export function vipIncrementPerSec(level: any): number {
  const lvl = normalizeVipLevel(level);
  return (VIP_INCREMENTS_SHIB_PER_HR[lvl] || 0) / 3600;
}

// Effective per-second mining rate = admin base rate + VIP increment.
export function effectiveRatePerSec(baseRatePerSec: number, level: any): number {
  return (Number(baseRatePerSec) || 0) + vipIncrementPerSec(level);
}

// SHIB-per-hour helpers for UI display.
export function vipIncrementPerHr(level: any): number {
  return VIP_INCREMENTS_SHIB_PER_HR[normalizeVipLevel(level)] || 0;
}
export function effectiveRatePerHr(baseRatePerSec: number, level: any): number {
  return (Number(baseRatePerSec) || 0) * 3600 + vipIncrementPerHr(level);
}

// Does the user meet ALL requirements for the target level?
export function meetsVipRequirements(targetLevel: number, m: VipMetrics): boolean {
  const req = VIP_REQUIREMENTS[normalizeVipLevel(targetLevel)];
  if (!req) return false;
  return (
    m.refs >= req.refs &&
    m.balance >= req.balance &&
    m.refIncome >= req.refIncome &&
    m.tasks >= req.tasks &&
    m.withdrawals >= req.withdrawals
  );
}

// Returns the list of unmet requirement keys for the target level (for UX).
export function unmetVipRequirements(targetLevel: number, m: VipMetrics): Array<keyof VipRequirement> {
  const req = VIP_REQUIREMENTS[normalizeVipLevel(targetLevel)];
  if (!req) return [];
  const unmet: Array<keyof VipRequirement> = [];
  if (m.refs < req.refs) unmet.push('refs');
  if (m.balance < req.balance) unmet.push('balance');
  if (m.refIncome < req.refIncome) unmet.push('refIncome');
  if (m.tasks < req.tasks) unmet.push('tasks');
  if (m.withdrawals < req.withdrawals) unmet.push('withdrawals');
  return unmet;
}

// Anti-drain helper: the highest tier (0..cap) whose BALANCE requirement is still
// satisfied, never dropping below `floor` (admin_promoted_level). Relies on the
// monotonic-increasing balance requirements. Used at claim time to demote users
// who drained their balance below their tier threshold.
export function highestBalanceEligibleTier(balance: number, cap: number, floor: number = 0): number {
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

// ── VIP wallet lock ──────────────────────────────────────────────────────────
// When a user holds VIP level N, the BALANCE requirement of level N is locked in
// their wallet to maintain their premium mining velocity. Level 0 locks nothing.
// withdrawable Available Balance = shib_balance − lockedBalanceForVipLevel(level).
export function lockedBalanceForVipLevel(level: any): number {
  const lvl = normalizeVipLevel(level);
  return lvl > 0 ? (VIP_REQUIREMENTS[lvl]?.balance || 0) : 0;
}

// Convenience: withdrawable balance after subtracting the VIP lock (never < 0).
export function availableBalanceAfterVipLock(balance: number, level: any): number {
  return Math.max(0, (Number(balance) || 0) - lockedBalanceForVipLevel(level));
}
