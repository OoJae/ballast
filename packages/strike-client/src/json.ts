/**
 * JSON that keeps Strike's int64 order ids exact. Engine ids are JSON numbers (`order_id`, `ID`,
 * the user stream's `i`); past 2^53 `JSON.parse` silently rounds them, and a cancel leg with a
 * rounded id is skipped by the engine without an event.
 */

type Reviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string },
) => unknown;

const INT_RE = /^-?\d+$/;

const keepBigInts: Reviver = (_key, value, context) => {
  if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source) {
    if (INT_RE.test(context.source)) return BigInt(context.source);
  }
  return value;
};

/** Like JSON.parse, but integers outside the safe range come back as bigint (exactly). */
export function parseJsonExact(text: string): unknown {
  return (JSON.parse as (text: string, reviver: Reviver) => unknown)(text, keepBigInts);
}

/**
 * Serialize once, exactly: bigint becomes a bare JSON integer, undefined object members are
 * omitted, and anything JSON cannot represent throws instead of being coerced.
 */
export function stringifyJsonExact(value: unknown): string {
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`cannot serialize ${value}`);
      return JSON.stringify(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) {
        return `[${value
          .map((v) => {
            if (v === undefined) throw new TypeError("cannot serialize undefined array element");
            return stringifyJsonExact(v);
          })
          .join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("only plain objects are serialized");
      }
      const parts: string[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(k)}:${stringifyJsonExact(v)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`cannot serialize ${typeof value}`);
  }
}

/** An engine order id as an exact bigint, from a JSON number, bigint or digit string. */
export function toOrderId(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}
