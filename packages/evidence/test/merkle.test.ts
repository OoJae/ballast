import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { merkleRootHex } from "../src/index.js";

const leaf = (i: number) => createHash("sha256").update(`seg-${i}`).digest("hex");
const leaves = (n: number) => Array.from({ length: n }, (_, i) => leaf(i));

// Vectors computed by an independent Python implementation of RFC 6962 §2.1.
const VECTORS: Record<number, string> = {
  0: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  1: "54d0cb9a1e57e780888faeae4e90305982a0c00cdac051abed95f84e7f0203aa",
  2: "efb17146da4f90280961c5a479da898dba49e5b07f5ccce0c114de7a08c292d1",
  3: "e6751b6b1098071fea401004971f0d0c5282169d766ffeadf25bebc8f1d96fac",
  5: "ec7c1b46f354ed1a0b428d4bbe5adc0d2ae07e48055eacdbee63919d4ade66e7",
  7: "83b2f02705a1b2a08cbb376f545c0d6018e7b837137255489fde033f1d6c38ce",
};

describe("merkleRootHex (RFC 6962)", () => {
  for (const [n, root] of Object.entries(VECTORS)) {
    it(`matches the independent vector for ${n} leaves`, () => {
      expect(merkleRootHex(leaves(Number(n)))).toBe(root);
    });
  }

  it("changes when any single leaf changes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.nat(), (n, at) => {
        const base = leaves(n);
        const tampered = [...base];
        tampered[at % n] = createHash("sha256").update("tampered").digest("hex");
        expect(merkleRootHex(tampered)).not.toBe(merkleRootHex(base));
      }),
    );
  });

  it("is order-sensitive", () => {
    const base = leaves(4);
    expect(merkleRootHex([...base].reverse())).not.toBe(merkleRootHex(base));
  });
});
