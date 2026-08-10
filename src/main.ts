import { getLanguage, Notice, Plugin, type MarkdownPostProcessorContext } from "obsidian";
import { MultiplayerChallengeModal } from "./multiplayer/challenge-modal";
import { MultiplayerService } from "./multiplayer/multiplayer-service";
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
  languageOverride?: ProjectLanguage;
}

export default class InteractiveVaultRuntimePlugin extends Plugin {
  loader!: VaultProjectLoader;
  multiplayer!: MultiplayerService;
  private activeChallengeId: string | null = null;
  private languageOverride: ProjectLanguage | null = null;
  private readonly languageListeners = new Set<(language: ProjectLanguage) => void>();

  async onload(): Promise<void> {
    const settings = await this.loadData() as RuntimeSettings | null;
    this.languageOverride = settings?.languageOverride === "zh" || settings?.languageOverride === "en"
      ? settings.languageOverride
      : null;
    this.loader = new VaultProjectLoader(this.app);
    this.multiplayer = new MultiplayerService();
    this.register(this.multiplayer.subscribe(() => this.presentIncomingChallenge()));

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
    return {
      displayMode,
      sourcePath,
      storage: new VaultProjectStorage(this.app, project.manifest.id),
      openInView: () => this.openProject(project.manifestPath, project.manifest.id),
      openProject: (manifestPath, expectedId) => this.openProject(manifestPath, expectedId),
      multiplayer: this.multiplayer.createProjectFacade(project),
      localization: {
        getLanguage: () => this.getProjectLanguage(),
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
    return getLanguage().toLocaleLowerCase().startsWith("zh") ? "zh" : "en";
  }

  subscribeProjectLanguage(listener: (language: ProjectLanguage) => void): () => void {
    this.languageListeners.add(listener);
    return () => this.languageListeners.delete(listener);
  }

  getProjectTitle(project: LoadedInteractiveProject): string {
    return this.getProjectLanguage() === "en" && project.manifest.titleI18n?.en
      ? project.manifest.titleI18n.en
      : project.manifest.title;
  }

  private async setProjectLanguage(language: ProjectLanguage): Promise<void> {
    if (language !== "zh" && language !== "en") return;
    if (this.languageOverride === language) return;
    this.languageOverride = language;
    for (const listener of this.languageListeners) listener(language);
    await this.saveData({ languageOverride: language } satisfies RuntimeSettings);
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
              : this.getProjectLanguage() === "en" ? "This device could not load the invited game" : "本机无法加载受邀游戏");
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
        : this.getProjectLanguage() === "en" ? "Could not load the interactive app" : "无法加载互动应用");
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
      text: this.getProjectLanguage() === "en" ? "Loading interactive app…" : "正在加载互动应用…",
    });
    try {
      const directive = parseProjectDirective(source);
      const manifestPath = this.loader.resolveManifestPath(directive, markdownContext.sourcePath);
      const project = await this.loader.load(manifestPath, directive.id);
      element.empty();

      if (directive.mode === "view") {
        const launchButton = element.createEl("button", {
          cls: "mod-cta ogr-launch-button",
          text: this.getProjectLanguage() === "en"
            ? `Open ${this.getProjectTitle(project)} in immersive mode`
            : `进入${project.manifest.title}沉浸模式`,
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
          : this.getProjectLanguage() === "en" ? "Could not load the interactive app" : "无法加载互动应用",
      });
    }
  }
}
