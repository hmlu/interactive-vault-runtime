import { describe, expect, it } from "vitest";
import { parseProjectDirective } from "../src/runtime/directive";

describe("project directive", () => {
  it("parses yaml-like directives", () => {
    expect(parseProjectDirective("id: sample-app\nmode: embedded")).toEqual({
      id: "sample-app",
      mode: "embedded",
    });
  });

  it("accepts a bare project id", () => {
    expect(parseProjectDirective("sample-app")).toEqual({ id: "sample-app" });
  });

  it("accepts a generic manifest path", () => {
    expect(parseProjectDirective("manifest: tools/timer/project.json\nmode: view")).toEqual({
      manifest: "tools/timer/project.json",
      mode: "view",
    });
  });

  it("rejects unsafe project ids", () => {
    expect(() => parseProjectDirective("../../game")).toThrow();
  });

  it("requires an id or manifest", () => {
    expect(() => parseProjectDirective("mode: embedded")).toThrow();
  });
});
