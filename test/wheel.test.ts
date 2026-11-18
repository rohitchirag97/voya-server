import { describe, expect, test } from "bun:test";
import { cancel, endsAt, finish, GAP_MS, idleState, join, leave, MAX_PLAYERS, open, payoutOf, RuleError, spinEnds, SPIN_MS, start, winnerOf } from "../src/lib/wheel";

// Pure rules: no server, no database.
const T0 = 1_000_000;
const p = (id: string) => ({ userId: id, displayName: id, avatarUrl: null });
const lobby = () => open(idleState(), "r1", 1000, T0);

describe("wheel", () => {
  test("open only with a listed fee, one round at a time", () => {
    expect(() => open(idleState(), "r", 123, T0)).toThrow(RuleError);
    expect(() => open(lobby(), "r2", 1000, T0)).toThrow(RuleError);
  });

  test("joining adds the fee to the pot; leaving takes it back out", () => {
    let s = join(join(lobby(), p("a")), p("b"));
    expect(s.round!.pot).toBe(2000);
    expect(() => join(s, p("a"))).toThrow(RuleError);
    s = leave(s, "a");
    expect(s.round!.pot).toBe(1000);
    expect(() => leave(s, "a")).toThrow(RuleError);
  });

  test("2 to 10 players", () => {
    expect(() => start(join(lobby(), p("a")), T0, () => 0)).toThrow(RuleError);
    let s = lobby();
    for (let i = 0; i < MAX_PLAYERS; i++) s = join(s, p(`u${i}`));
    expect(() => join(s, p("late"))).toThrow(RuleError);
  });

  test("the spin draws everyone's order; the winner gets the pot minus 10%", () => {
    let s = lobby();
    for (const id of ["a", "b", "c", "d"]) s = join(s, p(id));
    s = start(s, T0, (n) => n - 1); // no swaps: order is the joining order, so "d" wins
    expect(s.phase).toBe("spinning");
    expect(s.round!.order).toEqual(["a", "b", "c", "d"]);
    expect(winnerOf(s.round!)).toBe("d");
    expect(s.round!.payout).toBe(3600);
    expect(spinEnds(s.round!, 0)).toBe(T0 + SPIN_MS);
    expect(endsAt(s.round!)).toBe(T0 + 3 * SPIN_MS + 2 * GAP_MS);
    expect(finish(s).round!.paid).toBe(true);
    expect(() => cancel(s)).toThrow(RuleError); // spun: too late to cancel
  });

  test("random order covers everyone exactly once, and the cut rounds down", () => {
    let s = lobby();
    for (const id of ["a", "b", "c", "d", "e"]) s = join(s, p(id));
    const order = start(s, T0, (n) => Math.floor(Math.random() * n)).round!.order;
    expect([...order].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(payoutOf(205)).toBe(185);
  });
});
