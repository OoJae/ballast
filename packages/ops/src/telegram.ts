/**
 * Telegram alerts (ported from Ripcord's notifier/telegram.ts) with Ballast's event kinds.
 *
 * SAFETY PROPERTIES
 * - Never throws into a control loop: a network failure (throw or non-2xx) is logged and the
 *   promise resolves.
 * - Never leaks a secret: the bot token and every configured secret are scrubbed from the message
 *   text and from every log line, in their raw, hex and base64 forms.
 * - Unconfigured → a no-op that logs the would-send text at debug level and never calls fetch.
 * - HTML parse mode; every caller-supplied string is HTML-escaped.
 */
import { scrubSecrets } from "@ballast/governance";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export type AlertKind =
  | "startup"
  | "shutdown"
  | "kill"
  | "kill-confirmed"
  | "kill-escalated"
  | "guard-blocked"
  | "cover"
  | "supervision"
  | "policy"
  | "renewal"
  | "fill"
  | "heartbeat-lost"
  | "watchdog-fire"
  | "error";

export type AlertSeverity = "info" | "warn" | "page";

export interface Alert {
  kind: AlertKind;
  source: "keeper" | "watchdog";
  severity: AlertSeverity;
  title: string;
  detail?: string;
  accountId?: string;
  symbol?: string;
  dryRun?: boolean;
}

export interface Notifier {
  notify(alert: Alert): Promise<void>;
}

export type OpsLogFn = (obj: unknown, msg?: string) => void;

export interface OpsLogger {
  debug: OpsLogFn;
  info: OpsLogFn;
  warn: OpsLogFn;
}

/** Escape the characters Telegram's HTML parse mode cares about. Ampersand first. */
export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const SEVERITY_TAG: Record<AlertSeverity, string> = { info: "INFO", warn: "WARN", page: "PAGE" };

export function renderAlert(a: Alert): string {
  const lines = [
    `BALLAST ${a.source} [${SEVERITY_TAG[a.severity]}] ${a.kind}: ${escapeHtml(a.title)}`,
  ];
  if (a.detail !== undefined) lines.push(escapeHtml(a.detail));
  const where = [a.symbol, a.accountId ? `account ${a.accountId}` : undefined].filter(Boolean);
  if (where.length > 0) lines.push(escapeHtml(where.join(" · ")));
  if (a.dryRun) lines.push("DRY_RUN: nothing was sent to Strike");
  return lines.join("\n");
}

export interface TelegramOptions {
  botToken?: string;
  chatId?: string;
  logger: OpsLogger;
  /** Anything else that must never appear in a message or a log line (API keys, URLs with keys). */
  secrets?: readonly (string | Uint8Array)[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A notifier that can never throw and never blocks a caller for longer than `timeoutMs`. */
export function createTelegramNotifier(opts: TelegramOptions): Notifier {
  const secrets = [...(opts.secrets ?? []), ...(opts.botToken ? [opts.botToken] : [])];
  const scrub = (s: string) => scrubSecrets(s, secrets);
  if (!opts.botToken || !opts.chatId) {
    return {
      async notify(a) {
        opts.logger.debug(
          { kind: a.kind, text: scrub(renderAlert(a)) },
          "telegram off: would send",
        );
      },
    };
  }
  const url = `${TELEGRAM_API_BASE}/bot${opts.botToken}/sendMessage`;
  const doFetch = opts.fetch ?? fetch;
  const chatId = opts.chatId;
  return {
    async notify(a) {
      const text = scrub(renderAlert(a));
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          opts.logger.warn(
            { kind: a.kind, status: res.status, body: scrub(body).slice(0, 300) },
            "telegram sendMessage failed (non-2xx); continuing",
          );
        }
      } catch (err) {
        opts.logger.warn(
          { kind: a.kind, error: scrub(err instanceof Error ? err.message : String(err)) },
          "telegram sendMessage threw; continuing",
        );
      }
    },
  };
}

/** Wraps any notifier so that a throw, a rejection or a hang can never reach the caller. */
export function safeNotifier(inner: Notifier, logger: OpsLogger, timeoutMs = 5_000): Notifier {
  return {
    notify(a) {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          logger.warn({ kind: a.kind }, "notifier timed out; continuing");
          resolve();
        }, timeoutMs);
        timer.unref?.();
        let p: Promise<void>;
        try {
          p = inner.notify(a);
        } catch (err) {
          clearTimeout(timer);
          logger.warn({ kind: a.kind, error: String(err) }, "notifier threw; continuing");
          resolve();
          return;
        }
        p.then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (err: unknown) => {
            clearTimeout(timer);
            logger.warn({ kind: a.kind, error: String(err) }, "notifier rejected; continuing");
            resolve();
          },
        );
      });
    },
  };
}
