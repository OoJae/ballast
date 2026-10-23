## Morning order: D0 to D10

Every check below is a mainnet or testnet write path that the plan (section 11) marks
unverified. Run them in this order; each one either passes or adopts its fallback before the
next starts. D4, D5 and D9 are covered in their own sections.

| #   | Check                                                     | Runs on                    | Why here                                                                                        |
| --- | --------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | D0: builder code `ballast` shows Active in the Strike app | Strike app                 | Its approval latency is unknown, so it goes first (done 2026-10-23; confirm it is still Active) |
| 2   | D1: testnet write semantics                               | testnet                    | No money. Proves the replace-batch and silent-drop rules the keeper is built on                 |
| 3   | D10: cover oracle                                         | Cardano mainnet, read-only | No money. Proves the cover input before any account quotes against it                           |
| 4   | D4: Builder Connect                                       | mainnet                    | Creates holder #0's account and API key, which every later check needs                          |
| 5   | D5: in-app deposit                                        | mainnet                    | Funds holder #0's margin                                                                        |
| 6   | D2: builder attribution                                   | mainnet                    | The first resting ask; proves the `X-Builder-Fee-Bps` header survives                           |
| 7   | D8: sockets and rate                                      | mainnet                    | Calibrates socket and order budgets before the 100-trial drill                                  |
| 8   | D7: kill latency                                          | mainnet                    | 100 cancel-alls; publishes the kill p50/p99 the watchdog relies on                              |
| 9   | D3: builder fee on a maker fill                           | mainnet + human probe      | Needs the probe master (another family) ready                                                   |
| 10  | D6: mark probe                                            | mainnet + human probe      | Needs ≥ 24 h of recordings (the recorder has run since 2026-10-23 00:49 UTC)                    |
| 11  | D9: exit and withdrawal                                   | mainnet                    | Last: it closes the short and takes the money out                                               |

**Rules for every live run (CLAUDE.md, working habits)**
- **Go-ahead first.** Run the script with no flags. That is a dry run: it prints the exact plan
  and the pass condition and writes `data/dayone/<id>-dry-run-<time>.json`. Show that plan to the
  human who approves it. Run `--live` only after an explicit go-ahead.
- **Live flags.** A live run needs `--live --yes-i-approve --eligible-host`, plus `BALLAST_ARM=1`
  for anything touching mainnet (everything except D1). Missing any of them refuses the run before
  anything is read or sent.
