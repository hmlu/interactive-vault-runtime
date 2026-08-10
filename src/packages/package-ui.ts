import {
  Modal,
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  type App,
  type ButtonComponent,
} from "obsidian";
import { IVPKG_LIMITS, type ParsedInteractivePackage } from "./ivpkg";
import { createDefaultInstallPath } from "./package-paths";
import {
  InteractivePackageManager,
  type InstalledPackageRecord,
  type InstalledPackageSource,
} from "./package-manager";

export type PackageManagementHost = Plugin & {
  packageManager: InteractivePackageManager;
  getInstalledPackages(): readonly InstalledPackageRecord[];
  saveInstalledPackage(record: InstalledPackageRecord): Promise<void>;
  isProjectLanguageChinese(): boolean;
};

export class InteractivePackageSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: PackageManagementHost) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const chinese = this.host.isProjectLanguageChinese();

    new Setting(containerEl)
      .setName(chinese ? "互动应用包" : "Interactive packages")
      .setHeading();
    new Setting(containerEl)
      .setName(chinese ? "安装本地包" : "Install local package")
      .setDesc(chinese
        ? "选择本机上的 .ivpkg 文件，校验后安装到当前 Vault。"
        : "Choose a local .ivpkg file, verify it, and install it in this Vault.")
      .addButton((button) => button
        .setButtonText(chinese ? "选择文件" : "Choose file")
        .onClick(() => chooseLocalPackage(this.host, () => this.display())));
    new Setting(containerEl)
      .setName(chinese ? "从 URL 安装" : "Install from URL")
      .setDesc(chinese
        ? "从 HTTPS 地址下载 .ivpkg 文件，校验后安装。"
        : "Download a .ivpkg file from an HTTPS URL and verify it before installation.")
      .addButton((button) => button
        .setButtonText(chinese ? "输入 URL" : "Enter URL")
        .onClick(() => openRemotePackageInstaller(this.host, () => this.display())));

    new Setting(containerEl)
      .setName(chinese ? "已安装" : "Installed")
      .setHeading();
    const installed = this.host.getInstalledPackages();
    if (installed.length === 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: chinese ? "尚未安装互动应用包。" : "No interactive packages are installed.",
      });
      return;
    }

    for (const record of installed) {
      const setting = new Setting(containerEl)
        .setName(`${record.title} · ${record.version}`)
        .setDesc(`${record.publisher.name} · ${record.targetPath}`);
      if (record.entryNote) {
        setting.addButton((button) => button
          .setButtonText(chinese ? "打开" : "Open")
          .onClick(() => void openInstalledPackage(this.host, record)));
      }
      if (record.source.type === "url") {
        setting.addButton((button) => button
          .setButtonText(chinese ? "检查更新" : "Check for update")
          .onClick(() => void updateRemotePackage(this.host, record, button, () => this.display())));
      }
    }
  }
}

export function chooseLocalPackage(host: PackageManagementHost, onInstalled?: () => void): void {
  const chinese = host.isProjectLanguageChinese();
  const input = window.activeDocument.createElement("input");
  input.type = "file";
  input.accept = ".ivpkg,application/zip";
  input.style.display = "none";
  window.activeDocument.body.appendChild(input);
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    void (async () => {
      try {
        if (file.size > IVPKG_LIMITS.archiveBytes) throw new Error("The .ivpkg file is too large");
        const pkg = await host.packageManager.inspect(await file.arrayBuffer());
        new PackageInstallModal(host, pkg, { type: "local", name: file.name }, onInstalled).open();
      } catch (error) {
        new Notice(formatError(error, chinese ? "无法读取应用包" : "Could not read package"));
      }
    })();
  }, { once: true });
  input.click();
  window.setTimeout(() => input.remove(), 60_000);
}

export function openRemotePackageInstaller(
  host: PackageManagementHost,
  onInstalled?: () => void,
): void {
  new RemotePackageModal(host, onInstalled).open();
}

