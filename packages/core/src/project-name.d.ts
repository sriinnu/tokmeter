/**
 * @sriinnu/tokmeter-core — Project naming helpers.
 *
 * Normalizes raw workspace paths, slug directories, and workspace filenames
 * into stable project labels across Windows, WSL, VS Code, Cursor, and
 * similar environments.
 */
/**
 * Canonicalize a raw project path, slug, or workspace label into a stable
 * display-friendly project name.
 */
export declare function canonicalizeProjectName(rawProject: string, fallback?: string): string;
/**
 * Build a case-insensitive comparison key from any raw project identifier.
 */
export declare function projectMatchKey(rawProject: string, fallback?: string): string;
/**
 * Determine whether two raw project identifiers refer to the same project.
 */
export declare function projectNamesMatch(left: string, right: string): boolean;
/**
 * Determine whether a project name matches a search query after canonical
 * normalization, while still allowing substring search for the UI and CLI.
 */
export declare function projectNameIncludes(project: string, query: string): boolean;
