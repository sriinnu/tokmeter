import { describe, expect, test } from "vitest";
import { csvCell } from "./server.js";

describe("csvCell", () => {
  test.each(["=1+1", "+cmd", "-2+3", "@SUM(A1:A2)", '  =HYPERLINK("https://x")'])(
    "neutralizes spreadsheet formula text: %s",
    (value) => {
      const cell = csvCell(value);
      expect(cell.startsWith("\"'")).toBe(true);
      expect(cell.endsWith('"')).toBe(true);
    }
  );

  test("quotes commas and embedded quotes using RFC 4180 escaping", () => {
    expect(csvCell('safe, "quoted"')).toBe('"safe, ""quoted"""');
  });
});
