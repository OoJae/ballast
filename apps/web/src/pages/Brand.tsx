import { useEffect, useRef, useState } from "react";
import { Lockup, Mark } from "../components/Logo";
import { contrast } from "../lib/color";
import "./brand.css";

const SWATCHES: { token: string; name: string; role: string }[] = [
  { token: "--bg", name: "Night / Paper", role: "Page" },
  { token: "--bg-deep", name: "Deep / Shallows", role: "Below the waterline" },
  { token: "--ink", name: "Chalk / Ink", role: "Text, the load line" },
  { token: "--ink-3", name: "Fog", role: "Labels and captions" },
  { token: "--lead", name: "Lead", role: "Hull lines under water" },
  { token: "--accent-fill", name: "Oxide", role: "Ballast, cover, the one primary action" },
  { token: "--bid", name: "Sea", role: "Bids" },
];

const ASSETS = [
  ["Lockup on night", "/brand/ballast-lockup-on-night.svg"],
  ["Lockup on paper", "/brand/ballast-lockup-on-paper.svg"],
  ["Lockup, chalk", "/brand/ballast-lockup-mono-chalk.svg"],
  ["Lockup, ink", "/brand/ballast-lockup-mono-ink.svg"],
  ["Mark on night", "/brand/ballast-mark-on-night.svg"],
  ["Mark on paper", "/brand/ballast-mark-on-paper.svg"],
  ["Favicon (follows the OS theme)", "/favicon.svg"],
] as const;

function Palette({ theme }: { theme: "dark" | "light" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const s = getComputedStyle(el);
    const next: Record<string, string> = {};
    for (const { token } of SWATCHES) next[token] = s.getPropertyValue(token).trim();
    next["--on-accent"] = s.getPropertyValue("--on-accent").trim();
    setVals(next);
  }, []);
  const bg = vals["--bg"];
  return (
    <div ref={ref} data-theme={theme} className="br-panel">
      <p className="label">{theme === "dark" ? "Night watch (dark)" : "Chart table (light)"}</p>
      <ul className="br-swatches">
        {SWATCHES.map(({ token, name, role }) => {
          const v = vals[token] ?? "";
          const ratio =
            bg && /^#[0-9a-f]{6}$/i.test(v) && token !== "--bg" ? contrast(v, bg).toFixed(1) : null;
          return (
            <li key={token}>
              <span className="br-chip" style={{ background: `var(${token})` }} />
              <span className="br-sw-name">{name}</span>
              <span className="hash">
                {v}
                {ratio ? ` · ${ratio}:1 on page` : ""}
              </span>
              <span className="muted small">{role}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Brand() {
  return (
    <>
      <header className="page-head">
        <p className="overline">Brand</p>
        <h1 tabIndex={-1}>Load line.</h1>
        <p className="lede">
          Ballast's identity comes from the sea's oldest public measurements: the Plimsoll mark, the
          naval architect's lines plan and the chart's soundings. Every mark below stands for
          something Ballast actually does.
        </p>
      </header>

      <section className="section" aria-labelledby="br-mark">
        <h2 id="br-mark">The mark</h2>
        <div className="br-duo">
          <div data-theme="dark" className="br-stage">
            <Lockup />
          </div>
          <div data-theme="light" className="br-stage">
            <Lockup />
          </div>
        </div>
        <div className="grid grid-2">
          <p>
            The 1876 load line mark: a disc with a line one and a half times its diameter drawn
            through its centre, strokes at a twelfth of the diameter. A ship may load down to the
            line and never past it, which is Ballast's cover rule: short plus resting asks never
            exceed r × the NIGHT in the holder's wallet.
          </p>
          <p>
            Ballast weights the lower half in antifouling oxide, the red ships wear below the
            waterline: weight held low. In the lockup the wordmark (Archivo, width 125, weight 600)
            stands on the bar's lower edge, so only the oxide weight sits below the line. Never
            heel, outline, glow or recolour the mark; only the hull drawing heels.
          </p>
        </div>
        <div className="br-marks">
          <div data-theme="dark" className="br-stage sm">
            <Mark />
          </div>
          <div data-theme="light" className="br-stage sm">
            <Mark />
          </div>
          <div className="br-stage sm favicon">
            <img src="/favicon.svg" alt="The favicon at 32 pixels" width={32} height={32} />
            <img src="/favicon.svg" alt="The favicon at 16 pixels" width={16} height={16} />
          </div>
        </div>
        <ul className="br-assets">
          {ASSETS.map(([label, href]) => (
            <li key={href}>
              <a href={href} download>
                {label}
              </a>{" "}
              <span className="hash">{href}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section" aria-labelledby="br-colour">
        <h2 id="br-colour">Colour</h2>
        <p className="lede">
          A ship's hull is the palette: black topsides, a chalk load line, red antifouling below.
          Oxide is the only accent, and it means weight: the disc, Ballast's own orders and cover,
          the one primary action. Never errors, hovers or decoration. Contrast is checked in tests.
        </p>
        <div className="br-duo">
          <Palette theme="dark" />
          <Palette theme="light" />
        </div>
      </section>

      <section className="section" aria-labelledby="br-type">
        <h2 id="br-type">Type</h2>
        <div className="br-type">
          <div>
            <p className="label">Display · Archivo, width 125, weight 620</p>
            <p className="br-display">Keep your NIGHT. Steady the book.</p>
          </div>
          <div>
            <p className="label">Soundings · Bodoni Moda italic, lining tabular figures</p>
            <p className="sounding br-sounding">$15,568 · 98.8 bps · 14.9°</p>
            <p className="small muted">
              Liquidity numbers only, never below 20 px. Cartographers letter water in italic; so do
              we.
            </p>
          </div>
          <div>
            <p className="label">Text · Archivo, width 100</p>
            <p>
              Plain verbs, sentence case, specific numbers, each with its source. "Replayed", never
              "live", for recordings. Every anchor says which network it is on.
            </p>
          </div>
          <div>
            <p className="label">Labels · Archivo width 125, caps by CSS, +0.12em</p>
            <p className="label" style={{ color: "var(--ink)" }}>
              Asks within 0.5% · Check the evidence
            </p>
          </div>
          <div>
            <p className="label">Data · system monospace</p>
            <p className="hash">d6ca25c455d349b100d3ee72bc0fed235b2e30f05bbf5027e8919547c5f2af18</p>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="br-motion">
        <h2 id="br-motion">Motion and layout</h2>
        <ul className="lp-limits">
          <li>
            One family, water and weight: things rise and settle vertically on cubic-bezier(0.16, 1,
            0.3, 1). Transform and opacity only.
          </li>
          <li>
            Buttons fill to their load line when pressed: the fill rises to 55% of the button in 180
            ms and drains on release.
          </li>
          <li>
            The hull heels from the book's depth imbalance within 0.5%, and only the reader's
            what-if rights it. Under reduced motion nothing moves; final states appear at once.
          </li>
          <li>
            A waterline divides every screen: claims above, evidence below on the deep wash. Square
            corners, hairline rules, no cards, no glow.
          </li>
        </ul>
      </section>
    </>
  );
}
