---
name: Network Guard (VPN/geo blocking) lessons
description: Pitfalls found while building the two-layer IP guard (X4BNet CIDR + proxycheck.io) — interval merging, boot-window caching, test-server port precedence.
---

# CIDR interval lists MUST be merged before binary search
**Rule:** Never binary-search a sorted-but-unmerged interval list. Merge overlapping/adjacent `[start,end]` ranges first (`next.start <= cur.end + 1` → extend).
**Why:** X4BNet vpn+hosting lists have ~10% nested/overlapping ranges (53k → ~30k after merge). A probe landing on a narrow nested range returns "clean" for IPs covered only by the enclosing wider range — architect proved 5/20 sampled IPs were silently missed, each then cached clean for 6h.
**How to apply:** Any time raw CIDR/interval feeds are combined for lookup, merge after sorting; keep a reason-precedence rule when merging differently-labeled ranges.

# Boot-window verdict caching
Fail-open layers that load async (CIDR lists fetched after init) must NOT let early "clean" verdicts take the full cache TTL — cache them with the short fail-open TTL until the async layer is ready, or a bad IP checked at boot stays whitelisted for hours.

# Spinning a second server instance for E2E tests
`server/index.ts` port resolution is `SERVER_PORT || PORT || 5000`, and the Replit env pre-sets BOTH `SERVER_PORT=5000` and `PORT=5000` — so `PORT=5060 npx tsx server/index.ts` silently binds 5000. Use `SERVER_PORT=5060`. With `trust proxy 1`, a localhost curl with `X-Forwarded-For: <ip>` makes `req.ip` = that IP (last XFF entry) — handy for testing IP-based middleware.
