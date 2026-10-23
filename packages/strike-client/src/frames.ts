/**
 * Strike's price socket packs several JSON messages into one text frame, separated by "\n"
 * (strike-price-feeds). The L3 socket sends one per frame. Splitting is harmless for both.
 */
export function parseFrame(
  data: string,
  parse: (text: string) => unknown = JSON.parse,
): { messages: unknown[]; errors: string[] } {
  const messages: unknown[] = [];
  const errors: string[] = [];
  for (const line of data.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      messages.push(parse(text));
    } catch {
      errors.push(text.slice(0, 500));
    }
  }
  return { messages, errors };
}
