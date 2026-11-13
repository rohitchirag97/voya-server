import { describe, expect, test } from "bun:test";
import { isKey, mult, OUTSIDE, RED, settle, WHEEL, wins } from "../src/lib/roulette";

const ALL_KEYS = [...OUTSIDE, ...Array.from({ length: 37 }, (_, n) => `n:${n}`)];

describe("roulette rules", () => {
  test("the wheel holds every number once, 18 of them red", () => {
    expect([...WHEEL].sort((a, b) => a - b)).toEqual(Array.from({ length: 37 }, (_, i) => i));
    expect(RED.size).toBe(18);
  });

  test("every bet returns exactly 36/37", () => {
    for (const key of ALL_KEYS) {
      const back = Array.from({ length: 37 }, (_, n) => (wins(key, n) ? mult(key) : 0)).reduce((a, b) => a + b, 0);
      expect([key, back]).toEqual([key, 36]);
    }
  });

  test("keys", () => {
    for (const k of ALL_KEYS) expect(isKey(k)).toBe(true);
    for (const k of ["n:37", "n:-1", "n:07", "n:", "blue", "d4", "c0", "n:1.5"]) expect(isKey(k)).toBe(false);
  });

  test("settle", () => {
    const bets = [{ key: "n:17", amount: 100 }, { key: "black", amount: 50 }, { key: "d2", amount: 10 }, { key: "c3", amount: 10 }];
    expect(settle(bets, 17)).toEqual({ payout: 3600 + 100 + 30, keys: ["n:17", "black", "d2"] }); // 17: black, 2nd dozen, column 2
    expect(settle(bets, 0)).toEqual({ payout: 0, keys: [] });
    expect(settle(bets, 36)).toEqual({ payout: 30, keys: ["c3"] }); // 36 is red, 3rd dozen, column 3
  });
});
