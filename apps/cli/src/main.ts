/**
 * `ballast <command>`: the public verifier CLI (§7).
 *   verify       re-check an evidence bundle (chain, signatures, policies, anchors, cover)
 *   cover        read-only Proof of Cover for an addr1… or stake1… at the current tip
 *   book-health  "before" Book Health from local recordings (same as `pnpm book-health`)
 *   dayone       D4/D5/D9 day-one checks that need a browser wallet (dry run by default)
 *   keys         sealed keys: Strike API wallet, CIP-20 anchor wallet, operator, daemon
 *   policy       draft and operator-sign a QuotePolicy for the keeper's policy directory
 *   anchor       commit decisions and sealed recorder hours to a CIP-20 anchor
 *   export       write the public evidence bundle that verify reads
 */
const USAGE = `usage: ballast <verify|cover|book-health|dayone|keys|policy|anchor|export> [options]
  ballast verify --bundle <dir> [--from seq] [--to seq] [--account id]
                 [--operator-pubkey hex]... [--daemon-pubkey hex]... [--offline] [--live-cover]
                 [--recordings dir] [--json file|-]
  ballast cover <addr1...|stake1...> [--r-bps 5000] [--short NIGHT] [--json]
  ballast book-health [--root dir] [--from ISO] [--to ISO] [--symbols A,B] [--json file]
  ballast dayone <d4|d5|d9> --address addr1... [--dry-run] [--yes-i-approve] [--check-revoked]
                 (live only with --yes-i-approve AND BALLAST_ARM=1; see docs/dayone.md)
  ballast keys <new-strike|new-anchor|new-operator|new-daemon> --out <file> [--kek <path>]
  ballast policy <draft|sign> ...   (run \`ballast policy\` for options)
  ballast anchor --network <preprod|mainnet> --anchor-key <file> --daemon-key <file> [--submit]
  ballast export --out <dir> --network <preprod|mainnet> [--daemon-key <file>]...
`;

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv[0] === "--" ? argv.slice(1) : argv;

try {
  switch (cmd) {
    case "verify": {
      const { verifyMain } = await import("./verify-cli.js");
      process.exitCode = await verifyMain(rest);
      break;
    }
    case "cover": {
      const { coverMain } = await import("./cover.js");
      process.exitCode = await coverMain(rest);
      break;
    }
    case "keys": {
      const { keysMain } = await import("./keys.js");
      process.exitCode = keysMain(rest);
      break;
    }
    case "policy": {
      const { policyMain } = await import("./policy.js");
      process.exitCode = policyMain(rest);
      break;
    }
    case "anchor": {
      const { anchorMain } = await import("./anchor.js");
      process.exitCode = await anchorMain(rest);
      break;
    }
    case "export": {
      const { exportMain } = await import("./export.js");
      process.exitCode = exportMain(rest);
      break;
    }
    case "dayone": {
      const { dayoneMain } = await import("./dayone/index.js");
      process.exitCode = await dayoneMain(rest);
      break;
    }
    case "book-health":
      // book-health.ts reads process.argv at import time.
      process.argv = [process.argv[0] as string, process.argv[1] as string, ...rest];
      await import("./book-health.js");
      break;
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(USAGE);
      break;
    default:
      process.stderr.write(`unknown command ${cmd}\n${USAGE}`);
      process.exitCode = 2;
  }
} catch (err) {
  process.stderr.write(`ballast ${cmd}: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
}
