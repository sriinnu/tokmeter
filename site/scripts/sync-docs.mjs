// Copies the user-facing docs into site/src/content, rewriting links.
//
// Sources are the repo's docs/ (canonical) and the GitHub wiki, which is a
// separate repository. Usage:
//   npm run sync -- /path/to/tokmeter.wiki
//
// Each page records where it came from, so the site can link back to it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const wiki = process.argv[2];
if (!wiki || !existsSync(join(wiki, "Home.md"))) {
  console.error("usage: npm run sync -- /path/to/tokmeter.wiki");
  process.exit(1);
}
const repo = new URL("../../", import.meta.url).pathname;
const out = new URL("../src/content/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const BLOB = "https://github.com/sriinnu/tokmeter/blob/main/";

// slug -> [source root, path]. Order is the reading order on the site.
const pages = {
  install: ["wiki", "Installation.md"],
  cli: ["wiki", "CLI-Reference.md"],
  "menu-bar": ["repo", "docs/macos/themes.md"],
  mcp: ["repo", "docs/mcp-tools.md"],
  daemon: ["wiki", "MCP-and-Daemon.md"],
  numbers: ["repo", "docs/how-the-numbers-work.md"],
  backup: ["repo", "docs/backup-restore.md"],
  troubleshooting: ["repo", "docs/troubleshooting.md"],
  faq: ["wiki", "FAQ.md"],
  architecture: ["repo", "docs/architecture.md"],
};

// Links between synced pages stay on the site; anything else in the repo
// goes to GitHub.
const repoToSlug = Object.fromEntries(
  Object.entries(pages)
    .filter(([, [root]]) => root === "repo")
    .map(([slug, [, path]]) => [path, slug])
);
const wikiToSlug = Object.fromEntries(
  Object.entries(pages)
    .filter(([, [root]]) => root === "wiki")
    .map(([slug, [, path]]) => [path.replace(/\.md$/, ""), slug])
);

function rewrite(text, root, path) {
  const dir = root === "repo" ? path.split("/").slice(0, -1).join("/") : "";
  return text.replace(/\]\(([^)\s]+)\)/g, (whole, href) => {
    if (/^(https?:|mailto:|#)/.test(href)) return whole;
    const [target, hash = ""] = href.split("#");
    const anchor = hash ? `#${hash}` : "";
    if (root === "wiki" && !target.includes("/") && !target.includes(".")) {
      const slug = wikiToSlug[target];
      return slug
        ? `](/${slug}/${anchor})`
        : `](https://github.com/sriinnu/tokmeter/wiki/${target}${anchor})`;
    }
    if (root === "wiki")
      return `](${new URL(target, "https://github.com/sriinnu/tokmeter/blob/main/").href}${anchor})`;
    const resolved = new URL(target, `file:///${dir ? `${dir}/` : ""}`).pathname.slice(1);
    const slug = repoToSlug[resolved];
    return slug ? `](/${slug}/${anchor})` : `](${BLOB}${resolved}${anchor})`;
  });
}

for (const [slug, [root, path]] of Object.entries(pages)) {
  const file = root === "repo" ? join(repo, path) : join(wiki, path);
  let text = readFileSync(file, "utf8");
  const title = (text.match(/^#\s+(.+)$/m) || [null, slug])[1].trim();
  text = text.replace(/^#\s+.+\n+/, ""); // the page header shows the title
  text = rewrite(text, root, path);
  const source =
    root === "repo"
      ? `${BLOB}${path}`
      : `https://github.com/sriinnu/tokmeter/wiki/${path.replace(/\.md$/, "")}`;
  const front = `---\ntitle: ${JSON.stringify(title)}\nsource: ${JSON.stringify(source)}\n---\n\n`;
  writeFileSync(join(out, `${slug}.md`), front + text);
  console.log("synced", slug, "<-", root, path);
}
