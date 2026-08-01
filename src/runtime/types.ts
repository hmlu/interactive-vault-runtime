export type DisplayMode = "embedded" | "view";

export interface ProjectStorage<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
  clear(): Promise<void>;
}

export interface ProjectContext {
  displayMode: DisplayMode;
  sourcePath?: string;
  storage: ProjectStorage<unknown>;
  openInView(): Promise<void>;
}

export interface InteractiveProjectManifest {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  icon?: string;
  entry: string;
  styles?: string[];
}

export interface InteractiveProjectModule {
  mount(container: HTMLElement, context: ProjectContext): void | (() => void);
}

export interface LoadedInteractiveProject {
  manifestPath: string;
  manifest: InteractiveProjectManifest;
  module: InteractiveProjectModule;
  styleSources: string[];
}

export interface ProjectDirective {
  id?: string;
  manifest?: string;
  mode?: DisplayMode;
}
