export type DifficultyKey = "beginner" | "intermediate" | "expert";
export type GameStatus = "ready" | "playing" | "won" | "lost";

export interface Difficulty {
  key: DifficultyKey;
  label: string;
  rows: number;
  columns: number;
  mines: number;
}

export interface Cell {
  mine: boolean;
  revealed: boolean;
  flagged: boolean;
  adjacent: number;
}

export interface GameState {
  difficulty: DifficultyKey;
  rows: number;
  columns: number;
  mineCount: number;
  board: Cell[][];
  initialized: boolean;
  status: GameStatus;
}

export interface PersistedMinesweeperGame {
  version: 1;
  game: GameState;
  elapsedSeconds: number;
  flagMode: boolean;
}

export const DIFFICULTIES: Record<DifficultyKey, Difficulty> = {
  beginner: {
    key: "beginner",
    label: "初级 · 9×9 · 10雷",
    rows: 9,
    columns: 9,
    mines: 10,
  },
  intermediate: {
    key: "intermediate",
    label: "中级 · 16×16 · 40雷",
    rows: 16,
    columns: 16,
    mines: 40,
  },
  expert: {
    key: "expert",
    label: "高级 · 16×30 · 99雷",
    rows: 16,
    columns: 30,
    mines: 99,
  },
};

export function createNewGame(difficultyKey: DifficultyKey): GameState {
  const difficulty = DIFFICULTIES[difficultyKey];
  return {
    difficulty: difficultyKey,
    rows: difficulty.rows,
    columns: difficulty.columns,
    mineCount: difficulty.mines,
    board: createBoard(difficulty.rows, difficulty.columns),
    initialized: false,
    status: "ready",
  };
}

export function createBoard(rows: number, columns: number): Cell[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => ({
      mine: false,
      revealed: false,
      flagged: false,
      adjacent: 0,
    })),
  );
}

export function revealAt(
  state: GameState,
  row: number,
  column: number,
  random: () => number = Math.random,
): GameState {
  if (state.status === "won" || state.status === "lost") return state;
  const target = state.board[row]?.[column];
  if (!target || target.flagged) return state;

  if (target.revealed) return chordAt(state, row, column);

  let board = state.board;
  let initialized = state.initialized;
  if (!initialized) {
    board = plantMines(state, row, column, random);
    initialized = true;
  }

  const revealed = revealFrom(board, row, column);
  if (revealed.hitMine) {
    return {
      ...state,
      board: revealAllMines(revealed.board),
      initialized,
      status: "lost",
    };
  }

  const won = hasWon(revealed.board);
  return {
    ...state,
    board: won ? flagAllMines(revealed.board) : revealed.board,
    initialized,
    status: won ? "won" : "playing",
  };
}

export function toggleFlagAt(state: GameState, row: number, column: number): GameState {
  if (state.status === "won" || state.status === "lost") return state;
  const target = state.board[row]?.[column];
  if (!target || target.revealed) return state;
  if (!target.flagged && countFlags(state.board) >= state.mineCount) return state;

  const board = cloneBoard(state.board);
  board[row][column].flagged = !board[row][column].flagged;
  return { ...state, board };
}

export function chordAt(state: GameState, row: number, column: number): GameState {
  if (!state.initialized || state.status !== "playing") return state;
  const target = state.board[row]?.[column];
  if (!target?.revealed || target.adjacent === 0) return state;

  const neighbors = getNeighbors(state.rows, state.columns, row, column);
  const flaggedCount = neighbors.filter(
    ([neighborRow, neighborColumn]) => state.board[neighborRow][neighborColumn].flagged,
  ).length;
  if (flaggedCount !== target.adjacent) return state;

  let board = state.board;
  for (const [neighborRow, neighborColumn] of neighbors) {
    const cell = board[neighborRow][neighborColumn];
    if (cell.revealed || cell.flagged) continue;
    const revealed = revealFrom(board, neighborRow, neighborColumn);
    board = revealed.board;
    if (revealed.hitMine) {
      return { ...state, board: revealAllMines(board), status: "lost" };
    }
  }

  const won = hasWon(board);
  return {
    ...state,
    board: won ? flagAllMines(board) : board,
    status: won ? "won" : "playing",
  };
}

export function countFlags(board: Cell[][]): number {
  return board.reduce(
    (total, row) => total + row.filter((cell) => cell.flagged).length,
    0,
  );
}

