import { strFromU8, unzipSync, type UnzipFileInfo } from "fflate";

const PACKAGE_MANIFEST_PATH = "iv-package.json";
const CONTENT_PREFIX = "content/";
const PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const IVPKG_LIMITS = {
  archiveBytes: 128 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  fileCount: 4096,
} as const;

export interface InteractivePackagePublisher {
  id: string;
  name: string;
}

export interface InteractivePackageProject {
  id: string;
  title: string;
  kind?: string;
  version: string;
  manifest: string;
  entryNote?: string;
}

export interface InteractivePackageFile {
  path: string;
  size: number;
  sha256: string;
}

export interface InteractivePackageManifest {
  schemaVersion: 1;
  id: string;
  title: string;
  version: string;
  publisher: InteractivePackagePublisher;
  kind?: string;
  entryNote?: string;
  projects: InteractivePackageProject[];
  files: InteractivePackageFile[];
}

export interface ParsedInteractivePackage {
  manifest: InteractivePackageManifest;
  files: ReadonlyMap<string, Uint8Array>;
  archiveSize: number;
  contentSize: number;
}

export async function readInteractivePackage(
  archive: Uint8Array,
): Promise<ParsedInteractivePackage> {
  if (archive.byteLength === 0) throw new Error("The .ivpkg file is empty");
  if (archive.byteLength > IVPKG_LIMITS.archiveBytes) {
    throw new Error(`The .ivpkg file exceeds the ${formatBytes(IVPKG_LIMITS.archiveBytes)} limit`);
  }

  const archiveEntries = new Map<string, UnzipFileInfo>();
  let contentSize = 0;
  let fileCount = 0;
  let archiveEntryCount = 0;
  const extracted = unzipSync(archive, {
    filter: (info) => {
      const path = info.name;
      archiveEntryCount += 1;
      if (archiveEntryCount > IVPKG_LIMITS.fileCount + 1) {
        throw new Error(`The .ivpkg file contains more than ${IVPKG_LIMITS.fileCount} content entries`);
      }
      if (path.endsWith("/")) {
        assertSafePath(path.slice(0, -1), "archive directory");
        return false;
      }
      assertSafePath(path, "archive file");
      if (archiveEntries.has(path)) throw new Error(`Duplicate archive file: ${path}`);
      archiveEntries.set(path, info);
      fileCount += 1;
      if (fileCount > IVPKG_LIMITS.fileCount + 1) {
        throw new Error(`The .ivpkg file contains more than ${IVPKG_LIMITS.fileCount} content files`);
      }
      if (info.originalSize > IVPKG_LIMITS.fileBytes && path !== PACKAGE_MANIFEST_PATH) {
        throw new Error(`Package file is too large: ${path}`);
      }
      if (path === PACKAGE_MANIFEST_PATH) {
        if (info.originalSize > IVPKG_LIMITS.manifestBytes) {
          throw new Error("iv-package.json is too large");
        }
      } else {
        contentSize += info.originalSize;
        if (contentSize > IVPKG_LIMITS.totalBytes) {
          throw new Error(`Package contents exceed the ${formatBytes(IVPKG_LIMITS.totalBytes)} limit`);
        }
      }
      return true;
    },
  });

  const manifestBytes = extracted[PACKAGE_MANIFEST_PATH];
  if (!manifestBytes) throw new Error("The .ivpkg file is missing iv-package.json");

  let manifestSource: unknown;
  try {
    manifestSource = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new Error("iv-package.json is not valid JSON");
  }
  const manifest = validateInteractivePackageManifest(manifestSource);
  const declaredPaths = new Set(manifest.files.map((file) => `${CONTENT_PREFIX}${file.path}`));
  const actualPaths = new Set(Object.keys(extracted).filter((path) => path !== PACKAGE_MANIFEST_PATH));

  for (const path of actualPaths) {
    if (!declaredPaths.has(path)) throw new Error(`Archive contains an undeclared file: ${path}`);
  }
  for (const path of declaredPaths) {
    if (!actualPaths.has(path)) throw new Error(`Archive is missing a declared file: ${path}`);
  }

  const files = new Map<string, Uint8Array>();
  for (const declaration of manifest.files) {
    const data = extracted[`${CONTENT_PREFIX}${declaration.path}`];
    if (!data) throw new Error(`Archive is missing a declared file: ${declaration.path}`);
    if (data.byteLength !== declaration.size) {
      throw new Error(`Package file size does not match its manifest: ${declaration.path}`);
    }
    const digest = await sha256(data);
    if (digest !== declaration.sha256) {
      throw new Error(`Package file checksum does not match its manifest: ${declaration.path}`);
    }
    files.set(declaration.path, data);
  }

  validateProjectReferences(manifest, files);
  return { manifest, files, archiveSize: archive.byteLength, contentSize };
}

