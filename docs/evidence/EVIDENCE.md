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
