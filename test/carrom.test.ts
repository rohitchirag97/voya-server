import { describe, expect, test } from "bun:test";
import { lobbyState, POINTS, removePlayer, RuleError, startGame, strikerAt, takeShot, timeout, type CarromState, type Coin } from "../src/lib/carrom";
import { baseline, POCKETS, QUEEN, R, rack, S, simulate } from "../public/games/carrom/physics.js";

// Pure physics and rules: no server, no database.
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `p${i}`, displayName: `P${i}`, avatarUrl: null }));
const game = (n = 2) => startGame(lobbyState(), people(n));
const at = (s: CarromState, coins: Coin[], extra: Partial<CarromState> = {}): CarromState => ({ ...s, coins, ...extra });
// Aim the striker at side 0's baseline position t straight at (x, y).
const aimAt = (t: number, x: number, y: number, power: number) => {
  const p = baseline(0, t);
  return { t, dx: x - p.x, dy: y - p.y, power };
};
const pocketTL = POCKETS[0]!; // top-left, as side 0 sees it

describe("carrom physics", () => {
  test("the rack: 9 white, 9 black and the queen in the middle, none overlapping", () => {
    const c = rack();
    expect(c.length).toBe(19);
    expect(c.find((x) => x.n === QUEEN)).toEqual({ n: QUEEN, x: S / 2, y: S / 2 });
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) expect((c[i]!.x - c[j]!.x) ** 2 + (c[i]!.y - c[j]!.y) ** 2).toBeGreaterThanOrEqual((2 * R) ** 2 - 1e-12);
  });

  test("a straight shot cuts a coin into the corner pocket; discs stay on the board; same shot, same result", () => {
    // a coin on the line from the striker to the top-left pocket
    const st = baseline(0, 0.3);
    const f = 0.55, coin = { n: 3, x: st.x + (pocketTL.x - st.x) * f, y: st.y + (pocketTL.y - st.y) * f };
    const shot = { dx: pocketTL.x - st.x, dy: pocketTL.y - st.y, power: 0.6 };
    const len = Math.sqrt(shot.dx ** 2 + shot.dy ** 2);
    const r = simulate([coin], st, { ...shot, dx: shot.dx / len, dy: shot.dy / len });
    expect(r.potted).toEqual([3]);
    expect(r).toEqual(simulate([coin], st, { ...shot, dx: shot.dx / len, dy: shot.dy / len }));
    const brk = simulate(rack(), st, { dx: 0, dy: -1, power: 1 });
    for (const d of brk.to) expect(d.x >= 0 && d.x <= S && d.y >= 0 && d.y <= S).toBe(true);
    expect(brk.to.length + brk.potted.length).toBe(19);
  });
});

describe("carrom rules", () => {
  test("2 players face each other, 3-4 sit round the board", () => {
    expect(game(2).players.map((p) => p.side)).toEqual([0, 2]);
    expect(game(4).players.map((p) => p.side)).toEqual([0, 1, 2, 3]);
  });

  test("the striker must go forwards and can't sit on a coin", () => {
    const s = game();
    expect(() => takeShot(s, "p1", { t: 0.5, dx: 0, dy: -1, power: 0.5 })).toThrow(RuleError); // not their turn
    expect(() => takeShot(s, "p0", { t: 0.5, dx: 0, dy: 1, power: 0.5 })).toThrow(RuleError); // backwards
    const blocked = at(s, [{ n: 1, ...baseline(0, 0.5) }]);
    expect(strikerAt(blocked, 0, 0.5).ok).toBe(false);
  });

  test("a hard straight shot follows the coin in: a foul, the coin comes back", () => {
    const st = baseline(0, 0.3);
    const f = 0.55, coin = { n: 3, x: st.x + (pocketTL.x - st.x) * f, y: st.y + (pocketTL.y - st.y) * f };
    const n = takeShot(at(game(), [coin, { n: 12, x: 0.6, y: 0.2 }], { players: game().players.map((p) => ({ ...p, score: 30 })) }), "p0", aimAt(0.3, pocketTL.x, pocketTL.y, 0.6));
    expect(n.last?.kind === "shot" && n.last.strikerPotted).toBe(true);
    expect(n.players[0]!.score).toBe(30 - POINTS.foul);
    expect(n.coins.some((c) => c.n === 3)).toBe(true);
    expect(n.turn).toBe(1);
  });

  test("pocketing scores and keeps the turn; missing passes it", () => {
    const st = baseline(0, 0.3);
    const f = 0.55, coin = { n: 3, x: st.x + (pocketTL.x - st.x) * f, y: st.y + (pocketTL.y - st.y) * f };
    const s = at(game(), [coin, { n: 12, x: 0.6, y: 0.3 }]);
    const n = takeShot(s, "p0", aimAt(0.3, pocketTL.x, pocketTL.y, 0.3));
    expect(n.players[0]!.score).toBe(POINTS.white);
    expect(n.turn).toBe(0);
    const miss = takeShot(at(game(), [{ n: 12, x: 0.6, y: 0.2 }]), "p0", { t: 0.9, dx: 0, dy: -1, power: 0.05 });
    expect(miss.turn).toBe(1);
  });

  test("the queen needs cover: alone she waits, uncovered she goes back", () => {
    const st = baseline(0, 0.3);
    const f = 0.55, queen = { n: QUEEN, x: st.x + (pocketTL.x - st.x) * f, y: st.y + (pocketTL.y - st.y) * f };
    const s = at(game(), [queen, { n: 12, x: 0.6, y: 0.2 }]);
    const n = takeShot(s, "p0", aimAt(0.3, pocketTL.x, pocketTL.y, 0.3));
    expect(n.queenPending).toBe("p0");
    expect(n.players[0]!.score).toBe(0);
    const back = takeShot(n, "p0", { t: 0.9, dx: 0, dy: -1, power: 0.05 }); // no cover
    expect(back.queenPending).toBeNull();
    expect(back.coins.some((c) => c.n === QUEEN)).toBe(true);
  });

  test("clearing the board ends the game; a tie at the top is a draw", () => {
    const st = baseline(0, 0.3);
    const f = 0.55, coin = { n: 3, x: st.x + (pocketTL.x - st.x) * f, y: st.y + (pocketTL.y - st.y) * f };
    const end = takeShot(at(game(), [coin]), "p0", aimAt(0.3, pocketTL.x, pocketTL.y, 0.3));
    expect(end.phase).toBe("finished");
    expect(end.winner).toBe("p0");
    const tie = takeShot(at(game(), [coin], { players: game().players.map((p, i) => ({ ...p, score: i === 1 ? 20 : 0 })) }), "p0", aimAt(0.3, pocketTL.x, pocketTL.y, 0.3));
    expect(tie.reason).toBe("TIE");
  });

  test("timeouts pass the turn; a player leaving drops out, the last one wins", () => {
    expect(timeout(game(3)).turn).toBe(1);
    const s = game(3);
    const n = removePlayer(s, "p0");
    expect(n.players.map((p) => p.userId)).toEqual(["p1", "p2"]);
    expect(n.turn).toBe(0); // p1 is up
    expect(removePlayer(n, "p1").winner).toBe("p2");
  });
});
