import { App, Modal } from "obsidian";
import type { IncomingChallengeSnapshot } from "./multiplayer-service";

export class MultiplayerChallengeModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly challenge: IncomingChallengeSnapshot,
    private readonly respond: (accept: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ogr-multiplayer-challenge-modal");
    this.contentEl.createEl("p", { cls: "ogr-multiplayer-challenge-eyebrow", text: "联机对局邀请" });
    this.contentEl.createEl("h2", { text: `${this.challenge.peerName} 邀请你游玩` });
    const game = this.contentEl.createDiv({ cls: "ogr-multiplayer-challenge-game" });
    game.createEl("strong", { text: this.challenge.project.title });
    game.createEl("small", { text: `协议版本 ${this.challenge.protocolVersion}` });
    this.contentEl.createEl("p", {
      cls: "ogr-multiplayer-challenge-description",
      text: "接受后将打开对应游戏；拒绝不会断开联机小队。",
    });
    const actions = this.contentEl.createDiv({ cls: "ogr-multiplayer-challenge-actions" });
    actions.createEl("button", { text: "拒绝" }).addEventListener("click", () => this.answer(false));
    actions.createEl("button", { cls: "mod-cta", text: "接受并进入" }).addEventListener("click", () => this.answer(true));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.respond(false);
  }

  private answer(accept: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.respond(accept);
    this.close();
  }
}
