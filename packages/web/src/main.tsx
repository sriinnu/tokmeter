import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router-dom";
import { DashboardPage } from "./pages/DashboardPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { ModelsPage } from "./pages/ModelsPage.js";
import { TimelinePage } from "./pages/TimelinePage.js";
import { View3DPage } from "./pages/View3DPage.js";

function App() {
  return (
    <BrowserRouter>
      <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", margin: 0, padding: 0 }}>
        {/* Navigation */}
        <nav
          style={{
            background: "#1a1a2e",
            padding: "12px 24px",
            display: "flex",
            gap: 24,
            alignItems: "center",
          }}
        >
          <h1 style={{ color: "#39d353", margin: 0, fontSize: 20 }}>Tokmeter</h1>
          <NavLink to="/">Dashboard</NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/models">Models</NavLink>
          <NavLink to="/timeline">Timeline</NavLink>
          <NavLink to="/3d-view">3D View</NavLink>
        </nav>

        {/* Content */}
        <main style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:name" element={<ProjectsPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/timeline" element={<TimelinePage />} />
              <Route path="/3d-view" element={<View3DPage />} />
            </Routes>
          </ErrorBoundary>
        </main>
      </div>
    </BrowserRouter>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  const location = useLocation();
  const isActive = location.pathname === to;
  return (
    <Link
      to={to}
      style={{
        color: isActive ? "#39d353" : "#8b949e",
        textDecoration: "none",
        fontSize: 14,
        fontWeight: isActive ? 700 : 500,
        borderBottom: isActive ? "2px solid #39d353" : "2px solid transparent",
        paddingBottom: 2,
      }}
    >
      {children}
    </Link>
  );
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ color: "#f85149", padding: 24 }}>
          <h2>Something went wrong</h2>
          <pre style={{ color: "#8b949e", fontSize: 13 }}>
            {this.state.error?.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
