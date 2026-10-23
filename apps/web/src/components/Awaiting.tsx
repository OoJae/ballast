import type { ReactNode } from "react";
import { CircleIcon } from "./Icons";

/** An honest empty state: what will appear here, and what it waits for. */
export function Awaiting({
  tag = "Awaiting first armed run",
  title,
  children,
}: {
  tag?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="awaiting">
      <span className="placeholder-tag">
        <span className="dot wait" aria-hidden="true" />
        {tag}
      </span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Checklist({ items }: { items: { title: string; body: ReactNode }[] }) {
  return (
    <ul className="checklist">
      {items.map((i) => (
        <li key={i.title}>
          <CircleIcon />
          <span>
            <b>{i.title}.</b> {i.body}
          </span>
        </li>
      ))}
    </ul>
  );
}
