import { verifyRecordings } from "@ballast/evidence";
import { ledgerKey, readLedger } from "./ledger.js";
import type { RootsResponse, VerifyWire } from "./types.js";

/**
 * The hourly Merkle roots and the result of an independent re-check of the recordings
 * (`verifyRecordings`: every sealed segment re-hashed, every root and chain link recomputed).
 * Re-verified whenever a new hour is rooted, and at most every `minIntervalMs` otherwise.
 */
export class RecordingsEvidence {
  status: VerifyWire | null = null;
  private verifiedKey: string | null = null;
  private running: Promise<VerifyWire | null> | null = null;

  constructor(
    private readonly root: string,
    private readonly opts: { now?: () => number; onError?: (err: unknown) => void } = {},
  ) {}

  roots(): RootsResponse {
    const { manifest, roots } = readLedger(this.root);
    const bySegment = new Map(manifest.map((m) => [m.segment, m]));
    return {
      hours: roots.map((r) => ({
        hour: r.hour,
        root: r.root,
        prev: r.prev,
        chain: r.chain,
        leaves: r.leaves,
        segments: r.segments.map((seg, i) => {
          const m = bySegment.get(seg);
          return {
            segment: seg,
            stream: m?.stream ?? seg.split("/").at(-1)?.split(".")[0] ?? "",
            sha256: m?.sha256 ?? r.leaves[i] ?? "",
            lines: m?.lines ?? 0,
            bytes: m?.bytes ?? 0,
          };
        }),
        sealedMs: r.sealedMs,
      })),
      verify: this.status,
    };
  }

  /** Re-verifies if the ledger changed since the last check. Concurrent calls share one run. */
  refresh(): Promise<VerifyWire | null> {
    if (this.running) return this.running;
    const ledger = readLedger(this.root);
    const key = `${ledgerKey(ledger)}|${ledger.manifest.length}`;
    if (this.status && key === this.verifiedKey) return Promise.resolve(this.status);
    this.running = verifyRecordings(this.root)
      .then((r) => {
        this.status = {
          ok: r.ok,
          checkedAt: (this.opts.now ?? Date.now)(),
          segmentsChecked: r.segments.checked,
          compressed: r.segments.compressed,
          rootsChecked: r.roots.checked,
          failures: [
            ...r.segments.failed.map((f) => ({
              kind: "segment" as const,
              id: f.segment,
              reason: f.reason,
            })),
            ...r.roots.failed.map((f) => ({ kind: "root" as const, id: f.hour, reason: f.reason })),
          ],
          unsealed: r.unsealed.length,
        };
        this.verifiedKey = key;
        return this.status;
      })
      .catch((err: unknown) => {
        this.opts.onError?.(err);
        return this.status;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
