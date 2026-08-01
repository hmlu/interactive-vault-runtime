import { Notice, Plugin } from "obsidian";
import { minesweeperProject } from "./projects/minesweeper";
import { VaultProjectStorage } from "./platform/vault-storage";
import { parseProjectDirective } from "./runtime/directive";
import { ProjectRenderChild } from "./runtime/project-render-child";
import { ProjectRegistry } from "./runtime/registry";
import { PROJECT_VIEW_TYPE, ProjectView } from "./runtime/project-view";
import type { DisplayMode, ProjectContext } from "./runtime/types";

export default class InteractiveVaultRuntimePlugin extends Plugin {
  readonly registry = new ProjectRegistry();

  async onload(): Promise<void> {
    this.registry.register(minesweeperProject);

    this.registerView(
      PROJECT_VIEW_TYPE,
      (leaf) => new ProjectView(leaf, this),
    );

    this.registerMarkdownCodeBlockProcessor(
      "obs-game",
      (source, element, markdownContext) => {
        try {
          const directive = parseProjectDirective(source);
          const project = this.registry.get(directive.id);

          if (!project) {
            element.createDiv({
              cls: "ogr-error",
              text: `找不到互动项目：${directive.id}`,
            });
            return;
          }

          if (directive.mode === "view") {
            const launchButton = element.createEl("button", {
              cls: "mod-cta ogr-launch-button",
              text: `打开${project.title}`,
            });
            this.registerDomEvent(launchButton, "click", () => {
              void this.openProject(project.id);
            });
            return;
          }

          markdownContext.addChild(
            new ProjectRenderChild(
              element,
              project,
              this.createProjectContext(project.id, "embedded", markdownContext.sourcePath),
            ),
          );
        } catch (error) {
          element.createDiv({
            cls: "ogr-error",
            text: error instanceof Error ? error.message : "无法加载互动项目",
          });
        }
      },
    );

    this.addRibbonIcon("bomb", "打开扫雷", () => {
      void this.openProject("minesweeper");
    });

    this.addCommand({
      id: "open-minesweeper",
      name: "打开扫雷",
      callback: () => void this.openProject("minesweeper"),
    });
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(PROJECT_VIEW_TYPE);
  }

  createProjectContext(
    projectId: string,
    displayMode: DisplayMode,
    sourcePath?: string,
  ): ProjectContext {
    return {
      app: this.app,
      displayMode,
      sourcePath,
      storage: new VaultProjectStorage(this.app, projectId),
      openInView: (id) => this.openProject(id),
    };
  }

  async openProject(projectId: string): Promise<void> {
    const project = this.registry.get(projectId);
    if (!project) {
      new Notice(`找不到互动项目：${projectId}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: PROJECT_VIEW_TYPE,
      active: true,
      state: { projectId },
    });
    await this.app.workspace.revealLeaf(leaf);
  }
}
