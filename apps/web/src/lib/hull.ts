/**
 * A naval architect's body plan, generated: the hull's cross-sections ("stations") drawn nested,
 * forward stations on the right half and aft stations on the left, with waterlines, the centreline
 * and the sheer. Deterministic, so the hero drawing, the poster and the OG image all match.
 *
 * Units: the design waterline (DWL) is y = 0, depth is +y (down), height is -y (up), and the
 * centreline is x = 0. Half-beam 100, draft 70, freeboard 46.
 */

export interface Polyline {
  kind: "station" | "waterline" | "centreline" | "sheer" | "keel";
  /** Above the DWL (topsides) or below it (the underwater body). */
  zone: "above" | "below" | "both";
  points: [number, number][];
}

export const HALF_BEAM = 100;
export const DRAFT = 70;
export const FREEBOARD = 46;

/** Station fullness: 1 at midships, smaller toward the ends. */
const FORWARD = [1, 0.86, 0.68, 0.48, 0.28, 0.12];
const AFT = [1, 0.9, 0.76, 0.6, 0.42, 0.26];

function section(c: number, side: 1 | -1, samples: number): Polyline[] {
  const beam = HALF_BEAM * c ** 0.55;
  const draft = DRAFT * (0.55 + 0.45 * c ** 0.6);
  const p = 1.6 + 3.2 * c; // fuller sections are boxier
  const below: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const u = i / samples; // 0 at the DWL, 1 at the keel
    const half = beam * (1 - u ** p) ** (1 / p);
    below.push([side * half, draft * u]);
  }
  below.reverse(); // keel up to the waterline
  const flare = (1 - c) * 18;
  const above: [number, number][] = [];
  const steps = Math.max(4, Math.round(samples / 3));
  for (let i = 0; i <= steps; i++) {
    const h = i / steps;
    above.push([side * (beam + flare * h * h), -FREEBOARD * (1 - 0.18 * (1 - c)) * h]);
  }
  return [
    { kind: "station", zone: "below", points: below },
    { kind: "station", zone: "above", points: above },
  ];
}

export function bodyPlan(samples = 28): Polyline[] {
  const lines: Polyline[] = [];
  for (const c of FORWARD) lines.push(...section(c, 1, samples));
  for (const c of AFT) lines.push(...section(c, -1, samples));
  // Waterlines as drawn on the plan (the DWL itself is the bold one, drawn by the caller).
  for (const y of [-30, -15, 14, 28, 42, 56]) {
    const w = y < 0 ? HALF_BEAM + 6 : HALF_BEAM * (1 - (y / DRAFT) ** 3.2) ** (1 / 3.2);
    lines.push({
      kind: "waterline",
      zone: y < 0 ? "above" : "below",
      points: [
        [-w, y],
        [w, y],
      ],
    });
  }
  lines.push({
    kind: "centreline",
    zone: "both",
    points: [
      [0, DRAFT + 6],
      [0, -FREEBOARD - 14],
    ],
  });
  return lines;
}

/** SVG path data for one polyline, with coordinates rounded to 0.1. */
export function toPath(points: readonly [number, number][]): string {
  const r = (v: number) => Math.round(v * 10) / 10;
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${r(x)} ${r(y)}`).join("");
}
