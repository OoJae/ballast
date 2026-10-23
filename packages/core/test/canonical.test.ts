import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../src/index.js";

describe("canonicalize (RFC 8785)", () => {
  it("sorts keys recursively and drops whitespace", () => {
    expect(canonicalize({ b: 1, a: { d: [3, { z: 0, y: 1 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":1,"z":0}]},"b":1}',
    );
  });

  it("serializes numbers the ECMAScript way", () => {
    expect(canonicalize([0, -0, 1e21, 1.5, -2])).toBe("[0,0,1e+21,1.5,-2]");
  });

  it("sorts by UTF-16 code units, not locale", () => {
    expect(canonicalize({ é: 1, z: 2, A: 3 })).toBe('{"A":3,"z":2,"é":1}');
  });

  it("omits undefined object members like JSON.stringify", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(10n)).toThrow(TypeError);
    expect(() => canonicalize([undefined])).toThrow(TypeError);
  });

  it("is invariant to key insertion order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalize(reversed)).toBe(canonicalize(obj));
      }),
    );
  });

  it("round-trips through JSON.parse", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(canonicalize(JSON.parse(canonicalize(v)))).toBe(canonicalize(v));
      }),
    );
  });
});

describe("sha256Hex", () => {
  it("matches the FIPS 180-2 'abc' vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
