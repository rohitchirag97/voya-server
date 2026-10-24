import { describe, expect, test } from "bun:test";
import { autoToken, colorsFor, globalSquare, HOME, legalTokens, lobbyState, move, roll, startGame, type LudoState } from "../src/lib/ludo";

// Pure rules: no server, no database.
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, displayName: `P${i}`, avatarUrl: null }));
const game = (n = 2) => startGame(lobbyState(), people(n));
const withTokens = (s: LudoState, tokens: number[][]) => ({ ...s, players: s.players.map((p, i) => ({ ...p, tokens: tokens[i] ?? p.tokens })) });

describe("ludo rules", () => {
  test("seating: 2 players face each other, 3-4 fill in order", () => {
    expect(colorsFor(2)).toEqual([0, 2]);
    expect(colorsFor(3)).toEqual([0, 1, 2]);
    expect(game(4).players.map((p) => p.color)).toEqual([0, 1, 2, 3]);
    expect(game().players.every((p) => p.tokens.every((t) => t === -1))).toBe(true);
  });

  test("the shared loop lines up across colours", () => {
    expect(globalSquare(0, 13)).toBe(globalSquare(1, 0)); // red 13 steps in = green's start
    expect(globalSquare(3, 13)).toBe(globalSquare(0, 0)); // blue wraps round to red's start
    expect(globalSquare(0, 51)).toBeNull(); // home column is private
    expect(globalSquare(0, -1)).toBeNull();
  });

  test("only a 6 leaves base; no move passes the turn", () => {
    let s = roll(game(), 3);
    expect(s.last).toMatchObject({ kind: "pass", reason: "NO_MOVE" });
    expect(s.turn).toBe(1);
    s = roll(s, 6);
    expect(s).toMatchObject({ step: "move", legal: [0, 1, 2, 3], turn: 1 });
    s = move(s, 2);
    expect(s.players[1]!.tokens[2]).toBe(0);
    expect(s).toMatchObject({ turn: 1, step: "roll", sixes: 1 }); // a 6 rolls again
  });

  test("an ordinary move passes the turn", () => {
    const s = move(roll(withTokens(game(), [[5, -1, -1, -1]]), 4), 0);
    expect(s.players[0]!.tokens[0]).toBe(9);
    expect(s).toMatchObject({ turn: 1, sixes: 0 });
  });

  test("home needs the exact roll, and reaching home rolls again", () => {
    const s = withTokens(game(), [[54, -1, -1, -1]]);
    expect(legalTokens(s.players[0]!, 3)).toEqual([]);
    const home = move(roll(s, 2), 0);
    expect(home.players[0]!.tokens[0]).toBe(HOME);
    expect(home.turn).toBe(0);
  });

  test("capturing sends every opponent token on the square home and rolls again", () => {
    // red at 10 moves 4 to red-14 = global 14; yellow (color 2, start 26) is there at its position 40 (26+40=66%52=14), twice
    const s = withTokens(game(), [[10, -1, -1, -1], [40, 40, 3, -1]]);
    const after = move(roll(s, 4), 0);
    expect(after.last).toMatchObject({ kind: "move", captured: [{ userId: "u1", token: 0 }, { userId: "u1", token: 1 }] });
    expect(after.players[1]!.tokens).toEqual([-1, -1, 3, -1]);
    expect(after.turn).toBe(0);
  });

  test("safe squares (starts and stars) never capture", () => {
    // red to 8 (a star); yellow sits on global 8 at its position 34
    const star = move(roll(withTokens(game(), [[4, -1, -1, -1], [34, -1, -1, -1]]), 4), 0);
    expect(star.players[1]!.tokens[0]).toBe(34);
    // red to global 26 = yellow's start, where yellow just came out
    const start = move(roll(withTokens(game(), [[22, -1, -1, -1], [0, -1, -1, -1]]), 4), 0);
    expect(start.players[1]!.tokens[0]).toBe(0);
  });

  test("a third 6 in a row loses the turn", () => {
    let s = withTokens(game(), [[0, -1, -1, -1]]);
    s = move(roll(s, 6), 0);
    s = move(roll(s, 6), 0);
    expect(s.sixes).toBe(2);
    s = roll(s, 6);
    expect(s.last).toMatchObject({ kind: "pass", reason: "THREE_SIXES" });
    expect(s).toMatchObject({ turn: 1, sixes: 0 });
  });

  test("the last token home wins and ends the game", () => {
    const s = move(roll(withTokens(game(), [[HOME, HOME, HOME, 53]]), 3), 3);
    expect(s).toMatchObject({ phase: "finished", winner: "u0", deadline: null });
  });

  test("illegal moves are refused", () => {
    const s = roll(withTokens(game(), [[5, -1, -1, -1]]), 2);
    expect(() => move(s, 1)).toThrow();
  });

  test("the server's pick: capture first, then home, then out of base", () => {
    const capture = roll(withTokens(game(), [[10, 30, -1, -1], [40, -1, -1, -1]]), 4); // token 0 captures at global 14
    expect(autoToken(capture)).toBe(0);
    const homeFirst = roll(withTokens(game(), [[20, 50, -1, -1]]), 6); // token 1 reaches home (50+6)
    expect(autoToken(homeFirst)).toBe(1);
    const outFirst = roll(withTokens(game(), [[20, -1, -1, -1]]), 6);
    expect(autoToken(outFirst)).toBe(1);
  });
});
