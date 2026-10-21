// Copy the private core/cli/tui builds into this published package. A Node
// script rather than `rm -rf && cp -r ../core/dist/* …`: Bun runs package
// scripts in its own shell on Windows, where that glob copy fails.
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
for (const pkg of ["core", "cli", "tui"]) {
  cpSync(join(here, "..", pkg, "dist"), join(dist, pkg), { recursive: true });
}
