import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"],
    globals: true,
    // Fresh temp HOME, frozen kosha catalog and no network per test file: a
    // test run must never write the real ~/.kosha or ~/.cache/tokmeter.
    globalSetup: ["./scripts/test/vitest-global-setup.ts"],
    setupFiles: ["./scripts/test/vitest-setup.ts"],
  },
});
