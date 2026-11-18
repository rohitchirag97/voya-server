// Carrom rules, pure: no database, no sockets, no clock. The service (services/carrom.ts) owns time and storage; the
// physics (public/games/carrom/physics.js) is shared with the board page, which replays every shot.
//
// Freestyle (points) carrom for 2-4 players, each on their own side (2: facing each other; 3-4: round the board):
//   - white 20, black 10, the queen 50 once "covered": pocket another coin in the same shot or your next one, else
//     she goes back to the centre (no cover needed if she's the last coin on the board)
//   - pocketing a coin (and no foul) earns another shot
//   - foul: pocketing the striker. Minus 10 (not below zero); the coins that dropped in that shot go back to the centre
//   - the striker sits on your baseline and must go forwards (into the board)
//   - the board is cleared: the highest score wins (a tie at the top is a draw)
import { baseline, QUEEN, R, rack, RS, S, simulate, WHITE } from "../../public/games/carrom/physics.js";

export type Coin = { n: number; x: number; y: number };
export type Person = { userId: string; displayName: string | null; avatarUrl: string | null };
export type Shot = { t: number; dx: number; dy: number; power: number }; // t: striker position along the baseline, 0..1
export type LastAction =
  | { kind: "shot"; userId: string; side: number; shot: Shot; from: Coin[]; to: Coin[]; potted: number[]; strikerPotted: boolean; points: number; queen: "covered" | "pending" | "returned" | null; ms: number }
  | { kind: "timeout"; userId: string };
export type CarromState = {
  v: number;
  phase: "lobby" | "playing" | "finished";
  lobby: Person[];
  players: (Person & { side: number; score: number })[]; // turn order; side 0 = bottom, then round the board
  turn: number;
  coins: Coin[];
  queenPending: string | null; // pocketed the queen, still has to cover her
  readyAt: string | null; // when the last shot stops moving on the phones (ISO)
  deadline: string | null; // when the player on turn runs out of time (ISO)
  last: LastAction | null;
  winner: string | null;
  reason: "CLEARED" | "LEFT" | "TIE" | null;
};

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const POINTS = { white: 20, black: 10, queen: 50, foul: 10 };
const SIDES: Record<number, number[]> = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };

export class RuleError extends Error {}

export const lobbyState = (v = 0): CarromState => ({ v: v + 1, phase: "lobby", lobby: [], players: [], turn: 0, coins: [], queenPending: null, readyAt: null, deadline: null, last: null, winner: null, reason: null });

export function startGame(s: CarromState, people: Person[]): CarromState {
  const sides = SIDES[people.length]!;
  return { ...lobbyState(s.v), phase: "playing", players: people.map((p, i) => ({ ...p, side: sides[i]!, score: 0 })), coins: rack() };
}

const free = (coins: Coin[], x: number, y: number, r: number) => coins.every((c) => (c.x - x) ** 2 + (c.y - y) ** 2 >= (R + r) ** 2);

// The nearest free spot to the centre, for coins going back on the board.
function centreSpot(coins: Coin[]) {
  const c = S / 2;
  for (let ring = 0; ring < 60; ring++) {
    const rad = ring * R * 0.9;
    const steps = Math.max(1, ring * 6);
    for (let k = 0; k < steps; k++) {
      // a walk round the ring without trig: points on a square path, good enough to find a gap
      const f = k / steps;
      const side = Math.floor(f * 4), u = f * 4 - side;
      const [x, y] = side === 0 ? [c - rad + 2 * rad * u, c - rad] : side === 1 ? [c + rad, c - rad + 2 * rad * u] : side === 2 ? [c + rad - 2 * rad * u, c + rad] : [c - rad, c + rad - 2 * rad * u];
      if (free(coins, x, y, R)) return { x, y };
    }
  }
  return { x: c, y: c };
}
const returnToCentre = (coins: Coin[], ns: number[]) => ns.reduce((acc, n) => [...acc, { n, ...centreSpot(acc) }], coins);

// Where the striker goes: on the player's baseline, inside the board, not on a coin.
export function strikerAt(s: CarromState, side: number, t: number) {
  const p = baseline(side, Math.min(1, Math.max(0, t)));
  return { ...p, ok: free(s.coins, p.x, p.y, RS) && p.x > RS && p.x < S - RS && p.y > RS && p.y < S - RS };
}

const valueOf = (n: number) => (n === QUEEN ? 0 : WHITE(n) ? POINTS.white : POINTS.black);

