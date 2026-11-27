import { describe, expect, it } from "vitest";
import { type AmbientBarData, formatBarOutput, renderBarSnippet } from "./bar.js";

const SAMPLE: AmbientBarData = {
  todayCost: 4.56,
  todayTokens: 1_250_000,
  repoCost: 1.23,
  repoName: "tokmeter",
  paceMultiple: 1.4,
  dailyBudget: 10,
  liveCount: 1,
  activeAgent: "claude-code",
  contextFillPct: 42,
  topQuotaPct: 65,
  topQuotaLabel: "claude-code:5h",
  source: "daemon",
  computedAt: 1_795_760_000_000,
};

describe("tokmeter bar formatters and snippets", () => {
  it("formats plain, ansi, tmux, polybar, powershell, starship, json, and waybar", () => {
    expect(formatBarOutput(SAMPLE, "plain")).toContain("$4.56");
    expect(formatBarOutput(SAMPLE, "plain")).toContain("1.3M tok");
    expect(formatBarOutput(SAMPLE, "ansi")).toContain("\x1b[");
    expect(formatBarOutput(SAMPLE, "tmux")).toContain("#[fg=");
    expect(formatBarOutput(SAMPLE, "polybar")).toContain("%{F");
    expect(formatBarOutput(SAMPLE, "starship")).toBe(formatBarOutput(SAMPLE, "plain"));
    expect(formatBarOutput(SAMPLE, "powershell")).toBe(formatBarOutput(SAMPLE, "plain"));

    const waybar = JSON.parse(formatBarOutput(SAMPLE, "waybar")) as {
      text: string;
      tooltip: string;
      class: string;
      percentage: number;
    };
    expect(waybar.text).toContain("$4.56");
    expect(waybar.class).toBe("tokmeter-ok");
    expect(waybar.percentage).toBe(46);

    const parsedJson = JSON.parse(formatBarOutput(SAMPLE, "json")) as AmbientBarData;
    expect(parsedJson.todayCost).toBe(4.56);
  });

  it("renders valid shell/bar snippets for every supported target", () => {
    for (const target of [
      "tmux",
      "starship",
      "waybar",
      "polybar",
      "zsh",
      "fish",
      "powershell",
    ] as const) {
      expect(renderBarSnippet(target)).toContain("tokmeter bar");
    }
  });
});
