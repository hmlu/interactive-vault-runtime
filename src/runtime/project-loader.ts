import { normalizePath, type App } from "obsidian";
import type {
  InteractiveProjectManifest,
  InteractiveProjectModule,
  LoadedInteractiveProject,
  ProjectDirective,
} from "./types";

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export class VaultProjectLoader {
  constructor(private readonly app: App) {}

  resolveManifestPath(directive: ProjectDirective, sourcePath?: string): string {
    if (directive.manifest) {
      const manifest = directive.manifest.trim();
      if (manifest.startsWith("./") || manifest.startsWith("../")) {
        if (!sourcePath) {
          throw new Error("相对 manifest 路径需要来源笔记");
        }
        return normalizePath(joinVaultPath(vaultDirname(sourcePath), manifest));
      }
      return normalizePath(manifest);
    }

    if (!sourcePath) {
      throw new Error("缺少项目 manifest 路径");
    }
    return normalizePath(joinVaultPath(vaultDirname(sourcePath), "project.json"));
  }

  async load(manifestPath: string, expectedId?: string): Promise<LoadedInteractiveProject> {
    const source = await this.readRequired(manifestPath, "项目 manifest");
    const manifest = validateProjectManifest(JSON.parse(source) as unknown);
    if (expectedId && manifest.id !== expectedId) {
      throw new Error(`项目 id 不匹配：期望 ${expectedId}，实际为 ${manifest.id}`);
    }

    const projectDirectory = vaultDirname(manifestPath);
    const entryPath = resolvePackageFile(projectDirectory, manifest.entry, ".js");
    const stylePaths = (manifest.styles ?? []).map((style) =>
      resolvePackageFile(projectDirectory, style, ".css"),
    );
    const [entrySource, ...styleSources] = await Promise.all([
      this.readRequired(entryPath, "项目入口"),
      ...stylePaths.map((path) => this.readRequired(path, "项目样式")),
    ]);

    return {
      manifestPath,
      manifest,
      module: evaluateProjectModule(entrySource, entryPath),
      styleSources,
    };
  }

  private async readRequired(path: string, label: string): Promise<string> {
    if (!(await this.app.vault.adapter.exists(path))) {
      throw new Error(`${label}不存在：${path}`);
    }
    return this.app.vault.adapter.read(path);
  }
}

export function validateProjectManifest(value: unknown): InteractiveProjectManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("项目 manifest 必须是 JSON 对象");
  }

  const manifest = value as Partial<InteractiveProjectManifest>;
  if (manifest.schemaVersion !== 1) {
    throw new Error("仅支持 schemaVersion: 1 的项目 manifest");
  }
  if (typeof manifest.id !== "string" || !PROJECT_ID_PATTERN.test(manifest.id)) {
    throw new Error("项目 id 只能包含小写字母、数字和连字符");
  }
  if (typeof manifest.title !== "string" || !manifest.title.trim()) {
    throw new Error("项目 manifest 缺少 title");
  }
  if (typeof manifest.entry !== "string" || !manifest.entry.trim()) {
    throw new Error("项目 manifest 缺少 entry");
  }
  if (
    manifest.styles !== undefined &&
    (!Array.isArray(manifest.styles) || manifest.styles.some((style) => typeof style !== "string"))
  ) {
    throw new Error("项目 styles 必须是字符串数组");
  }
  if (manifest.icon !== undefined && typeof manifest.icon !== "string") {
    throw new Error("项目 icon 必须是字符串");
  }
  if (manifest.description !== undefined && typeof manifest.description !== "string") {
    throw new Error("项目 description 必须是字符串");
  }

  return {
    schemaVersion: 1,
    id: manifest.id,
    title: manifest.title.trim(),
    description: manifest.description?.trim(),
    icon: manifest.icon?.trim(),
    entry: manifest.entry,
    styles: manifest.styles,
  };
}

function evaluateProjectModule(source: string, entryPath: string): InteractiveProjectModule {
  const module = { exports: {} as Record<string, unknown> };
  const evaluator = new Function(
    "module",
    "exports",
    `"use strict";\n${source}\n//# sourceURL=interactive-vault://${entryPath}`,
  );
  evaluator(module, module.exports);

  const exported = module.exports as Record<string, unknown>;
  const candidate =
    exported.default && typeof exported.default === "object"
      ? (exported.default as Record<string, unknown>)
      : exported;
  if (typeof candidate.mount !== "function") {
    throw new Error(`项目入口必须导出 mount()：${entryPath}`);
  }
  return candidate as unknown as InteractiveProjectModule;
}

function resolvePackageFile(directory: string, relativePath: string, extension: string): string {
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes(":")
  ) {
    throw new Error(`无效的项目文件路径：${relativePath}`);
  }

  const resolved = normalizePath(joinVaultPath(directory, relativePath));
  const insideDirectory = directory
    ? resolved.startsWith(`${directory}/`)
    : !resolved.startsWith("../") && !resolved.startsWith("/");
  if (!insideDirectory || !resolved.endsWith(extension)) {
    throw new Error(`项目文件必须位于项目目录内且以 ${extension} 结尾：${relativePath}`);
  }
  return resolved;
}

function vaultDirname(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function joinVaultPath(directory: string, relativePath: string): string {
  return directory ? `${directory}/${relativePath}` : relativePath;
}
