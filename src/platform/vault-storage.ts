import { normalizePath, type App } from "obsidian";
import type { ProjectStorage } from "../runtime/types";

const STORAGE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export class VaultProjectStorage<T> implements ProjectStorage<T> {
  private readonly directory: string;
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    packageId: string,
    projectId: string,
  ) {
    if (!STORAGE_ID_PATTERN.test(packageId) || !STORAGE_ID_PATTERN.test(projectId)) {
      throw new Error("Package and project ids must be safe storage identifiers");
    }
    this.directory = normalizePath(`data/saves/${packageId}`);
    this.path = normalizePath(`${this.directory}/${projectId}.json`);
  }

  async load(): Promise<T | null> {
    if (!(await this.app.vault.adapter.exists(this.path))) return null;

    try {
      const source = await this.app.vault.adapter.read(this.path);
      return JSON.parse(source) as T;
    } catch (error) {
      console.error(`[Interactive Vault Runtime] 无法读取 ${this.path}`, error);
      return null;
    }
  }

  save(value: T): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await this.ensureSaveDirectory();
      await this.app.vault.adapter.write(this.path, JSON.stringify(value, null, 2));
    });
    return this.writeQueue;
  }

  clear(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      if (await this.app.vault.adapter.exists(this.path)) {
        await this.app.vault.adapter.remove(this.path);
      }
    });
    return this.writeQueue;
  }

  private async ensureSaveDirectory(): Promise<void> {
    for (const directory of ["data", "data/saves", this.directory]) {
      const path = normalizePath(directory);
      if (!(await this.app.vault.adapter.exists(path))) {
        await this.app.vault.adapter.mkdir(path);
      }
    }
  }
}
