import { App, Modal } from "obsidian";
import type { IncomingChallengeSnapshot } from "./multiplayer-service";
import type { ProjectLanguage } from "../runtime/types";

export class MultiplayerChallengeModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly challenge: IncomingChallengeSnapshot,
    private readonly language: ProjectLanguage,
    private readonly respond: (accept: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const english = this.language === "en";
    this.containerEl.addClass("ogr-multiplayer-challenge-layer");
    this.modalEl.addClass("ogr-multiplayer-challenge-modal");
    this.contentEl.createEl("p", {
      cls: "ogr-multiplayer-challenge-eyebrow",
      text: english ? "Multiplayer invitation" : "联机对局邀请",
    });
    this.contentEl.createEl("h2", {
      text: english ? `${this.challenge.peerName} invited you to play` : `${this.challenge.peerName} 邀请你游玩`,
    });
    const game = this.contentEl.createDiv({ cls: "ogr-multiplayer-challenge-game" });
    game.createEl("strong", { text: this.challenge.project.title });
    game.createEl("small", {
      text: english ? `Protocol version ${this.challenge.protocolVersion}` : `协议版本 ${this.challenge.protocolVersion}`,
    });
    this.contentEl.createEl("p", {
      cls: "ogr-multiplayer-challenge-description",
      text: english
        ? "Accepting opens the game. Declining keeps you connected to the party."
        : "接受后将打开对应游戏；拒绝不会断开联机小队。",
    });
    const actions = this.contentEl.createDiv({ cls: "ogr-multiplayer-challenge-actions" });
    actions.createEl("button", { text: english ? "Decline" : "拒绝" }).addEventListener("click", () => this.answer(false));
    actions.createEl("button", { cls: "mod-cta", text: english ? "Accept and open" : "接受并进入" }).addEventListener("click", () => this.answer(true));
  }

  onClose(): void {
    this.containerEl.removeClass("ogr-multiplayer-challenge-layer");
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
