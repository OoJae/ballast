/**
 * Arming (invariant 3), shared by the keeper and the watchdog. DRY_RUN=true is the default.
 * Live sends to Strike mainnet need all three switches: DRY_RUN=false, BALLAST_ARM=1 and the
 * explicit `--mainnet` flag. Every other combination is half-armed and refused at startup, with
 * the reason naming exactly which switch disagrees:
 *   DRY_RUN=true,  ARM=0, no --mainnet  → dry-run (the default)
 *   DRY_RUN=false, ARM=1, --mainnet     → armed
 *   anything else                       → refuse
 */
export type ArmMode = "dry-run" | "armed";

export interface Arming {
  mode: ArmMode;
  dryRun: boolean;
  armed: boolean;
  /** The operator passed `--mainnet`. */
  mainnetFlag: boolean;
}

export function resolveArming(a: {
  dryRun: boolean;
  armed: boolean;
  mainnetFlag: boolean;
}): Arming {
  if (a.dryRun && !a.armed && !a.mainnetFlag) return { mode: "dry-run", ...a };
  if (!a.dryRun && a.armed && a.mainnetFlag) return { mode: "armed", ...a };
  const missing: string[] = [];
  if (a.dryRun) missing.push("DRY_RUN=false");
  if (!a.armed) missing.push("BALLAST_ARM=1");
  if (!a.mainnetFlag) missing.push("--mainnet");
  const present: string[] = [];
  if (!a.dryRun) present.push("DRY_RUN=false");
  if (a.armed) present.push("BALLAST_ARM=1");
  if (a.mainnetFlag) present.push("--mainnet");
  throw new Error(
    `Refusing to start half-armed: ${present.join(" + ")} without ${missing.join(" + ")}. ` +
      "Mainnet sends need all three (DRY_RUN=false, BALLAST_ARM=1, --mainnet); " +
      "for a dry run set none of them.",
  );
}

/** Only `--mainnet` is recognised; anything else is refused. */
export function parseArmArgs(argv: readonly string[], role: string): { mainnetFlag: boolean } {
  let mainnetFlag = false;
  for (const a of argv) {
    if (a === "--mainnet") mainnetFlag = true;
    else if (a === "--") continue;
    else throw new Error(`unknown argument ${a}; the ${role} takes only --mainnet`);
  }
  return { mainnetFlag };
}

/** https/wss on Strike's own domain: armed processes talk to nothing else. */
export function isStrikeHost(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === "https:" || u.protocol === "wss:") &&
      (u.hostname === "strikefinance.org" || u.hostname.endsWith(".strikefinance.org"))
    );
  } catch {
    return false;
  }
}

/**
 * HOSTING RULE (CLAUDE.md): a process that loads a Strike key signs Strike requests (writes,
 * signed reads and the user-stream logon), so it may run only from a jurisdiction that is not on
 * strikefinance.org/restricted. BALLAST_ELIGIBLE_HOST=1 is the operator's attestation; it is
 * never inferred, and a VPN or proxy must never be used to get around the list.
 */
export function assertEligibleHost(
  loadsStrikeKeys: boolean,
  attested: boolean,
  role: string,
): void {
  if (loadsStrikeKeys && !attested) {
    throw new Error(
      `Refusing to start the ${role}: loading Strike keys means signing Strike requests, which ` +
        "only a host outside Strike's restricted jurisdictions may do (strikefinance.org/" +
        "restricted). Set BALLAST_ELIGIBLE_HOST=1 only after confirming this host's " +
        "jurisdiction; never use a VPN or proxy to get around the list.",
    );
  }
}
