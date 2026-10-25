import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  aliasFilePath,
  applyTagOp,
  loadAliases,
  saveAliases,
  setAlias,
  setHidden,
} from "./alias-service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("setAlias display safety", () => {
  test("sanitizes display and tag values at the mutation boundary", () => {
    const aliases = setAlias(
      {},
      "project",
      { display: "\u001b[2JVisible", tags: ["\u001b]0;x\u0007work", "\n"] },
      "user"
    );
    expect(aliases.project.display).toBe("Visible");
    expect(aliases.project.tags).toEqual(["work"]);
  });

  test("rejects unsafe keys rather than normalizing onto another alias", () => {
    expect(() => setAlias({}, "project\u001b[2J", { display: "Visible" })).toThrow(/Alias key/);
  });

  test("sanitizes applyTagOp and saveAliases exported mutation paths", () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-alias-save-safety-"));
    roots.push(home);
    const tagged = applyTagOp(
      { project: { display: "Project", modifiedBy: "user", modifiedAt: "now" } },
      "Project",
      "set",
      ["\u001b[2Jwork", "work", "\n"]
    );
    expect(tagged.project.tags).toEqual(["work"]);

    saveAliases(
      {
        project: {
          display: "\u001b]0;x\u0007Visible",
          tags: ["\u001b[2Jtag"],
          modifiedBy: "user",
          modifiedAt: "now",
        },
      },
      home
    );
    const persisted = readFileSync(aliasFilePath(home), "utf8");
    expect(persisted).not.toContain("\u001b");
    expect(JSON.parse(persisted).project).toMatchObject({ display: "Visible", tags: ["tag"] });
  });

  test("sanitizes pre-existing entries returned by tag and hidden mutations", () => {
    const unsafe = {
      project: {
        display: "Project\u001b[2J",
        tags: ["tag\u202e"],
        modifiedBy: "user" as const,
        modifiedAt: "now",
      },
    };
    expect(applyTagOp(unsafe, "Project", "add", ["safe"]).project).toMatchObject({
      display: "Project",
      tags: ["tag", "safe"],
    });
    expect(setHidden(unsafe, "Project", true).project).toMatchObject({
      display: "Project",
      tags: ["tag"],
      hidden: true,
    });
  });
});

describe("loadAliases display safety", () => {
  test("sanitizes imported display names and tags before rendering", () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-alias-safety-"));
    roots.push(home);
    const path = aliasFilePath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        project: {
          display: "\u001b]0;owned\u0007Visible\u202Etxt.exe",
          tags: ["safe", "\u001b[2Jclear", "\n"],
          modifiedBy: "user",
          modifiedAt: "2026-10-25T00:00:00Z",
        },
        "unsafe\u001b[2J": {
          display: "ignored",
          modifiedBy: "user",
          modifiedAt: "2026-10-25T00:00:00Z",
        },
      })
    );

    const aliases = loadAliases(home);
    expect(aliases.project).toMatchObject({
      display: "Visible txt.exe",
      tags: ["safe", "clear"],
    });
    expect(Object.keys(aliases)).toEqual(["project"]);
  });
});
