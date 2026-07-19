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

/**
 * Plain-text cleanup for free-form user text (support tickets, notes, etc.).
 * Ensures what is stored is data-only: strips HTML/script tags and control
 * characters (newlines kept), so script-like input is stored as harmless
 * literal text and can never render or run as markup/code anywhere.
 */
export function cleanFreeText(raw: unknown, maxLen = 1000): string {
  return String(raw ?? '')
    .replace(/<[^>]*>/g, '')                       // strip anything tag-shaped
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '') // control chars, keep \n \t
    .replace(/[ \t]+/g, ' ')                       // collapse runs of spaces/tabs
    .replace(/\n{3,}/g, '\n\n')                    // cap blank-line runs
    .trim()
    .slice(0, maxLen);
}
