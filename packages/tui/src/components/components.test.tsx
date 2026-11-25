import { PassThrough } from "node:stream";
import { render } from "ink";
import type React from "react";
import { describe, expect, it } from "vitest";
import { BarChart } from "./BarChart.js";
import { Heatmap } from "./Heatmap.js";
import { Sparkline } from "./Sparkline.js";

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function renderComponent(element: React.ReactElement): string {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { columns: 100, rows: 30, isTTY: true });
  const chunks: string[] = [];
  stdout.on("data", (d: Buffer) => chunks.push(d.toString("utf8")));

  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  });

  const app = render(element, { stdout, stdin, debug: true, exitOnCtrlC: false });
  const text = chunks.join("").replace(ANSI_ESCAPE_RE, "");
  app.unmount();
  return text;
}

describe("TUI chart components", () => {
  it("renders BarChart items and handles empty data", () => {
    expect(renderComponent(<BarChart data={[]} />)).toContain("No data");
    const out = renderComponent(
      <BarChart
        data={[
          { label: "claude-sonnet", value: 1500, maxValue: 2000 },
          { label: "gpt-5", value: 500, maxValue: 2000 },
        ]}
        width={20}
      />
    );
    expect(out).toContain("claude-sonnet");
    expect(out).toContain("1.5K");
    expect(out).toContain("75.0%");
    expect(out).toContain("gpt-5");
    expect(out).toContain("25.0%");
  });

  it("renders Heatmap grid and handles empty activity", () => {
    expect(renderComponent(<Heatmap data={[]} />)).toContain("No activity data");
    const out = renderComponent(
      <Heatmap
        data={[
          { date: "2026-11-23", value: 10 },
          { date: "2026-11-24", value: 40 },
        ]}
        weeks={4}
      />
    );
    expect(out).toContain("Contribution Heatmap");
    expect(out).toContain("Mon");
    expect(out).toContain("Less");
    expect(out).toContain("More");
  });

  it("renders Sparkline with label, range, and empty fallback", () => {
    expect(renderComponent(<Sparkline data={[]} />)).toContain("No data");
    const out = renderComponent(
      <Sparkline label="Cost/d" data={[100, 500, 1500, 2000]} width={10} />
    );
    expect(out).toContain("Cost/d");
    expect(out).toContain("100–2.0K");
  });
});
