import { type ReactNode, useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useDashboardData } from "../../lib/data-context.js";
import { cn } from "../../lib/utils.js";
import { SummaryStatusBanner } from "../SummaryStatusBanner.js";
import { AboutBlock } from "./AboutBlock.js";
import { BrandMark } from "./BrandMark.js";
import { DisplaySettings } from "./DisplaySettings.js";
import { LiveIndicator } from "./LiveIndicator.js";
import { MotionToggle } from "./MotionToggle.js";
import { NAV_ITEMS } from "./nav-items.js";
import { ThemeToggle } from "./ThemeToggle.js";

/**
 * Sidebar on wide screens, a compact top bar with an icon nav on phones.
 * The nav row scrolls inside itself so the page never scrolls sideways.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { live, data, warning, lastLoadedAt, source } = useDashboardData();
  const sessions = live.aggregated?.sessions ?? 0;
  const mobileNav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  // The phone nav scrolls sideways; keep the current page's tab in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on navigation
  useEffect(() => {
    mobileNav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[13.5rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 overflow-y-auto border-r bg-sidebar px-3 py-5 md:flex">
        <Brand live={live.status === "connected"} />
        <nav aria-label="Primary" className="grid gap-0.5">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={!item.nested}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                )
              }
            >
              <item.icon className="size-4" aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto grid gap-3">
          <LiveIndicator status={live.status} sessions={sessions} />
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
            <span>Theme</span>
            <ThemeToggle />
            <span>Motion</span>
            <MotionToggle />
          </div>
          <AboutBlock className="border-t px-1 pt-3" />
        </div>
      </aside>

      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur md:hidden">
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <Brand live={live.status === "connected"} />
          <div className="flex items-center gap-2">
            <LiveIndicator status={live.status} sessions={0} compact />
            <DisplaySettings />
          </div>
        </div>
        <nav ref={mobileNav} aria-label="Primary" className="flex gap-1 overflow-x-auto px-3 py-2">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={!item.nested}
              className={({ isActive }) =>
                cn(
                  "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs",
                  isActive ? "bg-accent font-medium text-foreground" : "text-muted-foreground"
                )
              }
            >
              <item.icon className="size-3.5" aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main id="main" className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <div className="mx-auto grid max-w-[1400px] gap-5">
          {data && (
            <SummaryStatusBanner
              meta={data.meta}
              warning={warning}
              lastLoadedAt={lastLoadedAt}
              summarySource={source}
              daemonStatus={live.status}
            />
          )}
          {children}
          {/* The sidebar's About block is hidden on phones; it lives at the page end instead. */}
          <footer className="border-t pt-4 md:hidden">
            <AboutBlock />
          </footer>
        </div>
      </main>
    </div>
  );
}

function Brand({ live }: { live: boolean }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <BrandMark live={live} />
      <span className="text-sm font-semibold tracking-tight">Tokmeter</span>
    </div>
  );
}
