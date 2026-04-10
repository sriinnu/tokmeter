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
import { webTheme, withAlpha } from "./theme.js";

function App() {
  const liveData = useLiveData();

  return (
    <BrowserRouter>
      <div style={appShellStyle}>
        <BackgroundAura />

        <nav style={navShellStyle}>
          <div style={navInnerStyle}>
            <div>
              <div style={brandEyebrowStyle}>Token telemetry cockpit</div>
              <h1 style={brandTitleStyle}>Tokmeter</h1>
            </div>

            <div style={navLinksStyle}>
              <NavLink to="/">Dashboard</NavLink>
              <NavLink to="/projects">Projects</NavLink>
              <NavLink to="/models">Models</NavLink>
              <NavLink to="/timeline">Timeline</NavLink>
              <NavLink to="/3d-view">3D View</NavLink>
            </div>

            <LiveIndicator
              status={liveData.status}
              sessionCount={liveData.aggregated?.sessions ?? 0}
            />
          </div>
        </nav>

        <main style={mainStyle}>
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
      aria-current={isActive ? "page" : undefined}
      to={to}
      style={{
        background: isActive ? withAlpha(webTheme.colors.olive, 0.18) : "transparent",
        border: isActive
          ? `1px solid ${withAlpha(webTheme.colors.cream, 0.24)}`
          : "1px solid transparent",
        borderRadius: 999,
        color: isActive ? webTheme.text.primary : webTheme.text.secondary,
        textDecoration: "none",
        fontSize: 14,
        fontWeight: isActive ? 700 : 600,
        padding: "10px 14px",
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
        <div style={{ color: webTheme.text.danger, padding: 24 }}>
          <h2>Something went wrong</h2>
          <pre style={{ color: webTheme.text.muted, fontSize: 13 }}>
            {this.state.error?.message}
          </pre>
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
  const dotColor = isLive
    ? webTheme.status.live
    : isConnecting
      ? webTheme.status.warning
      : webTheme.status.offline;
  const label = isLive ? "Daemon live" : isConnecting ? "Daemon connecting..." : "Daemon offline";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 13,
        color: isLive ? webTheme.status.live : webTheme.text.secondary,
        background: webTheme.surfaces.cardBackground,
        border: `1px solid ${webTheme.surfaces.cardBorder}`,
        borderRadius: 999,
        padding: "10px 14px",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: dotColor,
          boxShadow: isLive ? `0 0 10px ${webTheme.status.live}` : "none",
          animation: isLive ? "pulse 2s ease-in-out infinite" : "none",
        }}
      />
      <span>{label}</span>
      {isLive && sessionCount > 0 && (
        <span
          style={{
            background: withAlpha(webTheme.colors.teal, 0.32),
            border: `1px solid ${withAlpha(webTheme.colors.cream, 0.12)}`,
            borderRadius: 10,
            padding: "1px 8px",
            fontSize: 11,
            color: webTheme.text.muted,
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

function BackgroundAura() {
  return (
    <div aria-hidden="true" style={backgroundAuraStyle}>
      <div style={leftAuraStyle} />
      <div style={rightAuraStyle} />
      <div style={bottomAuraStyle} />
    </div>
  );
}

const appShellStyle = {
  background: webTheme.surfaces.shellBackground,
  color: webTheme.text.primary,
  fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  margin: 0,
  minHeight: "100vh",
  padding: 0,
  position: "relative",
} as const;

const backgroundAuraStyle = {
  inset: 0,
  overflow: "hidden",
  pointerEvents: "none",
  position: "fixed",
  zIndex: 0,
} as const;

const leftAuraStyle = {
  background: `radial-gradient(circle, ${withAlpha(webTheme.colors.olive, 0.18)}, transparent 62%)`,
  filter: "blur(18px)",
  height: 420,
  left: -120,
  position: "absolute",
  top: -120,
  width: 420,
} as const;

const rightAuraStyle = {
  background: `radial-gradient(circle, ${withAlpha(webTheme.colors.teal, 0.16)}, transparent 62%)`,
  filter: "blur(24px)",
  height: 360,
  position: "absolute",
  right: -80,
  top: 120,
  width: 360,
} as const;

const bottomAuraStyle = {
  background: `radial-gradient(circle, ${withAlpha(webTheme.colors.rose, 0.14)}, transparent 62%)`,
  bottom: -180,
  filter: "blur(28px)",
  height: 420,
  left: "25%",
  position: "absolute",
  width: 420,
} as const;

const navShellStyle = {
  backdropFilter: "blur(20px)",
  background: webTheme.surfaces.navBackground,
  borderBottom: `1px solid ${webTheme.surfaces.navBorder}`,
  position: "sticky",
  top: 0,
  zIndex: 10,
} as const;

const navInnerStyle = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 20,
  justifyContent: "space-between",
  margin: "0 auto",
  maxWidth: 1580,
  padding: "16px 24px",
} as const;

const brandEyebrowStyle = {
  color: webTheme.text.muted,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
} as const;

const brandTitleStyle = {
  color: webTheme.text.primary,
  fontSize: 26,
  margin: "2px 0 0",
} as const;

const navLinksStyle = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  justifyContent: "center",
} as const;

const mainStyle = {
  margin: "0 auto",
  maxWidth: 1580,
  padding: "28px 24px 56px",
  position: "relative",
  width: "100%",
  zIndex: 1,
} as const;

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
