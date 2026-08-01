import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ProjectContext, ProjectStorage } from "../../runtime/types";
import {
  countFlags,
  createNewGame,
  DIFFICULTIES,
  restoreGame,
  revealAt,
  toggleFlagAt,
  type Cell,
  type DifficultyKey,
  type GameState,
  type PersistedMinesweeperGame,
} from "./engine";

interface MinesweeperProps {
  context: ProjectContext;
}

export function mountMinesweeper(container: HTMLElement, context: ProjectContext): () => void {
  render(<Minesweeper context={context} />, container);
  return () => render(null, container);
}

function Minesweeper({ context }: MinesweeperProps) {
  const storage = context.storage as ProjectStorage<PersistedMinesweeperGame>;
  const [game, setGame] = useState<GameState>(() => createNewGame("beginner"));
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [flagMode, setFlagMode] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const latestRef = useRef({ game, elapsedSeconds, flagMode });

  latestRef.current = { game, elapsedSeconds, flagMode };

  const persist = useCallback(
    (snapshot = latestRef.current) => {
      void storage
        .save({
          version: 1,
          game: snapshot.game,
          elapsedSeconds: snapshot.elapsedSeconds,
          flagMode: snapshot.flagMode,
        })
        .catch((error) => console.error("[Minesweeper] 无法保存进度", error));
    },
    [storage],
  );

  useEffect(() => {
    let disposed = false;
    void storage.load().then((value) => {
      if (disposed) return;
      const restored = restoreGame(value);
      if (restored) {
        setGame(restored.game);
        setElapsedSeconds(restored.elapsedSeconds);
        setFlagMode(restored.flagMode);
      }
      setLoaded(true);
    });
    return () => {
      disposed = true;
      persist();
    };
  }, [persist, storage]);

  useEffect(() => {
    if (!loaded) return;
    const timeout = window.setTimeout(() => persist(), 180);
    return () => window.clearTimeout(timeout);
  }, [game, flagMode, loaded, persist]);

  useEffect(() => {
    if (game.status !== "playing") return;
    const interval = window.setInterval(() => {
      setElapsedSeconds((current) => {
        const next = current + 1;
        if (next % 10 === 0) {
          persist({ ...latestRef.current, elapsedSeconds: next });
        }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [game.status, persist]);

  const startNewGame = useCallback((difficulty: DifficultyKey = game.difficulty) => {
    setGame(createNewGame(difficulty));
    setElapsedSeconds(0);
  }, [game.difficulty]);

  const reveal = useCallback(
    (row: number, column: number) => {
      if (flagMode) {
        setGame((current) => toggleFlagAt(current, row, column));
      } else {
        setGame((current) => revealAt(current, row, column));
      }
    },
    [flagMode],
  );

  const flag = useCallback((row: number, column: number) => {
    setGame((current) => toggleFlagAt(current, row, column));
  }, []);

  const flags = countFlags(game.board);
  const remainingMines = game.mineCount - flags;
  const status = getStatusPresentation(game.status);

  if (!loaded) {
    return <div class="ogr-loading">正在恢复扫雷进度…</div>;
  }

  return (
    <section class={`minesweeper minesweeper--${context.displayMode}`}>
      <header class="minesweeper__header">
        <div>
          <p class="minesweeper__eyebrow">INTERACTIVE VAULT · 001</p>
          <h2>扫雷</h2>
          <p class="minesweeper__subtitle">首击安全 · 自动存档 · 桌面与触屏兼容</p>
        </div>
        {context.displayMode === "embedded" && (
          <button
            type="button"
            class="minesweeper__open-view"
            onClick={() => void context.openInView("minesweeper")}
          >
            独立页面
          </button>
        )}
      </header>

      <div class="minesweeper__controls" aria-label="游戏设置">
        <label>
          <span>难度</span>
          <select
            value={game.difficulty}
            onChange={(event) => startNewGame(event.currentTarget.value as DifficultyKey)}
          >
            {Object.values(DIFFICULTIES).map((difficulty) => (
              <option key={difficulty.key} value={difficulty.key}>
                {difficulty.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          class={`minesweeper__flag-mode ${flagMode ? "is-active" : ""}`}
          aria-pressed={flagMode}
          onClick={() => setFlagMode((active) => !active)}
        >
          <span aria-hidden="true">⚑</span>
          {flagMode ? "插旗模式：开" : "插旗模式"}
        </button>
      </div>

      <div class="minesweeper__dashboard">
        <Stat label="剩余雷数" value={String(remainingMines).padStart(2, "0")} />
        <button
          type="button"
          class={`minesweeper__reset minesweeper__reset--${game.status}`}
          onClick={() => startNewGame()}
          aria-label="重新开始"
          title="重新开始"
        >
          <span aria-hidden="true">{status.face}</span>
        </button>
        <Stat label="用时" value={formatTime(elapsedSeconds)} />
      </div>

      <p class={`minesweeper__status minesweeper__status--${game.status}`} role="status">
        <span aria-hidden="true">{status.icon}</span>
        {status.message}
      </p>

      <div class="minesweeper__board-scroll" tabIndex={0} aria-label="扫雷棋盘，可横向滚动">
        <div
          class="minesweeper__board"
          role="grid"
          aria-rowcount={game.rows}
          aria-colcount={game.columns}
          style={{
            "--minesweeper-columns": game.columns,
            "--minesweeper-cell-size": getCellSize(game.difficulty),
          }}
        >
          {game.board.map((row, rowIndex) =>
            row.map((cell, columnIndex) => (
              <CellButton
                key={`${rowIndex}:${columnIndex}`}
                cell={cell}
                row={rowIndex}
                column={columnIndex}
                ended={game.status === "won" || game.status === "lost"}
                onReveal={reveal}
                onFlag={flag}
              />
            )),
          )}
        </div>
      </div>

      <footer class="minesweeper__help">
        <span><strong>桌面：</strong>左键翻开，右键插旗，点击数字可快速展开。</span>
        <span><strong>手机：</strong>轻触翻开，长按插旗；也可开启插旗模式。</span>
      </footer>
    </section>
  );
}

function CellButton({
  cell,
  row,
  column,
  ended,
  onReveal,
  onFlag,
}: {
  cell: Cell;
  row: number;
  column: number;
  ended: boolean;
  onReveal(row: number, column: number): void;
  onFlag(row: number, column: number): void;
}) {
  const pressTimer = useRef<number>();
  const longPressTriggered = useRef(false);

  const cancelLongPress = () => {
    if (pressTimer.current !== undefined) window.clearTimeout(pressTimer.current);
    pressTimer.current = undefined;
  };

  const startLongPress = (event: PointerEvent) => {
    if (event.pointerType === "mouse" || ended || cell.revealed) return;
    longPressTriggered.current = false;
    pressTimer.current = window.setTimeout(() => {
      longPressTriggered.current = true;
      onFlag(row, column);
      navigator.vibrate?.(30);
    }, 450);
  };

  const activate = (event: MouseEvent) => {
    if (longPressTriggered.current) {
      event.preventDefault();
      longPressTriggered.current = false;
      return;
    }
    onReveal(row, column);
  };

  const label = getCellLabel(cell, row, column);
  const content = getCellContent(cell);
  const classes = [
    "minesweeper__cell",
    cell.revealed ? "is-revealed" : "is-covered",
    cell.flagged ? "is-flagged" : "",
    cell.revealed && cell.mine ? "is-mine" : "",
    cell.revealed && !cell.mine && cell.adjacent > 0 ? `is-number-${cell.adjacent}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      role="gridcell"
      class={classes}
      aria-label={label}
      aria-pressed={cell.flagged}
      disabled={ended && !cell.revealed}
      onClick={activate}
      onContextMenu={(event) => {
        event.preventDefault();
        onFlag(row, column);
      }}
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onKeyDown={(event) => {
        if (event.key.toLowerCase() === "f") {
          event.preventDefault();
          onFlag(row, column);
        }
      }}
    >
      <span aria-hidden="true">{content}</span>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div class="minesweeper__stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getStatusPresentation(status: GameState["status"]) {
  switch (status) {
    case "playing":
      return { face: "🙂", icon: "◆", message: "排雷进行中，小心下一格。" };
    case "won":
      return { face: "😎", icon: "✓", message: "区域已清理，任务完成！" };
    case "lost":
      return { face: "😵", icon: "×", message: "触雷了。复盘一下，再来一局。" };
    default:
      return { face: "🙂", icon: "◇", message: "选择任意格开始，第一次点击一定安全。" };
  }
}

function getCellContent(cell: Cell): string {
  if (cell.flagged && !cell.revealed) return "⚑";
  if (!cell.revealed) return "";
  if (cell.mine) return cell.flagged ? "⚑" : "✹";
  return cell.adjacent > 0 ? String(cell.adjacent) : "";
}

function getCellLabel(cell: Cell, row: number, column: number): string {
  const position = `第 ${row + 1} 行，第 ${column + 1} 列`;
  if (cell.flagged && !cell.revealed) return `${position}，已插旗`;
  if (!cell.revealed) return `${position}，未翻开`;
  if (cell.mine) return `${position}，地雷`;
  if (cell.adjacent === 0) return `${position}，空白`;
  return `${position}，附近有 ${cell.adjacent} 个地雷`;
}

function formatTime(totalSeconds: number): string {
  const capped = Math.min(totalSeconds, 99 * 60 + 59);
  const minutes = Math.floor(capped / 60);
  const seconds = capped % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getCellSize(difficulty: DifficultyKey): string {
  if (difficulty === "beginner") return "clamp(30px, 8vw, 38px)";
  if (difficulty === "intermediate") return "clamp(27px, 6vw, 34px)";
  return "clamp(25px, 5vw, 31px)";
}
