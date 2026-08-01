import { describe, expect, it } from "vitest";
import { parseProjectDirective } from "../src/runtime/directive";

describe("project directive", () => {
  it("parses yaml-like directives", () => {
    expect(parseProjectDirective("id: minesweeper\nmode: embedded")).toEqual({
      id: "minesweeper",
      mode: "embedded",
    });
  });

  it("accepts a bare project id", () => {
    expect(parseProjectDirective("minesweeper")).toEqual({ id: "minesweeper" });
  });

  it("rejects unsafe project ids", () => {
    expect(() => parseProjectDirective("../../game")).toThrow();
  });
});
