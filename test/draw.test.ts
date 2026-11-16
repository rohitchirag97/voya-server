import { describe, expect, test } from "bun:test";
import { DRAWER_POINTS, drawerOf, endTurn, guess, lobbyState, MAX_POINTS, PAUSE_MS, publicView, removePlayer, ROUNDS, startGame, TURN_MS, WORDS } from "../src/lib/draw";

// Pure rules: no server, no database.
const people = ["a", "b", "c"].map((userId) => ({ userId, displayName: userId.toUpperCase(), avatarUrl: null }));
const T0 = 1_000_000;
const game = () => startGame(lobbyState(), people, T0, () => 0); // rnd 0: always the first unused word

describe("draw & guess", () => {
  test("start: first player draws a word nobody else can see", () => {
    const s = game();
    expect(drawerOf(s)!.userId).toBe("a");
    expect(s.word).toBe(WORDS[0]!);
    expect(s.turns).toBe(people.length * ROUNDS);
    const v = publicView(s)!;
    expect(v.word).toBeUndefined();
    expect(v.used).toBeUndefined();
    expect(v.hint).toBe(WORDS[0]!.replace(/./g, "_").split("").join(" "));
    expect(JSON.stringify(v)).not.toContain(`"${WORDS[0]}"`);
  });

  test("a right guess scores by speed, pays the drawer, ignores case and spaces", () => {
    const s = game();
    const r = guess(s, "b", `  ${s.word!.toUpperCase()} `, T0);
    expect(r.result).toBe("hit");
    expect(r.state.players.find((p) => p.userId === "b")!.score).toBe(MAX_POINTS);
    expect(r.state.players.find((p) => p.userId === "a")!.score).toBe(DRAWER_POINTS);
    expect(guess(s, "b", "not it", T0).result).toBe("none");
  });

  test("the drawer and those who already guessed can't spoil it; listeners guess but don't score", () => {
    const s = game();
    expect(guess(s, "a", `it's ${s.word}`, T0).result).toBe("spoiler");
    const after = guess(s, "b", s.word!, T0).state;
    expect(guess(after, "b", s.word!, T0).result).toBe("spoiler");
    const l = guess(after, "listener", s.word!, T0);
    expect(l.result).toBe("hit");
    expect(l.state).toBe(after);
  });

  test("everyone guessing ends the turn: the word is shown, the next drawer starts after the pause", () => {
    let s = game();
    const word = s.word!;
    s = guess(s, "b", word, T0).state;
    s = guess(s, "c", word, T0 + TURN_MS / 2).state;
    expect(s.last).toEqual({ word, drawerId: "a" });
    expect(drawerOf(s)!.userId).toBe("b");
    expect(s.word).not.toBe(word);
    expect(Date.parse(s.startsAt!)).toBe(T0 + TURN_MS / 2 + PAUSE_MS);
    expect(guess(s, "c", s.word!, T0 + TURN_MS / 2).result).toBe("none"); // still in the pause
  });

  test("the game ends after every player drew ROUNDS times", () => {
    let s = game();
    for (let i = 0; i < people.length * ROUNDS; i++) s = endTurn(s, T0);
    expect(s.phase).toBe("finished");
    expect(s.word).toBeNull();
  });

  test("leaving: the drawer leaving passes to the next person; under 2 players ends the game", () => {
    const s = game();
    const n = removePlayer(s, "a", T0);
    expect(n.players.map((p) => p.userId)).toEqual(["b", "c"]);
    expect(drawerOf(n)!.userId).toBe("b");
    const mid = endTurn(s, T0); // b draws
    expect(drawerOf(removePlayer(mid, "a", T0))!.userId).toBe("b"); // someone before the drawer leaves: still b
    expect(removePlayer(removePlayer(s, "b", T0), "c", T0).phase).toBe("finished");
  });
});
