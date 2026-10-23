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


## 2026-10-23: how replace-batch operations count toward the orders/min limit is undocumented (D8)

- **Docs:** 1,200 orders/min and 2,400 weight/min are advertised; replace-batch caps a request at 1,000 operations (cancels + creates, cancel-all = 1). Nothing says how a replace-batch is charged against the per-minute budget.
- **What M1 does:** `rate.ts` charges one token per operation (cancels + creates) inside Ballast's own 300/min budget, the conservative choice. `// VERIFY: D8`.
- **Fix:** measure in D8 (429 behaviour vs operation count), then calibrate; ask Strike for the weight table.

## 2026-10-23: can `GET /v2/order` see a create that is sequenced but not yet processed?

- **Docs:** a 201 means sequenced; silently dropped creates never appear and `GET /v2/order` returns 404. They do not say whether a live create is visible before the engine processes it.
- **Risk:** if it is not, an engine slower than the 2 s lookup makes a live order look dropped.
- **What M1 does:** never resends. One 404 is not proof: a create is declared dropped only after two consecutive 404s at least 2 s apart, and counts as resting until then. A late event for a "dropped" create raises `onLateEvent` / a `late-event` anomaly and the order counts as resting again. `// VERIFY:` in `silent-drop.ts`.
- **Fix:** in D1, hold a create behind a slow path (or burst) and probe `GET /v2/order` within 100 ms of the 201.

## 2026-10-23: is a 429 on a create proof that nothing was sequenced?

- **Docs:** 400s publish nothing (binding, builder fee, reserved prefix); auth failures are middleware. The 429 path is not described.
- **What M1 does:** `PendingCreates.onSendError` treats any 4xx as not sent; 5xx and transport errors stay pending (unknown counts as resting). `// VERIFY:` in `silent-drop.ts`.
- **Fix:** confirm with Strike that the rate limiter runs before publishing.

## 2026-10-23: fill `position_seq` / `position_id` semantics are implied, not stated

