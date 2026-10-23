# Day-one runbook: D4, D5 and D9 with a browser wallet

These three checks settle the Cardano onboarding write paths (plan §11) on mainnet, with a
team wallet and small amounts. They need a person with Lace (then Eternl) at a browser, so the
work is split:
- **you** do every wallet step on `/join` and `/me`;
- **`pnpm dayone d4|d5|d9`** watches public reads (Strike's account check, Koios) and the
  holder role's evidence DB, times each step and writes a private JSON record.

Nothing here arms the keeper or places an order. Every funding step is signed by your wallet.

## Before you start

1. **Go-ahead.** These are mainnet, real-money actions. Get the explicit go-ahead for the plan
   below first (CLAUDE.md, working habits).
2. **Where you run it.** With `HOLDER_ROUTES=1` the API signs Strike requests, so it must run on
   your own machine in a jurisdiction that is not on
   [Strike's restricted list](https://www.strikefinance.org/restricted), never on a read-only
   host (Sonar-VPS2, Railway). No VPN or proxy.
3. **Builder code.** D0 must be done: the code `ballast` is registered and active in the Strike
   app. Otherwise Builder Connect answers `404 builder code not found`.
4. **Wallets.** In Lace, add a **fresh account** that has never been used on Strike. Send it
   about 30 ADA: 10 for the deposit, about 2 plus fees for the withdrawal's funding transaction,
   the rest for fees. For the USDM run of D5, also send it a few USDM. Do the same later with a
   fresh Eternl account. Use a Shelley (`addr1…`) base address.
5. **Amounts at risk.** At most the deposit (10 ADA, then a few USDM), the $1 withdrawal fee and
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
