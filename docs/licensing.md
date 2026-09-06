# Licenses and source

Copyright (c) 2026 Srinivas Pendela and contributors.

Tokmeter's applications (CLI, TUI, web dashboard, daemon/MCP server, and macOS app) are licensed under **AGPL-3.0-only**. The core library's source under `packages/core` is licensed under **MPL-2.0**. Bundling the core in the application does not remove its MPL source license. Other dependencies retain their own licenses and copyright notices.

## Included materials

The npm distributions include `dist/licenses/`. The macOS app includes `Contents/Resources/Licenses/`, accessible using **Licenses & source** in the popup footer. Each contains:

- `AGPL-3.0-only.txt` — the application license.
- `MPL-2.0.txt` — the core source license, including when the core is bundled in `@sriinnu/tokmeter`.
- `tokmeter-source.tar.gz` — local source and build inputs collected when this artifact was packaged. The application and core source retain the licenses described above.
- In the macOS app, `Sparkle.txt` — the complete notices supplied with the bundled Sparkle artifact, including its embedded third-party components.

JavaScript dependencies are installed separately by the package manager; their notices reside in their respective installed packages. The source snapshot includes the dependency manifests and lockfile. Build tools and platform SDKs are obtained separately.

Extract the source archive, install Bun and Node.js, and run `bun install --frozen-lockfile` followed by `bun run build` from its root. For the native app, install Xcode on macOS and run `swift build -c release --package-path packages/macos-bar`. Use `bash packages/macos-bar/bundle.sh --no-install` for a local ad-hoc bundle. Apple distribution credentials are not needed for a local build and are never included.

Upstream source: https://github.com/sriinnu/tokmeter. Public releases should point to the matching source tag; a local candidate may contain changes not yet published there. Rebuild artifacts after source changes so the enclosed source matches the binaries.

## Release checks

Run `bash scripts/prepare-packages.sh` after the workspace build. Both npm packages also prepare these materials in their `prepack` hook. The macOS bundle script adds them before signing. Verify the source archive and license files in the final artifacts, not only in the repository.

These instructions preserve the project's existing license choices. They are not a contributor-ownership audit or a claim that every dependency version has received legal review. The relevant license texts govern; see the [GNU AGPL](https://www.gnu.org/licenses/agpl-3.0.html.en) and [Mozilla's MPL guidance](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).
