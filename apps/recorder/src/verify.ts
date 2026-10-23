import { verifyRecordings } from "@ballast/evidence";

const dir = process.argv[2] ?? process.env.RECORDER_DATA_DIR ?? "data/recordings";
const report = await verifyRecordings(dir);
console.log(JSON.stringify(report, null, 2));
console.log(
  report.ok
    ? `PASS: ${report.segments.checked} segments (${report.segments.compressed} gzip), ${report.roots.checked} hourly roots, ${report.unsealed.length} open`
    : `FAIL: ${report.segments.failed.length} segment and ${report.roots.failed.length} root failures`,
);
process.exit(report.ok ? 0 : 1);
