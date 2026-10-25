import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function repoFile(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

describe("release trust chain", () => {
  test("macOS release cannot upload an unsigned or unverified build", () => {
    const workflow = repoFile(".github/workflows/release-macos.yml");
    expect(workflow).not.toContain("Bundle .app (unsigned)");
    expect(workflow).toMatch(/Required release secret .* is missing/);
    expect(workflow).toContain("Sparkle sign_update was not built");
    expect(workflow).toContain("steps.verify-sparkle.outputs.verified == 'true'");
    expect(workflow).toContain("scripts/verify-release-tag.sh");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("ref: main");
    expect(workflow).not.toMatch(/run:\s+scripts\/verify-release-tag\.sh\s+"\$\{\{/);
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
