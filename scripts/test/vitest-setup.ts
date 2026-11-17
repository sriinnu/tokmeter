/**
 * Every test file runs against a fresh, empty HOME, a frozen kosha catalog,
 * and no network.
 *
 * Without this, `bun run test` on a workstation wrote the real
 * ~/.cache/tokmeter/scan-cache.json and ran a live kosha refresh into the
 * real ~/.kosha (registry.json, its .bak, provider caches). That is the
 * user's pricing data: a test run must never touch it, and a test's prices
 * must not depend on the day it ran or on what is listening on this machine.
 *
 * - HOME / USERPROFILE: a temp dir per test file, inside a per-run root that
 *   vitest-global-setup.ts removes at the end (afterAll never runs for a file
 *   holding only todo tests). os.homedir() reads HOME on every call, and this
 *   file runs before the test file's imports, so module-level paths resolve
 *   into it too. A test that stubs HOME itself (vi.stubEnv) still works.
 * - Agent and XDG overrides (CODEX_HOME, CLAUDE_CONFIG_DIR, XDG_*) are
 *   cleared, so nothing resolves back to the real ones.
 * - KOSHA_CATALOG_SOURCE=local: kosha reads its catalog only from the
 *   committed fixture, not models.dev or LiteLLM.
 * - Local mode still runs kosha's provider discoverers, and some fetch:
 *   keyless public listings (openrouter.ai, ai-gateway.vercel.sh) and local
 *   servers (Ollama :11434, LM Studio :1234, llama.cpp :8080, vLLM :8000).
 *   Those are disabled in the temp ~/.kosharc.json. As a backstop, fetch
 *   rejects every URL at once (kosha's own timeout is 10s, vitest's 5s), so
 *   a discoverer a kosha bump adds fails fast and offline. A test that
 *   needs fetch stubs it (vi.stubGlobal) and gets its own.
 *
 * TOKMETER_TEST_REAL_HOME=1 opts out, for debugging against real data.
 * TOKMETER_TEST_FETCH_LOG=<file> appends each refused URL, for audits.
 */
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.TOKMETER_TEST_REAL_HOME !== "1") {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = process.env.TOKMETER_TEST_HOME_ROOT || tmpdir();
  const home = mkdtempSync(join(root, "tokmeter-test-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const name of [
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
  ]) {
    delete process.env[name];
  }
  process.env.KOSHA_CATALOG_SOURCE = "local";
  process.env.KOSHA_CATALOG_FILE = join(here, "fixtures", "kosha-catalog.json");
  // The discoverers that still fetch in local mode, switched off the way a
  // user would; the fetch guard below catches anything a kosha bump adds.
  const off = ["openrouter", "vercel", "ollama", "lmstudio", "llama.cpp", "vllm"];
  writeFileSync(
    join(home, ".kosharc.json"),
    JSON.stringify({ providers: Object.fromEntries(off.map((id) => [id, { enabled: false }])) })
  );

  const log = process.env.TOKMETER_TEST_FETCH_LOG;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (log) appendFileSync(log, `${url}\n`);
    throw new TypeError(`tests have no network: fetch(${url}) refused by vitest-setup.ts`);
  }) as typeof fetch;
}
