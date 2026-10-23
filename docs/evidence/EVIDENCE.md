# EVIDENCE

Demo-worthy, verifiable artifacts, newest last. Every number links to a public endpoint, a recorded segment (with its sha256 and hourly Merkle root), or a `ballast verify` command.

## M0: day-0 recorder

_(started 2026-10-23; the segment manifest and hourly roots live in `data/recordings/{manifest,roots}.jsonl`)_

**2026-10-23 00:49 UTC: recorder live on NIGHT-USD and ADA-USD.**
- **Sources:** public data only.
  - L3 order-by-order feed (`/ws/l3`, gap-checked per symbol);
  - `@markprice@1s`, `@trade` and `@bookticker` (`/ws/price`);
  - REST depth (1,000 levels, every 15 s), premium index (5 s), minimized live positions (5 min), markets, 24 h tickers, trades and `/v2/time` offsets.
- **First 5 minutes:** 68,954 L3 updates with **zero sequence gaps** on both books. NIGHT `10234780 → …` and ADA `26088014 → …` were contiguous from the first snapshot.
- **Storage:**
  - Hourly JSONL segments are fsynced and sha256-hashed into `manifest.jsonl`.
  - Each completed hour is rolled into an RFC 6962 Merkle root, hash-chained into `roots.jsonl`.
  - Sealed segments are gzipped after a verified round-trip (L3 compresses to about 12.7%).
- **Restart test:** a graceful SIGTERM sealed all 5 segments, and the restart continued in part `.1` of the same hour.
- **Check:** `pnpm recorder:verify` → `PASS: 5 segments (5 gzip), 0 hourly roots, 5 open`.
- **Privacy:** live positions are stored with no wallet address, ADA handle or account id. Only id, symbol, size, entry, mark, leverage, margin mode, isolated margin, liquidation price and a vault flag are kept.

**2026-10-23 01:00 UTC: first hour sealed and rooted.**
- `2026-10-23T00`: 10 segments (all gzip, verified round-trip).
- RFC 6962 root `87d1b7d985ddfa7b…`.
- `pnpm recorder:verify` → PASS. 0 L3 rebuilds.

**2026-10-23 01:26 UTC: recorder B live on a second host** (Sonar-VPS2, Tencent Cloud).
- Runs as a systemd user service with auto-restart and linger.
- Public data only; holds no keys.
- Deployed with `ops/deploy-recorder.sh`, which syncs nothing gitignored.
- Uses about 54 MB RSS and 0.3% CPU.

## D0: builder code registered

- **2026-10-23:** builder code **`Ballast`** shows in the Strike app with Max Fee Rate **10 bps**, Status **Active** and Created Oct 23 2026.
- It belongs to a dedicated builder wallet (`addr…3aut`), separate from holder #0.
- The code displays capitalized. The exact string Builder Connect expects is checked in D4.

## Holder #0

- **Address:** `addr1qxs7j5k6z2yd5wlczanm69humvehck9q6yzpvje663lrtfx3nqcq7jf585dszhf52g9x89sj6fcda9uzkmt5j2p379gs6qlujf`.
  - Koios: no on-chain history yet, as expected for a fresh wallet.
- **Strike account `01a1664c-1655-7c00-b94e-4f2d9a1ee0d2`:** already exists, with a zero balance (`/v2/account?blockchain_address=` → 200).
  - It was created by connecting the wallet in the Strike app. Builder Connect will approve Ballast on it.
  - The "404 → 200" demo moment therefore uses an outside holder's fresh wallet.
  - Control lookup: an unknown address returns 404 `user not found`.


## M2: market model

**2026-10-23, "before" Book Health** (`pnpm book-health -- --root data/recordings`, window 00:49:51–02:42:35 UTC, 1,837,348 recorded lines, 0 bad lines, 0 L3 sequence breaks).
| Time-weighted, no Ballast orders     | NIGHT-USD         | ADA-USD             |
| ------------------------------------ | ----------------- | ------------------- |
| Spread                               | 98.8 bps          | 3.9 bps             |
| Depth within ±0.5% of mid, bid / ask | $15,716 / **$31** | $215,045 / $125,108 |
| $1K market buy, VWAP vs mid          | 70.4 bps          | 2.5 bps             |
| $10K market buy, VWAP vs mid         | 92.8 bps          | 4.0 bps             |
- NIGHT's ask side is empty within 0.5% of mid.
- **Method:** once Ballast quotes, the actual and counterfactual books are both measured against the counterfactual (non-Ballast) mid, so Ballast's own asks cannot move the yardstick. Absolute VWAPs are reported next to slippage.
- **Funding replica:** every recorded `fundingRate` (1,353 per market) is reproduced exactly from `averagePremiumIndex` and the served parameters, and every `averagePremiumIndex` (1,232 per market) exactly from its samples. Exactness holds at those two levels. Samples rebuilt from the L3 book fall within the stream index's 8-dp rounding for 1,338/1,350 (NIGHT) and 1,337/1,348 (ADA). Of the rest, 20 of 23 match the book as of the cycle's own time, and 3 ADA samples are unexplained.
- **Mark replica (held-out half):** published `markPriceUpdate` marks reproduced with p50 0.021 / 0.007 bps and p99 0.77 / 0.65 bps (NIGHT / ADA). The best structure is P2 = 60 impact-mid basis samples ~1.5 s apart, with a 1.1 s book lag. P2's mid is the impact mid (top-of-book mid: 10.3 bps p50 error on NIGHT's P2 ticks).
- **Floor inputs:** b_liq = 10 bps + 2 × max(held-out, all-tick) p99 = 11.5 / 11.3 bps. A NIGHT long was fragile (tier-consistent trigger within b_liq of the index) on 1.8% of ticks, an ADA long on none. Positions were never stale.

