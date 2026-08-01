import type { InteractiveProject } from "../../runtime/types";
import { mountMinesweeper } from "./Minesweeper";

export const minesweeperProject: InteractiveProject = {
  id: "minesweeper",
  title: "扫雷",
  description: "经典扫雷，支持首击保护、连锁翻开、快捷展开和触控操作。",
  icon: "bomb",
  mount: mountMinesweeper,
};
