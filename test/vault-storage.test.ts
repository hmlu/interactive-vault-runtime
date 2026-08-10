import { describe, expect, it, vi } from "vitest";
import { VaultProjectStorage } from "../src/platform/vault-storage";

describe("Vault project storage namespaces", () => {
  it("stores project data below package id and project id", async () => {
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const adapter = {
      exists: vi.fn(async (path: string) => files.has(path) || directories.has(path)),
      mkdir: vi.fn(async (path: string) => { directories.add(path); }),
      write: vi.fn(async (path: string, value: string) => { files.set(path, value); }),
      read: vi.fn(async (path: string) => files.get(path) ?? ""),
      remove: vi.fn(async (path: string) => { files.delete(path); }),
    };
    const app = { vault: { adapter } } as never;
    const storage = new VaultProjectStorage<{ score: number }>(
      app,
      "example.interactive-pack",
      "sample-game",
    );

    await storage.save({ score: 42 });

    expect(adapter.mkdir.mock.calls.map(([path]) => path)).toEqual([
      "data",
      "data/saves",
      "data/saves/example.interactive-pack",
    ]);
    expect(adapter.write).toHaveBeenCalledWith(
      "data/saves/example.interactive-pack/sample-game.json",
      JSON.stringify({ score: 42 }, null, 2),
    );
    await expect(storage.load()).resolves.toEqual({ score: 42 });
  });

  it("rejects ids that could escape the save directory", () => {
    const app = { vault: { adapter: {} } } as never;
    expect(() => new VaultProjectStorage(app, "../outside", "sample-game"))
      .toThrow("safe storage identifiers");
    expect(() => new VaultProjectStorage(app, "example.pack", "../outside"))
      .toThrow("safe storage identifiers");
  });
});