export function restoreGame(value: unknown): PersistedMinesweeperGame | null {
  if (!value || typeof value !== "object") return null;
  const persisted = value as Partial<PersistedMinesweeperGame>;
  const game = persisted.game;
  if (persisted.version !== 1 || !game || typeof game !== "object") return null;
  if (!Object.hasOwn(DIFFICULTIES, game.difficulty)) return null;

  const difficulty = DIFFICULTIES[game.difficulty];
  if (
    game.rows !== difficulty.rows ||
    game.columns !== difficulty.columns ||
    game.mineCount !== difficulty.mines ||
    !Array.isArray(game.board) ||
    game.board.length !== difficulty.rows ||
    game.board.some((row) => !Array.isArray(row) || row.length !== difficulty.columns) ||
    !["ready", "playing", "won", "lost"].includes(game.status)
  ) {
    return null;
  }

  const validCells = game.board.every((row) =>
    row.every(
      (cell) =>
        cell &&
        typeof cell.mine === "boolean" &&
        typeof cell.revealed === "boolean" &&
        typeof cell.flagged === "boolean" &&
        Number.isInteger(cell.adjacent) &&
        cell.adjacent >= 0 &&
        cell.adjacent <= 8,
    ),
  );
  if (!validCells) return null;

  return {
    version: 1,
    game,
    elapsedSeconds:
      typeof persisted.elapsedSeconds === "number"
        ? Math.max(0, Math.floor(persisted.elapsedSeconds))
        : 0,
    flagMode: persisted.flagMode === true,
  };
}

function plantMines(
  state: GameState,
  safeRow: number,
  safeColumn: number,
  random: () => number,
): Cell[][] {
  const board = cloneBoard(state.board).map((row) =>
    row.map((cell) => ({ ...cell, mine: false, adjacent: 0 })),
  );
  const safeCells = new Set(
    [[safeRow, safeColumn], ...getNeighbors(state.rows, state.columns, safeRow, safeColumn)].map(
      ([row, column]) => `${row}:${column}`,
    ),
  );
  const candidates: Array<[number, number]> = [];

  for (let row = 0; row < state.rows; row += 1) {
    for (let column = 0; column < state.columns; column += 1) {
      if (!safeCells.has(`${row}:${column}`)) candidates.push([row, column]);
    }
  }

  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }

  for (const [row, column] of candidates.slice(0, state.mineCount)) {
    board[row][column].mine = true;
  }

  for (let row = 0; row < state.rows; row += 1) {
    for (let column = 0; column < state.columns; column += 1) {
      board[row][column].adjacent = getNeighbors(state.rows, state.columns, row, column).filter(
        ([neighborRow, neighborColumn]) => board[neighborRow][neighborColumn].mine,
      ).length;
    }
  }

  return board;
}

function revealFrom(
  source: Cell[][],
  startRow: number,
  startColumn: number,
): { board: Cell[][]; hitMine: boolean } {
  const board = cloneBoard(source);
  const start = board[startRow]?.[startColumn];
  if (!start || start.flagged || start.revealed) return { board: source, hitMine: false };

  if (start.mine) {
    start.revealed = true;
    return { board, hitMine: true };
  }

  const queue: Array<[number, number]> = [[startRow, startColumn]];
  const queued = new Set([`${startRow}:${startColumn}`]);
  while (queue.length > 0) {
    const [row, column] = queue.shift()!;
    const cell = board[row][column];
    if (cell.revealed || cell.flagged || cell.mine) continue;
    cell.revealed = true;

    if (cell.adjacent !== 0) continue;
    for (const [neighborRow, neighborColumn] of getNeighbors(
      board.length,
      board[0].length,
      row,
      column,
    )) {
      const key = `${neighborRow}:${neighborColumn}`;
      const neighbor = board[neighborRow][neighborColumn];
      if (!neighbor.revealed && !neighbor.flagged && !neighbor.mine && !queued.has(key)) {
        queued.add(key);
        queue.push([neighborRow, neighborColumn]);
      }
    }
  }

  return { board, hitMine: false };
}

function getNeighbors(
  rows: number,
  columns: number,
  row: number,
  column: number,
): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
      if (rowOffset === 0 && columnOffset === 0) continue;
      const neighborRow = row + rowOffset;
      const neighborColumn = column + columnOffset;
      if (
        neighborRow >= 0 &&
        neighborRow < rows &&
        neighborColumn >= 0 &&
        neighborColumn < columns
      ) {
        result.push([neighborRow, neighborColumn]);
      }
    }
  }
  return result;
}

function cloneBoard(board: Cell[][]): Cell[][] {
  return board.map((row) => row.map((cell) => ({ ...cell })));
}

function revealAllMines(board: Cell[][]): Cell[][] {
  return board.map((row) =>
    row.map((cell) => (cell.mine ? { ...cell, revealed: true } : { ...cell })),
  );
}

function flagAllMines(board: Cell[][]): Cell[][] {
  return board.map((row) =>
    row.map((cell) => (cell.mine ? { ...cell, flagged: true } : { ...cell })),
  );
}

function hasWon(board: Cell[][]): boolean {
  return board.every((row) => row.every((cell) => cell.mine || cell.revealed));
}
