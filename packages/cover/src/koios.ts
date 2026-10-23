import { z } from "zod";
import { KOIOS_MAINNET_URL, USER_AGENT } from "./config.js";

/**
 * Read-only Koios client (https://api.koios.rest, OpenAPI v1.4.2, checked 2026-10-23).
 * - Only the endpoints below can be called; there is no path to /submittx or anything else.
 *   POST is used only because Koios takes these queries as POST bodies (PostgREST RPC).
 * - Pages of 1000 rows are followed with offset/limit until a short page.
 * - Request bodies are split to stay under the public tier's 1 KB body limit.
 * - Every query is retried on transport errors, timeouts, 429 and 5xx (they are reads, so a
 *   retry cannot duplicate anything); other 4xx fail at once.
 * Responses are validated, tolerating unknown fields.
 */
export const KOIOS_READ_ENDPOINTS = {
  tip: "GET",
  account_utxos: "POST",
  address_utxos: "POST",
  utxo_info: "POST",
  asset_addresses: "GET",
  tx_metadata: "POST",
} as const;
export type KoiosEndpoint = keyof typeof KOIOS_READ_ENDPOINTS;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const digits = z.string().regex(/^\d+$/);

const TipSchema = z
  .array(
    z.object({
      hash: hex64,
      epoch_no: z.number().int(),
      abs_slot: z.number().int(),
      block_height: z.number().int().positive(),
      block_time: z.number().int(),
    }),
  )
  .min(1);
export type KoiosTip = z.infer<typeof TipSchema>[number];

const AssetSchema = z.object({
  policy_id: z.string(),
  asset_name: z.string().nullable(),
  decimals: z.number().int().nullable().optional(),
  quantity: digits,
});

const UtxoSchema = z.object({
  tx_hash: hex64,
  tx_index: z.number().int().nonnegative(),
  address: z.string(),
  value: digits,
  stake_address: z.string().nullable().optional(),
  payment_cred: z.string().nullable().optional(),
  block_height: z.number().int().nullable().optional(),
  block_time: z.number().int().nullable().optional(),
  datum_hash: z.string().nullable().optional(),
  inline_datum: z.unknown().optional(),
  reference_script: z.unknown().optional(),
  asset_list: z.array(AssetSchema).nullable().optional(),
  is_spent: z.boolean().nullable().optional(),
});
export type KoiosUtxo = z.infer<typeof UtxoSchema>;
const UtxoListSchema = z.array(UtxoSchema);

const AssetAddressSchema = z.array(
  z.object({
    payment_address: z.string(),
    stake_address: z.string().nullable().optional(),
    quantity: digits,
  }),
);
export type KoiosAssetHolder = z.infer<typeof AssetAddressSchema>[number];

const TxMetadataSchema = z
  .array(z.object({ tx_hash: hex64, metadata: z.record(z.string(), z.unknown()).nullable() }))
  .nullable();
export type KoiosTxMetadata = { tx_hash: string; metadata: Record<string, unknown> | null };

export class KoiosError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number | null,
    message: string,
  ) {
    super(`koios ${endpoint}: ${message}`);
    this.name = "KoiosError";
  }
}

export interface KoiosClientOptions {
  baseUrl?: string;
  token?: string;
  userAgent?: string;
  timeoutMs?: number;
  retries?: number;
  pageSize?: number;
  maxPages?: number;
  maxBodyBytes?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The narrow read interface the oracle and verifier depend on (fakes implement it in tests). */
export interface KoiosReader {
  tip(): Promise<KoiosTip>;
  accountUtxos(stakeAddresses: readonly string[]): Promise<KoiosUtxo[]>;
  addressUtxos(addresses: readonly string[]): Promise<KoiosUtxo[]>;
  utxoInfo(refs: readonly string[]): Promise<KoiosUtxo[]>;
  txMetadata(txHashes: readonly string[]): Promise<KoiosTxMetadata[]>;
}

export class KoiosClient implements KoiosReader {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: KoiosClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? KOIOS_MAINNET_URL).replace(/\/+$/, "");
    if (!this.baseUrl.startsWith("https://")) throw new Error("Koios base URL must be https");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async tip(): Promise<KoiosTip> {
    const rows = await this.query("tip", {}, TipSchema);
    return rows[0] as KoiosTip;
  }

  accountUtxos(stakeAddresses: readonly string[]): Promise<KoiosUtxo[]> {
    return this.batched("account_utxos", "_stake_addresses", stakeAddresses);
  }

