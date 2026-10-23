import { existsSync } from "node:fs";
import { CoverOracle, KoiosClient, loadCoverConfig } from "@ballast/cover";
import { openEvidenceDb } from "@ballast/evidence/db";
import { HostKek } from "@ballast/governance";
import type { HolderConfig } from "./config.js";
import { HolderKeyStore } from "./keystore.js";
import { createHolderHandler } from "./routes.js";
import { HolderService } from "./service.js";

export { type HolderConfig, loadHolderConfig } from "./config.js";

interface Log {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Builds the holder role from its config: the host KEK, the evidence DB (accounts, consents,
 * funding rows), the sealed-key store, the cover oracle and the HOLDER_PRESENT service.
 * main.ts imports this module only when HOLDER_ROUTES=1.
 */
export function createHolderRole(cfg: HolderConfig, log: Log) {
  const created = !existsSync(cfg.kekPath);
  const kek = created ? HostKek.create(cfg.kekPath) : HostKek.load(cfg.kekPath);
  if (created) log.warn({ path: cfg.kekPath }, "created a new host KEK (0600); back it up offline");
  const db = openEvidenceDb(cfg.dbPath);
  const coverCfg = loadCoverConfig();
  const cover =
    cfg.cover === "koios"
      ? new CoverOracle(
          new KoiosClient({
            baseUrl: coverCfg.koiosUrl,
            ...(coverCfg.koiosToken ? { token: coverCfg.koiosToken } : {}),
          }),
        )
      : undefined;
  const service = new HolderService({
    strikeUrl: cfg.strikeUrl,
    userAgent: cfg.userAgent,
    builderCode: cfg.builderCode,
    feeShareBps: cfg.feeShareBps,
    fundingMode: cfg.fundingMode,
    network: cfg.network,
    domain: cfg.domain,
    db,
    keys: new HolderKeyStore(cfg.keyDir, kek),
    ...(cover ? { cover } : {}),
    onEvent: (event, fields) => log.info({ event, ...fields }, "holder"),
  });
  return { handler: createHolderHandler(service), service, close: () => db.close() };
}
