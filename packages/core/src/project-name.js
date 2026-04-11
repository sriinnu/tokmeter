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
const WORKSPACE_SUFFIXES = [".code-workspace", ".cursor-workspace", ".workspace"];
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function stripWorkspaceSuffix(segment) {
  const trimmed = segment.trim();
  const lower = trimmed.toLowerCase();
  for (const suffix of WORKSPACE_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return trimmed.slice(0, -suffix.length);
    }
  }
  return trimmed;
}
function normalizePathSeparators(value) {
  return safeDecode(value).replace(/\\+/g, "/").replace(/\/+/g, "/");
}
function trimInfrastructureSegments(segments) {
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
function looksLikeEncodedPathTokens(tokens) {
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
function looksLikeSlugPath(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("-")) {
    return true;
  }
  if (/[\\/]/.test(trimmed)) {
    return false;
  }
  return looksLikeEncodedPathTokens(trimmed.split("-").filter(Boolean));
}
function looksLikeAcronym(segment) {
  return /^[A-Z0-9]{2,8}$/.test(segment);
}
function isGenericLeafName(segment) {
  return GENERIC_LEAF_NAMES.has(segment.toLowerCase());
}
function buildPathLabel(segments, fallback) {
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
function buildSlugLabel(rawProject, fallback) {
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
export function canonicalizeProjectName(rawProject, fallback = "unknown") {
  const normalized = normalizePathSeparators(rawProject).trim();
  if (!normalized) {
    return fallback;
  }
  const segments = trimInfrastructureSegments(normalized.split("/").filter(Boolean));
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
export function projectMatchKey(rawProject, fallback = "unknown") {
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
export function projectNamesMatch(left, right) {
  return projectMatchKey(left, left || "unknown") === projectMatchKey(right, right || "unknown");
}
/**
 * Determine whether a project name matches a search query after canonical
 * normalization, while still allowing substring search for the UI and CLI.
 */
export function projectNameIncludes(project, query) {
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
