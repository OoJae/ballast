/**
 * `ballast <command>`: the public verifier CLI (§7).
 *   verify       re-check an evidence bundle (chain, signatures, policies, anchors, cover)
 *   cover        read-only Proof of Cover for an addr1… or stake1… at the current tip
 *   book-health  "before" Book Health from local recordings (same as `pnpm book-health`)
 *   dayone       D4/D5/D9 day-one checks that need a browser wallet (dry run by default)
 */
const USAGE = `usage: ballast <verify|cover|book-health|dayone> [options]
  ballast verify --bundle <dir> [--from seq] [--to seq] [--account id]
                 [--operator-pubkey hex]... [--daemon-pubkey hex]... [--offline] [--live-cover]
                 [--recordings dir] [--json file|-]
  ballast cover <addr1...|stake1...> [--r-bps 5000] [--short NIGHT] [--json]
  ballast book-health [--root dir] [--from ISO] [--to ISO] [--symbols A,B] [--json file]
  ballast dayone <d4|d5|d9> --address addr1... [--dry-run] [--yes-i-approve] [--check-revoked]
                 (live only with --yes-i-approve AND BALLAST_ARM=1; see docs/dayone.md)
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
