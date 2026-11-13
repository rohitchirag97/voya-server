import { describe, expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import { drawReels, multiplier, rtp, SYMBOLS, WEIGHTS } from "../src/lib/slots";

describe("slots rules", () => {
  test("paytable", () => {
    expect(multiplier(["seven", "seven", "seven"])).toBe(500);
    expect(multiplier(["cherry", "cherry", "cherry"])).toBe(5);
    expect(multiplier(["cherry", "lemon", "cherry"])).toBe(2);
    expect(multiplier(["cherry", "lemon", "grape"])).toBe(0);
    expect(multiplier(["bell", "bell", "star"])).toBe(0);
  });

  test("the exact return is 96.89%", () => {
    expect(rtp()).toBeCloseTo(0.9689, 4);
  });

  test("reels land with their weights", () => {
    const n = 96_000;
    const seen = Object.fromEntries(SYMBOLS.map((s) => [s, 0])) as Record<string, number>;
    for (let i = 0; i < n / 3; i++) for (const s of drawReels(randomInt)) seen[s]!++;
    for (const s of SYMBOLS) expect(Math.abs(seen[s]! / n - WEIGHTS[s] / 32)).toBeLessThan(0.01);
  });
});
