import { MarkdownRenderChild } from "obsidian";
import type { LoadedInteractiveProject, ProjectContext } from "./types";

export class ProjectRenderChild extends MarkdownRenderChild {
  private unmountProject?: () => void;

  constructor(
    containerEl: HTMLElement,
    private readonly project: LoadedInteractiveProject,
    private readonly context: ProjectContext,
  ) {
    super(containerEl);
  }

  onload(): void {
    this.containerEl.addClass("ogr-embed-host");
    this.unmountProject = mountProject(this.containerEl, this.project, this.context);
  }

  onunload(): void {
    this.unmountProject?.();
    this.unmountProject = undefined;
    this.containerEl.empty();
  }
}

export function mountProject(
  container: HTMLElement,
  project: LoadedInteractiveProject,
  context: ProjectContext,
): () => void {
  for (const source of project.styleSources) {
    const style = container.createEl("style", { cls: "ivr-project-style" });
    style.textContent = source;
  }
  const projectRoot = container.createDiv({ cls: "ivr-project-root" });
  const cleanup = project.module.mount(projectRoot, context);

  return () => {
    if (typeof cleanup === "function") cleanup();
    container.empty();
  };
}