export function validateInteractivePackageManifest(value: unknown): InteractivePackageManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("iv-package.json must contain a JSON object");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new Error("Only .ivpkg schemaVersion 1 is supported");
  const id = requireString(input.id, "Package id");
  if (!PACKAGE_ID_PATTERN.test(id)) {
    throw new Error("Package id may contain lowercase letters, numbers, dots, and hyphens");
  }
  const title = requireString(input.title, "Package title");
  const version = requireSemver(input.version, "Package version");
  const publisher = validatePublisher(input.publisher);
  const kind = optionalString(input.kind, "Package kind");
  const entryNote = optionalSafePath(input.entryNote, "Package entryNote");
  if (!Array.isArray(input.projects) || input.projects.length === 0) {
    throw new Error("Package projects must be a non-empty array");
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new Error("Package files must be a non-empty array");
  }
  if (input.files.length > IVPKG_LIMITS.fileCount) {
    throw new Error(`Package declares more than ${IVPKG_LIMITS.fileCount} files`);
  }

  const projects = input.projects.map((project, index) => validateProject(project, index));
  const files = input.files.map((file, index) => validateFile(file, index));
  const projectIds = new Set<string>();
  for (const project of projects) {
    if (projectIds.has(project.id)) throw new Error(`Package declares the same project twice: ${project.id}`);
    projectIds.add(project.id);
  }
  const filePaths = new Set<string>();
  let declaredSize = 0;
  for (const file of files) {
    if (file.path === PACKAGE_MANIFEST_PATH) {
      throw new Error(`${PACKAGE_MANIFEST_PATH} is reserved for package installation metadata`);
    }
    if (filePaths.has(file.path)) throw new Error(`Package declares the same file twice: ${file.path}`);
    filePaths.add(file.path);
    declaredSize += file.size;
    if (declaredSize > IVPKG_LIMITS.totalBytes) {
      throw new Error(`Package contents exceed the ${formatBytes(IVPKG_LIMITS.totalBytes)} limit`);
    }
  }
  if (entryNote && !filePaths.has(entryNote)) {
    throw new Error(`Package entryNote is not declared as a file: ${entryNote}`);
  }
  for (const project of projects) {
    if (!filePaths.has(project.manifest)) {
      throw new Error(`Project manifest is not declared as a file: ${project.manifest}`);
    }
    if (project.entryNote && !filePaths.has(project.entryNote)) {
      throw new Error(`Project entryNote is not declared as a file: ${project.entryNote}`);
    }
  }

  return {
    schemaVersion: 1,
    id,
    title,
    version,
    publisher,
    kind,
    entryNote,
    projects,
    files,
  };
}

function validatePublisher(value: unknown): InteractivePackagePublisher {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Package publisher must be an object");
  }
  const input = value as Record<string, unknown>;
  const id = requireString(input.id, "Publisher id");
  if (!PACKAGE_ID_PATTERN.test(id)) throw new Error("Publisher id is invalid");
  return { id, name: requireString(input.name, "Publisher name") };
}

