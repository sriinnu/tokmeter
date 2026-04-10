import type { CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { projectNameIncludes, projectNamesMatch } from "../../../core/src/project-name.js";
import { ModelCostChart } from "../charts/ModelCostChart.js";
import {
  type TokmeterModelSummary,
  type TokmeterProjectSummary,
  useTokmeterData,
} from "../hooks/useTokmeterData.js";
import { applyTypography, pageCardStyle, webTheme, withAlpha } from "../theme.js";

/**
 * Render the project overview list and the project detail route.
 */
export function ProjectsPage() {
  const { name } = useParams<{ name?: string }>();
  const { data, loading, error } = useTokmeterData();
  const requestedProject = decodeURIComponent(name ?? "");

  if (loading) return <div style={{ color: webTheme.text.muted }}>Loading...</div>;
  if (error || !data) return <div style={{ color: webTheme.text.danger }}>Error loading data</div>;

  // Single project view
  if (name) {
    const project =
      data.projects.find((entry: TokmeterProjectSummary) =>
        projectNamesMatch(entry.project, requestedProject)
      ) ??
      data.projects.find((entry: TokmeterProjectSummary) =>
        projectNameIncludes(entry.project, requestedProject)
      );

    if (!project) return <div style={{ color: webTheme.text.danger }}>Project not found</div>;

    return (
      <div style={pageContainerStyle}>
        <h2 style={pageTitleStyle}>{project.project}</h2>
        <div style={statGridStyle}>
          <StatCard label="Total Cost" value={`$${project.totalCost.toFixed(2)}`} />
          <StatCard label="Total Tokens" value={formatNum(project.totalTokens)} />
          <StatCard label="Models" value={project.models.length.toString()} />
          <StatCard label="Active Days" value={project.activeDays.toString()} />
        </div>
        <ModelCostChart models={project.models} />

        <h3 style={sectionHeadingStyle}>Models</h3>
        <table style={tableStyle}>
          <thead>
            <tr style={theadRowStyle}>
              {["Model", "Provider", "Tokens", "Input", "Output", "Cost", "%"].map((h) => (
                <th key={h} style={thStyle}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {project.models.map((m: TokmeterModelSummary) => (
              <tr key={`${m.provider}-${m.model}`} style={tbodyRowStyle}>
                <td style={tdPrimaryStyle}>{m.model}</td>
                <td style={tdMutedStyle}>{m.provider}</td>
                <td style={tdStyle}>{formatNum(m.totalTokens)}</td>
                <td style={tdStyle}>{formatNum(m.inputTokens)}</td>
                <td style={tdStyle}>{formatNum(m.outputTokens)}</td>
                <td style={tdAccentStyle}>${m.cost.toFixed(2)}</td>
                <td style={tdMutedStyle}>{m.percentageOfTotal.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // All projects list
  return (
    <div style={pageContainerStyle}>
      <h2 style={pageTitleStyle}>Projects</h2>
      <div style={listStackStyle}>
        {data.projects.map((p: TokmeterProjectSummary, i: number) => (
          <Link
            key={p.project}
            to={`/projects/${encodeURIComponent(p.project)}`}
            style={{
              ...projectCardStyle,
              animation: `fadeUp ${webTheme.motion.duration.slow} ${webTheme.motion.easing.decelerate} both`,
              animationDelay: `${i * 60}ms`,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={projectNameStyle}>{p.project}</div>
                <div style={projectMetaStyle}>
                  {p.models.length} models | {p.providers.length} providers | {p.activeDays} active
                  days
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={projectCostStyle}>${p.totalCost.toFixed(2)}</div>
                <div style={projectMetaStyle}>{formatNum(p.totalTokens)} tokens</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={statCardStyle}>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

/* ── Style tokens ─────────────────────────────────────────────── */

const pageContainerStyle: CSSProperties = {
  animation: `fadeUp ${webTheme.motion.duration.slow} ${webTheme.motion.easing.decelerate} both`,
};

const pageTitleStyle: CSSProperties = {
  color: webTheme.colors.olive,
  ...applyTypography(webTheme.typography.h1),
};

const statGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: webTheme.spacing.lg,
  marginBottom: webTheme.spacing.xl,
};

const statCardStyle: CSSProperties = {
  ...pageCardStyle,
  borderRadius: webTheme.radii.md,
  padding: webTheme.spacing.lg,
  boxShadow: webTheme.elevation.low,
  transition: `box-shadow ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
};

const statLabelStyle: CSSProperties = {
  color: webTheme.text.muted,
  ...applyTypography(webTheme.typography.caption),
};

const statValueStyle: CSSProperties = {
  color: webTheme.text.primary,
  ...applyTypography(webTheme.typography.h1),
};

const sectionHeadingStyle: CSSProperties = {
  color: webTheme.text.muted,
  ...applyTypography(webTheme.typography.h3),
  marginTop: webTheme.spacing["2xl"],
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const theadRowStyle: CSSProperties = {
  borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.18)}`,
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: webTheme.spacing.sm,
  color: webTheme.text.muted,
  ...applyTypography(webTheme.typography.caption),
  fontWeight: 700,
};

const tbodyRowStyle: CSSProperties = {
  borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.1)}`,
  transition: `background ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
};

const tdStyle: CSSProperties = {
  padding: webTheme.spacing.sm,
  ...applyTypography(webTheme.typography.body),
};

const tdPrimaryStyle: CSSProperties = {
  ...tdStyle,
  color: webTheme.text.primary,
};

const tdMutedStyle: CSSProperties = {
  ...tdStyle,
  color: webTheme.text.muted,
};

const tdAccentStyle: CSSProperties = {
  ...tdStyle,
  color: webTheme.colors.olive,
};

const listStackStyle: CSSProperties = {
  display: "grid",
  gap: webTheme.spacing.md,
  marginTop: webTheme.spacing.lg,
};

const projectCardStyle: CSSProperties = {
  display: "block",
  ...pageCardStyle,
  borderRadius: webTheme.radii.md,
  padding: webTheme.spacing.lg,
  textDecoration: "none",
  color: "inherit",
  boxShadow: webTheme.elevation.low,
  transition: `box-shadow ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}, transform ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
};

const projectNameStyle: CSSProperties = {
  color: webTheme.text.primary,
  ...applyTypography(webTheme.typography.h3),
  fontSize: webTheme.spacing.lg,
};

const projectMetaStyle: CSSProperties = {
  color: webTheme.text.muted,
  ...applyTypography(webTheme.typography.mono),
};

const projectCostStyle: CSSProperties = {
  color: webTheme.colors.olive,
  ...applyTypography(webTheme.typography.h3),
};
