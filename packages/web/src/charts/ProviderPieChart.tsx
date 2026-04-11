/**
 * Provider pie chart — Plotly component.
 */

import React from "react";
import Plot from "react-plotly.js";
import { webTheme } from "../theme.js";

interface Props {
  providers: { provider: string; cost: number; percentageOfTotal: number }[];
}

/** Shared Plotly font sizes derived from theme typography tokens */
const baseFontSize = Number.parseInt(webTheme.typography.body.size);
const titleFontSize = Number.parseInt(webTheme.typography.h3.size);

export function ProviderPieChart({ providers }: Props) {
  if (providers.length === 0) {
    return (
      <div style={{ color: webTheme.text.muted, padding: webTheme.spacing.xl }}>
        No provider data to display.
      </div>
    );
  }

  return React.createElement(Plot, {
    data: [
      {
        labels: providers.map((p) => p.provider),
        values: providers.map((p) => p.cost),
        type: "pie",
        hole: 0.4,
        marker: {
          colors: webTheme.charts.providerPalette,
        },
        textinfo: "label+percent",
        textfont: { color: webTheme.text.primary, size: baseFontSize },
      },
    ],
    layout: {
      title: {
        text: "Cost by Provider",
        font: { color: webTheme.text.primary, size: titleFontSize },
      },
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: webTheme.text.muted, size: baseFontSize },
      showlegend: false,
    },
    config: { responsive: true },
    style: { width: "100%", height: 400 },
  });
}
