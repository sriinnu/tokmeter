/**
 * @sriinnu/tokmeter-core — Project naming helpers.
 *
 * Normalizes raw workspace paths, slug directories, and workspace filenames
 * into stable project labels across Windows, WSL, VS Code, Cursor, and
 * similar environments.
 */

const GENERIC_LEAF_NAMES = new Set([
  "api",
  "app",
  "backend",
  "client",
  "dashboard",
  "frontend",
  "server",
  "service",
  "site",
  "ui",
  "web",
]);

const ROOT_SEGMENTS = new Set(["home", "user", "users"]);

const INFRA_SEGMENTS = new Set([
  ".config",
  ".cursor",
  ".local",
  ".vscode",
  ".vscode-server",
  "appdata",
  "code",
  "globalstorage",
  "local",
  "project",
  "projects",
  "repo",
  "repos",
  "roaming",
  "source",
  "src",
  "storage",
  "workspace",
  "workspaces",
]);

/** Dot-folders under home that hold editor config, not a tool's own work. */
const HOME_CONFIG_DOTDIRS = new Set([
  ".cache",
  ".config",
  ".cursor",
  ".local",
  ".vscode",
  ".vscode-server",
]);

const WORKSPACE_SUFFIXES = [".code-workspace", ".cursor-workspace", ".workspace"];

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripWorkspaceSuffix(segment: string): string {
  const trimmed = segment.trim();
  const lower = trimmed.toLowerCase();

  for (const suffix of WORKSPACE_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return trimmed.slice(0, -suffix.length);
    }
  }

  return trimmed;
}

function normalizePathSeparators(value: string): string {
  return safeDecode(value).replace(/\\+/g, "/").replace(/\/+/g, "/");
}

function trimInfrastructureSegments(segments: string[]): string[] {
  let trimmed = segments.map(stripWorkspaceSuffix).filter(Boolean);

  if (trimmed[0]?.toLowerCase() === "mnt" && /^[a-z]$/i.test(trimmed[1] ?? "")) {
    trimmed = trimmed.slice(2);
  } else if (/^[a-z]:$/i.test(trimmed[0] ?? "")) {
    trimmed = trimmed.slice(1);
  }

  if (ROOT_SEGMENTS.has(trimmed[0]?.toLowerCase() ?? "") && trimmed.length > 2) {
    trimmed = trimmed.slice(2);
  }

  while (trimmed.length > 1 && INFRA_SEGMENTS.has(trimmed[0]?.toLowerCase() ?? "")) {
    trimmed = trimmed.slice(1);
  }

  return trimmed;
}

function looksLikeEncodedPathTokens(tokens: string[]): boolean {
  if (tokens.length < 3) {
    return false;
  }

  const normalizedTokens = tokens.map((token) => stripWorkspaceSuffix(token).toLowerCase());

  if (normalizedTokens[0] === "mnt" && /^[a-z]$/i.test(normalizedTokens[1] ?? "")) {
    return true;
  }

  if (/^[a-z]$/i.test(normalizedTokens[0] ?? "")) {
    const second = normalizedTokens[1] ?? "";

    if (ROOT_SEGMENTS.has(second) || INFRA_SEGMENTS.has(second)) {
      return true;
    }
  }

  return normalizedTokens.some((token, index) => {
    if (ROOT_SEGMENTS.has(token) || INFRA_SEGMENTS.has(token)) {
      return true;
    }

    return token === "mnt" && /^[a-z]$/i.test(normalizedTokens[index + 1] ?? "");
  });
}

function looksLikeSlugPath(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.startsWith("-")) {
    return true;
  }

  if (/[\\/]/.test(trimmed)) {
    return false;
  }

  return looksLikeEncodedPathTokens(trimmed.split("-").filter(Boolean));
}

function looksLikeAcronym(segment: string): boolean {
  return /^[A-Z0-9]{2,8}$/.test(segment);
}