- **Docs:** ACCOUNT_UPDATE position_seq is the "fill watermark"; fill updates carry `position_seq` and `position_id` too, and the example shows the same value (22) on both. `position_context` is "the position before this fill", but its `size` sign is not stated.
- **What M1 does:** a fill counts as reflected in a held stream report only when the ids match and its seq ≤ the report's seq. A fill on an earlier position life also counts once that life's close report (pa "0", seq ≥ the fill's) precedes the held report. `position_context` is not used. If the reading is wrong, exposure over-counts (safe) until the next REST resync. `// VERIFY:` in `reconcile.ts`.
- **Fix:** check on the first D3 fill: compare the fill's `position_seq` with the following POSITION_UPDATE and `/v2/history/position` `last_fill_seq`.

## 2026-10-23: nonce-reuse error text differs between docs

- **Docs:** strike-auth and trade-api.yaml say `401 request already processed`; docs.strikefinance.org/api/getting-started says `nonce already used`.
- **What M1 does:** both strings raise the `nonce-replay` bug alarm.
- **Fix:** report the mismatch to Strike.

## 2026-10-23: getting-started says API wallets cannot deposit; strike-auth lists deposit/withdraw for API wallets

- **Docs:** getting-started: "Not Allowed: Withdraw funds, deposit funds (requires JWT)". strike-auth: deposit and withdraw writes are masterOnly routes that reject only sub-account API keys.
- **Impact:** M5's HOLDER_PRESENT profile. M1 refuses every funding route under every profile and defines HOLDER_PRESENT as a type that signs nothing.
- **Fix:** settle it in D5/D9 before building M5.

## 2026-10-23: fake-server assumptions not covered by the docs

- An invalid but present `side`/`type` in a batch item is treated like a missing one (silent drop).
- Post-only "would match" counts the caller's own family's resting orders.
- A replace-batch with several statically invalid creates publishes only the first as rejected.
- **Fix:** each is a `// VERIFY:` in `packages/fake-strike/src/engine.ts`; adjust after D1.

## 2026-10-23: Biome 2.6 formats YAML and rewrote the pinned OpenAPI files

- **What happened:** `biome check --write .` re-indented `packages/strike-client/openapi/*.yaml`; the PIN.json hash test failed at once.
- **Fix:** excluded `packages/*/openapi/*.yaml` in `biome.json` and restored the byte-exact files from the pinned commit. Pinned third-party files need a hash test.

## 2026-10-23: does Strike bind JSON keys case-insensitively?

- **Docs:** bodies bind with Go/gin (the binding errors are `Key: 'CreateOrderRequest.Side' ...`) and unknown fields are ignored silently. Go's `encoding/json` matches keys case-insensitively by default, and a later key overrides an earlier one, but the docs do not say Strike keeps that default.
- **Risk:** if it does, `{"side":"sell","Side":"buy"}` is checked as a sell but bound as a buy, and `Vault_Id` selects a vault. The M1 review found that the signer allowlist checked only exact lowercase keys.
- **What M1 does:** `routes.ts` allows only byte-identical keys from Ballast's own subset, at every object level. It also refuses any selector key under Go's case folding (`ſ`→s, Kelvin sign→k included), any repeated query key, a `type` outside the route's set, a lowercase `time_in_force`, non-string decimals and non-boolean flags. This is safe whichever way Strike binds. `// VERIFY:` in `routes.ts`.
- **Fix:** in D1, send a testnet create with a `Side` key and see whether it binds; report the answer to Strike either way.

## 2026-10-23: a fill and its position update carry different times, and REST reads are no consistent cut

- **Docs:** in strike-userstream's own example, a fill update has `T` …150 and `position_seq` 22, while the POSITION_UPDATE for the same seq has `T` …250. "T is the position update time." `ORDER_TRADE_UPDATE` and `ACCOUNT_UPDATE` "can interleave in either order". `GET /v2/positions` rows carry no seq watermark.
- **Docs inconsistency:** strike-history's example has `last_fill_id` "36026" with `last_fill_seq` 21, but the fill update with `fill_id` "36026" carries `position_seq` 22.
- **Risk (M1 review, major):** the first reconciler compared fill and position times with Ballast's estimate of Strike's clock. An estimate off by more than 1 s re-credited fills that were already in the snapshot (truth 10, reported 7 or 4). Comparing fill times with position times directly is no better, given the 100 ms gap above.
- **What M1 does:** `reconcile.ts` never uses a server-clock estimate and never compares a fill time with a position time. It decides only by:
  - like-for-like Strike data: fill `z` against a listing's `Filled`, fill `T` against that row's `EventTimestamp`, position update `T` against `update_timestamp`, and position_seq;
  - local monotonic elapsed time: an event applied at least `lagMs` (1 s) before a REST request happened at least that long before Strike served it.
    `resyncAccount` waits `lagMs` between openOrders answering and the positions request. A resync without that gap credits no listing baselines.
- **Assumptions (`// VERIFY:` in `reconcile.ts`):**
  - Strike's internal propagation (fill → order state, position state, REST read models) takes less than `lagMs`;
  - fill `z` is cumulative including that fill, or `EventTimestamp` advances on every fill (either suffices);
  - position update `T` and `update_timestamp` share one clock, monotone per account and symbol.
- **Fix:**
  - In D1, measure the fill → position update → `GET /v2/positions` delay under load, then set `lagMs` from p99.
  - Check `z` and `EventTimestamp` on a partial fill.
  - Ask Strike for a seq watermark on `GET /v2/positions`. Or seed resyncs from `/v2/history/position` `position_checkpoints` (`last_fill_seq`), as strike-history recommends, once its lag is known.


## 2026-10-23: the skill's decimal.js recipe does not reproduce served values

- **Docs:** strike-calculations says `Decimal.set({ precision: 19, rounding: ROUND_HALF_EVEN }) // matches govalues/decimal`.
- **Measured:** govalues also caps the scale at 19 decimal places, so a value below 1 keeps fewer than 19 significant digits (`fundingRate` "0.0001847242572921308" has 16). The recipe reproduces 57 of 430 recorded `fundingRate` values; rounding to ≤ 19 significant digits and ≤ 19 decimals reproduces all 430.
- **Fix:** `packages/market/src/decimal.ts` rounds that way (`strikeRound`). Ask Strike to correct the skill.
## 2026-10-23: live-positions liquidation prices use a third precision

- **Measured:** isolated `liquidation_price` rows on `/stat/v1/stats/live-positions` carry 20 decimal places: each division is rounded to 20 dp, which reproduces every recorded isolated row digit for digit (428 distinct rows in the first three hours). Cross rows carry ~36 digits. Neither is the engine's 19-digit value that `/v2/positions` documents.
- **Fix:** compare numerically, within 1e-19 (golden test). The floor backs W′ out of the served LP, and 20 digits are ample for that.
## 2026-10-23: unverified mark/funding parameters (VERIFY items in packages/market)

- **Funding cap/floor** are not served by `/price/v2/premiumIndex` or `/v2/markets`; we use the docs' ±4% (8-hour basis). Rates from recorded averages match exactly, so the cap has not bound yet.
- **δ = 5% and τ = 5 s** are the docs' "reference values from the configuration template, not the settings of a live deployment".
- **P2's basis window:** the docs say "latest up to 60 samples, at most once per second". The fit on the first recorded hours prefers 60 samples ~1.5 s apart (a ~90 s span) with a 1.1 s book lag. The mid definition is confirmed as the impact mid: on NIGHT P2 ticks the impact mid errs 0.13 bps p50, the top-of-book mid 10.3 bps. `projectP2` stands down without a full, gap-free window.
- **Book timing:** premium samples match the L3 book as of 1 s before the slot (p99 0.001 bps vs 5–6 bps at 0 s); most of the ~1% they miss match the cycle-time book (see below). Marks match the book ~1.1 s before the `markPriceUpdate` event time. Undocumented. The live `FundingReplica` enforces the documented alignment: an index from the current slot, and a book at or before it, at most 10 s earlier.
- **Smaller gaps:** what P3 uses with neither a last trade nor a previous mark (we use 0), and whether the maker-rebate cap is rounded to quote_prec.
- **F_prev** (the last settled hourly rate, used by P1) is not served anywhere public; it is recovered from the last complete window of premium-index polls (exact once the recorder has seen a full hour) and fitted before that.
- **Fix:** ask Strike to confirm the live δ, τ, cap/floor, basis window and sampling rule, and to serve the settled rate. Until then `fitMarkReplica` estimates them, and Ballast stays in P2-blind mode (D6).
## 2026-10-23: the mark stream's index is rounded; premiumIndex's is not

- **Measured:** `markPriceUpdate.i` is rounded to quote_prec (8 dp); `/price/v2/premiumIndex` `indexPrice` is full precision. A premium sample rebuilt from the L3 book and the stream index therefore misses by up to (1 + premium)·½ulp/X: ≤ 0.0013 bps on NIGHT, ≤ 0.00024 bps on ADA.
- **Corrected (review, 00:49–02:42 UTC):** that bound holds for 1,338 of 1,350 NIGHT samples and 1,337 of 1,348 ADA samples, not "all but 3". The out-of-bound ones miss by 0.17–10.8 bps, far beyond any rounding.
- **Diagnosis:** a different index cycle in the slot does not explain them (tested against every tick in each slot). The book's age does: 20 of the 23 match within the bound when the book is taken as of the cycle's own time instead of ~1 s before the slot. That fits prices.md's "the newest eligible historical book", whose age we cannot observe. 3 ADA samples (0.93–7.4 bps) stay unexplained.
- **Exactness, stated precisely:** rate ← average (1,353/1,353 per market) and average ← samples (1,232/1,232) are exact. Samples ← book are not exact; `validateFunding` lists every out-of-bound sample with its diagnosis.
- **Fix:** ask Strike to publish the full-precision index on the stream, and the book timestamp each premium sample used.
## 2026-10-23: served liquidation prices assume the current tier; the real trigger can be higher

- **Docs:** margin-tiers.md: "Your tier is re-evaluated continuously as the mark price changes". The skill computes LP "with MMR, MA from the position's **current** notional tier". MM(notional) = max_i(notional·MMR_i − MA_i) is convex, so a long whose notional falls into a lower tier before the mark reaches its served LP meets maintenance margin above that LP.
- **Measured (aggregate only):** 26 of 176 distinct NIGHT long states (1 of 388 ADA, a served "0") have a tier-consistent trigger above the served LP, by up to ~22 bps, which is more than b_liq (~11.3–11.5 bps). The pre-fix floor F (served LP × (1 + b_liq)) failed MB > MM_actual-tier at F in 1,137 of 10,000 random cases.
- **Fix (done):** `longTriggerPrice` backs W + TU − TM out of the served LP with the tier at the row's mark and takes max_i LP_i over every tier. A served "0" is bounded by the lower tiers. F, `fragileLongs` and the P2 target all use it. A 10k-run property checks MB > MM at F with the tier in force there.
- **VERIFY:** that the served LP's tier is the tier at the row's `mark_price` is golden-checked on every recorded isolated row; cross rows cannot be checked because the wallet balance is not served.
- **Ask Strike:** serve a tier-consistent liquidation price, or document that the served one assumes the current tier.
## 2026-10-23: P2 is not monotone in Ballast's size (impact-ask fallback)

- **Docs:** prices.md protects each impact side, so an ask side that cannot fill the impact notional (or fills it outside 80–120% of index) falls back to the index.
- **Found by a property test:** on a thin ask side, Ballast's ladder can make the impact ask fillable (above index). A partial fill then drops it back to the index, which lowers P2. The depth search's monotonicity assumption was false there.
- **Fix (done):** `projectP2` also requires the projected P2 without Ballast's asks to be safe. Every partially filled state of the ladder then has P2 ≥ min(with ladder, without), which makes safety monotone in size. A 10k-run property checks random partial-fill states.
## 2026-10-23: golden live-position rows must not be committed

- **What happened:** the M2 golden test committed 181 real live-position rows (size, entry, leverage, isolated margin, liquidation price) as a fixture. That conflicts with the data policy, even though no row names an account.
- **Fix (done):** the fixture is gone. The repo keeps public market tiers (`markets.json`) and synthetic rows checked against an independent 100-digit reference. The golden test reads the local, gitignored recordings at test time (`BALLAST_RECORDINGS`, default `data/recordings`) and skips without them.
## 2026-10-23: bankruptcy definition differs between docs and skill

- **Docs:** liquidations.md calls a profile bankrupt when base balance **or** margin balance is ≤ 0. **Skill:** only MB ≤ 0.
- **Recorded:** an isolated NIGHT long with a negative `isolated_margin` is still open, and its served LP matches the formula.
- **Fix:** `riskLevel` follows the skill (`// VERIFY`). Ask Strike which one is right.
## 2026-10-23: Koios tip and UTxO set are separate reads (M4 cover oracle)

- **Docs:** `/tip` and `/account_utxos` are separate PostgREST queries; nothing says they share a snapshot. Verified live: `tip` returns `block_height`; `account_utxos` with `_extended: true` returns `asset_list` and `block_height` per UTxO.
- **What M4 does:** `CoverOracle` reads the tip, then the UTxOs, then the tip again, and only builds a proof when both tip hashes match (up to 3 retries, then it refuses). UTxOs created above the proof height are excluded. `// VERIFY:` in `packages/cover/src/oracle.ts`.
- **Fix:** in D10, measure how often the UTxO view lags the tip, and add Blockfrost as a second provider for cross-checks.

## 2026-10-23: Koios paging past 1000 rows on POST RPC endpoints is unexercised

- **Docs:** offset/limit paging applies to "any endpoint", 1000 rows per page; the public tier caps request bodies at 1 KB and bursts at 100 requests per 10 s.
- **What M4 does:** follows pages until a short page, refuses more than 200 pages rather than return a partial set, and splits address lists to stay under 1000 bytes. `// VERIFY:` in `packages/cover/src/koios.ts`.
- **Fix:** run the oracle on a wallet with more than 1000 UTxOs before outside holders onboard.

## 2026-10-23: Proof of Cover cannot yet prove a UTxO's spend height

- **Docs:** `utxo_info` reports `is_spent` now, not the height of the spending transaction.
- **What M4 does:** `recheckCoverProof` confirms every UTxO ref, address, NIGHT quantity and creation height, and lists UTxOs spent since. A proof stays valid if the spend landed after its height, but v1 does not look the spending transaction up. `// VERIFY:` in `packages/cover/src/proof.ts`.
- **Fix:** resolve spenders via Koios `tx_info` (inputs) and compare their `block_height` with the proof's.

## 2026-10-23: Ogmios mempool spend detection is a stub

- **What M4 does:** `packages/cover/src/ogmios.ts` defines `MempoolSpendSource`, a stub that never emits, and a tested matcher that sets r = 0 for any proof whose UTxO a pending transaction spends. The Ogmios v6 LocalTxMonitor calls (`acquireMempool`, `nextTransaction`, `releaseMempool`) are from memory. `// VERIFY:`.
- **Fix:** provision Ogmios (or a hosted equivalent), check the protocol against its docs, and run D10's mempool test.

## 2026-10-23: NIGHT sits at Byron addresses that cannot bind a stake credential

- **Measured (Koios `asset_addresses`, first page, aggregate only):** the first 20 holders of the pinned NIGHT asset were all Byron (`Ae2…`) addresses. Byron addresses carry no stake credential, so Ballast cannot bind them to an account.
- **What M4 does:** the oracle reports Byron UTxOs as excluded (`byron`), and `ballast cover` refuses a Byron input with a clear message.
- **Fix:** onboarding copy should tell Byron holders to move NIGHT to a Shelley (`addr1…`) address first. Measure how much NIGHT sits at Byron addresses before quoting the "86,040 staked wallets" figure next to total supply.

## 2026-10-23: the recorder deploy now installs native and wasm dependencies

- **What happened:** `ops/deploy-recorder.sh` runs a workspace-wide `pnpm install --frozen-lockfile` on read-only hosts. M4 adds better-sqlite3 (native build), cardano-serialization-lib (wasm) and the Anthropic SDK to the workspace. The recorder never imports them: `@ballast/evidence` keeps the SQLite store and anchoring behind subpaths (`/db`, `/anchor`, `/bundle`).
- **Fix:** change the deploy to `pnpm install --frozen-lockfile --filter @ballast/recorder...` so read-only hosts install only the recorder's graph. Not changed in M4, because the live recorder runs from the main checkout.

## 2026-10-23: Guard trips in the bundle are not yet signed

- **What M4 does:** renewals are refused after a safety-class Guard trip, and `ballast verify` re-checks every renewal against the bundle's `guard-trips.jsonl`. Adding a trip makes verification stricter, but deleting one cannot be detected yet, because trips are stored rows, not signed records.
- **Fix:** when the Guard lands (M3), record each trip in its decision record's `guard.violations` and have `verify` derive trips from the signed chain only.

## 2026-10-23: the Advisor's API call is not yet exercised live

- **What M4 does:** `createAnthropicLlm` follows the claude-api skill and the `@anthropic-ai/sdk` 1.1.0 types: `claude-opus-5-5` (thinking cannot be disabled, so effort is `low`), server-side fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`), a 20 s abort and no SDK retries. Tests use a fake client; no key was available. `// VERIFY:` in `packages/governance/src/advisor/llm.ts`.
- **Fix:** on the first run with `BALLAST_ADVISOR=on`, confirm the request is accepted and a refusal or timeout produces no note.

## 2026-10-23: M4 exit needs a preprod anchor transaction (human step)

- **What M4 does:** `buildAnchorTx` builds and signs a CIP-20 self-send offline (tested against preprod-format data with protocol parameters read from Koios for preprod epoch 321 and mainnet epoch 663). Nothing submits it.
- **Fix:** an operator funds a fresh preprod anchor wallet from the faucet, builds one anchor with these tools, submits it by hand, and records the tx hash in EVIDENCE.md. Mainnet anchoring needs the ≤ 20 ADA hot wallet and an explicit go-ahead.

## 2026-10-23: scoping the recorder deploy with `--filter "@ballast/recorder..."` does not help

- **Proposal (M4 entry above):** install only the recorder's tree on read-only hosts to skip the native and wasm packages.
- **Why it fails:** `@ballast/evidence` now depends on better-sqlite3 and cardano-serialization-lib, so `@ballast/recorder...` still pulls them in. The filter would also skip the root `tsx` that the systemd unit runs.
- **Decision:** keep the full `pnpm install --frozen-lockfile`. better-sqlite3 has prebuilt linux-x64 binaries and Sonar-VPS2 has make, gcc and python3 anyway. If read-only hosts need to stay lean later, move db, anchor and bundle into their own package.

## 2026-10-23: which minimum size applies to limit orders (VERIFY in packages/engine)

- **Docs:** strike-trading's CloseReason table says `order_less_than_min_size` checks `order_market_min_size` for every order type, limits included. `/v2/markets` also serves `order_limit_min_size` (both are "1" on NIGHT and ADA today).
- **Fix (done):** `engineMarket` enforces the larger of the two, so either reading is safe. Ask Strike which field the engine reads for limit orders.
## 2026-10-23: the limit price bound's reference is not documented (VERIFY in packages/engine)

- **Docs:** `order_price_out_of_price_cap` / `_floor` mean "limit price too far from mark (`order_limit_price_bound`)". There is no formula: whether it is |price − mark| / mark, symmetric, and applied to post-only sells is inferred.
- **Fix (done):** `validateCreate` checks ±4.5% of mark, inside Strike's 5%. A static reject only wastes one requote (a replace-batch then applies nothing); it never loosens safety. Ask Strike for the formula.
## 2026-10-23: Ballast stands down whenever NIGHT's ask side is fully empty

- **Measured (M3 replay of the first 3.5 h of recordings, 00:49–04:21 UTC):** 152 requotes found no non-Ballast ask at all. The arm rule (L1 ≤ best ask − 5 bps) and the aggregate cap (asks within 2% of mid, Ballast excluded) then both read zero, and the engine stands down. Another 121 stood down for a fragile long under P2-blind mode.
- This is fail-closed and matches plan section 5, but it is exactly when Ballast's asks would help most.
- **Proposed fix (operator decision, not changed in M3):** with an empty ask side, arm against index + a fixed offset and size the cap from the last non-empty depth snapshot; or accept the stand-down.
## 2026-10-23: replay assumes a recorded bid that crosses a Ballast ask would have traded

- **Unknown:** whether the house posts its bids post-only. That is not public, and Ballast does not parse house order flags.
- **Sim choice:** a recorded bid that opens at or above a resting Ballast ask takes it for the crossing size (25 of the 27 fills in the recorded replay). This is the conservative reading: more fills, more stress on cover and the floor.
- **Fix:** revisit if Strike says how the house quotes. The same-size taker re-match is unaffected.

## 2026-10-23: API-wallet funding, M5 design for both answers (open question above)

- **Docs, re-read for M5:** the builder-codes pages (`/api/builder-codes/deposit.md`, `/withdraw.md`) say every deposit and withdraw route "requires API wallet authentication" and that builder-connect wallets call them for the connected account; the strike-deposit and strike-withdraw skills agree (masterOnly, sub-account keys refused). Only getting-started says "Not Allowed: deposit funds, withdraw funds (requires JWT)". Three sources against one, still unproven.
- **What M5 does:** the HOLDER_PRESENT profile (`@ballast/strike-client/funding`) signs the six funding routes, and only with a fresh holder proof; the holder's wallet signs every transaction and the withdrawal message either way. If Strike answers a first funding step (deposit quote, withdraw estimate or quote) with a 401/403 that is not an ordinary signature or clock error, the API returns `fallback: "strike-app"` and `/join` and `/me` send the holder to Strike's own app. `HOLDER_FUNDING_MODE=strike-app` forces that path. `// VERIFY:` in `apps/api/src/holder/service.ts` and `funding.ts`.
- **Fix:** D5 and D9 decide (docs/dayone.md). Record the exact answer here and close this entry.

## 2026-10-23: M5 VERIFY items (Cardano onboarding)

- **Hex address to `signData`.** CIP-30 accepts bech32 or hex; Ballast passes hex bytes, as the reference integration does. `// VERIFY:` in `packages/cardano/src/cip30.ts`. D4 confirms with Lace and Eternl.
- **Eternl's change address.** Ballast binds to `getChangeAddress()` exactly (Strike's `Wallet:` line and `wallet_address` must match). Eternl in multi-address mode may rotate it. `// VERIFY:` in `cip30.ts`; recommend single-address mode until D4 shows otherwise.
- **Hashed CIP-8 payloads are refused.** Lace and Eternl send `hashed: false`; Strike documents only the plain payload. `// VERIFY:` in `packages/cardano/src/cose-verify.ts`.
- **A fresh account's `/v2/account`.** The dedicated-account check treats any non-zero balance, margin or PnL, any sub-account and any `symbol_settings` as foreign activity. That a fresh Builder Connect account reads all zeros is assumed. `// VERIFY:` in `packages/strike-client/src/builder-connect.ts`.
- **Builder Connect's message template.** Before asking for a signature, Ballast checks that Strike's `message_to_sign` names the builder, this wallet, the generated API key and the nonce (strike-auth's template). A template change makes the connect refuse, not sign blind. `// VERIFY:` in `builder-connect.ts`.
- **`/v2/withdraw/estimate` for builder wallets.** It is in the strike-withdraw skill but not on the builder-codes withdraw page. `// VERIFY:` in `funding.ts`; D9.
- **USDM decimals.** `/join` converts USDM amounts at 6 decimals. `// VERIFY:` in `apps/web/src/lib/join.ts`; D5 compares the quote's `usd_value`.
- **WITHDRAWAL_SETTLED.** It arrives only on the user stream, which M5 does not open; the D9 watcher uses the payout UTxO on Koios (excluding the funding tx's own change) instead. `// VERIFY:` in `apps/cli/src/dayone/d9-withdraw.ts`.
- **The fake's guesses** (`packages/fake-strike/src/onboarding.ts`): the error an API wallet gets on a JWT-only route (`401 missing authorization header`), the credit's user-stream event kind, and the error text for a funding tx that is not the quoted one. Adjust after D5/D9.
- **Withdrawal funding tx signers.** A multi-address wallet may sign the funding tx with keys other than the connect address's. Ballast requires the quoted body unchanged, at least one witness and every witness valid, and leaves "which keys" to the chain.

## 2026-10-23: a holder proof per funding call costs wallet prompts

- **What M5 does:** each funding request needs its own CIP-8 proof (≤ 60 s, single-use, bound to the account and the exact body). A deposit is 3 `signData` + 1 `signTx`; a withdrawal 4 `signData` + 1 `signTx` (docs/dayone.md has the table).
- **Why:** the plan's HOLDER_PRESENT rule (§7). Proofs bound to a request cannot be replayed for a different one, and a stolen session token cannot fund anything.
- **Proposed fix (operator decision):** if the prompts hurt onboarding, let one proof cover a named sequence (quote then build-tx for one amount) with a per-step body hash list, keeping the 60 s life.

## 2026-10-23: the consent hash is stored but not yet chained

- **What M5 does:** the holder role stores `sha256(consent message)` in the private `holder_consents` table and applies r to the account. The signed decision chain belongs to the daemon key on host A, so the API process does not append to it.
- **Fix (M7):** when the keeper first picks an account up, it appends a `consent` decision whose `inputsDigest` is that hash; `verify` then ties every order to a consent as well as a policy.

## 2026-10-23: the keeper reads margin from `/v2/balances` (VERIFY in apps/keeper)

- **Docs:** user-api.yaml documents `/v2/balances` as a one-element USDT array with `marginBalance` and `maintMargin`. The keeper takes equity = `marginBalance` and the margin ratio = `maintMargin / marginBalance` (rounded up), refreshed every 5 s. A read older than 30 s counts as unknown, which is the reduce band: cancel, no creates.
- **Unverified:** which row (and asset) carries the margin of an account funded with ADA or USDM, and whether USDT here is treated 1:1 as USD.
- **Fix:** after D5, compare `/v2/balances` with `/v2/portfolio` and the Strike UI on holder #0's account.

## 2026-10-23: the loss stop values paired coins at Strike's index (VERIFY in apps/keeper)

- **What M6 does:** combined-MTM PnL is integrated tick by tick: the change in perp equity plus `prior short × Δindex` for the coins paired with the short. A buy-back is therefore not counted as a loss. The plan says the wallet coins should be valued at the CEX/DEX mid.
- **Fix:** add a CEX/DEX mid source (the same one the reference-sanity rule needs) and value the paired coins at it.

## 2026-10-23: the CEX reference for `reference-sanity` is not wired (VERIFY in apps/keeper)

- **What M6 does:** the keeper tells the Guard `reference: unavailable`, which passes only while the index is fresh (≤ 3 s). That is the same choice the Critic's replay makes, since no CEX feed is recorded.
- **Fix:** add a read-only CEX median (USDT pairs converted with `/price/v2/fxRates`) and feed `deviationBps`.

## 2026-10-23: Proof-of-Conduct vault check uses an unverified public read (VERIFY in apps/keeper)

- **What M6 does:** `vaultCheck` reads `GET /v2/vault/positions?account_id=` without a key every 60 s. It treats a null or empty `positions` list (or an empty array) as no vault shares. Until the first successful read, shares are assumed held, which blocks creates (`dedicated-account`).
- **Unverified:** the response shape, and whether the route is public for any account id.
- **Fix:** one live GET on holder #0 after D4, then pin the schema.

## 2026-10-23: the protocol-as-taker fill budget is not enforced live (VERIFY in apps/keeper)

- **Plan:** at most 25% of the day's capacity may be sold to the protocol (house) as taker.
- **Problem:** measuring it means knowing which taker fills are the house's. The data policy forbids parsing vault client ids or identifying the house from private data.
- **What M6 does:** the keeper calls `planRequote` without `protocolTaker`. The engine and the simulator support the budget; the P2-blind $300 cap bounds the same exposure for now.
- **Fix:** ask Strike for the opt-in (which waives the budget) or for an aggregate house-taker figure Ballast may use.

## 2026-10-23: one user stream per key: the watchdog's confirmation path (VERIFY, D8)

- **What M6 does:** the watchdog keeps its own `/ws/user-api` socket with the account's key to confirm cancels, plus a REST resync every 5 s. If Strike refuses a second socket for one key while the keeper holds one, the REST resync confirms instead; the e2e test with every order event dropped proves that path.
- **Test-only difference:** `@ballast/strike-client` allows one UserStream per key per process, so the tests register a second key on the same fake account for the watchdog. In production they are separate hosts and the same key.
- **Fix:** D8 measures it. If two sockets per key are refused, keep the REST path and say so in the runbook.

## 2026-10-23: day-one hosts and reads not yet confirmed (VERIFY in apps/cli/src/dayone)

- **Testnet WebSocket origin:** assumed to be `wss://api-v2-testnet.strikefinance.org` (mirroring REST). Also assumed: that testnet serves `/v2/l3/snapshot` for BTC-USD. D1 fails at once if either is wrong.
- **D2's public read:** `GET /v2/order?account_id&client_order_id` with no key (FlexibleAuth) is the plan's pass condition. Ballast's signer refuses `account_id` on signed reads, so the script reads it unauthenticated. The signed read is recorded beside it.
- **D3's builder balance:** which account receives builder fees, and whether its `walletBalance` moves on each fill or on a later payout, is unknown. D3 records the maker fill's `builder_fee` either way, and passes only if the builder account's balance is seen to rise.
- **Fix:** each answer goes into EVIDENCE.md and the marker is removed.

## 2026-10-23: day-one probe orders carry `bal_d<N>_…` ids, not policy-tied ids

- **What M6 does:** D2, D3, D6, D7 and D8 place probe asks with ids like `bal_d7_<time>_<n>`. They are `bal_` orders (they pass the route allowlist and do not trip manual-activity detection), but they do not parse to a signed policy.
- **Risk:** the public Proof-of-Conduct check ("every order parses to a signed policy") would flag them, and a running keeper would treat them as its own asks.
- **Fix:** run the day-one checks with the keeper and watchdog stopped for that account (the runbook says so). Record every probe trade id with `insertProbe`, and teach the conduct check to accept the `bal_d<N>_` family only when it is listed in `probes`.

## 2026-10-23: three keeper bugs found by the M6 chaos and wiring tests (fixed)

- **Self-chasing:** an unconfirmed create (no stream event yet) that already rested on L3 was counted as house liquidity, so the keeper saw its own ask as the best non-Ballast ask and stood down. Fix: every live Ballast order, confirmed or not, is attributed on L3 by price and fingerprinted size, and removed from the counterfactual book.
- **Fast L3 rebuilds went unnoticed:** a gap or `clear` that the feed rebuilt within milliseconds never showed as stale. Fix: any rebuild counts as stale data for the tick that first sees it, so resting asks are cancelled once and quoting resumes on the rebuilt book.
- **Mempool spends were invisible to the Guard:** the keeper zeroed capacity on a pending spend, but the Guard and the engine still saw the confirmed cover. Fix: an unconfirmed spend now zeroes the cover the engine and the Guard plan against.

## 2026-10-23: `ballast verify` now exempts reduce-only exits from invariant 2's retro-check

- **Why:** the Guard checks cancels and reduce-only buy-backs only against `route-allowlist` and `dry-run` (plan section 6). A buy-back sent after a policy expired (the keeper closing a short on a cover loss) is correct behaviour, but verify v1 counted it as a create with no policy in force.
- **Fix (done):** verify skips ops with `side: "buy"`. A sell op with no policy in force still fails (apps/cli/test/verify-exits.test.ts).

## 2026-10-23: DRY_RUN evaluates the Guard as if armed

- **What M6 does:** in DRY_RUN the keeper evaluates every create with `armed: true`. Otherwise the `arm-flag` rule would block every create, and the would-place log could never show "all 28 checks passed". The `dry-run` rule is evaluated last, and a dry-run decision is never "execute", so nothing can be sent. A wiring test proves no signer method is ever called in DRY_RUN.
- **Read the logs knowing this:** `data/keeper/would-place.jsonl` records the hypothetical armed verdict. The decision record's `guard.decision` is `dry-run`.

## 2026-10-23: the keeper and watchdog tests run in real time against the fake

- **Cost:** the full suite went from about 34 s to about 66 s wall time (97 s before the chaos and invariant files were split so they run in parallel). These files wait out real 2 s replace-batch spacing, 2 s silent-drop lookups and kill-retry windows; the 429-storm case alone takes about 20 s.
- **Fix:** give FakeStrike, the daemon and the strike-client timers one injectable clock (vitest fake timers do not reach the `ws` sockets).

## 2026-10-23: two review findings left open in the M6 keeper and watchdog

- **Restart does not re-register in-flight creates:** a keeper that crashes between a 201 and the create's stream event restarts with an empty PendingCreates. It learns its orders from the first `/v2/openOrders` resync and the user stream. A create that was sequenced but not yet visible at that resync shows up later on the stream as an order the keeper did not send in this run. It is a `bal_` id, so it is adopted, not treated as manual activity. A create that was silently dropped is simply never seen.
- **Risk:** until that order shows up, the keeper undercounts its resting size, so one create could overshoot the cover invariant by up to that order's size. The window is short: a systemd restart takes seconds, and Strike sequences a 201'd create well before then. The watchdog's cover rule uses its own stream and L3 view, so it would cancel on an overshoot.
- **Fix:** on start, read the evidence DB's unresolved creates for each account and feed them to PendingCreates before the first tick, so silent-drop lookups resume.
- **Watchdog kills are not signed decision records:** host B holds no daemon signing key (by design, CANCEL_ONLY), so its kills go to its own `kills` JSONL and SQLite table, with latency, and not into the keeper's hash chain. `ballast verify` therefore does not see them.
- **Fix:** give the watchdog its own signing domain (`ballast/watchdog/v1`) and key, append its kills to a separate chain, and teach verify to merge both chains by time.

## 2026-10-23: D1 on testnet: three API behaviours that differ from the docs or from mainnet

- **A post-only cross does not stop later creates.** In a replace-batch ordered far to near, the crossing create was REJECTED (`order_would_match_immediately`) and the next, nearer create still rested (seen in 2 runs). The skill docs say later creates are skipped. Ballast does not depend on either behaviour, but anyone relying on the documented skip as a safety stop would be wrong. Asked in the memo.
- **Testnet BTC-USD has a $100 minimum notional** (`order_min_notional`), against $10 on mainnet NIGHT. The first D1 run had every create REJECTED at $10.50. The probe size now comes from the market's own rule (1.05 × minimum).
- **Our own limiter refused D1's check (a) locally.** The client allows one replace-batch per account per 2 s, and the probe sent its first replace-batch right after the setup batch. Fix: D1 waits 2.5 s, and a check that never reached Strike is reported as untested, never as a pass or fail.
- **An unknown symbol is accepted, then silently dropped.** `BTCX-USD` came back in `successful` with a sequence id and then 404'd. This confirms the silent-drop detector is needed for every create, not just for rate-limited ones.

## 2026-10-23: Railway would not switch from Railpack to our Dockerfile

- **Symptom:** the first deploy built with Railpack and failed ("No start command detected"). `railway.json` was ignored, and `railway environment edit --service-config ballast-public build.builder DOCKERFILE` answered "No changes to apply" while the config still read RAILPACK.
- **Fix:** set the service instance's `dockerfilePath` via the GraphQL API and the variable `RAILWAY_DOCKERFILE_PATH`. The next deploy built from `deploy/railway/Dockerfile` and went live. Recipe in `deploy/railway/README.md`.

## 2026-10-23: a silent WebSocket costs up to 75 s of blackout

- **What happened:** enabling `ufw` on host A left both the recorder's and the keeper's Strike WebSockets ESTABLISHED, but with no data flowing.
  - The keeper's own staleness check flagged index/mark as stale more than 3 s after the last update, and it stood down as designed.
  - The sockets were only replaced when `ReconnectingSocket`'s idle timeout fired, after 75 s of silence. That figure is sized to Strike's 54 s ping interval.
- **Proposed fix:** give each socket an idle timeout that matches its guaranteed traffic.
  - The price socket carries `markprice@1s` for every symbol, so about 10 s.
  - L3 on NIGHT-USD and ADA-USD carries about 55 updates a second, so about 20 s.
  - Thread `idleTimeoutMs` through `L3FeedOptions`, and set it in the keeper, the watchdog and the recorder.

## 2026-10-23: Strike builder codes are case-sensitive

- **What happened:** Builder Connect answered `404 builder code not found` for `ballast`. The code was registered as `Ballast`, and the app displays it with that capital B. `request-signature` with `code: "Ballast"` returned Strike's message: "Connect to Strike via builder "Ballast". This authorizes the builder to collect up to 0.1% fee on your trades."
- **Fix (done):** `HOLDER_BUILDER_CODE` accepts mixed case and defaults to `Ballast`. D2 expects `Builder{Code:"Ballast"}` on mainnet; `BALLAST_BUILDER_CODE` overrides it for the fake.
- **For Strike:** document that codes are case-sensitive, or match them case-insensitively, since the app shows the code capitalized.
