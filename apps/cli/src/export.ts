import { exportBundle } from "@ballast/evidence/bundle";
import { openEvidenceDb } from "@ballast/evidence/db";
import { readSealedKey } from "@ballast/governance";

const USAGE = `usage: ballast export --out <dir> --network <preprod|mainnet> [--db data/ballast.sqlite]
                      [--daemon-key <sealed file>]... [--operator-pubkey <hex>]...
  Writes the public evidence bundle (policies, Critic reports, renewals, decisions, anchors, cover
  proofs, Guard trips) for \`ballast verify --bundle\`. The trust block carries public keys only:
  a sealed key file's public half is read without unsealing it.`;

export function exportMain(args: readonly string[], env = process.env, now = Date.now): number {
  const values = (name: string) =>
    args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1] as string] : []));
  const out = values("--out")[0];
  const network = values("--network")[0];
  if (!out || (network !== "preprod" && network !== "mainnet")) {
    console.error(USAGE);
    return 2;
  }
  const daemonPubkeys = values("--daemon-key").map((f) => {
    const sealed = readSealedKey(f);
    if (sealed.role !== "daemon") throw new Error(`${f} is a ${sealed.role} key, not a daemon key`);
    return sealed.publicKeyHex;
  });
  const operatorPubkeys = values("--operator-pubkey");
  for (const k of [...daemonPubkeys, ...operatorPubkeys]) {
    if (!/^[0-9a-f]{64}$/.test(k)) throw new Error(`not a 64-hex public key: ${k}`);
  }
  const db = openEvidenceDb(values("--db")[0] ?? env.BALLAST_DB_PATH ?? "data/ballast.sqlite");
  try {
    const m = exportBundle(db, out, {
      network,
      trust: { operatorPubkeys, daemonPubkeys },
      createdMs: now(),
    });
    const range = m.decisions
      ? `decisions ${m.decisions.firstSeq}-${m.decisions.lastSeq}`
      : "no decisions";
    console.log(
      `bundle written to ${out} (${range}; ${m.files.map((f) => `${f.part} ${f.records}`).join(", ")})`,
    );
    return 0;
  } finally {
    db.close();
  }
}