  addressUtxos(addresses: readonly string[]): Promise<KoiosUtxo[]> {
    return this.batched("address_utxos", "_addresses", addresses);
  }

  utxoInfo(refs: readonly string[]): Promise<KoiosUtxo[]> {
    return this.batched("utxo_info", "_utxo_refs", refs);
  }

  async txMetadata(txHashes: readonly string[]): Promise<KoiosTxMetadata[]> {
    const out: KoiosTxMetadata[] = [];
    for (const chunk of this.chunks("_tx_hashes", txHashes, {})) {
      const rows = await this.query(
        "tx_metadata",
        { body: { _tx_hashes: chunk } },
        TxMetadataSchema,
      );
      for (const r of rows ?? []) out.push({ tx_hash: r.tx_hash, metadata: r.metadata });
    }
    return out;
  }

  /** One page of holders of an asset (used for live validation, not by the oracle). */
  assetAddresses(
    policyId: string,
    assetNameHex: string,
    page: { limit?: number; offset?: number; filter?: Record<string, string> } = {},
  ): Promise<KoiosAssetHolder[]> {
    return this.query(
      "asset_addresses",
      {
        query: {
          _asset_policy: policyId,
          _asset_name: assetNameHex,
          limit: String(page.limit ?? 100),
          offset: String(page.offset ?? 0),
          ...page.filter,
        },
      },
      AssetAddressSchema,
    );
  }

  private chunks(
    key: string,
    items: readonly string[],
    extra: Record<string, unknown>,
  ): string[][] {
    const max = this.opts.maxBodyBytes ?? 1000;
    const out: string[][] = [];
    let cur: string[] = [];
    for (const item of items) {
      const next = [...cur, item];
      if (cur.length > 0 && JSON.stringify({ [key]: next, ...extra }).length > max) {
        out.push(cur);
        cur = [item];
      } else {
        cur = next;
      }
    }
    if (cur.length > 0) out.push(cur);
    return out;
  }

  private async batched(
    endpoint: KoiosEndpoint,
    key: string,
    items: readonly string[],
  ): Promise<KoiosUtxo[]> {
    const out: KoiosUtxo[] = [];
    for (const chunk of this.chunks(key, items, { _extended: true })) {
      out.push(...(await this.paged(endpoint, { [key]: chunk, _extended: true })));
    }
    return out;
  }

  private async paged(
    endpoint: KoiosEndpoint,
    body: Record<string, unknown>,
  ): Promise<KoiosUtxo[]> {
    const limit = this.opts.pageSize ?? 1000;
    const maxPages = this.opts.maxPages ?? 200;
    const out: KoiosUtxo[] = [];
    for (let page = 0; page < maxPages; page++) {
      const rows = await this.query(
        endpoint,
        { body, query: { offset: String(page * limit), limit: String(limit) } },
        UtxoListSchema,
      );
      out.push(...rows);
      if (rows.length < limit) return out;
    }
    throw new KoiosError(endpoint, null, `more than ${maxPages} pages; refusing a partial result`);
  }

  private async query<T>(
    endpoint: KoiosEndpoint,
    req: { query?: Record<string, string>; body?: unknown },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const method = KOIOS_READ_ENDPOINTS[endpoint];
    if (!method) throw new KoiosError(endpoint, null, "not a read-only endpoint");
    const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
    const url = `${this.baseUrl}/${endpoint}${qs}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.opts.userAgent ?? USER_AGENT,
    };
    if (method === "POST") headers["content-type"] = "application/json";
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    const retries = this.opts.retries ?? 3;
    let lastError = "no attempt made";
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(500 * 2 ** (attempt - 1), 8_000));
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          ...(method === "POST" ? { body: JSON.stringify(req.body ?? {}) } : {}),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        });
      } catch (err) {
        lastError = `transport: ${err instanceof Error ? err.name : String(err)}`;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        const after = Number(res.headers.get("retry-after"));
        if (Number.isFinite(after) && after > 0 && after <= 60) await this.sleep(after * 1000);
        continue;
      }
      if (!res.ok) throw new KoiosError(endpoint, res.status, `HTTP ${res.status}`);
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        lastError = "invalid JSON";
        continue;
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new KoiosError(
          endpoint,
          res.status,
          `unexpected response shape at ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? ""}`,
        );
      }
      return parsed.data;
    }
    throw new KoiosError(endpoint, null, `gave up after ${retries + 1} attempts (${lastError})`);
  }
}
