/**
 * Seeded PRNG (mulberry32) for the simulator's stochastic choices: synthetic taker timing and
 * sizes, which requests a 429 storm hits. 32-bit integer state, so a seed fixes every draw on
 * every platform. Never used for money: draws pick sizes in whole steps.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new TypeError("seed must be a safe integer");
    this.state = seed >>> 0;
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    if (hi < lo) throw new RangeError("int: hi < lo");
    return lo + (this.nextU32() % (hi - lo + 1));
  }

  /** True with probability num/den. */
  chance(num: number, den: number): boolean {
    return this.nextU32() % den < num;
  }
}
