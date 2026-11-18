// Elimination wheel for a room, pure: no database, no sockets, no clock (callers pass `now`). The service
// (services/wheel.ts) moves the coins; this decides who is in, the order everyone is knocked out, and the payout.
//
// A round: the owner/admins open it with an entry fee; 2-10 people join, each paying the fee into the pot (held by
// the game, refunded if they leave before the spin or the round is cancelled). Spin: the whole elimination order is
// drawn at once, then played back one spin at a time (SPIN_MS each, GAP_MS between) so every phone shows the same
// thing; the last one standing wins the pot minus HOUSE_CUT, paid when the last spin ends.

export type Person = { userId: string; displayName: string | null; avatarUrl: string | null };
export type Round = {
  id: string;
  fee: number;
  players: Person[]; // in joining order
  openedAt: string;
  startedAt: string | null; // the first spin starts here (ISO)
  order: string[]; // userIds, knocked out first to last; the last one is the winner
  pot: number;
  payout: number; // pot minus the house cut
  paid: boolean; // the winner has the payout
};
export type WheelState = { v: number; phase: "idle" | "lobby" | "spinning" | "finished" | "cancelled"; round: Round | null };

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;
export const FEES = [100, 1000, 10000, 100000] as const;
export const HOUSE_CUT = 0.1; // keeps the wheel from being a free way to move coins between people
export const SPIN_MS = 4500;
export const GAP_MS = 1800;
export const LOBBY_MS = 15 * 60_000; // a round nobody spins is cancelled (and refunded) after this

const iso = (ms: number) => new Date(ms).toISOString();
export class RuleError extends Error {}

export const idleState = (v = 0): WheelState => ({ v: v + 1, phase: "idle", round: null });

export function open(s: WheelState, id: string, fee: number, now: number): WheelState {
  if (s.phase === "lobby" || s.phase === "spinning") throw new RuleError("A round is already on");
  if (!(FEES as readonly number[]).includes(fee)) throw new RuleError("Pick one of the entry fees");
  return { v: s.v + 1, phase: "lobby", round: { id, fee, players: [], openedAt: iso(now), startedAt: null, order: [], pot: 0, payout: 0, paid: false } };
}

export function join(s: WheelState, p: Person): WheelState {
  const r = s.round;
  if (s.phase !== "lobby" || !r) throw new RuleError("No round is open to join");
  if (r.players.some((x) => x.userId === p.userId)) throw new RuleError("You're already in");
  if (r.players.length >= MAX_PLAYERS) throw new RuleError(`The wheel is full (${MAX_PLAYERS} players)`);
  return { ...s, v: s.v + 1, round: { ...r, players: [...r.players, p], pot: r.pot + r.fee } };
}

export function leave(s: WheelState, userId: string): WheelState {
  const r = s.round;
  if (s.phase !== "lobby" || !r || !r.players.some((x) => x.userId === userId)) throw new RuleError("You're not waiting in a round");
  return { ...s, v: s.v + 1, round: { ...r, players: r.players.filter((x) => x.userId !== userId), pot: r.pot - r.fee } };
}

export const payoutOf = (pot: number) => pot - Math.floor(pot * HOUSE_CUT);

// Spin: draw the whole elimination order (Fisher-Yates with `rnd`, a crypto source in the service).
export function start(s: WheelState, now: number, rnd: (n: number) => number): WheelState {
  const r = s.round;
  if (s.phase !== "lobby" || !r) throw new RuleError("No round is open");
  if (r.players.length < MIN_PLAYERS) throw new RuleError(`At least ${MIN_PLAYERS} players must join`);
  const order = r.players.map((p) => p.userId);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return { ...s, v: s.v + 1, phase: "spinning", round: { ...r, startedAt: iso(now), order, payout: payoutOf(r.pot) } };
}

// Spin k (0-based) lands at this time; there are players - 1 spins, and the round ends with the last one.
export const spinEnds = (r: Round, k: number) => Date.parse(r.startedAt!) + (k + 1) * SPIN_MS + k * GAP_MS;
export const endsAt = (r: Round) => spinEnds(r, r.players.length - 2);
export const winnerOf = (r: Round) => r.order.at(-1) ?? null;

export const finish = (s: WheelState): WheelState => ({ ...s, v: s.v + 1, phase: "finished", round: { ...s.round!, paid: true } });
// Cancelled before the spin: everyone gets their fee back (the service refunds `round.players`).
export function cancel(s: WheelState): WheelState {
  if (s.phase !== "lobby") throw new RuleError("Only a round that hasn't spun can be cancelled");
  return { ...s, v: s.v + 1, phase: "cancelled" };
}
