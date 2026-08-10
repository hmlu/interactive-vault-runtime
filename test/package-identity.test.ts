import { describe, expect, it } from "vitest";
import {
  findInstalledPackageIdForProject,
  STANDALONE_PACKAGE_ID,
} from "../src/packages/package-identity";
import type { InstalledPackageRecord } from "../src/packages/package-manager";

describe("installed package project identity", () => {
  const installedPackage: InstalledPackageRecord = {
    id: "example.interactive-pack",
    title: "Example pack",
    version: "1.0.0",
    publisher: { id: "example", name: "Example" },
    targetPath: "Interactive Apps/example.interactive-pack",
    entryNote: "index.md",
    source: { type: "local", name: "example.ivpkg" },
    installedAt: "2026-08-10T00:00:00.000Z",
    files: ["index.md", "apps/sample/project.json", "apps/sample/dist/main.js"],
  };

  it("finds the package that owns an installed project manifest", () => {
    expect(findInstalledPackageIdForProject(
      "Interactive Apps/example.interactive-pack/apps/sample/project.json",
      [installedPackage],
    )).toBe("example.interactive-pack");
  });

  it("does not classify a similarly prefixed external manifest as package content", () => {
    expect(findInstalledPackageIdForProject(
      "Interactive Apps/example.interactive-pack-copy/apps/sample/project.json",
      [installedPackage],
    )).toBeNull();
  });

  it("provides a stable namespace for projects outside installed packages", () => {
    expect(STANDALONE_PACKAGE_ID).toBe("standalone");
  });
});
