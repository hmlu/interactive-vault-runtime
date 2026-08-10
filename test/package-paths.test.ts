import { describe, expect, it } from "vitest";
import { createDefaultInstallPath } from "../src/packages/package-paths";

describe("default package install path", () => {
  it("uses the user-facing package title instead of its internal id", () => {
    expect(createDefaultInstallPath("Puzzle Suite")).toBe("Interactive Apps/Puzzle Suite");
  });

  it("keeps localized titles and removes unsafe path characters", () => {
    expect(createDefaultInstallPath("  游戏合集：桌面/移动端  "))
      .toBe("Interactive Apps/游戏合集：桌面 移动端");
  });

  it("uses a readable fallback when the title has no safe characters", () => {
    expect(createDefaultInstallPath("../\\"))
      .toBe("Interactive Apps/Interactive Package");
  });
});
