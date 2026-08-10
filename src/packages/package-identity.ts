import { normalizePath } from "obsidian";
import type { InstalledPackageRecord } from "./package-manager";

export const STANDALONE_PACKAGE_ID = "standalone";

export function findInstalledPackageIdForProject(
  manifestPath: string,
  installedPackages: readonly InstalledPackageRecord[],
): string | null {
  const normalizedManifestPath = normalizePath(manifestPath);

  for (const record of installedPackages) {
    const targetPath = normalizePath(record.targetPath);
    for (const relativePath of record.files) {
      if (normalizePath(`${targetPath}/${relativePath}`) === normalizedManifestPath) {
        return record.id;
      }
    }
  }

  return null;
}
