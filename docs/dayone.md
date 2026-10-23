# Day-one runbook: D0 to D10

These three checks settle the Cardano onboarding write paths (plan §11) on mainnet, with a
team wallet and small amounts. They need a person with Lace (then Eternl) at a browser, so the
work is split:
- **you** do every wallet step on `/join` and `/me`;
- **`pnpm dayone d4|d5|d9`** watches public reads (Strike's account check, Koios) and the
  holder role's evidence DB, times each step and writes a private JSON record.

Nothing here arms the keeper or places an order. Every funding step is signed by your wallet.

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

## Before you start

1. **Go-ahead.** These are mainnet, real-money actions. Get the explicit go-ahead for the plan
   below first (CLAUDE.md, working habits).
2. **Where you run it.** With `HOLDER_ROUTES=1` the API signs Strike requests, so it must run on
   your own machine in a jurisdiction that is not on
   [Strike's restricted list](https://www.strikefinance.org/restricted), never on a read-only
   host (Sonar-VPS2, Railway). No VPN or proxy.
3. **Builder code.** D0 is done: the code was registered on 2026-10-23 as `ballast`, with a 10 bps
   cap, and shows Active. The Strike app displays it as "Ballast", which may only be styling.
   `HOLDER_BUILDER_CODE` defaults to `ballast`. If Builder Connect answers
   `404 builder code not found`, re-run with `HOLDER_BUILDER_CODE=Ballast`. The challenge request
   fails before anything is signed, so the retry costs nothing. Record which spelling Strike accepts.
4. **Wallets.** D4/D5 run with **holder #0**. Its Strike account exists but is empty and dedicated,
   so it qualifies; the 404 → 200 flip is shown later by an outside holder's fresh wallet.
   - Strike's minimum deposit is **$5**. At ADA ≈ $0.22 (2026-10-23), 10 ADA would be refused.
   - Deposit **50 ADA** for D5 (≈ $11), plus the margin the later tests need (see the morning
     checklist).
   - Keep about 25 ADA in the wallet for fees and the withdrawal's ~2 ADA funding transaction.
   - Use a Shelley (`addr1…`) base address.
   - The Eternl run of D4 is optional and can use the D3 probe wallet.
5. **Amounts at risk.** At most the deposit (50 ADA, then a few USDM), the $1 withdrawal fee and
   network fees.

## Setup (once)

```sh
pnpm install
mkdir -p ~/.ballast && chmod 700 ~/.ballast

# Terminal 1: the API with the holder role (a signing role)
HOLDER_ROUTES=1 BALLAST_ARM=1 \
HOLDER_KEK_PATH=~/.ballast/host.kek \
HOLDER_KEY_DIR=~/.ballast/holder-keys \
HOLDER_DB_PATH=data/evidence.sqlite \
pnpm api:dev

# Terminal 2: the web app
pnpm web:dev            # then open http://localhost:5173/join
```

- The first start creates the host KEK (`0600`). Back it up offline; without it the sealed API
  keys cannot be opened.
- The API refuses to start the holder role against Strike mainnet without `BALLAST_ARM=1`.
- `HOLDER_FUNDING_MODE=strike-app` turns in-app funding off (the D5/D9 fallback).

Read each plan before running it live: without flags every script is a dry run that prints its
steps and the exact requests it would make.

```sh
pnpm dayone d4 --address addr1…        # dry run: prints the plan, sends nothing
```

## How many wallet prompts to expect

| Flow              | `signData` | `signTx` | Why                                                                                      |
| ----------------- | ---------- | -------- | ---------------------------------------------------------------------------------------- |
| Sign in           | 1          | –        | Sign-In-With-Cardano: proves you hold the address                                        |
| Connect to Strike | 1          | –        | Strike's Builder Connect message, shown verbatim on `/join`                              |
| Deposit           | 3          | 1        | proofs for quote, build and confirm (each ≤ 60 s old), plus the deposit tx               |
| Withdraw          | 4          | 1        | proofs for estimate, quote and confirm, Strike's withdrawal message, plus the funding tx |
| Consent           | 1          | –        | r, max short and your statements; its hash is stored                                     |

A holder proof is a short "Ballast holder proof" message naming your account and the exact
request. It expires after 60 seconds and works once.

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

## D4: Builder Connect (Lace, then Eternl)

**Proves:** one CIP-30 `signData` creates (or approves) your Strike master account; Strike's
public account check flips **404 → 200**; the API key Strike registered is the one Ballast
generated (only its public half left the machine); reconnecting revokes the old key.
1. Terminal 3:
   `BALLAST_ARM=1 pnpm dayone d4 --address addr1… --yes-i-approve --check-revoked`
   It reads `GET /v2/account?blockchain_address=…` once (expect **404**) and starts polling.
2. On `/join`: tick the restricted-jurisdiction statement, then the risk disclosure (with its
   zero-funding line). **Connect Lace**, approve the connection, sign the sign-in message.
   `/join` records your statement and shows Strike's account check (404 for a fresh account;
   a used account is refused as not dedicated).
3. Step 4, **Connect to Strike**: read Strike's message on screen (builder `ballast`, fee cap 10
   bps, your wallet, the API key, a nonce), then sign it in Lace. `/join` shows
   **404 → 200** and the account id. The script prints `after: 200`.
