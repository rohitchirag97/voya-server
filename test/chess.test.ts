import { describe, expect, test } from "bun:test";
import { CLOCK_MS, lobbyState, move, offerDraw, resign, RuleError, startGame, timeout, type ChessState } from "../src/lib/chess";

// Pure rules: no server, no database.
const T0 = 1_000_000;
const people = [{ userId: "w", displayName: "W", avatarUrl: null }, { userId: "b", displayName: "B", avatarUrl: null }];
const game = () => startGame(lobbyState(), people, T0, () => 0); // rnd 0: the first to join plays white
const play = (s: ChessState, ...ms: [string, string, string, string?][]) => ms.reduce((g, [who, from, to, promotion], i) => move(g, who, { from, to, promotion }, T0 + (i + 1) * 1000), s);

describe("chess", () => {
  test("start: white moves first, both clocks full", () => {
    const s = game();
    expect(s.players.map((p) => [p.userId, p.color])).toEqual([["w", "w"], ["b", "b"]]);
    expect(s.clock).toEqual({ w: CLOCK_MS, b: CLOCK_MS });
    expect(() => move(s, "b", { from: "e7", to: "e5" }, T0)).toThrow(RuleError); // not black's turn
    expect(() => move(s, "w", { from: "e2", to: "e5" }, T0)).toThrow(RuleError); // illegal
  });

  test("moves are recorded and the mover's clock is charged", () => {
    const s = move(game(), "w", { from: "e2", to: "e4" }, T0 + 3000);
    expect(s.moves).toEqual(["e4"]);
    expect(s.clock.w).toBe(CLOCK_MS - 3000);
    expect(s.last).toEqual({ from: "e2", to: "e4", san: "e4" });
  });

  test("fool's mate ends the game", () => {
    const s = play(game(), ["w", "f2", "f3"], ["b", "e7", "e5"], ["w", "g2", "g4"], ["b", "d8", "h4"]);
    expect(s.phase).toBe("finished");
    expect(s.reason).toBe("CHECKMATE");
    expect(s.winner).toBe("b");
    expect(s.moves.at(-1)).toBe("Qh4#");
  });

  test("promotion defaults to a queen and can underpromote", () => {
    const s: ChessState = { ...game(), moves: [] };
    // a quick path to a promotion: the a-pawn marches while black shuffles a knight
    const g = play(s, ["w", "a2", "a4"], ["b", "g8", "f6"], ["w", "a4", "a5"], ["b", "f6", "g8"], ["w", "a5", "a6"], ["b", "g8", "f6"], ["w", "a6", "b7"], ["b", "f6", "g8"]);
    expect(play(g, ["w", "b7", "a8"]).moves.at(-1)).toBe("bxa8=Q");
    expect(play(g, ["w", "b7", "a8", "n"]).moves.at(-1)).toBe("bxa8=N");
  });

  test("threefold repetition is a draw", () => {
    const shuffle: [string, string, string][] = [["w", "g1", "f3"], ["b", "g8", "f6"], ["w", "f3", "g1"], ["b", "f6", "g8"]];
    const s = play(game(), ...shuffle, ...shuffle);
    expect(s.phase).toBe("finished");
    expect(s.reason).toBe("REPETITION");
    expect(s.winner).toBeNull();
  });

  test("resigning, draw offers and the clock", () => {
    expect(resign(game(), "w").winner).toBe("b");
    const offered = offerDraw(game(), "w");
    expect(offered.drawOffer).toBe("w");
    expect(offerDraw(offered, "b").reason).toBe("AGREED");
    expect(move(offered, "w", { from: "e2", to: "e4" }, T0).drawOffer).toBeNull();
    expect(timeout(game(), T0 + CLOCK_MS - 1).phase).toBe("playing");
    const late = timeout(game(), T0 + CLOCK_MS);
    expect(late.winner).toBe("b");
    expect(late.reason).toBe("TIMEOUT");
  });
});
