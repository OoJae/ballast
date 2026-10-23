/**
 * Colour arithmetic for the design tokens: WCAG 2 contrast, and OKLab distance with simulated
 * colour-vision deficiency. Pure, so the token tests and the /brand page share one definition.
 */

export type CvdMode = "normal" | "protan" | "deutan" | "tritan";
type Vec3 = readonly [number, number, number];

export function parseHex(hex: string): Vec3 {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new TypeError(`not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(m[1] as string, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(toLinear) as unknown as Vec3;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** Machado, Oliveira and Fernandes (2009) matrices at severity 1.0, applied in linear sRGB. */
const CVD: Record<Exclude<CvdMode, "normal">, readonly Vec3[]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

function oklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function simulate(hex: string, mode: CvdMode): Vec3 {
  const rgb = parseHex(hex).map(toLinear) as unknown as Vec3;
  if (mode === "normal") return rgb;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return CVD[mode].map((row) => clamp(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])) as [
    number,
    number,
    number,
  ];
}

/** OKLab Euclidean distance × 100 as seen under `mode`. About 2 is just noticeable. */
export function deltaE(a: string, b: string, mode: CvdMode = "normal"): number {
  const p = oklab(simulate(a, mode));
  const q = oklab(simulate(b, mode));
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

export const CVD_MODES: readonly CvdMode[] = ["normal", "protan", "deutan", "tritan"];