- **Where to run.** `--eligible-host` is your attestation that this machine is not in a
  jurisdiction on [Strike's restricted list](https://www.strikefinance.org/restricted). Use your
  own machine or the EU keeper host. Never Sonar-VPS2 or Railway, and never through a VPN or proxy.
- **Keeper stopped.** Stop the keeper and the watchdog for the account under test. The probes use
  `bal_d<N>_…` ids, which the keeper would otherwise treat as its own resting asks.
- **Keys.** `--key` is a sealed key file under the host KEK (`BALLAST_KEK_PATH`, default
  `data/keys/host.kek`). Keys are never printed.
- **Evidence.** Each live run writes `data/dayone/<id>-live-<time>.json`. Copy the pass/fail
  line, the p50/p99 figures and any trade ids into `docs/evidence/EVIDENCE.md`. Label every probe
  trade id as a probe; probes are excluded from KPIs.
- **Exit codes.** 0 is pass (or a dry run), 1 is a live FAIL, 2 is a refusal or an error.

## D1: testnet write semantics

```
pnpm exec tsx apps/cli/src/dayone/d1-testnet-semantics.ts
pnpm exec tsx apps/cli/src/dayone/d1-testnet-semantics.ts --live --yes-i-approve --eligible-host \
  --account <testnet account id> --key data/keys/testnet.strike.json [--symbol BTC-USD]
```

- **Host.** `api-v2-testnet.strikefinance.org` only. Testnet trades BTC, ETH and SOL.
- **What it does.** It signs every request at `/v2/time` − 1 s and rests two post-only asks
  through `/v2/orders/batch`. It then runs a replace-batch (cancel one, create one) and three
  injected faults:
  - (a) a replace-batch whose create is off the tick grid;
  - (b) a replace-batch ordered far ask, crossing ask, near ask;
  - (c) a batch item on the unknown symbol `BTCX-USD`.

  Finally it cancels everything and confirms `/v2/openOrders` is empty.
- **Pass.** (a) Nothing applied and no cancels: the first ask is still OPEN and the off-tick
  create is REJECTED. (b) Earlier creates rest; later ones are skipped with no event: far OPEN,
  crossing REJECTED, near with no event and `GET /v2/order` 404. (c) No event within 2 s, and
  `GET /v2/order` returns 404.
- **What it proves.** The keeper's far-to-near ordering, its "unknown counts as resting" rule and
  its silent-drop detector rest on these semantics. D1 is the M1 exit gate.
- **Fallback.** If testnet collateral can't be obtained (no faucet is documented), run the same
  tests on mainnet BTC-USD with $10 post-only orders 4% from mid, as a separately approved run.
  If semantics differ, send cancel and batch as two commands, and count both old and new orders as
  resting until their events arrive.

## D10: cover oracle (Cardano mainnet, read-only)

```
pnpm exec tsx apps/cli/src/dayone/d10-cover-oracle.ts
BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d10-cover-oracle.ts --live --yes-i-approve \
  --eligible-host --stake stake1… [--addresses addr1…,addr1…] [--minutes 10]
```

- **What it does.** It reads Koios `account_utxos` for the stake address: pinned NIGHT only (the
  registry policy and asset `4e49474854`). It polls the tip and the cover every 5 s for 10 minutes
  and records block arrivals and read latency. It checks that both the in-memory binding and the
  evidence DB's `UNIQUE(stake_cred)` refuse a second account on the same stake key, and it groups
  base addresses that share a stake key.
- **Pass.** A single binding is enforced, latency is measured, and a mempool event sets r = 0.
- **Mempool.** Ogmios is still a stub (VERIFY). Without `BALLAST_OGMIOS_URL` the script runs the
  spend matcher on the live proof (a spend of a counted UTxO must alert r = 0) and records the
  live mempool test as skipped. The mempool part passes for real only once an Ogmios endpoint is
  provisioned.
- **What it proves.** The cover the keeper and the watchdog compute is the cover on chain, at the
  block, and fresh enough for the 60 s rule.
- **Fallback.** Use Blockfrost as a second provider, poll every 10 s, and widen the cancel-first
  path.

## D2: builder attribution on a resting ask

```
pnpm exec tsx apps/cli/src/dayone/d2-builder-attribution.ts
BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d2-builder-attribution.ts --live --yes-i-approve \
  --eligible-host --account <holder #0 id> --key data/keys/holder0.strike.json
```

- **What it does.** It rests one post-only ask of about $10.5 at ceil(mark × 1.04) through
  replace-batch, and one at ceil(mark × 1.041) through orders/batch. Both carry
  `X-Builder-Fee-Bps: 10`. It reads each back with the public
  `GET /v2/order?account_id&client_order_id` and with the signed read, then cancels both.
- **Pass.** The public `GET /v2/order?account_id&client_order_id` shows
  `Builder{Code:"ballast",FeeBps:10}`.
- **What it proves.** Attribution survives both quoting routes. Ballast never uses
  `/v2/order/replace`, which drops it.
- **Fallback.** Test single vs batch routes, report to Strike, and run with fee 0 (attribution
  remains).

## D8: sockets per IP and rate accounting

```
pnpm exec tsx apps/cli/src/dayone/d8-socket-and-rate-limits.ts
BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d8-socket-and-rate-limits.ts --live --yes-i-approve \
  --eligible-host --account <holder #0 id> --key data/keys/holder0.strike.json
```

- **What it does.** It opens rounds of 5, 10, 20 and 40 `/ws/user-api` logons with one key, and
  stops at the first round with a refusal (that is the cap). It then sends up to 20 replace-batches
  of one cancel plus one far ask, spaced 2.1 s apart (at most 60 ops/min, a twentieth of the
  advertised budget), and records every status and any rate-limit headers. It stops at the first
  429, then cancels all.
- **Pass.** The socket cap is found and the budgets are calibrated. It deliberately never tries
  to exceed the budget.
- **What it proves.** Whether the keeper and the watchdog can each hold a user stream for the same
  key (the watchdog falls back to REST resyncs if not). It also shows how replace-batch operations
  count toward 1,200 orders/min; the keeper counts every operation until this says otherwise.
- **Fallback.** Shard keepers by IP, or poll public reads (`openOrders`,
  `history/fill?since_trade_id`) every 2 s.

## D7: kill latency

```
pnpm exec tsx apps/cli/src/dayone/d7-kill-latency.ts
BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d7-kill-latency.ts --live --yes-i-approve \
  --eligible-host --account <holder #0 id> --key data/keys/holder0.strike.json \
  [--trials 100] [--concurrent-every 4]
```

- **Host.** Run it from the EU keeper host (host A), where the keeper will run.
- **What it does.** Each trial rests one post-only ask of about $10.5 at ceil(mark × 1.04), waits
  for OPEN and for the ask on L3, then sends `DELETE /v2/order/cancel-all {symbol: NIGHT-USD}`.
  It times CANCELED on the stream and removal on L3. Every 4th trial also fires the same cancel-all
  from a CANCEL_ONLY client with the same key, as the watchdog would.
- **Pass.** p50 and p99 are published, with no nonce or 429 interference.
- **What it proves.** The kill path's real latency (plan target ≤ 2 s, unverified) and that the
  watchdog's concurrent cancels do not collide with the keeper's.
- **Fallback.** Raise the offset and requote thresholds; ask Strike for DMA.

## D3: builder fee on a maker fill

```
pnpm exec tsx apps/cli/src/dayone/d3-builder-fee-on-maker.ts
BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d3-builder-fee-on-maker.ts --live --yes-i-approve \
  --eligible-host --account <holder #0 id> --key data/keys/holder0.strike.json \
  [--builder-account <id> --builder-key <file>] [--wait-min 10]
```

- **Before you start.** A second person, or you in another browser, is logged in to the Strike
  app as the probe master. It must be a separate master family, because self-trade prevention
  expires makers inside one family. Fund it with about $15.
- **What it does.** It computes the liquidation-aware floor F from live positions and rests one
  post-only ask of about $10.5 at max(F, ceil(mark), best bid + 1 tick), with a 10 bps builder fee.
  It then prints a line: `HUMAN PROBE: … buy <size> NIGHT-USD at <price>, limit IOC, now.`
  Do exactly that from the probe master. The script records the maker fill's `builder_fee`, and
  the builder account's balance before and after when its key is given.
- **Pass.** `builder_fee` is non-zero on the maker's ORDER_TRADE_UPDATE, and the builder account
  balance increases.
- **Why the human.** Ballast's signer can never send that taker buy. Every Ballast buy is a
  reduce-only exit (invariants 4 and 6).
- **Fallback.** Builder fees apply to exits only, or they are dropped before any revenue claim.

## D6: mark probe

```
pnpm exec tsx apps/cli/src/dayone/d6-mark-probe.ts --recordings data/recordings
BALLAST_ARM=1 pnpm exec tsx apps/cli/src/dayone/d6-mark-probe.ts --live --yes-i-approve \
  --eligible-host --account <holder #0 id> --key data/keys/holder0.strike.json \
  --recordings data/recordings [--hours 24] [--warmup-s 120]
```

- **Before you start.** The recorder needs at least 24 h of NIGHT-USD, the earliest being about
  2026-10-24 01:00 UTC. The probe master is ready, as for D3.
- **What it does.** It fits the mark replica on the last 24 h of recordings. That is read-only, so
  the dry run does it too when you pass `--recordings`. The fit gives the best hypothesis, the
  held-out p50/p99 and P2's mid on P2 ticks. Live, it warms a replica on `/ws/l3` and
  `markprice@1s` for 2 minutes, then rests a $10.5 ask at max(F, ceil(mark), best bid + 1 tick).
  It predicts the next mark after that ask is lifted, prints the human-probe line, and compares
  the first published mark after the fill with the prediction.
- **Pass.** Replica error < 0.5 bps, the post-fill mark matches the prediction, and P2's mid
  definition is known.
- **What it proves.** The floor's guarantee rests on the mark model. Until D6 passes, the keeper
  stays in P2-blind mode (≤ $300 of asks, L1 ≥ max(F, mark), and it stands down while any long is
  fragile).
- **Fallback.** Stay in P2-blind mode (Section 5), widen b_liq to cover p99, and ask Shan for the
  formula.