4. **Reconnect:** reload `/join`, sign in again and run Connect to Strike once more. The script
   then makes one signed `GET /v2/account` with the first key and expects
   **401 `wallet expired or revoked`** (or `authentication failed`).
5. In the Strike app, revoke Ballast's API wallet. Note what Strike shows.
6. Repeat 1–4 with a fresh **Eternl** account and its own address.

**Evidence:** the JSON under `data/dayone/` (private: it names the wallet and account),
screenshots of Lace's prompt, `/join`'s 404 → 200 line and the Strike app's revoke screen, and
one EVIDENCE.md line per wallet (date, wallet, flip time, revoke result; no address).

**If it fails:** if Strike refuses the `coseSign1Hex:coseKeyHex` form, retry with the JSON
`{signature, key}` form and note it in FRICTION.md. Support only the wallets that pass.

## D5: in-app deposit (ADA, then USDM)

**Proves:** Strike accepts deposit quote, build-tx and confirm from the Builder Connect API
wallet (this answers FRICTION's open question for deposits); the wallet's partial witness
merges into Strike's unsigned transaction without changing its hash; the wallet submits it;
Strike credits the account. Measures time-to-credit and the conversion cost.
1. Terminal 3: `BALLAST_ARM=1 pnpm dayone d5 --address addr1… --yes-i-approve`
2. On `/join` step 5 (or resume `/join`; it skips what is done): **ADA**, amount `10`,
   **Get a quote**. Lace asks for two proof signatures.
3. Check the transaction review: it pays Strike's address (an exchanger address for ADA) and
   returns change to your wallet. Then **Sign and submit**: Lace signs the transaction (it shows
   the same outputs), submits it, and one more proof confirms the deposit.
4. Follow the cexplorer link until the transaction confirms. The script waits for Strike's
   balance to rise and prints `PASS` with the time-to-credit and conversion cost
   (`index × amount − usd_value`).
5. Run the script again and repeat with **USDM**.

**Evidence:** the JSON record, the cexplorer link, the quote's `usd_value`, and an EVIDENCE.md
line (asset, amount, time-to-credit, conversion cost).

**If it fails:**
- `/join` says _"Strike refused API-wallet funding"_: deposit in Strike's own app with the same
  wallet, record the exact error in FRICTION.md and set `HOLDER_FUNDING_MODE=strike-app`. This
  is the getting-started reading ("deposit funds requires JWT").
- The merge or submit fails: keep the unsigned transaction, submit it by hand and confirm with
  the pasted hash (the reference app's flow). Recommend USDM.

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

## D9: user-signed withdrawal

**Proves:** Strike accepts withdraw estimate, quote and confirm from the API wallet when your
wallet signs `message_to_sign` (already hex: signed as-is) and the small funding transaction;
the payout lands at the same wallet. Records the asset received, the $1 fee and the end-to-end
time.
1. Make sure Strike shows no open position (nothing quotes in M5).
2. Terminal 3: `BALLAST_ARM=1 pnpm dayone d9 --address addr1… --yes-i-approve`
3. On `/me`: **Withdraw**, **ADA**, amount at least `$5` (for example `$8`), **Get a
   withdrawal quote** (two proof signatures). Read Strike's message, which names your wallet,
   the amount and the $1 fee.
4. **Sign**: Lace signs the message, then the ~2 ADA funding transaction, then one proof
   confirms. Strike submits the funding transaction itself.
5. The script waits for the balance to drop and for a new UTxO at your wallet that is not the
   funding transaction's change, then prints `PASS`.

**Evidence:** the JSON record, the payout transaction on cexplorer, and an EVIDENCE.md line
(asset received, fee, end-to-end time).

**If it fails:** withdraw with USDM (`direct_cardano_usdm`), or in Strike's app. Record the
error in FRICTION.md.

## Afterwards

- On `/me`, press **Stop** (the account is paused; nothing arms for it). If you are done with
  the wallet, follow the revocation guide there: Stop, Close, Withdraw, then revoke.
- Move the evidence lines into `docs/evidence/EVIDENCE.md` (no addresses or account ids), and
  any surprises into FRICTION.md with the date.
- Answer FRICTION's open question ("API wallets cannot deposit" vs masterOnly funding routes)
  with what D5 and D9 showed.

## Troubleshooting

| Message                                      | Meaning                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `builder code not found`                     | D0 is not done, or the code is not active yet                                    |
| `that signing request is unknown or expired` | the 5-minute challenge lapsed: start the step again                              |
| `holder proof is older than 60 s`            | the proof was signed too long before it reached Strike, or your clock is off     |
| `holder proof was already used`              | a proof works once: the page signs a new one per request                         |
| `this Strike account is not dedicated`       | the wallet's Strike account has balances or settings: use a fresh wallet account |
| `insufficient wallet funds`                  | the withdrawal's funding transaction needs about 2 ADA plus fees in the wallet   |
| `withdrawal below minimum`                   | Strike's minimum is $5                                                           |
| `Strike refused API-wallet funding`          | the getting-started reading holds: fund in Strike's app                          |
