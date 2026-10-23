/**
 * The Plimsoll mark: a ship's load line, here with its lower half weighted. A hull loaded to
 * the line, never past it, is the picture of the cover invariant. Decorative: the brand link
 * around it carries the name.
 */
export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M5.5 16a10.5 10.5 0 0 0 21 0z" fill="var(--ballast)" />
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="currentColor" strokeWidth="2.25" />
      <rect x="1.5" y="14.9" width="29" height="2.2" rx="1.1" fill="currentColor" />
    </svg>
  );
}
