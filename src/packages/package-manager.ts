import {
  normalizePath,
  requestUrl,
  TFile,
  TFolder,
  type App,
} from "obsidian";
import {
  IVPKG_LIMITS,
  readInteractivePackage,
  validateInteractivePackageManifest,
  type ParsedInteractivePackage,
} from "./ivpkg";

export type InstalledPackageSource =
  | { type: "local"; name: string }
  | { type: "url"; url: string };

export interface InstalledPackageRecord {
  id: string;
  title: string;
  version: string;
  publisher: { id: string; name: string };
  targetPath: string;
  entryNote?: string;
  source: InstalledPackageSource;
  installedAt: string;
  files: string[];
}

export function readInstalledPackageRecords(value: unknown): InstalledPackageRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((record): record is InstalledPackageRecord => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const input = record as Partial<InstalledPackageRecord>;
    const publisher = input.publisher;
    const source = input.source;
    return typeof input.id === "string"
      && typeof input.title === "string"
      && typeof input.version === "string"
      && typeof input.targetPath === "string"
      && typeof input.installedAt === "string"
      && (input.entryNote === undefined || typeof input.entryNote === "string")
      && Array.isArray(input.files)
      && input.files.every((path) => typeof path === "string")
      && Boolean(publisher)
      && typeof publisher?.id === "string"
      && typeof publisher?.name === "string"
      && Boolean(source)
      && ((source?.type === "local" && typeof source.name === "string")
        || (source?.type === "url" && typeof source.url === "string"));
  });
}

export class InteractivePackageManager {
  constructor(private readonly app: App) {}

  inspect(data: ArrayBuffer | Uint8Array): Promise<ParsedInteractivePackage> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return readInteractivePackage(bytes);
  }

  async download(url: string): Promise<ParsedInteractivePackage> {
    const normalizedUrl = validatePackageUrl(url);
    const response = await requestUrl({ url: normalizedUrl, method: "GET" });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Package download failed with HTTP ${response.status}`);
    }
    if (response.arrayBuffer.byteLength > IVPKG_LIMITS.archiveBytes) {
      throw new Error("The downloaded .ivpkg file is too large");
    }
    return this.inspect(response.arrayBuffer);
  }

  async install(
    pkg: ParsedInteractivePackage,
    target: string,
    source: InstalledPackageSource,
    installedPackages: readonly InstalledPackageRecord[],
  ): Promise<InstalledPackageRecord> {
    const targetPath = validateTargetPath(target, this.app.vault.configDir);
    const existing = installedPackages.find((record) => record.id === pkg.manifest.id);
    if (existing && normalizePath(existing.targetPath) !== targetPath) {
      throw new Error(`This package is already installed at ${existing.targetPath}`);
    }
    for (const record of installedPackages) {
      if (record.id === pkg.manifest.id) continue;
      const installedPath = normalizePath(record.targetPath);
      if (isSameOrNested(targetPath, installedPath) || isSameOrNested(installedPath, targetPath)) {
        throw new Error(`The install folder overlaps the managed package at ${record.targetPath}`);
      }
    }

    const currentTarget = this.app.vault.getAbstractFileByPath(targetPath);
    const recovered = currentTarget && !existing
      ? await this.isMatchingManagedFolder(targetPath, pkg.manifest.id)
      : false;
    if (currentTarget && !existing && !recovered) {
      throw new Error("The selected folder already exists and is not managed by this plugin");
    }
    if (currentTarget && !(currentTarget instanceof TFolder)) {
      throw new Error("The selected install path is an existing file");
    }

    const parentPath = dirname(targetPath);
    await this.ensureFolder(parentPath);
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stagingPath = joinVaultPath(parentPath, `${basename(targetPath)}.ivpkg-staging-${nonce}`);
    const backupPath = joinVaultPath(parentPath, `${basename(targetPath)}.ivpkg-backup-${nonce}`);
    let previousMoved = false;
    let installed = false;

    try {
      await this.app.vault.createFolder(stagingPath);
      for (const [relativePath, data] of [...pkg.files.entries()].sort(([left], [right]) =>
        left.localeCompare(right, "en")
      )) {
        const destination = `${stagingPath}/${relativePath}`;
        await this.ensureFolder(dirname(destination));
        await this.app.vault.createBinary(destination, toArrayBuffer(data));
      }
      await this.app.vault.create(
        `${stagingPath}/iv-package.json`,
        `${JSON.stringify(pkg.manifest, null, 2)}\n`,
      );

      const existingTarget = this.app.vault.getAbstractFileByPath(targetPath);
      if (existingTarget) {
        await this.app.vault.rename(existingTarget, backupPath);
        previousMoved = true;
      }
      const staging = this.app.vault.getFolderByPath(stagingPath);
      if (!staging) throw new Error("The package staging folder disappeared before installation");
      await this.app.vault.rename(staging, targetPath);
      installed = true;
    } catch (error) {
      if (previousMoved && !this.app.vault.getAbstractFileByPath(targetPath)) {
        const backup = this.app.vault.getFolderByPath(backupPath);
        if (backup) await this.app.vault.rename(backup, targetPath);
      }
      await this.trashIfPresent(stagingPath);
      throw error;
    }

    if (installed && previousMoved) await this.trashIfPresent(backupPath);
    return {
      id: pkg.manifest.id,
      title: pkg.manifest.title,
      version: pkg.manifest.version,
      publisher: pkg.manifest.publisher,
      targetPath,
      entryNote: pkg.manifest.entryNote,
      source,
      installedAt: new Date().toISOString(),
      files: pkg.manifest.files.map((file) => file.path),
    };
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path) return;
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const stat = await this.app.vault.adapter.stat(current);
      if (stat?.type === "file") throw new Error(`A file blocks the install folder: ${current}`);
      if (stat?.type === "folder") continue;

      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) throw new Error(`A file blocks the install folder: ${current}`);
      if (existing instanceof TFolder) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        const created = await this.app.vault.adapter.stat(current);
        if (created?.type !== "folder") throw error;
      }
    }
  }

  private async isMatchingManagedFolder(targetPath: string, packageId: string): Promise<boolean> {
    const marker = this.app.vault.getFileByPath(`${targetPath}/iv-package.json`);
    if (!marker) return false;
    try {
      const manifest = validateInteractivePackageManifest(JSON.parse(await this.app.vault.read(marker)));
      return manifest.id === packageId;
    } catch {
      return false;
    }
  }

  private async trashIfPresent(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return;
    try {
      await this.app.vault.trash(file, false);
    } catch (error) {
      console.warn(`[Interactive Vault Runtime] Could not move ${path} to trash`, error);
    }
  }
}

export function validatePackageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid package URL");
  }
  if (url.protocol !== "https:") throw new Error("Remote packages must use HTTPS");
  return url.toString();
}

export function validateTargetPath(value: string, configDir: string): string {
  const input = value.trim();
  if (
    !input ||
    input.startsWith("/") ||
    input.includes("\\") ||
    input.includes(":") ||
    input.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Choose a folder inside the current Vault");
  }
  const path = normalizePath(input);
  const protectedRoots = [normalizePath(configDir), ".trash", "data"];
  if (protectedRoots.some((root) => isSameOrNested(path, root))) {
    throw new Error("Packages cannot be installed in the Vault configuration, trash, or Runtime data folder");
  }
  return path;
}

function isSameOrNested(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

function dirname(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function basename(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? path : path.slice(separator + 1);
}

function joinVaultPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
