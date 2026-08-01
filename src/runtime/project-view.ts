import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type InteractiveVaultRuntimePlugin from "../main";
import { mountProject } from "./project-render-child";

export const PROJECT_VIEW_TYPE = "interactive-vault-project";

interface ProjectViewState extends Record<string, unknown> {
  manifestPath?: string;
  expectedId?: string;
}

export class ProjectView extends ItemView {
  private manifestPath?: string;
  private expectedId?: string;
  private projectTitle = "互动应用";
  private projectIcon = "blocks";
  private unmountProject?: () => void;
  private renderVersion = 0;

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
    return this.projectTitle;
  }

  getIcon(): string {
    return this.projectIcon;
  }

  getState(): ProjectViewState {
    return { manifestPath: this.manifestPath, expectedId: this.expectedId };
  }

  async setState(state: ProjectViewState, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    this.readState(state);
    if (this.contentEl.isConnected) await this.renderProject();
  }

  async onOpen(): Promise<void> {
    this.readState(this.leaf.getViewState().state as ProjectViewState);
    await this.renderProject();
  }

  async onClose(): Promise<void> {
    this.renderVersion += 1;
    this.unmountProject?.();
    this.unmountProject = undefined;
    this.contentEl.empty();
  }

  private readState(state: ProjectViewState): void {
    this.manifestPath = typeof state.manifestPath === "string" ? state.manifestPath : undefined;
    this.expectedId = typeof state.expectedId === "string" ? state.expectedId : undefined;
  }

  private async renderProject(): Promise<void> {
    const version = ++this.renderVersion;
    this.unmountProject?.();
    this.unmountProject = undefined;
    this.contentEl.empty();
    this.contentEl.addClass("ogr-view-host");

    if (!this.manifestPath) {
      this.showError("缺少项目 manifest 路径");
      return;
    }

    this.contentEl.createDiv({ cls: "ogr-loading", text: "正在加载互动应用…" });
    try {
      const project = await this.plugin.loader.load(this.manifestPath, this.expectedId);
      if (version !== this.renderVersion) return;

      this.projectTitle = project.manifest.title;
      this.projectIcon = project.manifest.icon || "blocks";
      this.contentEl.empty();
      this.unmountProject = mountProject(
        this.contentEl,
        project,
        this.plugin.createProjectContext(project, "view"),
      );
    } catch (error) {
      if (version !== this.renderVersion) return;
      this.showError(error instanceof Error ? error.message : "无法加载互动应用");
    }
  }

  private showError(message: string): void {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "ogr-error", text: message });
  }
}