## M4: cover oracle, live and read-only

**2026-10-23, `pnpm ballast cover <addr>`** (Koios, pinned NIGHT `0691b2fe…5af1fa.4e49474854`, r = 0.5).
- **Holder #0:** stake credential `stake1u8gesvq0fy6r6xcpt569yznrjcfdyux7j7ptd46f9qclz5gp23ddv` (derived locally, cross-checked with cardano-serialization-lib). At block 14,104,006: 0.000000 NIGHT in 0 UTxOs, capacity 0, as expected for a fresh wallet.
- **A real NIGHT holder** (found via Koios `asset_addresses`; address withheld): at block 14,104,012 the stake credential holds 130,733.476954 NIGHT in 11 spendable UTxOs across 2 base addresses on the same stake key.
  - Its first payment address alone sums to 120,189.314965 NIGHT, exactly Koios's own `asset_addresses` figure for it.
  - One script-locked UTxO (3,514.720663 NIGHT) under the same stake key is excluded as cover.
  - The proof passed the offline re-check and a live re-read of every UTxO ref via `utxo_info`.

## M3: engine, Guard and simulator

**2026-10-23, Critic replay** (`runCritic`, default NIGHT policy, P2-blind mode, holder #0 plus two outside holders, seed 1). The recorded window is 00:49:49–04:21:36 UTC (3.53 h); the stress library is synthetic.
| Scenario                      | Violations | Fills | Armed h | Max combined drawdown |
| ----------------------------- | ---------- | ----- | ------- | --------------------- |
| recorded (same size)          | 0          | 27    | 2.36    | $16.32                |
| recorded (same notional)      | 0          | 27    | 2.36    | $16.32                |
| house reaction (fair +60 bps) | 0          | 28    | 0.13    | $29.44                |
| mark drop, one $417 sell      | 0          | 67    | 0.33    | $0.89                 |
| +30% rally (1 h)              | 0          | 137   | 0.35    | $17.67                |
| index stall (40 s)            | 0          | 43    | 0.19    | $3.62                 |
| L3 `clear`                    | 0          | 41    | 0.20    | $3.44                 |
| Koios 3 blocks behind         | 0          | 0     | 0.00    | $0.00                 |
| holder sells cover mid-quote  | 0          | 38    | 0.25    | $4.67                 |
| 429 storm (2 min, 90%)        | 0          | 53    | 0.25    | $4.43                 |
| partial replace-batch reject  | 0          | 34    | 0.15    | $2.94                 |
- "Violations" sums the simulator's own cover, floor, P2, static and rate checks. They are measured independently of the Guard, which sits in the loop.
- The verdict is PASS, with output hash `b70888ff…ecbcc` (`windows: [{ fromMs: 0, toMs: 04:21:36.333 UTC }]`). The same data root, policy hash and seed reproduce it exactly (a CI test).
- Recorded fills: 2 re-matched taker buys, and 25 recorded bids that opened at or over a Ballast ask (see FRICTION).
- Stand-downs over the recorded window: 152 requotes found no non-Ballast ask (NIGHT's ask side was empty), and 121 had a fragile long under P2-blind mode.
- **Exit criterion not yet met:** M3 asks for a 7-day replay, and only 3.5 h are recorded so far.

## D10: cover oracle, live (2026-10-23, read-only Koios, 10 min)

Verdict: **FAIL, for missing prerequisites; to re-run.**
- Evidence: `data/dayone/d10-live-20261023T075425Z.json`.
- Subject: holder #0's stake key, `stake1u8gesvq0fy6r6xcpt569yznrjcfdyux7j7ptd46f9qclz5gp23ddv`.

| Check                   | Result                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Single binding enforced | **pass.** A second account on the same stake key was refused both in memory and by the evidence DB's UNIQUE(stake_cred).                 |
| Latency measured        | **pass.** 120 polls; 28 blocks observed; Koios read latency p50 1.1 s, max 2.4 s.                                                        |
| Mempool spend → r = 0   | **untested.** No Ogmios endpoint (`BALLAST_OGMIOS_URL` unset), and holder #0 holds no UTxOs yet, so the matcher had nothing to exercise. |

To re-run:
- once holder #0 holds NIGHT cover (two base addresses on its stake key would also exercise the grouping test);
- and either with an Ogmios source, or by accepting the plan's fallback of per-block Koios polling with the cancel-first path.

## D1: testnet order semantics (2026-10-23, Strike testnet, BTC-USD)

Verdict: **PASS.**
- Evidence: `data/dayone/d1-live-20261023T081422Z.json`.
- Clock: signed at `/v2/time` − 1 s; measured offset 41 ms; 0 auth errors.
- Orders: post-only, sized at 1.05 × the market's `order_min_notional` (testnet BTC-USD is $100, not mainnet's $10).

| Check                     | Result                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Batch create              | **pass.** Both creates came back `pending` with sequence ids, and both reached OPEN on the user stream.                                                               |
| Replace-batch             | **pass.** The cancel and the create applied together: a1 CANCELED, a3 OPEN.                                                                                           |
| Static-rule failure       | **pass.** An off-tick create in a replace-batch: HTTP 200, the create REJECTED, and the cancel in the same batch **not** applied (a2 still resting). Nothing applied. |
| Post-only cross mid-batch | **pass, against observed behaviour.** Far OPEN, crossing REJECTED, near OPEN (lookup 200). The docs say a cross skips the later creates; on testnet it does not.      |
| Unknown symbol            | **pass.** `BTCX-USD` was listed in `successful` with a sequence id, then never appeared on the stream and `GET /v2/order` returned 404: a silent drop, detected.      |
| Cleanup                   | **pass.** `/v2/openOrders` empty afterwards.                                                                                                                          |

What changed because of D1:
- The fake Strike and the replace-batch tests now model the observed cross behaviour: a post-only reject does not stop later creates.
- The engine never relies on the documented skip. Every create in a batch is sized and floored on its own, so either behaviour is safe.

## M4: first operator-signed policy, Critic PASS, keeper in DRY_RUN on mainnet data (2026-10-23)

- **Keys:** a sealed operator key (public `c5908355…a3b90e`) and a sealed daemon key (public `4eccaf39…d3c7cf`), both under the host KEK. Only public halves are ever printed.
- **Policy:** `ballast policy draft` (the plan's section 5 defaults), then `ballast policy sign`.
  - Policy `01M5KYCC77MKFPB3HRD435DT3E`, hash `81edb227…bbb89`.
  - Valid 2026-10-23 08:35 → 2026-10-24 08:35 UTC.
- **Critic** (run by the keeper at start; report `54bab71a…facd`, sim at `8834dd0`, seed 1): **PASS, 11 scenarios, 0 violations.**

| Scenario                                | Fills | Armed h | Max combined drawdown |
| --------------------------------------- | ----- | ------- | --------------------- |
| recorded, 00:49:49–08:36:33 UTC (7.8 h) | 29    | 2.45    | $35.75                |
| recorded (same notional)                | 29    | 2.45    | $35.75                |
| house reaction (fair +60 bps)           | 28    | 0.13    | $36.89                |
| mark drop, one $417 sell                | 67    | 0.33    | $0.89                 |
| +30% rally (1 h)                        | 137   | 0.35    | $17.67                |
| index stall (40 s)                      | 43    | 0.19    | $3.62                 |
| L3 `clear`                              | 41    | 0.20    | $3.44                 |
| Koios 3 blocks behind                   | 0     | 0.00    | $0.00                 |
| holder sells cover mid-quote            | 38    | 0.25    | $4.67                 |
| 429 storm (2 min, 90%)                  | 53    | 0.25    | $4.43                 |
| partial replace-batch reject            | 34    | 0.15    | $2.94                 |
- **Decision 1** in the evidence DB is the daemon-signed `policy` activation, committing to the Critic report's hash.
- **Keeper:** running in DRY_RUN with no accounts, on mainnet public data (L3 and price sockets open, health `ok`). DRY_RUN never sends: a wiring test proves no signer method is called. The plan's 72 h DRY_RUN clock starts once holder #0's account is bound after D4.
- **Anchor tooling:** `ballast anchor` is ready. The preprod anchor of this trail waits on faucet funds for the anchor wallet. The keeper holds the daemon lock, so the anchor runs in a short keeper stop (the plan's daily anchor becomes a keeper job).
