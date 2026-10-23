import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from "react";

/** A five-route site does not need a router library: history API plus one hook. */
const EVENT = "ballast-navigate";

function subscribe(fn: () => void): () => void {
  window.addEventListener("popstate", fn);
  window.addEventListener(EVENT, fn);
  return () => {
    window.removeEventListener("popstate", fn);
    window.removeEventListener(EVENT, fn);
  };
}

export function usePath(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => "/",
  );
}

export function navigate(to: string): void {
  const url = new URL(to, window.location.href);
  window.history.pushState(null, "", url);
  window.dispatchEvent(new Event(EVENT));
  if (url.hash) {
    requestAnimationFrame(() => document.getElementById(url.hash.slice(1))?.scrollIntoView());
  } else {
    window.scrollTo(0, 0);
  }
}

export function Link({
  to,
  onClick,
  ...rest
}: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const path = usePath();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(to);
  };
  const current = to.split("#")[0] === path && !to.includes("#");
  return <a href={to} onClick={handle} aria-current={current ? "page" : undefined} {...rest} />;
}
