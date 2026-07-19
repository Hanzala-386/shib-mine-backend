/* ────────────────────────────────────────────────────────────────────────────
 * Input cleanup helpers — mirror the server-side versions in server/routes.ts
 * so the APK's direct-PocketBase fallback paths store the same normalized
 * values as the Express paths. Keep both in sync.
 * ──────────────────────────────────────────────────────────────────────────── */

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Trim + lowercase; returns null when the result is not a plausible email. */
export function cleanEmail(raw: unknown): string | null {
  const e = String(raw ?? '').trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** Strip control chars / markup-ish chars, collapse whitespace, cap at 40. */
export function cleanDisplayName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F<>"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}
