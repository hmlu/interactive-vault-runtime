import { Notice, Plugin, type MarkdownPostProcessorContext } from "obsidian";
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

  async onload(): Promise<void> {
    this.loader = new VaultProjectLoader(this.app);

    this.registerView(
      PROJECT_VIEW_TYPE,
      (leaf) => new ProjectView(leaf, this),
    );

    for (const language of ["interactive-vault", "obs-game"]) {
      this.registerMarkdownCodeBlockProcessor(
        language,
        (source, element, markdownContext) =>
          this.renderDirective(source, element, markdownContext),
      );
    }
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(PROJECT_VIEW_TYPE);
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
    };
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
          text: `打开${project.manifest.title}`,
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
