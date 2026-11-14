import { describe, expect, test } from "bun:test";
import { canPlace, forfeit, lobbyState, startGame, takeShot, timeout, type Ball, type PoolState } from "../src/lib/pool";
import { HEAD, L, R, W, simulate } from "../public/games/pool/physics.js";

// Pure physics and rules: no server, no database.
const people = [{ userId: "a", displayName: "A", avatarUrl: null }, { userId: "b", displayName: "B", avatarUrl: null }];
const game = () => startGame(lobbyState(), people);
const at = (s: PoolState, balls: Ball[], extra: Partial<PoolState> = {}): PoolState => ({ ...s, balls, inHand: null, breakShot: false, ...extra });
const aim = (from: { x: number; y: number }, to: { x: number; y: number }, power = 0.4, sx = 0, sy = 0) => {
  const d = Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2);
  return { dx: (to.x - from.x) / d, dy: (to.y - from.y) / d, power, sx, sy };
};
const cue = (x: number, y: number) => ({ n: 0, x, y });

describe("pool physics", () => {
  test("a straight shot sends the object ball into the corner pocket; a stun shot stops the cue ball dead", () => {
    const balls = [cue(0.8, 0.8), { n: 1, x: 0.4, y: 0.4 }];
    const r = simulate(balls, aim(balls[0]!, balls[1]!, 0.9)); // hard: still sliding at contact
    expect(r.potted).toEqual([1]);
    expect(r.firstHit).toBe(1);
    const c = r.to.find((b) => b.n === 0)!;
    expect(Math.sqrt((c.x - 0.4) ** 2 + (c.y - 0.4) ** 2)).toBeLessThan(0.2); // close to the contact point: little roll left
  });

  test("draw pulls the cue ball back, follow carries it on", () => {
    const balls = [cue(0.8, 0.8), { n: 1, x: 0.4, y: 0.4 }]; // the 1 drops in the corner either way
    const draw = simulate(balls, aim(balls[0]!, balls[1]!, 0.3, 0, -1));
    const follow = simulate(balls, aim(balls[0]!, balls[1]!, 0.25, 0, 1));
    expect(draw.to.find((b) => b.n === 0)!.x).toBeGreaterThan(0.6);
    expect(follow.potted.includes(0) || follow.to.find((b) => b.n === 0)!.x < 0.3).toBe(true);
  });

  test("balls stay on the cloth and the same shot gives the same result", () => {
    const s = game();
    const shot = aim(HEAD, { x: 1.68, y: W / 2 + 0.01 }, 1);
    const a = simulate(s.balls, shot);
    expect(a).toEqual(simulate(s.balls, shot));
    for (const b of a.to) {
      expect(b.x).toBeGreaterThanOrEqual(R - 0.01);
      expect(b.x).toBeLessThanOrEqual(L - R + 0.01);
      expect(b.y).toBeGreaterThanOrEqual(R - 0.01);
      expect(b.y).toBeLessThanOrEqual(W - R + 0.01);
    }
    expect(a.potted.length + a.to.length).toBe(16);
    expect(a.ms).toBeLessThan(40_000);
  });
});

describe("8 ball rules", () => {
  test("start: racked, first player breaks from the kitchen", () => {
    const s = game();
    expect(s.balls.length).toBe(16);
    expect(s.inHand).toBe("kitchen");
    expect(s.breakShot).toBe(true);
    expect(canPlace(s, 0.3, 0.5)).toBe(true);
    expect(canPlace(s, 1.0, 0.5)).toBe(false); // past the head string
  });

  test("first legal pot on an open table decides groups, and the shooter goes again", () => {
    const s = at(game(), [cue(0.8, 0.8), { n: 3, x: 0.4, y: 0.4 }, { n: 12, x: 1.8, y: 0.3 }, { n: 8, x: 1.8, y: 0.8 }]);
    const n = takeShot(s, aim(s.balls[0]!, s.balls[1]!, 0.35));
    expect(n.players.map((p) => p.group)).toEqual(["solid", "stripe"]);
    expect(n.turn).toBe(0);
    expect(n.last?.kind === "shot" && n.last.foul).toBe(null);
  });

  test("hitting the wrong group first is a foul: ball in hand for the other player", () => {
    let s = at(game(), [cue(0.8, 0.8), { n: 12, x: 0.4, y: 0.4 }, { n: 3, x: 1.8, y: 0.3 }, { n: 8, x: 1.8, y: 0.8 }]);
    s = { ...s, players: [{ ...s.players[0]!, group: "solid" }, { ...s.players[1]!, group: "stripe" }] };
    const n = takeShot(s, aim(s.balls[0]!, s.balls[1]!, 0.35));
    expect(n.last?.kind === "shot" && n.last.foul).toBe("WRONG_BALL");
    expect(n.turn).toBe(1);
    expect(n.inHand).toBe("table");
  });

  test("the 8: early loses, after clearing your group wins", () => {
    const base = at(game(), [cue(0.8, 0.8), { n: 8, x: 0.4, y: 0.4 }, { n: 3, x: 1.8, y: 0.3 }]);
    const early = takeShot(base, aim(base.balls[0]!, base.balls[1]!, 0.35));
    expect([early.phase, early.winner, early.reason]).toEqual(["finished", "b", "EIGHT_EARLY"]);
    const cleared = { ...base, balls: base.balls.slice(0, 2), players: [{ ...base.players[0]!, group: "solid" as const }, { ...base.players[1]!, group: "stripe" as const }] };
    const won = takeShot(cleared, aim(cleared.balls[0]!, cleared.balls[1]!, 0.35));
    expect([won.phase, won.winner, won.reason]).toEqual(["finished", "a", "EIGHT"]);
  });

  test("a scratch puts the cue ball back for the opponent; timeouts and forfeits", () => {
    const s = at(game(), [cue(0.3, 0.3), { n: 1, x: 1.8, y: 0.8 }]);
    const n = takeShot(s, aim(s.balls[0]!, { x: 0, y: 0 }, 0.3)); // straight into the corner
    expect(n.last?.kind === "shot" && n.last.foul).toBe("SCRATCH");
    expect(n.balls.some((b) => b.n === 0)).toBe(true);
    expect([n.turn, n.inHand]).toEqual([1, "table"]);
    expect(timeout(n)).toMatchObject({ turn: 0, inHand: "table", last: { kind: "timeout", userId: "b" } });
    expect(forfeit(n, "a")).toMatchObject({ phase: "finished", winner: "b", reason: "LEFT" });
  });
});
