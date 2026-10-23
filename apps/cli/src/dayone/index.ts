/**
 * `ballast dayone <d4|d5|d9> --address addr1… [--yes-i-approve]`: the wallet-dependent
 * day-one checks. Dry run by default; live only with --yes-i-approve AND BALLAST_ARM=1.
 * The morning runbook is docs/dayone.md.
 */
export async function dayoneMain(argv: readonly string[]): Promise<number> {
  const [id, ...rest] = argv;
  switch (id?.toLowerCase()) {
    case "d4":
      return (await import("./d4-builder-connect.js")).d4Main(rest);
    case "d5":
      return (await import("./d5-deposit.js")).d5Main(rest);
    case "d9":
      return (await import("./d9-withdraw.js")).d9Main(rest);
    default:
      process.stderr.write("usage: ballast dayone <d4|d5|d9> --address addr1… [--yes-i-approve]\n");
      return 2;
  }
}
