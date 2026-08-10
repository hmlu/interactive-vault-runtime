import { getLanguage, Notice, Plugin, type MarkdownPostProcessorContext } from "obsidian";
import { MultiplayerChallengeModal } from "./multiplayer/challenge-modal";
import { MultiplayerService } from "./multiplayer/multiplayer-service";
import {
  InteractivePackageManager,
  readInstalledPackageRecords,
  type InstalledPackageRecord,
} from "./packages/package-manager";
import {
  findInstalledPackageIdForProject,
  STANDALONE_PACKAGE_ID,
} from "./packages/package-identity";
import {
  chooseLocalPackage,
  InteractivePackageSettingTab,
  openRemotePackageInstaller,
} from "./packages/package-ui";
import { VaultProjectStorage } from "./platform/vault-storage";
import { parseProjectDirective } from "./runtime/directive";
import { VaultProjectLoader } from "./runtime/project-loader";
import { ProjectRenderChild } from "./runtime/project-render-child";
import { PROJECT_VIEW_TYPE, ProjectView } from "./runtime/project-view";
import type {
  DisplayMode,
  LoadedInteractiveProject,
  ProjectContext,
  ProjectLanguage,
} from "./runtime/types";

interface RuntimeSettings {
  localeOverride?: ProjectLanguage | null;
  installedPackages?: InstalledPackageRecord[];
}

export default class InteractiveVaultRuntimePlugin extends Plugin {
  loader!: VaultProjectLoader;
  multiplayer!: MultiplayerService;
  packageManager!: InteractivePackageManager;
  private activeChallengeId: string | null = null;
  private languageOverride: ProjectLanguage | null = null;
  private runtimeSettings: RuntimeSettings = {};
  private readonly languageListeners = new Set<(
    language: ProjectLanguage,
    override: ProjectLanguage | null,
  ) => void>();

  async onload(): Promise<void> {
    const loadedSettings = await this.loadData() as RuntimeSettings | null;
    this.runtimeSettings = {
      localeOverride: typeof loadedSettings?.localeOverride === "string" && loadedSettings.localeOverride.trim()
        ? loadedSettings.localeOverride.trim()
        : null,
      installedPackages: readInstalledPackageRecords(loadedSettings?.installedPackages),
    };
    this.languageOverride = typeof this.runtimeSettings.localeOverride === "string" && this.runtimeSettings.localeOverride.trim()
      ? this.runtimeSettings.localeOverride.trim()
      : null;
    this.loader = new VaultProjectLoader(this.app);
    this.multiplayer = new MultiplayerService();
    this.packageManager = new InteractivePackageManager(this.app);
    this.register(this.multiplayer.subscribe(() => this.presentIncomingChallenge()));
    this.addSettingTab(new InteractivePackageSettingTab(this.app, this));
    this.addCommand({
      id: "install-local-interactive-package",
      name: "Install local interactive package",
      callback: () => chooseLocalPackage(this),
    });
    this.addCommand({
      id: "install-interactive-package-from-url",
      name: "Install interactive package from URL",
      callback: () => openRemotePackageInstaller(this),
    });

    this.registerView(
      PROJECT_VIEW_TYPE,
      (leaf) => new ProjectView(leaf, this),
    );

    this.registerMarkdownCodeBlockProcessor(
      "interactive-vault",
      (source, element, markdownContext) =>
        this.renderDirective(source, element, markdownContext),
    );
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(PROJECT_VIEW_TYPE);
    await this.multiplayer.dispose();
  }

  createProjectContext(
    project: LoadedInteractiveProject,
    displayMode: DisplayMode,
    sourcePath?: string,
  ): ProjectContext {
    const packageId = findInstalledPackageIdForProject(
      project.manifestPath,
      this.getInstalledPackages(),
    ) ?? STANDALONE_PACKAGE_ID;

    return {
      displayMode,
      sourcePath,
      storage: new VaultProjectStorage(this.app, packageId, project.manifest.id),
      openInView: () => this.openProject(project.manifestPath, project.manifest.id),
      openProject: (manifestPath, expectedId) => this.openProject(
        this.loader.resolveManifestPath(
          { manifest: manifestPath },
          sourcePath ?? project.manifestPath,
        ),
        expectedId,
      ),
      multiplayer: this.multiplayer.createProjectFacade(project),
      localization: {
        getLanguage: () => this.getProjectLanguage(),
        getLanguageOverride: () => this.getProjectLanguageOverride(),
        setLanguage: (language) => this.setProjectLanguage(language),
        subscribe: (listener) => {
          this.languageListeners.add(listener);
          return () => this.languageListeners.delete(listener);
        },
      },
    };
  }

  getProjectLanguage(): ProjectLanguage {
    if (this.languageOverride) return this.languageOverride;
    return getLanguage().trim().replaceAll("_", "-") || "en";
  }

