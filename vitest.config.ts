import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    // Property suites are CPU-bound; under parallel runs the 5 s default fails on load alone.
    testTimeout: 30_000,
    // better-sqlite3 (evidence db, M4) is a native addon; forks are the known-good pool for it.
    pool: "forks",
  },
});