function validateProject(value: unknown, index: number): InteractivePackageProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Package project ${index + 1} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const id = requireString(input.id, `Package project ${index + 1} id`);
  if (!PROJECT_ID_PATTERN.test(id)) throw new Error(`Package project id is invalid: ${id}`);
  return {
    id,
    title: requireString(input.title, `Package project ${index + 1} title`),
    kind: optionalString(input.kind, `Package project ${index + 1} kind`),
    version: requireSemver(input.version, `Package project ${index + 1} version`),
    manifest: requireSafePath(input.manifest, `Package project ${index + 1} manifest`),
    entryNote: optionalSafePath(input.entryNote, `Package project ${index + 1} entryNote`),
  };
}

function validateFile(value: unknown, index: number): InteractivePackageFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Package file ${index + 1} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const path = requireSafePath(input.path, `Package file ${index + 1} path`);
  if (!Number.isSafeInteger(input.size) || (input.size as number) < 0) {
    throw new Error(`Package file size is invalid: ${path}`);
  }
  const size = input.size as number;
  if (size > IVPKG_LIMITS.fileBytes) throw new Error(`Package file is too large: ${path}`);
  const checksum = requireString(input.sha256, `Package file ${index + 1} sha256`).toLowerCase();
  if (!SHA256_PATTERN.test(checksum)) throw new Error(`Package file checksum is invalid: ${path}`);
  return { path, size, sha256: checksum };
}

function validateProjectReferences(
  manifest: InteractivePackageManifest,
  files: ReadonlyMap<string, Uint8Array>,
): void {
  for (const project of manifest.projects) {
    const source = files.get(project.manifest);
    if (!source) throw new Error(`Project manifest is missing: ${project.manifest}`);
    let value: unknown;
    try {
      value = JSON.parse(strFromU8(source));
    } catch {
      throw new Error(`Project manifest is not valid JSON: ${project.manifest}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Project manifest must be a JSON object: ${project.manifest}`);
    }
    const projectManifest = value as Record<string, unknown>;
    if (projectManifest.schemaVersion !== 1) {
      throw new Error(`Project manifest must use schemaVersion 1: ${project.manifest}`);
    }
    if (projectManifest.id !== project.id) {
      throw new Error(`Project id does not match package manifest: ${project.manifest}`);
    }
    const directory = dirname(project.manifest);
    const entry = requireSafePath(projectManifest.entry, `Project entry in ${project.manifest}`);
    assertProjectFileExists(files, directory, entry, ".js", project.manifest);
    if (projectManifest.styles !== undefined && !Array.isArray(projectManifest.styles)) {
      throw new Error(`Project styles must be an array: ${project.manifest}`);
    }
    for (const style of projectManifest.styles ?? []) {
      const path = requireSafePath(style, `Project style in ${project.manifest}`);
      assertProjectFileExists(files, directory, path, ".css", project.manifest);
    }
  }
}

function assertProjectFileExists(
  files: ReadonlyMap<string, Uint8Array>,
  directory: string,
  relativePath: string,
  extension: string,
  manifestPath: string,
): void {
  if (!relativePath.endsWith(extension)) {
    throw new Error(`Project file must end with ${extension}: ${manifestPath}`);
  }
  const resolved = directory ? `${directory}/${relativePath}` : relativePath;
  assertSafePath(resolved, `Project file in ${manifestPath}`);
  if (!files.has(resolved)) throw new Error(`Project file is missing: ${resolved}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function requireSemver(value: unknown, label: string): string {
  const version = requireString(value, label);
  if (!SEMVER_PATTERN.test(version)) throw new Error(`${label} must be a semantic version`);
  return version;
}

function requireSafePath(value: unknown, label: string): string {
  const path = requireString(value, label);
  assertSafePath(path, label);
  return path;
}

function optionalSafePath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireSafePath(value, label);
}

function assertSafePath(path: string, label: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is unsafe: ${path}`);
  }
}

function dirname(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

async function sha256(data: Uint8Array): Promise<string> {
  const input = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}
