// 8 Ball Pool rules, pure: no database, no sockets, no clock. The service (services/pool.ts) owns time and storage;
// the physics (public/games/pool/physics.js) is shared with the table page, which replays every shot.
//
// Rules (WPA-style, as most players know them from mobile pool):
//   - break from the kitchen; the table stays open after the break
//   - on an open table, the first legally pocketed ball decides groups (solids 1-7, stripes 9-15)
//   - fouls: cue ball pocketed, nothing hit, wrong ball hit first, or no ball pocketed and none touching a cushion
//     after contact. A foul gives the opponent ball in hand anywhere (behind the head string after a break scratch)
//   - the 8 on the break is spotted again; otherwise pocketing the 8 wins once your group is cleared, and loses if
//     pocketed early or on a foul
//   - pocket one of your own balls without a foul and you shoot again
// shortcut: no called pocket for the 8 (any pocket counts); add calling if players want tournament rules.
import { HEAD, HEAD_X, FOOT, L, R, W, rack, simulate } from "../../public/games/pool/physics.js";

export type Group = "solid" | "stripe";
export type Ball = { n: number; x: number; y: number };
export type Person = { userId: string; displayName: string | null; avatarUrl: string | null };
export type Shot = { dx: number; dy: number; power: number; sx: number; sy: number };
export type Foul = "SCRATCH" | "NO_HIT" | "WRONG_BALL" | "NO_RAIL" | "TIMEOUT";
export type LastAction =
  | { kind: "shot"; userId: string; shot: Shot; from: Ball[]; to: Ball[]; potted: number[]; firstHit: number | null; foul: Foul | null; ms: number }
  | { kind: "timeout"; userId: string };

export type PoolState = {
  v: number; // bumps on every change, so clients drop stale updates
  phase: "lobby" | "playing" | "finished";
  lobby: Person[]; // joined, waiting for the start (2 play)
  players: (Person & { group: Group | null })[]; // players[0] breaks
  turn: number;
  balls: Ball[]; // on the table, cue ball (n 0) included
  inHand: "kitchen" | "table" | null; // the shooter may place the cue ball first
  breakShot: boolean;
  readyAt: string | null; // when the last shot stops rolling on the phones; the next one waits for it (ISO)
  deadline: string | null; // when the shooter's time runs out (ISO)
  last: LastAction | null;
  winner: string | null;
  reason: "EIGHT" | "EIGHT_EARLY" | "EIGHT_FOUL" | "LEFT" | null;
};

export const PLAYERS = 2;

export const lobbyState = (v = 0): PoolState => ({
  v, phase: "lobby", lobby: [], players: [], turn: 0, balls: [], inHand: null, breakShot: false, readyAt: null, deadline: null, last: null, winner: null, reason: null,
});

export const groupOf = (n: number): Group | 8 => (n === 8 ? 8 : n < 8 ? "solid" : "stripe");
const other = (g: Group): Group => (g === "solid" ? "stripe" : "solid");

export function startGame(state: PoolState, people: Person[]): PoolState {
  return {
    ...lobbyState(state.v + 1),
    phase: "playing",
    players: people.slice(0, PLAYERS).map((p) => ({ userId: p.userId, displayName: p.displayName, avatarUrl: p.avatarUrl, group: null })),
    balls: rack(),
    inHand: "kitchen",
    breakShot: true,
  };
}

const free = (balls: Ball[], x: number, y: number) => balls.every((b) => (b.x - x) ** 2 + (b.y - y) ** 2 >= 4 * R * R);

// Where the shooter may put the cue ball: on the cloth, clear of every other ball, behind the head string after a
// break scratch.
export function canPlace(s: PoolState, x: number, y: number) {
  if (!s.inHand || x < R || x > L - R || y < R || y > W - R) return false;
  if (s.inHand === "kitchen" && x > HEAD_X) return false;
  return free(s.balls.filter((b) => b.n !== 0), x, y);
}

// The nearest free spot to `p` along the long string of the table (spotting the 8, bringing the cue ball back).
function spot(balls: Ball[], p: { x: number; y: number }, dir: 1 | -1) {
  for (let i = 0; i < 400; i++) {
    for (const x of [p.x + dir * i * 0.005, p.x - dir * i * 0.005]) if (x >= R && x <= L - R && free(balls, x, p.y)) return { x, y: p.y };
  }
  return { x: p.x, y: p.y };
}