class RemotePackageModal extends Modal {
  private url = "";

  constructor(
    private readonly host: PackageManagementHost,
    private readonly onInstalled?: () => void,
  ) {
    super(host.app);
  }

  onOpen(): void {
    const chinese = this.host.isProjectLanguageChinese();
    this.setTitle(chinese ? "从 URL 安装应用包" : "Install package from URL");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: chinese
        ? "请输入直接指向 .ivpkg 文件的 HTTPS 地址。"
        : "Enter an HTTPS URL that points directly to a .ivpkg file.",
    });
    new Setting(this.contentEl)
      .setName("URL")
      .addText((text) => {
        text
          .setPlaceholder("https://example.com/package.ivpkg")
          .onChange((value) => { this.url = value; });
        text.inputEl.type = "url";
      });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(chinese ? "取消" : "Cancel")
        .onClick(() => this.close()))
      .addButton((button) => button
        .setCta()
        .setButtonText(chinese ? "下载并校验" : "Download and verify")
        .onClick(() => void this.download(button)));
  }

  private async download(button: ButtonComponent): Promise<void> {
    const chinese = this.host.isProjectLanguageChinese();
    button.setDisabled(true).setButtonText(chinese ? "正在下载…" : "Downloading…");
    try {
      const pkg = await this.host.packageManager.download(this.url);
      const source = { type: "url", url: new URL(this.url.trim()).toString() } as const;
      this.close();
      new PackageInstallModal(this.host, pkg, source, this.onInstalled).open();
    } catch (error) {
      new Notice(formatError(error, chinese ? "无法下载应用包" : "Could not download package"));
      button.setDisabled(false).setButtonText(chinese ? "下载并校验" : "Download and verify");
    }
  }
}

class PackageInstallModal extends Modal {
  private targetPath: string;

  constructor(
    private readonly host: PackageManagementHost,
    private readonly pkg: ParsedInteractivePackage,
    private readonly source: InstalledPackageSource,
    private readonly onInstalled?: () => void,
  ) {
    super(host.app);
    const existing = host.getInstalledPackages().find((record) => record.id === pkg.manifest.id);
    this.targetPath = existing?.targetPath ?? createDefaultInstallPath(pkg.manifest.title);
  }

  onOpen(): void {
    const chinese = this.host.isProjectLanguageChinese();
    const existing = this.host.getInstalledPackages().find((record) => record.id === this.pkg.manifest.id);
    this.setTitle(existing
      ? chinese ? "更新互动应用包" : "Update interactive package"
      : chinese ? "安装互动应用包" : "Install interactive package");
    this.contentEl.empty();

    const summary = this.contentEl.createDiv({ cls: "ivr-package-summary" });
    summary.createEl("strong", { text: this.pkg.manifest.title });
    summary.createEl("span", { text: `${this.pkg.manifest.publisher.name} · ${this.pkg.manifest.version}` });
    summary.createEl("span", {
      text: chinese
        ? `${this.pkg.manifest.files.length} 个文件 · ${formatBytes(this.pkg.contentSize)}`
        : `${this.pkg.manifest.files.length} files · ${formatBytes(this.pkg.contentSize)}`,
    });

    new Setting(this.contentEl)
      .setName(chinese ? "安装目录" : "Install folder")
      .setDesc(chinese ? "当前 Vault 内的专用目录" : "A dedicated folder inside the current Vault")
      .addText((text) => {
        text.setValue(this.targetPath).onChange((value) => { this.targetPath = value; });
        text.setDisabled(Boolean(existing));
      });
    this.contentEl.createEl("p", {
      cls: "ivr-package-warning",
      text: chinese
        ? "应用包包含可执行代码。请仅安装来自可信发布者的包。该目录将由包管理器完整管理，更新时旧版本会移入 Vault 回收站。"
        : "Packages contain executable code. Install only from trusted publishers. The selected folder is fully managed; updates move the previous version to the Vault trash.",
    });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(chinese ? "取消" : "Cancel")
        .onClick(() => this.close()))
      .addButton((button) => button
        .setCta()
        .setButtonText(existing
          ? chinese ? "更新" : "Update"
          : chinese ? "安装" : "Install")
        .onClick(() => void this.install(button)));
  }

  private async install(button: ButtonComponent): Promise<void> {
    const chinese = this.host.isProjectLanguageChinese();
    const isUpdate = this.host.getInstalledPackages().some((record) => record.id === this.pkg.manifest.id);
    button.setDisabled(true).setButtonText(chinese ? "正在安装…" : "Installing…");
    try {
      const record = await this.host.packageManager.install(
        this.pkg,
        this.targetPath,
        this.source,
        this.host.getInstalledPackages(),
      );
      await this.host.saveInstalledPackage(record);
      this.close();
      this.onInstalled?.();
      new Notice(chinese
        ? `${record.title} ${record.version} 已安装到 ${record.targetPath}`
        : `${record.title} ${record.version} was installed at ${record.targetPath}`);
    } catch (error) {
      new Notice(formatError(error, chinese ? "无法安装应用包" : "Could not install package"));
      button.setDisabled(false).setButtonText(isUpdate
        ? chinese ? "更新" : "Update"
        : chinese ? "安装" : "Install");
    }
  }
}