export function takeShot(s: CarromState, userId: string, raw: Shot): CarromState {
  if (s.phase !== "playing") throw new RuleError("No game is running");
  const me = s.players[s.turn]!;
  if (me.userId !== userId) throw new RuleError("It's not your turn");
  const len = Math.sqrt(raw.dx * raw.dx + raw.dy * raw.dy);
  if (!(len > 1e-6)) throw new RuleError("Aim first");
  const shot = { t: Math.min(1, Math.max(0, raw.t)), dx: raw.dx / len, dy: raw.dy / len, power: Math.min(1, Math.max(0, raw.power)) };
  const st = strikerAt(s, me.side, shot.t);
  if (!st.ok) throw new RuleError("The striker can't go on a coin");
  if (shot.dx * st.inX + shot.dy * st.inY < 0.05) throw new RuleError("Shoot forwards, into the board");

  const r = simulate(s.coins, { x: st.x, y: st.y }, shot);
  const foul = r.strikerPotted;
  const queenNow = r.potted.includes(QUEEN);
  const others = r.potted.filter((n) => n !== QUEEN);
  let coins = r.to;
  let points = 0;
  let queen: "covered" | "pending" | "returned" | null = null;
  let queenPending = s.queenPending;

  if (foul) {
    // everything pocketed this shot goes back; a queen waiting for cover goes back too
    const back = [...r.potted];
    if (queenPending === me.userId) back.push(QUEEN);
    coins = returnToCentre(coins, back.filter((n, i) => back.indexOf(n) === i));
    if (queenPending === me.userId) { queenPending = null; queen = "returned"; }
    points = -Math.min(POINTS.foul, me.score);
  } else {
    points = others.reduce((t, n) => t + valueOf(n), 0);
    const onlyQueenLeft = coins.length === 0;
    if (queenPending === me.userId) {
      // last shot's queen: covered now, or back to the centre
      if (others.length) { points += POINTS.queen; queen = "covered"; }
      else { coins = returnToCentre(coins, [QUEEN]); queen = "returned"; }
      queenPending = null;
    }
    if (queenNow) {
      if (others.length || onlyQueenLeft) { points += POINTS.queen; queen = "covered"; }
      else { queenPending = me.userId; queen = "pending"; }
    }
  }

  const players = s.players.map((p, i) => (i === s.turn ? { ...p, score: p.score + points } : p));
  const again = !foul && r.potted.length > 0;
  const last: LastAction = { kind: "shot", userId, side: me.side, shot, from: s.coins, to: coins, potted: r.potted, strikerPotted: foul, points, queen, ms: r.ms };
  const n: CarromState = { ...s, v: s.v + 1, players, coins, queenPending, last, turn: again ? s.turn : (s.turn + 1) % players.length };
  return coins.length === 0 && !queenPending ? finish(n) : n;
}

function finish(s: CarromState): CarromState {
  const top = Math.max(...s.players.map((p) => p.score));
  const leaders = s.players.filter((p) => p.score === top);
  return { ...s, phase: "finished", deadline: null, winner: leaders.length === 1 ? leaders[0]!.userId : null, reason: leaders.length === 1 ? "CLEARED" : "TIE" };
}

// The player on turn ran out of time: the turn passes (a queen they owed cover for goes back).
export function timeout(s: CarromState): CarromState {
  const me = s.players[s.turn]!;
  const owes = s.queenPending === me.userId;
  return { ...s, v: s.v + 1, coins: owes ? returnToCentre(s.coins, [QUEEN]) : s.coins, queenPending: owes ? null : s.queenPending, turn: (s.turn + 1) % s.players.length, last: { kind: "timeout", userId: me.userId } };
}

// A player leaves (or loses their seat): out of the game; one player left wins.
export function removePlayer(s: CarromState, userId: string): CarromState {
  const i = s.players.findIndex((p) => p.userId === userId);
  if (s.phase !== "playing" || i < 0) return s;
  const players = s.players.filter((p) => p.userId !== userId);
  const owes = s.queenPending === userId;
  const base = { ...s, v: s.v + 1, players, coins: owes ? returnToCentre(s.coins, [QUEEN]) : s.coins, queenPending: owes ? null : s.queenPending };
  if (players.length === 1) return { ...base, phase: "finished", deadline: null, winner: players[0]!.userId, reason: "LEFT" };
  const turn = i < s.turn ? s.turn - 1 : i === s.turn ? s.turn % players.length : s.turn;
  return { ...base, turn };
}

