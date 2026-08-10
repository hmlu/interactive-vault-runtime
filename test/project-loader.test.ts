import { describe, expect, it } from "vitest";
import { validateProjectManifest } from "../src/runtime/project-loader";

describe("project manifest localization", () => {
  it("keeps normalized titles for every declared language", () => {
    const manifest = validateProjectManifest({
      schemaVersion: 1,
      id: "sample-game",
      title: "示例游戏",
      titleI18n: { en: " Sample Game ", ja: "サンプルゲーム" },
      entry: "dist/main.js",
    });

    expect(manifest.titleI18n).toEqual({ en: "Sample Game", ja: "サンプルゲーム" });
  });

  it("rejects non-string localized titles", () => {
    expect(() => validateProjectManifest({
      schemaVersion: 1,
      id: "sample-game",
      title: "示例游戏",
      titleI18n: { en: 42 },
      entry: "dist/main.js",
    })).toThrow("titleI18n");
  });
});
