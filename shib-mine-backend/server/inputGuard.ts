/* ────────────────────────────────────────────────────────────────────────────
 * Server-side input validation guard.
 * Rejects malformed identifier fields BEFORE any route logic runs, so
 * user-supplied strings can never break out of the PocketBase filter
 * expressions or record paths they are interpolated into.
 *
 * Two layers:
 *  1. Known identifier fields in body/query (pbId, taskId, …) must match a
 *     strict identifier charset (letters, digits, _ . : -), max 128 chars.
 *  2. Every decoded URL path segment is checked for filter-breaking
 *     metacharacters (quotes, backslash, parens, angle brackets, |, &, =,
 *     whitespace) — this covers route params like /:pbId that middleware
 *     cannot see by name.
 * Emails, display names, and free text are validated route-level
 * (cleanEmail / cleanDisplayName / KYC validators) — this guard only covers
 * machine identifiers.
 * ──────────────────────────────────────────────────────────────────────────── */
import type { Request, Response, NextFunction } from "express";

// Fields that are always machine identifiers (PB record IDs, Firebase UIDs,
// referral codes, match/session IDs). JWT-style tokens contain "." and "-".
const ID_FIELDS = [
  "pbId",
  "taskId",
  "userId",
  "sessionId",
  "matchId",
  "firebaseUid",
  "referredBy",
  "referralCode",
  "code",
] as const;

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

// Characters that can alter a PocketBase filter expression or record path.
// Deliberately does NOT include @ + % etc. so emails/encoded values in paths
// stay valid.
const PATH_META = /["'\\()<>|&=\s]/;

function badIdField(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  for (const f of ID_FIELDS) {
    const v = (obj as Record<string, unknown>)[f];
    if (v === undefined || v === null || v === "") continue;
    // Present but not a plain string (arrays via ?code=a&code=b or JSON
    // arrays/objects) is always invalid — template literals would coerce
    // them back into injectable strings downstream.
    if (typeof v !== "string" || !ID_PATTERN.test(v)) return f;
  }
  return null;
}

export function inputGuard() {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Identifier fields in body and query.
    const bad = badIdField(req.body) || badIdField(req.query);
    if (bad) {
      return res.status(400).json({ error: `Invalid ${bad} format.` });
    }

    // 2. Decoded path segments — covers /:pbId-style route params.
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
