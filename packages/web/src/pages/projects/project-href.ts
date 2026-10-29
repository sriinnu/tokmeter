/**
 * Route for one project. Names can be paths, so the whole name is a single
 * encoded segment — the shape dashboard-server.mjs allows (`/projects/[^/]+`).
 */
export function projectHref(project: string): string {
  return `/projects/${encodeURIComponent(project)}`;
}
