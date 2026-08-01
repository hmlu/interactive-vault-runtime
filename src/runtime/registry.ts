import type { InteractiveProject } from "./types";

export class ProjectRegistry {
  private readonly projects = new Map<string, InteractiveProject>();

  register(project: InteractiveProject): void {
    if (this.projects.has(project.id)) {
      throw new Error(`项目 id 重复：${project.id}`);
    }
    this.projects.set(project.id, project);
  }

  get(id: string): InteractiveProject | undefined {
    return this.projects.get(id);
  }

  all(): InteractiveProject[] {
    return [...this.projects.values()];
  }
}
