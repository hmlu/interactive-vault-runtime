import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  readInteractivePackage,
  type InteractivePackageFile,
  type InteractivePackageManifest,
} from "../src/packages/ivpkg";

describe(".ivpkg reader", () => {
  it("reads a valid generic package and verifies its files", async () => {
    const archive = await createPackage();
    const pkg = await readInteractivePackage(archive);

    expect(pkg.manifest.id).toBe("example.interactive-pack");
    expect(pkg.manifest.projects).toHaveLength(1);
    expect([...pkg.files.keys()]).toEqual([
      "apps/sample/project.json",
      "apps/sample/dist/main.js",
      "apps/sample/dist/styles.css",
      "index.md",
    ]);
  });

  it("rejects content whose checksum does not match the manifest", async () => {
    const archive = await createPackage({ overrideHash: "0".repeat(64) });
    await expect(readInteractivePackage(archive)).rejects.toThrow("checksum does not match");
  });

  it("rejects files not declared by the package manifest", async () => {
    const archive = await createPackage({ extraFile: true });
    await expect(readInteractivePackage(archive)).rejects.toThrow("undeclared file");
  });

  it("rejects archive paths that escape the package root", async () => {
    const archive = zipSync({ "../outside.js": strToU8("unsafe") });
    await expect(readInteractivePackage(archive)).rejects.toThrow("unsafe");
  });

  it("rejects projects whose declared runtime entry is missing", async () => {
    const archive = await createPackage({ omitRuntimeEntry: true });
    await expect(readInteractivePackage(archive)).rejects.toThrow("Project file is missing");
  });
});

async function createPackage(options: {
  overrideHash?: string;
  extraFile?: boolean;
  omitRuntimeEntry?: boolean;
} = {}): Promise<Uint8Array> {
  const content = new Map<string, Uint8Array>([
    ["apps/sample/project.json", strToU8(JSON.stringify({
      schemaVersion: 1,
      id: "sample-app",
      title: "Sample app",
      version: "1.0.0",
      entry: "dist/main.js",
      styles: ["dist/styles.css"],
    }))],
    ["apps/sample/dist/main.js", strToU8("module.exports={mount(){}};")],
    ["apps/sample/dist/styles.css", strToU8(".sample { color: red; }")],
    ["index.md", strToU8("```interactive-vault\nid: sample-app\n```")],
  ]);
  if (options.omitRuntimeEntry) content.delete("apps/sample/dist/main.js");

  const files: InteractivePackageFile[] = [];
  for (const [path, data] of content) {
    files.push({
      path,
      size: data.byteLength,
      sha256: options.overrideHash && path === "index.md" ? options.overrideHash : await sha256(data),
    });
  }
  const manifest: InteractivePackageManifest = {
    schemaVersion: 1,
    id: "example.interactive-pack",
    title: "Example interactive pack",
    version: "1.0.0",
    publisher: { id: "example", name: "Example publisher" },
    kind: "collection",
    entryNote: "index.md",
    projects: [{
      id: "sample-app",
      title: "Sample app",
      kind: "app",
      version: "1.0.0",
      manifest: "apps/sample/project.json",
      entryNote: "index.md",
    }],
    files,
  };
  const archiveFiles: Record<string, Uint8Array> = {
    "iv-package.json": strToU8(JSON.stringify(manifest)),
  };
  for (const [path, data] of content) archiveFiles[`content/${path}`] = data;
  if (options.extraFile) archiveFiles["content/undeclared.txt"] = strToU8("extra");
  return zipSync(archiveFiles, { level: 6 });
}

async function sha256(data: Uint8Array): Promise<string> {
  const input = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
