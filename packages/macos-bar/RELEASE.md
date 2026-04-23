# TokmeterBar — Release Process

This is the full pipeline from source to a notarized, Sparkle-updatable
`.app` that any Mac on the internet can install.

## TL;DR for a release

From the monorepo root — one command:

```sh
bun run bar:ship      # clean → notarized build → GitHub release upload
```

Then commit + push the updated `appcast.xml` on your branch and merge to `main`
so Sparkle clients pick it up. Existing users get the update automatically
within 24h.

Or run the steps by hand if you need to control each one:

```sh
bun run clean                 # wipe old artifacts
bun run bar:release           # sign + notarize + staple + sparkle-sign + appcast
bun run bar:publish           # upload TokmeterBar-<version>.zip to GitHub release
git add packages/macos-bar/appcast.xml && git commit && git push
```

## One-time setup

You need to do these **once** when you first start releasing TokmeterBar:

### 1. Apple Developer ID

You need a paid Apple Developer Program membership ($99/year) and a
**Developer ID Application** certificate installed in your keychain.

```sh
# Verify you have one
security find-identity -v -p codesigning | grep "Developer ID Application"
```

If you don't, follow Apple's instructions:
https://developer.apple.com/account/resources/certificates/list

### 2. App-specific password for notarization

`notarytool` needs an Apple ID + app-specific password (NOT your real Apple
password). Generate one at:

https://appleid.apple.com → Sign-In and Security → App-Specific Passwords

Save it. You'll only see it once.

### 3. Sparkle EdDSA keypair

Sparkle signs every update zip with an EdDSA private key. The public half
is embedded in `Info.plist` (`SUPublicEDKey`) and verified by every running
copy of the app.

```sh
cd packages/macos-bar
swift build  # fetch Sparkle SPM dep first
./generate-sparkle-keys.sh
```

This writes `sparkle_ed25519_priv` (mode 600) and `sparkle_ed25519_priv.pub`.

**CRITICAL:** Back up the private key to 1Password / encrypted storage. If you
lose it, you can never sign another update — users would need to manually
download a new build because their existing app would reject the new signing
key.

The private key is gitignored. Never commit it.

### 4. `.env` file

```sh
cp .env.example .env
$EDITOR .env  # fill in DEV_ID, APPLE_*, paths
```

The `.env` is gitignored.

## Per-release workflow

Each time you ship a new version:

### 1. Bump versions

Edit one or both:
- `CFBundleShortVersionString` → semver (`0.1.0` → `0.2.0`)
- `CFBundleVersion` → integer build number (`1` → `2`)

You can override either via env vars:
```sh
CFBundleShortVersionString=0.2.0 CFBundleVersion=2 ./bundle.sh --release
```

### 2. Build, sign, notarize, staple

```sh
set -a; source .env; set +a
./bundle.sh --release
```

This will:
1. Build the release binary via `swift build -c release`
2. Bundle Sparkle.framework into `Frameworks/`
3. Write `Info.plist` (with `SUPublicEDKey` from your keypair)
4. Sign Sparkle's nested XPC services with hardened runtime
5. Sign the main `.app` with hardened runtime + entitlements
6. Submit to Apple's notary service via `notarytool` (5-30 min wait)
7. Staple the notarization ticket to the `.app`
8. Re-zip the stapled `.app` for distribution
9. Sign the zip with Sparkle's `sign_update` (EdDSA)
10. Append a new `<item>` to `appcast.xml`

The result: `TokmeterBar-X.Y.Z.zip` ready to upload.

### 3. Publish the zip

```sh
gh release create v0.2.0 \
  --title "TokmeterBar v0.2.0" \
  --notes-file CHANGELOG.md \
  TokmeterBar-0.2.0.zip
```

Or upload to S3 / R2 / wherever — whatever URL you set in `RELEASE_DOWNLOAD_URL`
must serve the zip at exactly that path.

### 4. Publish the appcast

```sh
git add appcast.xml
git commit -m "release: v0.2.0 — short summary"
git push
```

The `SUFeedURL` in `Info.plist` points at the raw GitHub URL of `appcast.xml`,
so as soon as it's pushed, every running TokmeterBar will see the new version
on its next 24h check (or immediately when the user clicks "Check for Updates…"
in the popover).

## Modes recap

| Command | What it produces | Use case |
|---|---|---|
| `./bundle.sh` | Ad-hoc signed `.app` | Local development, throwaway testing |
| `./bundle.sh --signed` | Developer ID signed `.app` | Sharing with colleagues over AirDrop without notarization wait |
| `./bundle.sh --release` | Notarized, stapled `.app` + signed zip + appcast entry | Public release |
| `./bundle.sh --install` | Ad-hoc + copy to /Applications | Local install |

## Troubleshooting

### "notarytool: invalid credentials"
Your `APPLE_APP_PASSWORD` is wrong. Generate a new one at appleid.apple.com.

### "the executable does not have the hardened runtime enabled"
Apple notarization requires hardened runtime. The bundle.sh script signs with
`--options runtime` automatically — if you see this error, the Sparkle nested
components weren't signed first. Check that `Frameworks/Sparkle.framework`
exists in the bundle before the main signing pass.

### "the application has invalid signature"
Run `codesign --verify --deep --strict --verbose=2 TokmeterBar.app` to see
which component is failing. Usually it's a Sparkle XPC service that wasn't
re-signed after Sparkle updated.

### Sparkle: "Update is improperly signed"
Either:
1. The `SUPublicEDKey` in `Info.plist` doesn't match the private key used to
   sign the zip — regenerate `appcast.xml` with the correct key.
2. The zip was modified after signing (e.g. re-zipped with a different tool).
   Re-run `./bundle.sh --release` end to end.

### Sparkle: "Couldn't find appcast"
Check that `SUFeedURL` is reachable in a browser and returns valid XML.
If you're hosting on GitHub, use the raw URL not the rendered HTML page.

## What a release looks like

```
packages/macos-bar/
├── TokmeterBar.app/                    # signed, notarized, stapled
├── TokmeterBar-0.2.0.zip               # ready to upload
├── appcast.xml                         # updated with new <item>
└── sparkle_ed25519_priv                # secret, gitignored, do not lose
```

After upload + push, users running v0.1.0 will see the update prompt
within 24h or when they manually check.
