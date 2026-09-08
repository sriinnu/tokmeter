import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

/** Include the installed license texts for dependencies in the app's web bundle. */
export function appNoticesPlugin(): Plugin {
  return {
    name: "tokmeter-app-notices",
    apply: "build",
    generateBundle(_options, bundle) {
      if (process.env.TOKMETER_APP_BUILD !== "1") return;
      const packages = new Map<string, string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules)) {
          if (id.startsWith("\0") || !id.includes("/node_modules/")) continue;
          let directory = dirname(id.split("?")[0]);
          while (directory !== dirname(directory)) {
            const manifestPath = join(directory, "package.json");
            if (existsSync(manifestPath)) {
              const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
              if (manifest.name) {
                if (!packages.has(directory)) {
                  const notices = readdirSync(directory)
                    .filter((name) => /^(licen[sc]e|copying|notice)(\..*)?$/i.test(name))
                    .sort()
                    .map((name) => readFileSync(join(directory, name), "utf8"));
                  if (!notices.length)
                    throw new Error(`Missing bundled license text: ${manifest.name}`);
                  packages.set(
                    directory,
                    `${manifest.name}@${manifest.version}\n${notices.join("\n\n")}`
                  );
                }
                break;
              }
            }
            directory = dirname(directory);
          }
        }
      }
      if (!packages.size) throw new Error("No web dependency notices were collected");
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.txt",
        source: `Third-party notices for the bundled web dashboard.\n\n${[...packages.values()]
          .sort()
          .join("\n\n------------------------------------------------------------\n\n")}`,
      });
    },
  };
}
