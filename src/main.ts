import { Notice, Plugin, type MarkdownPostProcessorContext } from "obsidian";
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
} from "./runtime/types";

export default class InteractiveVaultRuntimePlugin extends Plugin {
  loader!: VaultProjectLoader;
  multiplayer!: MultiplayerService;
  private activeChallengeId: string | null = null;

  async onload(): Promise<void> {
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
    };
  }

  private presentIncomingChallenge(): void {
    const challenge = this.multiplayer.getIncomingChallenge();
    if (!challenge || challenge.challengeId === this.activeChallengeId) return;
    this.activeChallengeId = challenge.challengeId;
    new MultiplayerChallengeModal(this.app, challenge, (accept) => {
      void (async () => {
        if (accept) {
          try {
            await this.loader.load(challenge.project.manifestPath, challenge.project.id);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "本机无法加载受邀游戏");
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
      new Notice(error instanceof Error ? error.message : "无法加载互动应用");
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
    element.createDiv({ cls: "ogr-loading", text: "正在加载互动应用…" });
    try {
      const directive = parseProjectDirective(source);
      const manifestPath = this.loader.resolveManifestPath(directive, markdownContext.sourcePath);
      const project = await this.loader.load(manifestPath, directive.id);
      element.empty();

      if (directive.mode === "view") {
        const launchButton = element.createEl("button", {
          cls: "mod-cta ogr-launch-button",
          text: `进入${project.manifest.title}沉浸模式`,
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
        text: error instanceof Error ? error.message : "无法加载互动应用",
      });
    }
  }
}
