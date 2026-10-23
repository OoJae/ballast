/**
 * The cover oracle per bound account (plan section 2, step 3): a Proof of Cover per block (Koios
 * is polled faster than the ~20 s block time) and, when a mempool source is wired, an
 * unconfirmed spend of any counted UTxO drops capacity to r = 0 at once (invariant 1).
 *
 * A failed read keeps the last proof; its age then grows past 60 s and the daemon cancels
 * (invariant 8). Nothing here can write to Cardano or to Strike.
 */
import {
  type CoverProof,
  type CoverSubject,
  type MempoolSpendSource,
  spendsAgainstCover,
} from "@ballast/cover";

export interface CoverState {
  proof: CoverProof;
  coverBase: bigint;
  height: number;
  checkedAtMs: number;
  /** An unconfirmed spend of counted cover, until a later block's proof replaces it. */
  mempoolSpend: { txId: string; refs: string[]; seenAtMs: number; height: number } | null;
}

export interface CoverSource {
  view(accountId: string): CoverState | null;
}

export interface CoverWatchOptions {
  oracle: { proof(subject: CoverSubject): Promise<CoverProof> };
  subjects: readonly { accountId: string; stakeAddress: string }[];
  everyMs?: number;
  now?: () => number;
  /** A proof at a new height (or with a changed cover) arrived: record it as evidence. */
  onProof?: (accountId: string, proof: CoverProof) => void;
  onSpend?: (accountId: string, spend: CoverState["mempoolSpend"]) => void;
  onError?: (accountId: string, err: string) => void;
  mempool?: MempoolSpendSource;
}

export class CoverWatch implements CoverSource {
  private readonly states = new Map<string, CoverState>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private busy = false;

  constructor(private readonly opts: CoverWatchOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  view(accountId: string): CoverState | null {
    return this.states.get(accountId) ?? null;
  }

  /** Feed a proof directly (the poller uses this; tests use it to move cover). */
  accept(accountId: string, proof: CoverProof): void {
    const prev = this.states.get(accountId);
    const changed =
      !prev || prev.height !== proof.height || prev.proof.coverBase !== proof.coverBase;
    // A spend stays flagged until a block after the one it was seen at has been proven.
    const spend =
      prev?.mempoolSpend && proof.height <= prev.mempoolSpend.height ? prev.mempoolSpend : null;
    this.states.set(accountId, {
      proof,
      coverBase: BigInt(proof.coverBase),
      height: proof.height,
      checkedAtMs: proof.checkedAtMs,
      mempoolSpend: spend,
    });
    if (changed) this.opts.onProof?.(accountId, proof);
  }

  /** Mark a pending spend against an account's counted UTxOs (capacity → 0 until proven). */
  flagSpend(accountId: string, txId: string, refs: string[]): void {
    const st = this.states.get(accountId);
    if (!st) return;
    st.mempoolSpend = { txId, refs, seenAtMs: this.now(), height: st.height };
    this.opts.onSpend?.(accountId, st.mempoolSpend);
  }

  async pollOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await Promise.all(
        this.opts.subjects.map(async (s) => {
          try {
            const proof = await this.opts.oracle.proof({
              kind: "stake",
              stakeAddress: s.stakeAddress,
            });
            this.accept(s.accountId, proof);
          } catch (err) {
            this.opts.onError?.(s.accountId, err instanceof Error ? err.message : String(err));
          }
        }),
      );
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.opts.everyMs ?? 10_000);
    this.timer.unref();
    if (this.opts.mempool) {
      this.unsubscribe = this.opts.mempool.subscribe((spend) => {
        const proofs = [...this.states.entries()];
        for (const alert of spendsAgainstCover(
          spend,
          proofs.map(([, st]) => st.proof),
        )) {
          const hit = proofs.find(([, st]) => st.proof.subject === alert.subject);
          if (hit) this.flagSpend(hit[0], alert.txId, alert.spentRefs);
        }
      });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
