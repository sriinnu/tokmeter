import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useLocation } from "react-router-dom";
import { useLiveData } from "./hooks/useLiveData.js";
import type { LiveConnectionStatus } from "./hooks/useLiveData.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { ModelsPage } from "./pages/ModelsPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { TimelinePage } from "./pages/TimelinePage.js";
import { View3DPage } from "./pages/View3DPage.js";

function App() {
  const liveData = useLiveData();

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
          <div style={{ marginLeft: "auto" }}>
            <LiveIndicator
              status={liveData.status}
              sessionCount={liveData.aggregated?.sessions ?? 0}
            />
          </div>
        </nav>

        {/* Content */}
        <main style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<DashboardPage liveData={liveData} />} />
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

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
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
          <pre style={{ color: "#8b949e", fontSize: 13 }}>{this.state.error?.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Pulsing dot + status label shown in the nav bar. */
function LiveIndicator({
  status,
  sessionCount,
}: {
  status: LiveConnectionStatus;
  sessionCount: number;
}) {
  const isLive = status === "connected";
  const isConnecting = status === "connecting";
  const dotColor = isLive ? "#39d353" : isConnecting ? "#f0883e" : "#484f58";
  const label = isLive ? "Live" : isConnecting ? "Connecting..." : "Offline";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 13,
        color: isLive ? "#39d353" : "#8b949e",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: dotColor,
          boxShadow: isLive ? "0 0 6px #39d353" : "none",
          animation: isLive ? "pulse 2s ease-in-out infinite" : "none",
        }}
      />
      <span>{label}</span>
      {isLive && sessionCount > 0 && (
        <span
          style={{
            background: "#21262d",
            border: "1px solid #30363d",
            borderRadius: 10,
            padding: "1px 8px",
            fontSize: 11,
            color: "#8b949e",
          }}
        >
          {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
        </span>
      )}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
