# Release workflow

Release the npm packages and macOS app from the same reviewed, merged source. Use this manual workflow: `scripts/release.sh` is a legacy convenience script that creates an intermediate tag and permits admin merge before CI; it does not implement this sequence. `bar:ship` only builds and uploads the app.

## Prepare the branch

1. Run `bash scripts/bump-version.sh X.Y.Z` once. It updates package versions, the README badge, changelog, and macOS version/build. Repeating it advances the build number again.
2. Fill the changelog, review README and SKILL examples against source, and preserve private/unrelated workspace files.
3. Run `bun install --lockfile-only`, `bun run build`, `bun run lint`, `bun run test`, and `swift test --package-path packages/macos-bar`. For native fixture review, set `TOKMETER_UI_QA_DIR` to an existing temporary directory. Run `bun run check:secrets` and inspect `git diff --check`.
4. Run `bash scripts/prepare-packages.sh /tmp/tokmeter-candidate-X.Y.Z`. Inspect both tarballs for version, resolved dependencies, entrypoints, licenses, and source; install them together outside the workspace and exercise CLI help and synthetic query/TUI fixtures.
5. Stage only intended public files. Make a signed commit, push the branch, and open a PR with the actual change and validation. Wait for both JavaScript and native CI on that exact head; resolve failures before merging. Do not bypass a red check with admin merge.
6. Fast-forward local main to the reviewed merge. Create the signed `vX.Y.Z` tag on that commit and push it. Never create or move an intermediate release tag.

## Build and publish

Signing requires an installed Developer ID Application certificate, notarization credentials, and the existing Sparkle private key. Keep credentials in the ignored `packages/macos-bar/.env`; never print or commit them. `.env.example` lists supported settings. Back up the Sparkle private key securely: changing it breaks updates for existing installations.

From merged main, rebuild and prepare the two npm tarballs, then publish those exact reviewed artifacts, Tokmeter first:

```sh
npm publish /tmp/tokmeter-candidate-X.Y.Z/tokmeter-X.Y.Z.tgz --access public
npm publish /tmp/tokmeter-candidate-X.Y.Z/mcp-X.Y.Z.tgz --access public
```

Build the macOS artifact without replacing the running app during packaging:

```sh
cd packages/macos-bar
set -a
. ./.env
set +a
./bundle.sh --release --no-install
```

The bundler signs the app and nested Sparkle components, submits notarization, staples the accepted ticket, signs the final ZIP with Sparkle, and updates `appcast.xml`. Verify `codesign --verify --deep --strict`, `xcrun stapler validate`, `spctl --assess --type execute`, and the update signature against the bundled public key. Check the app version/build and bundled license/source archive.

Create the GitHub release at the signed tag with the release-specific changelog and ZIP. Download the published ZIP and compare its SHA-256 to the verified local artifact. Verify both npm registry versions and tarball integrity.

## Publish the update routes

- Commit the generated `packages/macos-bar/appcast.xml` on a separate signed branch, open a PR, wait for CI, and merge. Verify the public feed's version, build, URL, length, and signature against the published ZIP.
- Update `Casks/tokmeterbar.rb` in `sriinnu/homebrew-tap` with the version and published ZIP digest through its own branch and PR. The current `scripts/update-brew-cask.sh` pushes directly; use the PR workflow when branch review is required.
- Install the verified app, restart the matching daemon when needed, and verify installed version, signature, binary identity, and live process separately. Record source, distribution, and installed evidence in the review/completion docs.

A published release does not complete the [macOS acceptance tracker](../../docs/macos-completion.md). Fresh-machine use, sustained reliability, a real Sparkle upgrade, independent accounting, live accessibility, and user-trial evidence remain distinct gates.
