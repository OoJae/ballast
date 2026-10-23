/**
 * A minimal CBOR (RFC 8949) codec for tests and the fake server only. It is written apart from
 * the Emurgo libraries on purpose: COSE structures and transactions built here are checked by
 * those libraries, so the two implementations cross-check each other.
 */
export type Cbor =
  | { t: "uint"; v: bigint }
  | { t: "nint"; v: bigint }
  | { t: "bytes"; v: Uint8Array }
  | { t: "text"; v: string }
  | { t: "array"; v: Cbor[]; indefinite?: boolean }
  | { t: "map"; v: [Cbor, Cbor][]; indefinite?: boolean }
  | { t: "tag"; tag: bigint; v: Cbor }
  | { t: "simple"; v: boolean | null | undefined };

export const uint = (v: number | bigint): Cbor => ({ t: "uint", v: BigInt(v) });
/** A negative integer: nint(-8) encodes -8. */
export const nint = (v: number | bigint): Cbor => ({ t: "nint", v: BigInt(v) });
export const int = (v: number | bigint): Cbor => (BigInt(v) < 0n ? nint(v) : uint(v));
export const bytes = (v: Uint8Array): Cbor => ({ t: "bytes", v });
export const text = (v: string): Cbor => ({ t: "text", v });
export const array = (v: Cbor[], indefinite = false): Cbor => ({ t: "array", v, indefinite });
export const map = (v: [Cbor, Cbor][], indefinite = false): Cbor => ({ t: "map", v, indefinite });
export const tag = (t: number | bigint, v: Cbor): Cbor => ({ t: "tag", tag: BigInt(t), v });
export const bool = (v: boolean): Cbor => ({ t: "simple", v });
export const nul: Cbor = { t: "simple", v: null };

function head(major: number, n: bigint): number[] {
  const m = major << 5;
  if (n < 24n) return [m | Number(n)];
  if (n < 0x100n) return [m | 24, Number(n)];
  if (n < 0x10000n) return [m | 25, Number(n >> 8n), Number(n & 0xffn)];
  if (n < 0x100000000n) {
    return [m | 26, ...[24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 0xffn))];
  }
  return [m | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 0xffn))];
}

export function encode(c: Cbor): Uint8Array {
  const out: number[] = [];
  const put = (x: Cbor): void => {
    switch (x.t) {
      case "uint":
        out.push(...head(0, x.v));
        return;
      case "nint":
        out.push(...head(1, -x.v - 1n));
        return;
      case "bytes":
        out.push(...head(2, BigInt(x.v.length)), ...x.v);
        return;
      case "text": {
        const b = new TextEncoder().encode(x.v);
        out.push(...head(3, BigInt(b.length)), ...b);
        return;
      }
      case "array":
        if (x.indefinite) out.push(0x9f);
        else out.push(...head(4, BigInt(x.v.length)));
        for (const e of x.v) put(e);
        if (x.indefinite) out.push(0xff);
        return;
      case "map":
        if (x.indefinite) out.push(0xbf);
        else out.push(...head(5, BigInt(x.v.length)));
        for (const [k, v] of x.v) {
          put(k);
          put(v);
        }
        if (x.indefinite) out.push(0xff);
        return;
      case "tag":
        out.push(...head(6, x.tag));
        put(x.v);
        return;
      case "simple":
        out.push(x.v === false ? 0xf4 : x.v === true ? 0xf5 : x.v === null ? 0xf6 : 0xf7);
        return;
    }
  };
  put(c);
  return Uint8Array.from(out);
}

export interface Decoded {
  value: Cbor;
  /** Byte offsets of this item in the input: [start, end). */
  start: number;
  end: number;
  /** Children with their own offsets (array items; map keys and values interleaved). */
  items?: Decoded[];
}

export function decode(input: Uint8Array, at = 0): Decoded {
  const byte = (i: number): number => {
    const b = input[i];
    if (b === undefined) throw new RangeError("truncated CBOR");
    return b;
  };
  const start = at;
  const ib = byte(at);
  const major = ib >> 5;
  const info = ib & 0x1f;
  let pos = at + 1;
  let n = 0n;
  let indefinite = false;
  if (info < 24) n = BigInt(info);
  else if (info >= 24 && info <= 27) {
    const len = 1 << (info - 24);
    for (let i = 0; i < len; i++) n = (n << 8n) | BigInt(byte(pos + i));
    pos += len;
  } else if (info === 31 && (major === 4 || major === 5)) indefinite = true;
  else if (major !== 7) throw new RangeError(`unsupported CBOR additional info ${info}`);

  switch (major) {
    case 0:
      return { value: { t: "uint", v: n }, start, end: pos };
    case 1:
      return { value: { t: "nint", v: -1n - n }, start, end: pos };
    case 2:
    case 3: {
      const len = Number(n);
      if (pos + len > input.length) throw new RangeError("truncated CBOR string");
      const slice = input.slice(pos, pos + len);
      const value: Cbor =
        major === 2 ? { t: "bytes", v: slice } : { t: "text", v: new TextDecoder().decode(slice) };
      return { value, start, end: pos + len };
    }
    case 4:
    case 5: {
      const items: Decoded[] = [];
      const count = major === 4 ? n : 2n * n;
      for (let i = 0n; indefinite || i < count; i++) {
        if (indefinite && byte(pos) === 0xff) {
          pos += 1;
          break;
        }
        const d = decode(input, pos);
        items.push(d);
        pos = d.end;
      }
      if (major === 4) {
        return {
          value: { t: "array", v: items.map((d) => d.value), indefinite },
          start,
          end: pos,
          items,
        };
      }
      const pairs: [Cbor, Cbor][] = [];
      for (let i = 0; i < items.length; i += 2) {
        pairs.push([(items[i] as Decoded).value, (items[i + 1] as Decoded).value]);
      }
      return { value: { t: "map", v: pairs, indefinite }, start, end: pos, items };
    }
    case 6: {
      const inner = decode(input, pos);
      return { value: { t: "tag", tag: n, v: inner.value }, start, end: inner.end, items: [inner] };
    }
    default: {
      const simple: Record<number, boolean | null | undefined> = {
        20: false,
        21: true,
        22: null,
        23: undefined,
      };
      if (!(info in simple)) throw new RangeError(`unsupported CBOR simple value ${info}`);
      return { value: { t: "simple", v: simple[info] }, start, end: pos };
    }
  }
}
