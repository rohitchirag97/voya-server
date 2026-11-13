// Slot machine rules, pure: no database, no clock. The service (services/slots.ts) owns coins and storage.
// Three reels, one payline. Every reel has the same weighted strip; each spin draws each reel on its own.
//   - three of a kind pays PAYS[symbol] × bet
//   - otherwise exactly two cherries anywhere pays 2× bet
// Exact return: rtp() = 96.89% of what is bet, about 1 spin in 4 pays something. Never pick reels from what people bet.

export const SYMBOLS = ["cherry", "lemon", "orange", "grape", "bell", "star", "seven"] as const;
export type Symbol = (typeof SYMBOLS)[number];
export const WEIGHTS: Record<Symbol, number> = { cherry: 10, lemon: 8, orange: 6, grape: 4, bell: 2, star: 1, seven: 1 }; // out of 32
export const PAYS: Record<Symbol, number> = { cherry: 5, lemon: 10, orange: 20, grape: 40, bell: 100, star: 250, seven: 500 };
export const TWO_CHERRIES = 2;
export const MAX_MULT = PAYS.seven;
const TOTAL = SYMBOLS.reduce((s, x) => s + WEIGHTS[x], 0);

// `rand(n)` returns an integer in [0, n); the service passes crypto.randomInt.
export function drawReel(rand: (n: number) => number): Symbol {
  let r = rand(TOTAL);
  for (const s of SYMBOLS) if ((r -= WEIGHTS[s]) < 0) return s;
  throw new Error("unreachable");
}
export const drawReels = (rand: (n: number) => number) => [drawReel(rand), drawReel(rand), drawReel(rand)] as [Symbol, Symbol, Symbol];

export function multiplier([a, b, c]: readonly Symbol[]) {
  if (a === b && b === c) return PAYS[a!];
  return [a, b, c].filter((s) => s === "cherry").length === 2 ? TWO_CHERRIES : 0;
}

// The exact return over every possible spin (for the tests and the help page).
export function rtp() {
  let sum = 0;
  for (const a of SYMBOLS) for (const b of SYMBOLS) for (const c of SYMBOLS) sum += WEIGHTS[a] * WEIGHTS[b] * WEIGHTS[c] * multiplier([a, b, c]);
  return sum / TOTAL ** 3;
}