// The direction as a unit vector and the tip inside the half-radius disc, whatever the phone sent.
export function cleanShot(shot: Shot): Shot {
  const len = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy);
  if (!(len > 1e-6)) throw new Error("no direction");
  const s = Math.sqrt(shot.sx * shot.sx + shot.sy * shot.sy);
  const k = s > 1 ? 1 / s : 1;
  return { dx: shot.dx / len, dy: shot.dy / len, power: Math.min(1, Math.max(0, shot.power)), sx: shot.sx * k, sy: shot.sy * k };
}

// One shot by the player on turn, with the cue ball first moved to `cue` when they had ball in hand.
export function takeShot(s: PoolState, raw: Shot, cue?: { x: number; y: number }): PoolState {
  if (s.phase !== "playing") throw new Error("not playing");
  const shot = cleanShot(raw);
  const me = s.players[s.turn]!;
  const from = cue ? s.balls.map((b) => (b.n === 0 ? { n: 0, x: cue.x, y: cue.y } : b)) : s.balls;
  const r = simulate(from, shot);
  const onEight = me.group !== null && !from.some((b) => b.n !== 0 && groupOf(b.n) === me.group);
  const cuePotted = r.potted.includes(0);
  const objects = r.potted.filter((n) => n !== 0 && n !== 8);
  const wrongFirst = r.firstHit !== null && !s.breakShot && (me.group ? (onEight ? r.firstHit !== 8 : groupOf(r.firstHit) !== me.group) : r.firstHit === 8);
  const foul: Foul | null = cuePotted ? "SCRATCH" : r.firstHit === null ? "NO_HIT" : wrongFirst ? "WRONG_BALL" : !r.potted.length && !r.rail ? "NO_RAIL" : null;
  const last: LastAction = { kind: "shot", userId: me.userId, shot, from, to: r.to, potted: r.potted, firstHit: r.firstHit, foul, ms: r.ms };
  const opp = s.players[1 - s.turn]!;

  if (r.potted.includes(8) && !s.breakShot) {
    const won = onEight && !foul;
    return { ...s, v: s.v + 1, phase: "finished", balls: r.to, inHand: null, deadline: null, last, winner: (won ? me : opp).userId, reason: won ? "EIGHT" : onEight ? "EIGHT_FOUL" : "EIGHT_EARLY" };
  }
  let balls = r.to;
  if (r.potted.includes(8)) balls = [...balls, { n: 8, ...spot(balls, FOOT, 1) }];
  if (cuePotted) balls = [...balls, { n: 0, ...spot(balls, HEAD, -1) }];

  let players = s.players;
  if (!me.group && !s.breakShot && !foul && objects.length) {
    const g = groupOf(objects[0]!) as Group;
    players = players.map((p, i) => ({ ...p, group: i === s.turn ? g : other(g) }));
  }
  const mine = players[s.turn]!.group;
  const scored = s.breakShot ? r.potted.some((n) => n !== 0) : objects.some((n) => !mine || groupOf(n) === mine);
  const again = !foul && scored;
  return {
    ...s, v: s.v + 1, players, balls, last,
    turn: again ? s.turn : 1 - s.turn,
    inHand: foul ? (s.breakShot && cuePotted ? "kitchen" : "table") : null,
    breakShot: false,
  };
}

// The shooter ran out of time: a foul, so the other player gets ball in hand (and the break, if it wasn't taken).
export const timeout = (s: PoolState): PoolState => ({
  ...s, v: s.v + 1, turn: 1 - s.turn, inHand: s.breakShot ? "kitchen" : "table", last: { kind: "timeout", userId: s.players[s.turn]!.userId },
});

// A player resigned or left their seat: the other one wins.
export const forfeit = (s: PoolState, loser: string): PoolState => ({
  ...s, v: s.v + 1, phase: "finished", inHand: null, deadline: null, winner: s.players.find((p) => p.userId !== loser)!.userId, reason: "LEFT",
});
