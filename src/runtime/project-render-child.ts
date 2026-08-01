import { MarkdownRenderChild } from "obsidian";
import type { InteractiveProject, ProjectContext } from "./types";

export class ProjectRenderChild extends MarkdownRenderChild {
  private unmountProject?: () => void;

  constructor(
    containerEl: HTMLElement,
    private readonly project: InteractiveProject,
    private readonly context: ProjectContext,
  ) {
    super(containerEl);
  }

  onload(): void {
    this.containerEl.addClass("ogr-embed-host");
    this.unmountProject = this.project.mount(this.containerEl, this.context);
  }

  onunload(): void {
    this.unmountProject?.();
    this.unmountProject = undefined;
    this.containerEl.empty();
  }
}
