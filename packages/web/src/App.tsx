import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { AppShell } from "./components/layout/AppShell.js";
import { EmptyState, PageSkeleton } from "./components/states.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { DataProvider } from "./lib/data-context.js";
import { MotionProvider } from "./lib/motion.js";
import { ThemeProvider } from "./lib/theme.js";
import { DashboardPage } from "./pages/DashboardPage.js";

// Secondary routes load on demand; the 3D route additionally defers three.js
// until WebGL is confirmed, so the first paint only pays for the overview.
const ProjectsPage = lazy(() =>
  import("./pages/ProjectsPage.js").then((m) => ({ default: m.ProjectsPage }))
);
const ProjectDetailPage = lazy(() =>
  import("./pages/projects/ProjectDetailPage.js").then((m) => ({ default: m.ProjectDetailPage }))
);
const ModelsPage = lazy(() =>
  import("./pages/ModelsPage.js").then((m) => ({ default: m.ModelsPage }))
);
const TimelinePage = lazy(() =>
  import("./pages/TimelinePage.js").then((m) => ({ default: m.TimelinePage }))
);
const View3DPage = lazy(() =>
  import("./pages/View3DPage.js").then((m) => ({ default: m.View3DPage }))
);

export function App() {
  return (
    <ThemeProvider>
      <MotionProvider>
        <TooltipProvider>
          <DataProvider>
            <BrowserRouter>
              <AppShell>
                <RoutedContent />
              </AppShell>
            </BrowserRouter>
          </DataProvider>
        </TooltipProvider>
      </MotionProvider>
    </ThemeProvider>
  );
}

function RoutedContent() {
  const location = useLocation();
  return (
    // Keyed on the path so a crash on one route clears when you navigate away.
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<PageSkeleton />}>
        {/* Keyed wrapper replays a short opacity/transform fade per route; no layout change. */}
        <div key={location.pathname} className="grid animate-route-in gap-5">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:name" element={<ProjectDetailPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/timeline" element={<TimelinePage />} />
            <Route path="/3d-view" element={<View3DPage />} />
            <Route path="*" element={<EmptyState title="Page not found" />} />
          </Routes>
        </div>
      </Suspense>
    </ErrorBoundary>
  );
}
