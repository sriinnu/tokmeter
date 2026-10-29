import {
  Box,
  CalendarDays,
  Cpu,
  FolderKanban,
  LayoutDashboard,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Whether nested paths (e.g. /projects/:name) count as this item. */
  nested?: boolean;
}

// Paths are fixed: the macOS bar and dashboard-server.mjs both know them.
export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/projects", label: "Projects", icon: FolderKanban, nested: true },
  { to: "/models", label: "Models", icon: Cpu },
  { to: "/timeline", label: "Timeline", icon: CalendarDays },
  { to: "/3d-view", label: "3D view", icon: Box },
];
