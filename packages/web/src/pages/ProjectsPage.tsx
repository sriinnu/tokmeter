import React from "react";
import { useParams } from "react-router-dom";
import { useTokmeterData, type TokmeterProjectSummary, type TokmeterModelSummary } from "../hooks/useTokmeterData.js";
import { ModelCostChart } from "../charts/ModelCostChart.js";

export function ProjectsPage() {
  const { name } = useParams<{ name?: string }>();
  const { data, loading, error } = useTokmeterData();

  if (loading) return <div style={{ color: "#8b949e" }}>Loading...</div>;
  if (error || !data) return <div style={{ color: "#f85149" }}>Error loading data</div>;

  // Single project view
  if (name) {
    const project = data.projects.find(
      (p: TokmeterProjectSummary) => p.project === name || p.project.toLowerCase().includes(name.toLowerCase()),
    );
    if (!project) return <div style={{ color: "#f85149" }}>Project not found</div>;

    return (
      <div>
        <h2 style={{ color: "#39d353" }}>{project.project}</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
          <StatCard label="Total Cost" value={`$${project.totalCost.toFixed(2)}`} />
          <StatCard label="Total Tokens" value={formatNum(project.totalTokens)} />
          <StatCard label="Models" value={project.models.length.toString()} />
          <StatCard label="Active Days" value={project.activeDays.toString()} />
        </div>
        <ModelCostChart models={project.models} />

        <h3 style={{ color: "#8b949e", marginTop: 32 }}>Models</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #30363d" }}>
              {["Model", "Provider", "Tokens", "Input", "Output", "Cost", "%"].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: 8, color: "#8b949e" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {project.models.map((m: TokmeterModelSummary, i: number) => (
              <tr key={i} style={{ borderBottom: "1px solid #21262d" }}>
                <td style={{ padding: 8, color: "#c9d1d9" }}>{m.model}</td>
                <td style={{ padding: 8, color: "#8b949e" }}>{m.provider}</td>
                <td style={{ padding: 8 }}>{formatNum(m.totalTokens)}</td>
                <td style={{ padding: 8 }}>{formatNum(m.inputTokens)}</td>
                <td style={{ padding: 8 }}>{formatNum(m.outputTokens)}</td>
                <td style={{ padding: 8, color: "#39d353" }}>${m.cost.toFixed(2)}</td>
                <td style={{ padding: 8, color: "#8b949e" }}>{m.percentageOfTotal.toFixed(1)}%</td>
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
      <h2 style={{ color: "#39d353" }}>Projects</h2>
      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {data.projects.map((p: TokmeterProjectSummary) => (
          <a
            key={p.project}
            href={`/projects/${encodeURIComponent(p.project)}`}
            style={{
              display: "block",
              background: "#161b22",
              border: "1px solid #30363d",
              borderRadius: 8,
              padding: 16,
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ color: "#c9d1d9", fontWeight: 600, fontSize: 16 }}>{p.project}</div>
                <div style={{ color: "#8b949e", fontSize: 13 }}>
                  {p.models.length} models | {p.providers.length} providers | {p.activeDays} active days
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#39d353", fontSize: 18, fontWeight: 700 }}>${p.totalCost.toFixed(2)}</div>
                <div style={{ color: "#8b949e", fontSize: 13 }}>{formatNum(p.totalTokens)} tokens</div>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 8, padding: 16 }}>
      <div style={{ color: "#8b949e", fontSize: 12 }}>{label}</div>
      <div style={{ color: "#c9d1d9", fontSize: 24, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
