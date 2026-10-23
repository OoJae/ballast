import { useEffect, useState, useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "ballast-theme";
const EVENT = "ballast-theme";
const query = () => window.matchMedia("(prefers-color-scheme: light)");

function readChoice(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function resolvedTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  if (t === "light" || t === "dark") return t;
  return query().matches ? "light" : "dark";
}

function subscribe(fn: () => void): () => void {
  const mq = query();
  mq.addEventListener("change", fn);
  window.addEventListener(EVENT, fn);
  return () => {
    mq.removeEventListener("change", fn);
    window.removeEventListener(EVENT, fn);
  };
}

/** The theme actually on screen; charts re-read their colors when it changes. */
export function useResolvedTheme(): Theme {
  return useSyncExternalStore(subscribe, resolvedTheme, () => "dark");
}

export function useThemeChoice(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);
  useEffect(() => {
    const root = document.documentElement;
    if (choice === "system") delete root.dataset.theme;
    else root.dataset.theme = choice;
    try {
      if (choice === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      // Storage may be unavailable (private mode); the choice still applies for this visit.
    }
    window.dispatchEvent(new Event(EVENT));
  }, [choice]);
  return [choice, setChoice];
}

/** Current values of the design tokens charts draw with. */
export function chartTokens() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    surface: v("--surface"),
    line: v("--line"),
    lineStrong: v("--line-strong"),
    ink: v("--ink"),
    ink2: v("--ink-2"),
    ink3: v("--ink-3"),
    bid: v("--bid"),
    ask: v("--ask"),
    ballast: v("--ballast"),
    cf: v("--cf"),
    brass: v("--brass"),
  };
}
export type ChartTokens = ReturnType<typeof chartTokens>;
