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
        <style>{`
          @keyframes fadeUp {
            from { opacity: 0; transform: translateY(12px); }
            to   { opacity: 1; transform: translateY(0); }
          }
        `}</style>
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
        borderRadius: webTheme.radii.pill,
        color: isActive ? webTheme.text.primary : webTheme.text.secondary,
        textDecoration: "none",
        fontSize: webTheme.typography.body.size,
        fontWeight: isActive ? 700 : 600,
        padding: `10px ${webTheme.spacing.md}`,
        transition: `background ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}, border ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}, color ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
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
        <div style={{ color: webTheme.text.danger, padding: webTheme.spacing.xl }}>
          <h2>Something went wrong</h2>
          <pre
            style={{
              color: webTheme.text.muted,
              fontSize: webTheme.typography.mono.size,
            }}
          >
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
        gap: webTheme.spacing.sm,
        fontSize: webTheme.typography.mono.size,
        color: isLive ? webTheme.status.live : webTheme.text.secondary,
        background: webTheme.surfaces.cardBackground,
        border: `1px solid ${webTheme.surfaces.cardBorder}`,
        borderRadius: webTheme.radii.pill,
        padding: `10px ${webTheme.spacing.md}`,
        transition: `color ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
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
          animation: isLive
            ? `pulse ${webTheme.motion.duration.glacial} ${webTheme.motion.easing.smooth} infinite`
            : "none",
          transition: `background-color ${webTheme.motion.duration.normal} ${webTheme.motion.easing.default}`,
        }}
      />
      <span>{label}</span>
      {isLive && sessionCount > 0 && (
        <span
          style={{
            background: withAlpha(webTheme.colors.teal, 0.32),
            border: `1px solid ${withAlpha(webTheme.colors.cream, 0.12)}`,
            borderRadius: webTheme.radii.pill,
            padding: `1px ${webTheme.spacing.sm}`,
            fontSize: webTheme.typography.micro.size,
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

/** Top-left olive aura — 420×420 orb, offset into the corner */
const leftAuraStyle = {
  background: `radial-gradient(circle, ${withAlpha(webTheme.colors.olive, 0.18)}, transparent 62%)`,
  filter: "blur(18px)",
  height: 420,
  left: -120,
  position: "absolute",
  top: -120,
  width: 420,
} as const;

/** Right teal aura — 360×360 orb, offset right edge */
const rightAuraStyle = {
  background: `radial-gradient(circle, ${withAlpha(webTheme.colors.teal, 0.16)}, transparent 62%)`,
  filter: "blur(24px)",
  height: 360,
  position: "absolute",
  right: -80,
  top: 120,
  width: 360,
} as const;

/** Bottom rose aura — 420×420 orb, anchored at 25% from left */
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
  gap: webTheme.spacing.xl,
  justifyContent: "space-between",
  margin: "0 auto",
  maxWidth: 1580,
  padding: `${webTheme.spacing.lg} ${webTheme.spacing.xl}`,
} as const;

const brandEyebrowStyle = {
  color: webTheme.text.muted,
  fontSize: webTheme.typography.micro.size,
  fontWeight: webTheme.typography.micro.weight,
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
  gap: webTheme.spacing.md,
  justifyContent: "center",
} as const;

const mainStyle = {
  animation: `fadeUp ${webTheme.motion.duration.slow} ${webTheme.motion.easing.decelerate} both`,
  margin: "0 auto",
  maxWidth: 1580,
  padding: `${webTheme.spacing["2xl"]} ${webTheme.spacing.xl} ${webTheme.spacing["3xl"]}`,
  position: "relative",
  width: "100%",
  zIndex: 1,
} as const;

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
