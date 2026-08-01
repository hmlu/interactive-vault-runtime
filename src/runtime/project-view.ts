import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type InteractiveVaultRuntimePlugin from "../main";

export const PROJECT_VIEW_TYPE = "interactive-vault-project";

interface ProjectViewState extends Record<string, unknown> {
  projectId?: string;
}

export class ProjectView extends ItemView {
  private projectId = "minesweeper";
  private unmountProject?: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: InteractiveVaultRuntimePlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return PROJECT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.plugin.registry.get(this.projectId)?.title ?? "互动应用";
  }

  getIcon(): string {
    return this.plugin.registry.get(this.projectId)?.icon ?? "gamepad-2";
  }

  getState(): ProjectViewState {
    return { projectId: this.projectId };
  }

  async setState(state: ProjectViewState, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    if (typeof state.projectId === "string") this.projectId = state.projectId;
    if (this.contentEl.isConnected) this.renderProject();
  }

  async onOpen(): Promise<void> {
    const state = this.leaf.getViewState().state as ProjectViewState;
    if (typeof state.projectId === "string") this.projectId = state.projectId;
    this.renderProject();
  }

  async onClose(): Promise<void> {
    this.unmountProject?.();
    this.unmountProject = undefined;
    this.contentEl.empty();
  }

  private renderProject(): void {
    this.unmountProject?.();
    this.unmountProject = undefined;
    this.contentEl.empty();
    this.contentEl.addClass("ogr-view-host");

    const project = this.plugin.registry.get(this.projectId);
    if (!project) {
      this.contentEl.createDiv({
        cls: "ogr-error",
        text: `找不到互动项目：${this.projectId}`,
      });
      return;
    }

    this.unmountProject = project.mount(
      this.contentEl,
      this.plugin.createProjectContext(project.id, "view"),
    );
  }
}
