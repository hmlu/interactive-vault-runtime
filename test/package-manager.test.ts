import { TFolder } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { ParsedInteractivePackage } from "../src/packages/ivpkg";
import {
  InteractivePackageManager,
  validateTargetPath,
} from "../src/packages/package-manager";

describe("interactive package install target", () => {
  it("allows a dedicated application directory", () => {
    expect(validateTargetPath("Interactive Apps/example.pack", ".obsidian"))
      .toBe("Interactive Apps/example.pack");
  });

  it("protects runtime save data from package replacement", () => {
    expect(() => validateTargetPath("data", ".obsidian")).toThrow("Runtime data");
    expect(() => validateTargetPath("data/saves/example.pack", ".obsidian"))
      .toThrow("Runtime data");
  });

  it("allows multiple packages to share an existing install root while the file cache catches up", async () => {
    const directories = new Set<string>();
    const files = new Map<string, Uint8Array | string>();
    const stat = vi.fn(async (path: string) => {
      if (directories.has(path)) return { type: "folder" as const, ctime: 0, mtime: 0, size: 0 };
      if (files.has(path)) return { type: "file" as const, ctime: 0, mtime: 0, size: 0 };
      return null;
    });
    const createFolder = vi.fn(async (path: string) => {
      if (directories.has(path)) throw new Error("Folder already exists.");
      directories.add(path);
    });
    const vault = {
      configDir: ".obsidian",
      adapter: { stat },
      getAbstractFileByPath: vi.fn(() => null),
      createFolder,
      createBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
        files.set(path, new Uint8Array(data));
      }),
      create: vi.fn(async (path: string, source: string) => { files.set(path, source); }),
      getFolderByPath: vi.fn((path: string) => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        if (name.startsWith(".")) return null;
        return directories.has(path) ? Object.assign(new TFolder(), { path }) : null;
      }),
      rename: vi.fn(async (folder: TFolder, target: string) => {
        directories.delete(folder.path);
        directories.add(target);
      }),
      trash: vi.fn(async () => undefined),
    };
    const manager = new InteractivePackageManager({ vault } as never);
    const data = new TextEncoder().encode("home");
    const pkg: ParsedInteractivePackage = {
      manifest: {
        schemaVersion: 1,
        id: "example.pack",
        title: "Example pack",
        version: "1.0.0",
        publisher: { id: "example", name: "Example" },
        entryNote: "index.md",
        projects: [{
          id: "sample",
          title: "Sample",
          version: "1.0.0",
          manifest: "project.json",
        }],
        files: [{ path: "index.md", size: data.byteLength, sha256: "0".repeat(64) }],
      },
      files: new Map([["index.md", data]]),
      archiveSize: data.byteLength,
      contentSize: data.byteLength,
    };

    const record = await manager.install(
      pkg,
      "Interactive Apps/Example pack",
      { type: "local", name: "example.ivpkg" },
      [],
    );

    expect(record.targetPath).toBe("Interactive Apps/Example pack");
    expect(directories.has("Interactive Apps/Example pack")).toBe(true);
    expect(createFolder.mock.calls.filter(([path]) => String(path).includes("ivpkg-staging")))
      .toHaveLength(1);
    expect(createFolder.mock.calls.some(([path]) => String(path).includes("/.")))
      .toBe(false);

    const secondPackage: ParsedInteractivePackage = {
      ...pkg,
      manifest: {
        ...pkg.manifest,
        id: "second.pack",
        title: "Second pack",
      },
    };
    const secondRecord = await manager.install(
      secondPackage,
      "Interactive Apps/Second pack",
      { type: "local", name: "second.ivpkg" },
      [record],
    );

    expect(secondRecord.targetPath).toBe("Interactive Apps/Second pack");
    expect(directories.has("Interactive Apps/Example pack")).toBe(true);
    expect(directories.has("Interactive Apps/Second pack")).toBe(true);
    expect(createFolder.mock.calls.filter(([path]) => path === "Interactive Apps"))
      .toHaveLength(1);
  });
});
