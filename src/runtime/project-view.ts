import { ItemView, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
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
  private projectTitleZh = "互动应用";
  private projectTitles: Record<string, string> = {};
  private projectIcon = "blocks";
  private unmountProject?: () => void;
  private immersiveEl?: HTMLElement;
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
    this.register(this.plugin.subscribeProjectLanguage(() => this.updateLocalizedChrome()));
    this.registerDomEvent(
      this.contentEl.ownerDocument,
      "keydown",
      (event) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          !this.immersiveEl?.isConnected
        ) {
          return;
        }
        const activeHost = this.immersiveEl;
        queueMicrotask(() => {
          if (
            event.defaultPrevented ||
            !activeHost?.isConnected ||
            this.immersiveEl !== activeHost
          ) {
            return;
          }
          this.exitImmersiveMode();
        });
      },
      { capture: true },
    );
    this.readState(this.leaf.getViewState().state as ProjectViewState);
    await this.renderProject();
  }

  async onClose(): Promise<void> {
    this.renderVersion += 1;
    this.unmountProject?.();
    this.unmountProject = undefined;
    this.removeImmersiveHost();
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
    const host = this.prepareImmersiveHost();

    if (!this.manifestPath) {
      this.showError(this.plugin.isProjectLanguageChinese() ? "缺少项目 manifest 路径" : "Missing project manifest path");
      return;
    }

    host.createDiv({
      cls: "ogr-loading",
      text: this.plugin.isProjectLanguageChinese() ? "正在加载互动应用…" : "Loading interactive app…",
    });
    try {
      const project = await this.plugin.loader.load(this.manifestPath, this.expectedId);
      if (version !== this.renderVersion) return;

      this.projectTitleZh = project.manifest.title;
      this.projectTitles = project.manifest.titleI18n ?? {};
      this.projectTitle = this.plugin.getProjectTitle(project);
      this.projectIcon = project.manifest.icon || "blocks";
      const projectHost = this.prepareImmersiveHost();
      this.unmountProject = mountProject(
        projectHost,
        project,
        this.plugin.createProjectContext(project, "view"),
      );
    } catch (error) {
      if (version !== this.renderVersion) return;
      this.showError(error instanceof Error
        ? error.message
        : this.plugin.isProjectLanguageChinese() ? "无法加载互动应用" : "Could not load the interactive app");
    }
  }

  private showError(message: string): void {
    const host = this.prepareImmersiveHost();
    host.createDiv({ cls: "ogr-error", text: message });
  }

  private prepareImmersiveHost(): HTMLElement {
    this.removeImmersiveHost();
    const host = this.contentEl.ownerDocument.body.createDiv({
      cls: "ogr-immersive-host",
      attr: {
        contenteditable: "false",
        spellcheck: "false",
        draggable: "false",
        "data-ivr-app-surface": "true",
      },
    });
    this.immersiveEl = host;
    this.installAppSurfaceGuards(host);

    const exitButton = host.createEl("button", {
      cls: "ivr-exit-immersive",
      attr: {
        type: "button",
        "aria-label": this.plugin.isProjectLanguageChinese() ? "退出沉浸模式" : "Exit immersive mode",
        title: this.plugin.isProjectLanguageChinese() ? "退出沉浸模式（Esc）" : "Exit immersive mode (Esc)",
      },
    });
    const icon = exitButton.createSpan({ cls: "ivr-exit-immersive__icon" });
    setIcon(icon, "minimize-2");
    exitButton.createSpan({ cls: "ivr-exit-immersive__label", text: this.plugin.isProjectLanguageChinese() ? "退出沉浸" : "Exit" });
    exitButton.addEventListener("click", () => this.exitImmersiveMode());
    return host;
  }

  private updateLocalizedChrome(): void {
    const chinese = this.plugin.isProjectLanguageChinese();
    const language = this.plugin.getProjectLanguage().toLocaleLowerCase();
    const baseLanguage = language.split("-")[0];
    this.projectTitle = chinese
      ? this.projectTitleZh
      : this.projectTitles[language] ?? this.projectTitles[baseLanguage] ?? this.projectTitles.en ?? this.projectTitleZh;
    const button = this.immersiveEl?.querySelector<HTMLButtonElement>(".ivr-exit-immersive");
    if (!button) return;
    button.setAttribute("aria-label", chinese ? "退出沉浸模式" : "Exit immersive mode");
    button.title = chinese ? "退出沉浸模式（Esc）" : "Exit immersive mode (Esc)";
    const label = button.querySelector<HTMLElement>(".ivr-exit-immersive__label");
    if (label) label.textContent = chinese ? "退出沉浸" : "Exit";
  }

  private installAppSurfaceGuards(host: HTMLElement): void {
    const closest = (target: EventTarget | null, selector: string): Element | null => {
      if (!target || typeof (target as Element).closest !== "function") return null;
      return (target as Element).closest(selector);
    };
    const editableSelector = "input, textarea, select, [contenteditable='true'], .ivr-allow-text-input";

    host.addEventListener("beforeinput", (event) => {
      if (!closest(event.target, editableSelector)) event.preventDefault();
    });
    host.addEventListener("selectstart", (event) => {
      if (!closest(event.target, `${editableSelector}, .ivr-allow-select`)) event.preventDefault();
    });
    host.addEventListener("contextmenu", (event) => {
      if (!closest(event.target, `${editableSelector}, .ivr-allow-context-menu`)) event.preventDefault();
    });
    host.addEventListener("dragstart", (event) => {
      if (!closest(event.target, ".ivr-allow-drag")) event.preventDefault();
    });
  }

  private removeImmersiveHost(): void {
    this.immersiveEl?.remove();
    this.immersiveEl = undefined;
  }

  private exitImmersiveMode(): void {
    this.leaf.detach();
  }
}
