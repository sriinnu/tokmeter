#!/usr/bin/env node
// Copies each MCP tool's description from packages/mcp/src/server.ts into
// docs/mcp-tools.md, so the reference can't drift from what an agent reads.
//
//   node scripts/sync-mcp-tool-docs.mjs          # rewrite the descriptions
//   node scripts/sync-mcp-tool-docs.mjs --check  # exit 1 if they differ
//
// Only the paragraph right under each `### tokmeter_x` heading is replaced.
// Notes added after it are left alone.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "packages/mcp/src/server.ts");
const docPath = join(root, "docs/mcp-tools.md");

/** Plain constants a description can interpolate, like `const X = 14;`. */
function readConstants(source) {
  const constants = {};
  for (const match of source.matchAll(/^const ([A-Z][A-Z0-9_]*) = (\d[\d_]*|"[^"]*");$/gm)) {
    constants[match[1]] = JSON.parse(match[2].replaceAll("_", ""));
  }
  return constants;
}

/** Reads the string literals joined by `+` that start at `from`. */
function readDescription(source, from, constants) {
  const literal = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*(\+?)/y;
  literal.lastIndex = from;
  let text = "";
  for (;;) {
    const match = literal.exec(source);
    if (!match) throw new Error(`no description string at offset ${from}`);
    // The literal comes from this repo's own source, in the three quote forms.
    const names = Object.keys(constants);
    text += new Function(...names, `return ${match[1]};`)(...names.map((name) => constants[name]));
    if (match[2] !== "+") return text;
  }
}

function toolDescriptions(source) {
  const constants = readConstants(source);
  const tools = new Map();
  const header = /\.tool\(\s*"(tokmeter_\w+)",/g;
  for (let match = header.exec(source); match; match = header.exec(source)) {
    tools.set(match[1], readDescription(source, header.lastIndex, constants));
  }
  return tools;
}

const source = readFileSync(serverPath, "utf8");
const tools = toolDescriptions(source);
const before = readFileSync(docPath, "utf8");
const seen = new Set();

const after = before.replace(/^### (tokmeter_\w+)\n\n.+$/gm, (_whole, name) => {
  const description = tools.get(name);
  if (!description) throw new Error(`${name} is in the docs but not in server.ts`);
  seen.add(name);
  return `### ${name}\n\n${description}`;
});

const undocumented = [...tools.keys()].filter((name) => !seen.has(name));
if (undocumented.length > 0) {
  throw new Error(`in server.ts but not in the docs: ${undocumented.join(", ")}`);
}

if (process.argv.includes("--check")) {
  if (after !== before) {
    console.error(
      "docs/mcp-tools.md differs from server.ts. Run: node scripts/sync-mcp-tool-docs.mjs"
    );
    process.exit(1);
  }
  console.log(`${tools.size} tool descriptions match server.ts`);
} else {
  writeFileSync(docPath, after);
  console.log(`${tools.size} tool descriptions ${after === before ? "already match" : "updated"}`);
}
