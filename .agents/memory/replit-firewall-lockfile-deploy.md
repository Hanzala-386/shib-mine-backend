---
name: Replit package-firewall URLs break external (Railway) npm ci
description: package-lock.json resolved URLs can point at http://package-firewall.replit.local; external CI/hosts (Railway) can't resolve it → ENOTFOUND. Fix by host-rewrite to registry.npmjs.org.
---

# Replit firewall URLs leak into package-lock.json → break external deploys

Replit installs npm packages through an internal proxy, so some `"resolved"` entries in
`package-lock.json` get written as
`http://package-firewall.replit.local/npm/<pkg>/-/<file>.tgz` instead of the public
`https://registry.npmjs.org/...`. Usually only a handful of entries carry the firewall
host (packages installed at a moment the proxy URL leaked); the vast majority already
use the public registry.

**Symptom:** an external build (Railway, GitHub Actions, any non-Replit host) runs
`npm ci` and dies with `npm error code ENOTFOUND ... package-firewall.replit.local`.

**Fix (deterministic, no reinstall):** rewrite only the host prefix in the lockfile —
`sed -i 's#http://package-firewall.replit.local/npm/#https://registry.npmjs.org/#g' package-lock.json`
**Why it's safe:** the path (`<pkg>/-/<file>.tgz`) is identical on both hosts and the
`integrity` sha512 is content-based, so `npm ci` still validates the downloaded tarball —
no need to regenerate the lockfile (regenerating on Replit would just re-inject the
firewall host). Also safe for Replit dev, since the other ~1500 entries already resolve
to the public registry and work fine.

**How to apply here:** Railway's `npm ci` for this repo resolved the **ROOT**
`package-lock.json` — the firewall ref that failed (`react-reconciler`) existed only in
the root lockfile; `shib-mine-backend/package-lock.json` was already clean. So keep the
ROOT lockfile firewall-free for Railway, not just the subdir copy. `.npmrc` here only
sets `legacy-peer-deps=true` (no registry override), so the lockfile URLs are the sole
source of the firewall host.
