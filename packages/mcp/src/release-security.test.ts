import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function repoFile(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

/** The text of one top-level job in a workflow, from its header to the next. */
function jobText(workflow: string, job: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  if (start < 0) throw new Error(`job ${job} not found`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[a-z][a-z0-9-]*:\s*$/.test(line));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

describe("release trust chain", () => {
  test("macOS release cannot upload an unsigned or unverified build", () => {
    const workflow = repoFile(".github/workflows/release-macos.yml");
    expect(workflow).not.toContain("Bundle .app (unsigned)");
    expect(workflow).toMatch(/Required release secret .* is missing/);
    expect(workflow).toContain("Sparkle sign_update was not fetched");
    expect(workflow).toContain("Verify the Sparkle signature against the app's own key");
    expect(workflow).toContain("Verify the feed signature against the app's own key");
    expect(workflow).toContain("scripts/verify-release-tag.sh");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("ref: main");
    expect(workflow).not.toMatch(/run:\s+scripts\/verify-release-tag\.sh\s+"\$\{\{/);
    expect(workflow).toMatch(/^permissions: \{\}$/m);
  });

  test("macOS release keeps third-party code away from signing keys and write access", () => {
    const workflow = repoFile(".github/workflows/release-macos.yml");
    const build = jobText(workflow, "build");
    const sign = jobText(workflow, "sign");
    const publish = jobText(workflow, "publish");

    // build runs bun/vite/swift: read-only token, no environment, no secrets.
    expect(build).toContain("bundle.sh --unsigned");
    expect(build).toMatch(/permissions:\n {6}contents: read\n/);
    expect(build).not.toContain("environment:");
    expect(build).not.toContain("secrets.");
    expect(build).not.toMatch(/contents: write|pull-requests: write|id-token/);

    // sign holds the keys: release environment, read-only token, and it runs
    // none of the build tooling — it signs the verified, digest-checked bytes.
    expect(sign).toContain("environment: release");
    expect(sign).toMatch(/needs: \[verify-tag, build\]/);
    expect(sign).toMatch(/permissions:\n {6}contents: read\n/);
    expect(sign).not.toMatch(/contents: write|pull-requests: write|id-token/);
    expect(sign).not.toMatch(/bun install|bunx|swift build|bundle\.sh --/);
    expect(sign).toMatch(/UNSIGNED_SHA256: \$\{\{ needs\.build\.outputs\.sha256 \}\}/);
    const unpack = sign.indexOf("Verify and unpack the unsigned app");
    expect(unpack).toBeGreaterThan(0);
    expect(unpack).toBeLessThan(sign.indexOf("Import signing certificate"));
    expect(sign).toContain("sign-app.sh");

    // publish can write, so it gets no secrets and runs no repository code.
    expect(publish).toMatch(/needs: \[verify-tag, sign\]/);
    expect(publish).not.toContain("secrets.");
    expect(publish).not.toContain("actions/checkout");
    expect(publish).not.toContain("environment:");
    expect(publish).toContain("sha256sum -c -");
    expect(publish).not.toContain("--clobber");
  });

  test("signed app enables Sparkle's signed-feed protections", () => {
    const bundle = repoFile("packages/macos-bar/bundle.sh");
    const signApp = repoFile("packages/macos-bar/sign-app.sh");
    for (const key of ["SUVerifyUpdateBeforeExtraction", "SURequireSignedFeed"]) {
      expect(bundle).toContain(`<key>${key}</key>`);
      expect(signApp).toContain(`plist_get ${key}`);
    }
    expect(signApp).toContain("--options runtime --timestamp");
  });

  test("npm release verifies its tag and checks the publisher archive digest", () => {
    const workflow = repoFile(".github/workflows/publish.yml");
    expect(workflow).toContain("scripts/verify-release-tag.sh");
    expect(workflow).toContain("needs.verify.outputs.release_commit");
    expect(workflow).toContain("actions/download-artifact@");
    expect(workflow).toContain("dist.integrity");
    expect(workflow).toContain("dist.attestations --json");
    expect(workflow).toContain(".url // empty");
    expect(workflow).toContain(".provenance.predicateType // empty");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("Verify package versions match the signed release");
    expect(workflow).toContain("sha256sum -c -");
    expect(workflow).not.toContain("npm@latest");
    expect(workflow).not.toContain("bun-version: latest");
  });

  test("signed app keeps hardened runtime protections enabled", () => {
    const entitlements = repoFile("packages/macos-bar/entitlements.plist");
    const bundle = repoFile("packages/macos-bar/bundle.sh");
    expect(entitlements).not.toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).not.toContain("com.apple.security.cs.disable-library-validation");
    expect(bundle).not.toContain("SUEnableInstallerLauncherService");
  });

  test("release tag verifier requires an annotated verified tag on main", () => {
    const script = repoFile("scripts/verify-release-tag.sh");
    expect(script).toContain(".object.type");
    expect(script).toContain(".verification.verified");
    expect(script).toContain(".tag");
    expect(script).toContain("RELEASE_SIGNER_FINGERPRINT");
    expect(script).toContain("ssh-keygen -Y check-novalidate");
    expect(script).toContain("git merge-base --is-ancestor");
  });
});
