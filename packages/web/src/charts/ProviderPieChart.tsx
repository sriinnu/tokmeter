/**
 * Provider pie chart — Plotly component.
 */

import React from "react";
import Plot from "react-plotly.js";

interface Props {
  providers: { provider: string; cost: number; percentageOfTotal: number }[];
}

export function ProviderPieChart({ providers }: Props) {
  if (providers.length === 0) {
    return <div style={{ color: "#8b949e", padding: 24 }}>No provider data to display.</div>;
  }

  return React.createElement(Plot, {
    data: [
      {
        labels: providers.map((p) => p.provider),
        values: providers.map((p) => p.cost),
        type: "pie",
        hole: 0.4,
        marker: {
          colors: [
            "#39d353",
            "#006d32",
            "#26a641",
            "#0e4429",
            "#2ea043",
            "#56d364",
            "#58a6ff",
            "#f0883e",
            "#d2a8ff",
            "#f85149",
            "#79c0ff",
            "#ffa657",
          ],
        },
        textinfo: "label+percent",
      },
    ],
    layout: {
      title: "Cost by Provider",
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: "#8b949e" },
      showlegend: false,
    },
    config: { responsive: true },
    style: { width: "100%", height: 400 },
  });
}
