# FRICTION

Dated notes on confusion, docs/API mismatches, and breakage, each with a proposed fix. Entries that concern Strike's API feed the issue list in the post-hackathon memo.

## 2026-10-23: L3 docs say BTC-only; live returns all markets

- **Docs:** `strike-orderbook` SKILL.md says "Only allowlisted symbols are served (currently `BTC-USD`)".
- **Live:** `/v2/l3/snapshot` returns 200 for NIGHT-USD, ADA-USD, ZHIPU-USD and CXMT-USD (research probe, 2026-10-22).
- **Fix:** treat L3 as available, but handle `400 unsupported or missing symbol` gracefully, and report the docs mismatch to Strike.

## 2026-10-23: `biome migrate` silently disabled every lint rule
- **What happened:** Biome 2.6.2's migration rewrote `"rules": { "recommended": true }` as `"rules": { "preset": "none" }`. Lint then passed trivially.
- **Fix:** set `"preset": "recommended"`, then prove the rules fire by linting a temporary probe file (it raised `noDebugger`, `noDoubleEquals` and `noExplicitAny`).
- **Lesson:** after any migration, check that the linter still fails on a known violation.

## 2026-10-23: the local RTK hook rewrites `pnpm lint` and summarizes output
- **What happened:** the shell hook turned `pnpm lint` into an ESLint invocation, and it summarized `biome check` as "No issues found" while 11 errors existed.
- **Fix:** run gates as `rtk proxy pnpm test`, `rtk proxy pnpm typecheck` and `rtk proxy pnpm exec biome check .` to see raw output.

## 2026-10-23: `exchangeInfo.serverTime` is stale by 78–195 min

- **Docs** already warn that it is a cache-fill time.
- **Fix:** always sync REST signing clocks from `GET /v2/time`, then subtract 1 s.
