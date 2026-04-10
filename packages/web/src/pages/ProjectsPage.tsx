import { Link, useParams } from "react-router-dom";
import { projectNameIncludes, projectNamesMatch } from "../../../core/src/project-name.js";
import { ModelCostChart } from "../charts/ModelCostChart.js";
import {
  type TokmeterModelSummary,
  type TokmeterProjectSummary,
  useTokmeterData,
} from "../hooks/useTokmeterData.js";
import { pageCardStyle, webTheme, withAlpha } from "../theme.js";

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
      <div>
        <h2 style={{ color: webTheme.colors.olive }}>{project.project}</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 16,
            marginBottom: 24,
          }}
        >
          <StatCard label="Total Cost" value={`$${project.totalCost.toFixed(2)}`} />
          <StatCard label="Total Tokens" value={formatNum(project.totalTokens)} />
          <StatCard label="Models" value={project.models.length.toString()} />
          <StatCard label="Active Days" value={project.activeDays.toString()} />
        </div>
        <ModelCostChart models={project.models} />

        <h3 style={{ color: webTheme.text.muted, marginTop: 32 }}>Models</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.18)}` }}>
              {["Model", "Provider", "Tokens", "Input", "Output", "Cost", "%"].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: 8, color: webTheme.text.muted }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {project.models.map((m: TokmeterModelSummary) => (
              <tr
                key={`${m.provider}-${m.model}`}
                style={{ borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.1)}` }}
              >
                <td style={{ padding: 8, color: webTheme.text.primary }}>{m.model}</td>
                <td style={{ padding: 8, color: webTheme.text.muted }}>{m.provider}</td>
                <td style={{ padding: 8 }}>{formatNum(m.totalTokens)}</td>
                <td style={{ padding: 8 }}>{formatNum(m.inputTokens)}</td>
                <td style={{ padding: 8 }}>{formatNum(m.outputTokens)}</td>
                <td style={{ padding: 8, color: webTheme.colors.olive }}>${m.cost.toFixed(2)}</td>
                <td style={{ padding: 8, color: webTheme.text.muted }}>
                  {m.percentageOfTotal.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // All projects list
  return (
    <div>
      <h2 style={{ color: webTheme.colors.olive }}>Projects</h2>
      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {data.projects.map((p: TokmeterProjectSummary) => (
          <Link
            key={p.project}
            to={`/projects/${encodeURIComponent(p.project)}`}
            style={{
              display: "block",
              ...pageCardStyle,
              borderRadius: 12,
              padding: 16,
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ color: webTheme.text.primary, fontWeight: 600, fontSize: 16 }}>
                  {p.project}
                </div>
                <div style={{ color: webTheme.text.muted, fontSize: 13 }}>
                  {p.models.length} models | {p.providers.length} providers | {p.activeDays} active
                  days
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: webTheme.colors.olive, fontSize: 18, fontWeight: 700 }}>
                  ${p.totalCost.toFixed(2)}
                </div>
                <div style={{ color: webTheme.text.muted, fontSize: 13 }}>
                  {formatNum(p.totalTokens)} tokens
                </div>
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
    <div style={{ ...pageCardStyle, borderRadius: 12, padding: 16 }}>
      <div style={{ color: webTheme.text.muted, fontSize: 12 }}>{label}</div>
      <div style={{ color: webTheme.text.primary, fontSize: 24, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
