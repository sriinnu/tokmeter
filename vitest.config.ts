import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    globals: true,
    // Hermeticity guard — snapshots ~/.tokmeter, ~/.cache/tokmeter, and
    // ~/.kosha; fails the suite if any test writes to them. Catches the
    // class of bug where tests silently corrupt the user's state.
    setupFiles: ["./test/setup-hermeticity.ts"],
  },
});
