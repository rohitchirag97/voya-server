// European roulette rules, pure: no database, no clock. The service (services/roulette.ts) owns coins and storage.
// One zero, numbers 0-36. A bet is a key on the table; it returns `MULT[key] × amount` (stake included) when it wins.
//   "n:<0-36>"                straight up        36× (35 to 1)
//   "red" "black" "odd" "even" "low" (1-18) "high" (19-36)    2× (1 to 1)
//   "d1" "d2" "d3"  dozens 1-12 / 13-24 / 25-36             3× (2 to 1)
//   "c1" "c2" "c3"  columns (c1 = 1, 4, 7 … 34)              3× (2 to 1)
// Zero loses every outside bet. Every bet returns exactly 36/37 = 97.30% on average.

export const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26]; // pocket order, clockwise from zero
export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export const OUTSIDE = ["red", "black", "odd", "even", "low", "high", "d1", "d2", "d3", "c1", "c2", "c3"] as const;

export function isKey(key: string) {
  if ((OUTSIDE as readonly string[]).includes(key)) return true;
  const m = /^n:(\d{1,2})$/.exec(key);
  return !!m && Number(m[1]) <= 36 && String(Number(m[1])) === m[1];
}

export const mult = (key: string) => (key.startsWith("n:") ? 36 : key[0] === "d" || key[0] === "c" ? 3 : 2);

export function wins(key: string, n: number) {
  if (key.startsWith("n:")) return Number(key.slice(2)) === n;
  if (n === 0) return false;
  switch (key) {
    case "red": return RED.has(n);
    case "black": return !RED.has(n);
    case "odd": return n % 2 === 1;
    case "even": return n % 2 === 0;
    case "low": return n <= 18;
    case "high": return n >= 19;
    case "d1": case "d2": case "d3": return Math.ceil(n / 12) === Number(key[1]);
    case "c1": case "c2": case "c3": return ((n - 1) % 3) + 1 === Number(key[1]);
  }
  return false;
}

// What a set of bets returns when the ball lands on n, and which keys won.
export function settle(bets: { key: string; amount: number }[], n: number) {
  const won = bets.filter((b) => wins(b.key, n));
  return { payout: won.reduce((s, b) => s + b.amount * mult(b.key), 0), keys: [...new Set(won.map((b) => b.key))] };
}
