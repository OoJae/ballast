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
