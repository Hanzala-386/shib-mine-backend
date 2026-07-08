---
name: Baked-art overlay coupling (redeem screen)
description: How to overlay dynamic values on frame PNGs that have baked-in art/placeholder text, and what breaks when the art changes.
---

# Baked-art overlays on frame PNGs

Some screens (e.g. the Redemption Center, `app/redeem.tsx`) render dynamic values
ON TOP of image assets that already have text/numbers/labels baked into the art
(a "circuit box" balance frame with a placeholder number + "Hit Tickets available"
and "1 ticket = 10 SHIB" labels; sci-fi cell frames with a gold price nameplate).

The pattern used: an OPAQUE overlay chip masks ONLY the baked placeholder number,
and the real value is drawn in the chip. The baked LABELS are intentionally kept
(cheaper than re-generating clean art, and keeps the design cohesive).

**Rule:** the overlay positions are percentage-based and are TIGHTLY COUPLED to the
exact PNG that ships. They only stay correct because each frame wrapper's box
aspect-ratio is set to EXACTLY match the image's aspect ratio, and the image uses
`contentFit="contain"` so the art fills the box edge-to-edge — this makes the
percentage coordinates geometrically valid at any screen width.

**Why:** if you regenerate/swap the balance-frame or cell-frame PNG (different art,
different crop, or a different aspect ratio), the baked number/nameplate moves and
the masking chip / price text will no longer line up — you must re-measure and
re-tune the percentage overlays for the new asset.

**How to apply:**
- Keep wrapper `aspectRatio` == asset AR; never hardcode overlay pixel positions.
- Tune chip/overlay %s against a full-scale render (the web screenshot harness for
  `/redeem` is flaky: it shows a boot-gate WHITE on the first nav right after an HMR
  rebundle — warm the app by screenshotting another route like `/auth` first, or
  just retry; it is NOT a code crash, which would show the dark ErrorBoundary).
- The masking chip must be fully OPAQUE (not ~0.9) or the bright baked number ghosts
  through; and it must be tall/wide enough — the baked number can be larger than a
  first estimate suggests (measure by bracketing: shrink from top and bottom until
  neither edge of the baked glyphs pokes out).
