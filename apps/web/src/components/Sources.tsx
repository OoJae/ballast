import type { ReactNode } from "react";

/**
 * Every number on screen carries a footnote marker that names its source: the title shows on
 * hover, and the link jumps to the page's numbered source list.
 */
export interface SourceDef {
  id: string;
  text: ReactNode;
  /** Plain-text version for the hover title. */
  title: string;
}

export function Fn({ source, n }: { source: SourceDef; n: number }) {
  return (
    <a
      className="fn"
      href={`#src-${source.id}`}
      title={source.title}
      aria-label={`Source ${n}: ${source.title}`}
    >
      [{n}]
    </a>
  );
}

export function SourceList({ sources }: { sources: SourceDef[] }) {
  return (
    <section className="sources" aria-labelledby="sources-title">
      <h2 id="sources-title" className="overline">
        Sources
      </h2>
      <ol>
        {sources.map((s) => (
          <li key={s.id} id={`src-${s.id}`}>
            {s.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Numbered footnotes for one page: `fn("spread")` renders the marker for that source. */
export function footnotes(sources: SourceDef[]) {
  const index = new Map(sources.map((s, i) => [s.id, i + 1]));
  return (id: string) => {
    const s = sources.find((x) => x.id === id);
    const n = index.get(id);
    return s && n ? <Fn source={s} n={n} /> : null;
  };
}