async function updateRemotePackage(
  host: PackageManagementHost,
  record: InstalledPackageRecord,
  button: ButtonComponent,
  onInstalled?: () => void,
): Promise<void> {
  if (record.source.type !== "url") return;
  const chinese = host.isProjectLanguageChinese();
  button.setDisabled(true).setButtonText(chinese ? "正在检查…" : "Checking…");
  try {
    const pkg = await host.packageManager.download(record.source.url);
    if (pkg.manifest.id !== record.id) throw new Error("The remote package id has changed");
    const comparison = compareSemver(pkg.manifest.version, record.version);
    if (comparison === 0) {
      new Notice(chinese ? "当前已经是最新版本。" : "The installed package is up to date.");
      return;
    }
    if (comparison < 0) {
      new Notice(chinese
        ? `远程版本 ${pkg.manifest.version} 早于已安装版本 ${record.version}。`
        : `Remote version ${pkg.manifest.version} is older than installed version ${record.version}.`);
      return;
    }
    new PackageInstallModal(host, pkg, record.source, onInstalled).open();
  } catch (error) {
    new Notice(formatError(error, chinese ? "无法检查更新" : "Could not check for update"));
  } finally {
    button.setDisabled(false).setButtonText(chinese ? "检查更新" : "Check for update");
  }
}

async function openInstalledPackage(
  host: PackageManagementHost,
  record: InstalledPackageRecord,
): Promise<void> {
  if (!record.entryNote) return;
  const path = normalizePath(`${record.targetPath}/${record.entryNote}`);
  const file = host.app.vault.getFileByPath(path);
  if (!file) {
    new Notice(host.isProjectLanguageChinese() ? `入口笔记不存在：${path}` : `Entry note not found: ${path}`);
    return;
  }
  const leaf = host.app.workspace.getLeaf("tab");
  await leaf.openFile(file);
  await host.app.workspace.revealLeaf(leaf);
}

function formatError(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}: ${error.message}` : fallback;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function compareSemver(left: string, right: string): number {
  const [leftCore, leftPrerelease] = splitSemver(left);
  const [rightCore, rightPrerelease] = splitSemver(right);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return Math.sign(difference);
  }
  if (leftPrerelease === rightPrerelease) return 0;
  if (!leftPrerelease) return 1;
  if (!rightPrerelease) return -1;
  return leftPrerelease.localeCompare(rightPrerelease, "en", { numeric: true });
}

function splitSemver(version: string): [string, string | undefined] {
  const separator = version.indexOf("-");
  return separator < 0
    ? [version, undefined]
    : [version.slice(0, separator), version.slice(separator + 1)];
}
