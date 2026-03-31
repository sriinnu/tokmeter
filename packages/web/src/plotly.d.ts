/**
 * Type declarations for react-plotly.js
 */
declare module "react-plotly.js" {
  import { Component } from "react";

  interface PlotParams {
    data: Plotly.Data[];
    layout?: Partial<Plotly.Layout>;
    config?: Partial<Plotly.Config>;
    style?: React.CSSProperties;
    className?: string;
    divId?: string;
    onInitialized?: (figure: Plotly.Figure, graphDiv: HTMLElement) => void;
    onUpdate?: (figure: Plotly.Figure, graphDiv: HTMLElement) => void;
    onPurge?: (figure: Plotly.Figure, graphDiv: HTMLElement) => void;
    onError?: (err: Error) => void;
    useResizeHandler?: boolean;
    revision?: number;
  }

  class Plot extends Component<PlotParams> {}
  export default Plot;
}

declare namespace Plotly {
  interface Data {
    x?: (string | number)[];
    y?: (string | number)[];
    z?: (number | number[] | number[][])[] | number[][];
    type?: string;
    mode?: string;
    name?: string;
    line?: { color?: string; shape?: string };
    marker?: { color?: string | string[]; colors?: string[] };
    textinfo?: string;
    hole?: number;
    showscale?: boolean;
    colorbar?: { title?: string };
    colorscale?: (number | string)[][] | string;
    labels?: string[];
    values?: number[];
  }

  interface Layout {
    title?: string | { text: string };
    xaxis?: { title?: string; tickangle?: number; visible?: boolean };
    yaxis?: { title?: string; side?: string; overlaying?: string; rangemode?: string; visible?: boolean };
    yaxis2?: { title?: string; side?: string; overlaying?: string; rangemode?: string };
    legend?: { orientation?: string; y?: number };
    margin?: { t?: number; b?: number; l?: number; r?: number };
    paper_bgcolor?: string;
    plot_bgcolor?: string;
    font?: { color?: string };
    showlegend?: boolean;
    scene?: {
      xaxis?: { title?: string };
      yaxis?: { title?: string };
      zaxis?: { title?: string };
      camera?: { eye?: { x: number; y: number; z: number } };
    };
    width?: number;
    height?: number;
  }

  interface Config {
    responsive?: boolean;
  }

  interface Figure {
    data: Data[];
    layout: Layout;
  }
}
