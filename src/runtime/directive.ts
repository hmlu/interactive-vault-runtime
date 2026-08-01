import type { ProjectDirective } from "./types";

export function parseProjectDirective(source: string): ProjectDirective {
  const trimmed = source.trim();

  if (!trimmed) {
    throw new Error("缺少项目 id");
  }

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Partial<ProjectDirective>;
    return validateDirective(parsed);
  }

  if (!trimmed.includes(":")) {
    return validateDirective({ id: trimmed });
  }

  const values: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values[key] = value;
  }

  return validateDirective(values);
}

function validateDirective(value: Partial<ProjectDirective>): ProjectDirective {
  const id = typeof value.id === "string" ? value.id.trim() : undefined;
  const manifest = typeof value.manifest === "string" ? value.manifest.trim() : undefined;
  if (id !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error("项目 id 只能包含小写字母、数字和连字符");
  }
  if (manifest !== undefined && (!manifest || manifest.includes("\\") || manifest.includes(":"))) {
    throw new Error("manifest 必须是 Vault 内的 JSON 文件路径");
  }
  if (!id && !manifest) {
    throw new Error("至少需要项目 id 或 manifest 路径");
  }

  const mode = value.mode;
  if (mode !== undefined && mode !== "embedded" && mode !== "view") {
    throw new Error("mode 只能是 embedded 或 view");
  }

  const directive: ProjectDirective = {};
  if (id) directive.id = id;
  if (manifest) directive.manifest = manifest;
  if (mode) directive.mode = mode;
  return directive;
}
