import type { App } from "obsidian";

export type DisplayMode = "embedded" | "view";

export interface ProjectStorage<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  clear(): Promise<void>;
}

export interface ProjectContext {
  app: App;
  displayMode: DisplayMode;
  sourcePath?: string;
  storage: ProjectStorage<unknown>;
  openInView(projectId: string): Promise<void>;
}

export interface InteractiveProject {
  id: string;
  title: string;
  description: string;
  icon: string;
  mount(container: HTMLElement, context: ProjectContext): () => void;
}

export interface ProjectDirective {
  id: string;
  mode?: DisplayMode;
}