/**
 * A leaf that can't name a project on its own: a generic folder like `web`, or
 * a bare number (a trial, run or shard index such as `.../core/1`).
 */
function isGenericLeafName(segment: string): boolean {
  return GENERIC_LEAF_NAMES.has(segment.toLowerCase()) || /^\d+$/.test(segment);
}

/**
 * A session in a numbered folder inside a tool's own work folder under home
 * (`~/.ribhu/eval/work/<run>/<task>/<variant>/1`) is named for the tool and its
 * first subfolder (`ribhu/eval`). Eval harnesses nest hundreds of throwaway
 * trial folders there; naming each by its number split one workload into
 * cards called `1`, `2`, `3`. A named leaf (`~/.codex/worktrees/<id>/AUriva`)
 * is a real project and keeps the normal rules.
 */
function homeToolLabel(segments: string[]): string | undefined {
  const root = segments[0]?.toLowerCase() ?? "";
  const dotdir = segments[2];
  if (!ROOT_SEGMENTS.has(root) || !dotdir?.startsWith(".") || dotdir.length < 2) return undefined;
  if (HOME_CONFIG_DOTDIRS.has(dotdir.toLowerCase())) return undefined;
  if (segments.length < 5 || !/^\d+$/.test(segments.at(-1) ?? "")) return undefined;
  return `${dotdir.slice(1)}/${segments[3]}`;
}

/**
 * The random tail `mkdtemp` adds (`ribhu-live-ws-06Wwnk`, `tmp.Ab3dE9xQ`):
 * 6–12 letters/digits that mix cases or put a letter after a digit. A word
 * (`server`, `Harbor`) or a word and a number (`accept2417`, `build42`) never
 * looks like that.
 */
const RANDOM_TAIL_RE = /[._-]?([A-Za-z0-9]{6,12})$/;

function isRandomToken(token: string): boolean {
  if (!/^[A-Za-z0-9]{6,12}$/.test(token)) return false;
  return /\d[A-Za-z]/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token));
}

/** A temp folder's name without its random tail; `tmp` when nothing is left. */
function stripRandomTail(name: string): string {
  const match = RANDOM_TAIL_RE.exec(name);
  if (!match?.[1] || !isRandomToken(match[1])) return name;
  const base = name.slice(0, match.index).replace(/[._-]+$/, "");
  return base || "tmp";
}

/**
 * A session started in a fresh temp folder (`/tmp/x-AbC123`, macOS
 * `/var/folders/<a>/<b>/T/x-AbC123`) is named for the folder's prefix, so a
 * tool that makes a new temp workspace per run gets one card, not one per run.
 */
function tempDirLabel(segments: string[]): string | undefined {
  const lower = segments.map((s) => s.toLowerCase());
  let i = lower[0] === "private" ? 1 : 0;
  if (lower[i] === "tmp") i += 1;
  else if (lower[i] === "var" && lower[i + 1] === "folders" && lower[i + 4] === "t") i += 5;
  else if (lower[i] === "var" && lower[i + 1] === "tmp") i += 2;
  else return undefined;
  // Only a session sitting directly in the temp folder; deeper paths name normally.
  if (segments.length !== i + 1) return undefined;
  return stripRandomTail(segments[i] ?? "");
}

/**
 * The slug form of {@link tempDirLabel}. A slug can't tell `/tmp/a-b` from
 * `/tmp/a/b`, so it only applies when the slug ends in a random tail: only a
 * per-run temp folder looks like that, while deeper paths (`/tmp/claude-501/
 * .../scratchpad`) keep the normal rules.
 */
function tempDirSlugLabel(slug: string): string | undefined {
  const match = /^-(?:private-)?(?:tmp|var-tmp|var-folders-[^-]+-[^-]+-T)-(.+)$/i.exec(slug.trim());
  const rest = match?.[1];
  if (!rest) return undefined;
  const stripped = stripRandomTail(rest);
  return stripped === rest ? undefined : stripped;
}

