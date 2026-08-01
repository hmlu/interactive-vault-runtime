import { describe, expect, it } from "vitest";
import {
  chordAt,
  countFlags,
  createNewGame,
  restoreGame,
  revealAt,
  toggleFlagAt,
  type GameState,
} from "../src/projects/minesweeper/engine";

describe("minesweeper engine", () => {
  it("keeps the first cell and its neighbors safe", () => {
    const game = revealAt(createNewGame("beginner"), 4, 4, () => 0.37);

    expect(game.initialized).toBe(true);
    expect(game.board.flat().filter((cell) => cell.mine)).toHaveLength(10);
    for (let row = 3; row <= 5; row += 1) {
      for (let column = 3; column <= 5; column += 1) {
        expect(game.board[row][column].mine).toBe(false);
      }
    }
    expect(game.board[4][4].revealed).toBe(true);
    expect(game.board[4][4].adjacent).toBe(0);
  });

  it("toggles flags without revealing a cell", () => {
    const initial = createNewGame("beginner");
    const flagged = toggleFlagAt(initial, 0, 0);

    expect(flagged.board[0][0].flagged).toBe(true);
    expect(flagged.board[0][0].revealed).toBe(false);
    expect(countFlags(flagged.board)).toBe(1);
    expect(toggleFlagAt(flagged, 0, 0).board[0][0].flagged).toBe(false);
  });

  it("does not reveal a flagged cell", () => {
    const flagged = toggleFlagAt(createNewGame("beginner"), 0, 0);
    const result = revealAt(flagged, 0, 0, () => 0.5);

    expect(result).toBe(flagged);
    expect(result.initialized).toBe(false);
  });

  it("does not place more flags than the number of mines", () => {
    let game = createNewGame("beginner");
    for (let column = 0; column < game.mineCount + 1; column += 1) {
      const row = Math.floor(column / game.columns);
      game = toggleFlagAt(game, row, column % game.columns);
    }

    expect(countFlags(game.board)).toBe(game.mineCount);
  });

  it("reveals every mine after a loss", () => {
    let game = revealAt(createNewGame("beginner"), 4, 4, () => 0.21);
    const mineIndex = game.board.flat().findIndex((cell) => cell.mine);
    const mineRow = Math.floor(mineIndex / game.columns);
    const mineColumn = mineIndex % game.columns;

    game = revealAt(game, mineRow, mineColumn);

    expect(game.status).toBe("lost");
    expect(game.board.flat().filter((cell) => cell.mine).every((cell) => cell.revealed)).toBe(true);
  });

  it("wins when every safe cell is revealed", () => {
    let game = revealAt(createNewGame("beginner"), 4, 4, () => 0.63);

    for (let row = 0; row < game.rows; row += 1) {
      for (let column = 0; column < game.columns; column += 1) {
        if (!game.board[row][column].mine) game = revealAt(game, row, column);
      }
    }

    expect(game.status).toBe("won");
    expect(game.board.flat().filter((cell) => cell.mine).every((cell) => cell.flagged)).toBe(true);
  });

  it("chords around a revealed number when adjacent flags match", () => {
    const game: GameState = {
      difficulty: "beginner",
      rows: 2,
      columns: 2,
      mineCount: 1,
      initialized: true,
      status: "playing",
      board: [
        [
          { mine: true, revealed: false, flagged: true, adjacent: 0 },
          { mine: false, revealed: false, flagged: false, adjacent: 1 },
        ],
        [
          { mine: false, revealed: false, flagged: false, adjacent: 1 },
          { mine: false, revealed: true, flagged: false, adjacent: 1 },
        ],
      ],
    };

    const result = chordAt(game, 1, 1);

    expect(result.status).toBe("won");
    expect(result.board[0][1].revealed).toBe(true);
    expect(result.board[1][0].revealed).toBe(true);
  });

  it("rejects malformed saved games", () => {
    expect(restoreGame({ version: 1, game: { difficulty: "beginner" } })).toBeNull();
    expect(restoreGame(null)).toBeNull();
  });
});