  getProjectLanguageOverride(): ProjectLanguage | null {
    return this.languageOverride;
  }

  getInstalledPackages(): readonly InstalledPackageRecord[] {
    return this.runtimeSettings.installedPackages ?? [];
  }

  async saveInstalledPackage(record: InstalledPackageRecord): Promise<void> {
    const packages = [...this.getInstalledPackages()];
    const existingIndex = packages.findIndex((candidate) => candidate.id === record.id);
    if (existingIndex >= 0) packages[existingIndex] = record;
    else packages.push(record);
    this.runtimeSettings.installedPackages = packages;
    await this.saveData(this.runtimeSettings);
  }

  isProjectLanguageChinese(): boolean {
    return this.getProjectLanguage().toLocaleLowerCase().startsWith("zh");
  }

  subscribeProjectLanguage(
    listener: (language: ProjectLanguage, override: ProjectLanguage | null) => void,
  ): () => void {
    this.languageListeners.add(listener);
    return () => this.languageListeners.delete(listener);
  }

  getProjectTitle(project: LoadedInteractiveProject): string {
    if (this.isProjectLanguageChinese()) return project.manifest.title;
    const language = this.getProjectLanguage().toLocaleLowerCase();
    const baseLanguage = language.split("-")[0];
    const titles = project.manifest.titleI18n;
    return titles?.[language] ?? titles?.[baseLanguage] ?? titles?.en ?? project.manifest.title;
  }

  private async setProjectLanguage(language: ProjectLanguage | null): Promise<void> {
    const nextOverride = typeof language === "string" && language.trim() ? language.trim() : null;
    if (this.languageOverride === nextOverride) return;
    this.languageOverride = nextOverride;
    this.runtimeSettings.localeOverride = nextOverride;
    const effectiveLanguage = this.getProjectLanguage();
    for (const listener of this.languageListeners) listener(effectiveLanguage, nextOverride);
    await this.saveData(this.runtimeSettings);
  }

  private presentIncomingChallenge(): void {
    const challenge = this.multiplayer.getIncomingChallenge();
    if (!challenge || challenge.challengeId === this.activeChallengeId) return;
    this.activeChallengeId = challenge.challengeId;
    new MultiplayerChallengeModal(this.app, challenge, this.getProjectLanguage(), (accept) => {
      void (async () => {
        if (accept) {
          try {
            await this.loader.load(challenge.project.manifestPath, challenge.project.id);
          } catch (error) {
            new Notice(error instanceof Error
              ? error.message
              : this.isProjectLanguageChinese() ? "本机无法加载受邀游戏" : "This device could not load the invited game");
            accept = false;
          }
        }
        const project = await this.multiplayer.respondToIncomingChallenge(accept);
        this.activeChallengeId = null;
        if (project) void this.openProject(project.manifestPath, project.id);
      })();
    }).open();
  }

  async openProject(manifestPath: string, expectedId?: string): Promise<void> {
    try {
      await this.loader.load(manifestPath, expectedId);
    } catch (error) {
      new Notice(error instanceof Error
        ? error.message
        : this.isProjectLanguageChinese() ? "无法加载互动应用" : "Could not load the interactive app");
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: PROJECT_VIEW_TYPE,
      active: true,
      state: { manifestPath, expectedId },
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async renderDirective(
    source: string,
    element: HTMLElement,
    markdownContext: MarkdownPostProcessorContext,
  ): Promise<void> {
    element.createDiv({
      cls: "ogr-loading",
      text: this.isProjectLanguageChinese() ? "正在加载互动应用…" : "Loading interactive app…",
    });
    try {
      const directive = parseProjectDirective(source);
      const manifestPath = this.loader.resolveManifestPath(directive, markdownContext.sourcePath);
      const project = await this.loader.load(manifestPath, directive.id);
      element.empty();

      if (directive.mode === "view") {
        const launchButton = element.createEl("button", {
          cls: "mod-cta ogr-launch-button",
          text: this.isProjectLanguageChinese()
            ? `进入${project.manifest.title}沉浸模式`
            : `Open ${this.getProjectTitle(project)} in immersive mode`,
        });
        this.registerDomEvent(launchButton, "click", () => {
          void this.openProject(project.manifestPath, project.manifest.id);
        });
        return;
      }

      markdownContext.addChild(
        new ProjectRenderChild(
          element,
          project,
          this.createProjectContext(
            project,
            directive.mode ?? "embedded",
            markdownContext.sourcePath,
          ),
        ),
      );
    } catch (error) {
      element.empty();
      element.createDiv({
        cls: "ogr-error",
        text: error instanceof Error
          ? error.message
          : this.isProjectLanguageChinese() ? "无法加载互动应用" : "Could not load the interactive app",
      });
    }
  }
}