/** The slug form of {@link homeToolLabel}: Claude Code writes `/.` as `--`. */
function homeToolSlugLabel(slug: string): string | undefined {
  const match = /^-(users|home|user)-[^-]+--([^-]+)-(.+)$/i.exec(slug.trim());
  if (!match) return undefined;
  const tool = match[2] ?? "";
  if (HOME_CONFIG_DOTDIRS.has(`.${tool.toLowerCase()}`)) return undefined;
  const rest = (match[3] ?? "").split("-").filter(Boolean);
  if (rest.length < 2 || !/^\d+$/.test(rest.at(-1) ?? "")) return undefined;
  return `${tool}/${rest[0]}`;
}

function buildPathLabel(segments: string[], fallback: string): string {
  const leaf = segments.at(-1);
  const previous = segments.at(-2);

  if (!leaf) {
    return fallback;
  }

  if (isGenericLeafName(leaf) && previous) {
    return `${previous}/${leaf}`;
  }

  return leaf;
}

function buildSlugLabel(rawProject: string, fallback: string): string {
  const tokens = trimInfrastructureSegments(rawProject.split("-").filter(Boolean));
  const leaf = tokens.at(-1);
  const previous = tokens.at(-2);

  if (!leaf) {
    return fallback;
  }

  if (isGenericLeafName(leaf) && previous) {
    return `${previous}/${leaf}`;
  }

  if (previous && looksLikeAcronym(leaf)) {
    return `${previous}-${leaf}`;
  }

  return leaf;
}

/**
 * Canonicalize a raw project path, slug, or workspace label into a stable
 * display-friendly project name.
 */
export function canonicalizeProjectName(rawProject: string, fallback = "unknown"): string {
  const normalized = normalizePathSeparators(rawProject).trim();

  if (!normalized) {
    return fallback;
  }

  const rawSegments = normalized.split("/").filter(Boolean);
  const toolLabel =
    rawSegments.length > 1
      ? (homeToolLabel(rawSegments) ?? tempDirLabel(rawSegments))
      : (homeToolSlugLabel(normalized) ?? tempDirSlugLabel(normalized));
  if (toolLabel) {
    return toolLabel;
  }

  const segments = trimInfrastructureSegments(rawSegments);

  if (segments.length > 1) {
    return buildPathLabel(segments, fallback);
  }

  if (segments.length === 1) {
    const single = segments[0] ?? fallback;
    return looksLikeSlugPath(single) ? buildSlugLabel(single, fallback) : single;
  }

  return looksLikeSlugPath(normalized)
    ? buildSlugLabel(normalized, fallback)
    : stripWorkspaceSuffix(normalized) || fallback;
}

/**
 * Build a case-insensitive comparison key from any raw project identifier.
 */
export function projectMatchKey(rawProject: string, fallback = "unknown"): string {
  const canonicalProject = canonicalizeProjectName(rawProject, fallback);
  const key = canonicalProject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return key || fallback.toLowerCase();
}

/**
 * Determine whether two raw project identifiers refer to the same project.
 */
export function projectNamesMatch(left: string, right: string): boolean {
  return projectMatchKey(left, left || "unknown") === projectMatchKey(right, right || "unknown");
}

/**
 * Determine whether a project name matches a search query after canonical
 * normalization, while still allowing substring search for the UI and CLI.
 */
export function projectNameIncludes(project: string, query: string): boolean {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return true;
  }

  const canonicalProject = canonicalizeProjectName(project, project || "unknown");
  const canonicalQuery = canonicalizeProjectName(trimmedQuery, trimmedQuery);
  const projectKey = projectMatchKey(project, project || "unknown");
  const queryKey = projectMatchKey(trimmedQuery, trimmedQuery);

  return (
    projectKey === queryKey ||
    projectKey.includes(queryKey) ||
    canonicalProject.toLowerCase().includes(canonicalQuery.toLowerCase()) ||
    project.toLowerCase().includes(trimmedQuery.toLowerCase())
  );
}
