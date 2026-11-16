// Mafia rules, pure: no database, no sockets, no clock (callers pass `now`). The service (services/mafia.ts) owns time
// and storage. Talking happens on the room's voice seats; this only runs roles, night actions and votes.
//
// Rules: 5-12 seated players get secret roles: Mafia (1 per 4 players, rounded down), one Doctor, one Detective, the
// rest Villagers. Night: each Mafia picks a victim (most picks wins, ties go to the earliest pick), the Doctor saves
// one person (themselves too), the Detective learns whether one person is Mafia. Morning: the victim dies unless
// saved. Day: everyone alive votes someone out or skips; the most votes is out if it beats the skips and isn't a tie.
// The dead show their role. Town wins when no Mafia are left; Mafia win once they are at least half of the living.
// shortcut: the dead can still talk on voice; mute them through seats if players want it strict.

export type Person = { userId: string; displayName: string | null; avatarUrl: string | null };
export type Role = "MAFIA" | "DOCTOR" | "DETECTIVE" | "VILLAGER";
export type Outcome =
  | { kind: "night"; killed: string | null; saved: boolean } // saved: the Mafia picked someone and the Doctor saved them
  | { kind: "vote"; out: string | null }
  | { kind: "left"; out: string };
export type MafiaState = {
  v: number; // bumps on every change, so clients drop stale updates
  phase: "lobby" | "night" | "day" | "finished";
  lobby: Person[];
  players: (Person & { alive: boolean })[];
  roles: Record<string, Role>; // secret: see publicView / privateView
  day: number; // 1 = the first night and the day after it
  deadline: string | null; // the phase ends (ISO)
  night: { kills: Record<string, string>; save: string | null; check: string | null }; // secret: this night's picks
  checks: { target: string; mafia: boolean }[]; // secret: the Detective's results so far
  votes: Record<string, string>; // the day's votes (open, as at a real table): voter -> target userId or "skip"
  last: Outcome | null; // what just happened, for the morning / evening news
  winner: "MAFIA" | "TOWN" | null;
};

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 12;
export const NIGHT_MS = Number(process.env.MAFIA_NIGHT_MS ?? 30_000);
export const DAY_MS = Number(process.env.MAFIA_DAY_MS ?? 120_000);
export const SKIP = "skip";

const iso = (ms: number) => new Date(ms).toISOString();
const emptyNight = () => ({ kills: {}, save: null, check: null });
const alive = (s: MafiaState) => s.players.filter((p) => p.alive);
const aliveWith = (s: MafiaState, role: Role) => alive(s).filter((p) => s.roles[p.userId] === role);
const isAlive = (s: MafiaState, userId: string) => s.players.some((p) => p.userId === userId && p.alive);

export const lobbyState = (v = 0): MafiaState => ({ v: v + 1, phase: "lobby", lobby: [], players: [], roles: {}, day: 0, deadline: null, night: emptyNight(), checks: [], votes: {}, last: null, winner: null });

export function dealRoles(n: number, rnd: () => number): Role[] {
  const roles: Role[] = [...Array(Math.floor(n / 4)).fill("MAFIA"), "DOCTOR", "DETECTIVE"];
  while (roles.length < n) roles.push("VILLAGER");
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [roles[i], roles[j]] = [roles[j]!, roles[i]!];
  }
  return roles;
}

export function startGame(s: MafiaState, people: Person[], now: number, rnd = Math.random): MafiaState {
  const dealt = dealRoles(people.length, rnd);
  const roles = Object.fromEntries(people.map((p, i) => [p.userId, dealt[i]!]));
  return { ...s, v: s.v + 1, phase: "night", players: people.map((p) => ({ ...p, alive: true })), roles, day: 1, deadline: iso(now + NIGHT_MS), night: emptyNight(), checks: [], votes: {}, last: null, winner: null };
}

function winnerOf(s: MafiaState): MafiaState["winner"] {
  const mafia = aliveWith(s, "MAFIA").length;
  if (!mafia) return "TOWN";
  return mafia * 2 >= alive(s).length ? "MAFIA" : null;
}

// After a death: the end, or on to `next`.
function settle(s: MafiaState, next: () => MafiaState): MafiaState {
  const winner = winnerOf(s);
  return winner ? { ...s, phase: "finished", winner, deadline: null, night: emptyNight(), votes: {} } : next();
}

const kill = (s: MafiaState, userId: string | null) => (userId ? s.players.map((p) => (p.userId === userId ? { ...p, alive: false } : p)) : s.players);

// The night is over (everyone acted, or time ran out): the Mafia's pick dies unless saved, then it's day.
export function resolveNight(s: MafiaState, now: number): MafiaState {
  if (s.phase !== "night") return s;
  const tally = new Map<string, number>();
  for (const t of Object.values(s.night.kills)) tally.set(t, (tally.get(t) ?? 0) + 1); // insertion order = pick order
  let target: string | null = null;
  for (const [t, n] of tally) if (!target || n > tally.get(target)!) target = t;
  const saved = !!target && target === s.night.save;
  const killed = saved ? null : target;
  const checks = s.night.check && aliveWith(s, "DETECTIVE").length ? [...s.checks, { target: s.night.check, mafia: s.roles[s.night.check] === "MAFIA" }] : s.checks;
  const n = { ...s, v: s.v + 1, players: kill(s, killed), checks, night: emptyNight(), last: { kind: "night" as const, killed, saved } };
  return settle(n, () => ({ ...n, phase: "day", votes: {}, deadline: iso(now + DAY_MS) }));
}

// The day is over: the most-voted is out if they beat the skips and nobody ties them; then night falls.
export function resolveDay(s: MafiaState, now: number): MafiaState {
  if (s.phase !== "day") return s;
  const tally = new Map<string, number>();
  for (const t of Object.values(s.votes)) tally.set(t, (tally.get(t) ?? 0) + 1);
  const skips = tally.get(SKIP) ?? 0;
  tally.delete(SKIP);
  const top = Math.max(0, ...tally.values());
  const leaders = [...tally].filter(([, n]) => n === top).map(([t]) => t);
  const out = top > skips && leaders.length === 1 ? leaders[0]! : null;
  const n = { ...s, v: s.v + 1, players: kill(s, out), votes: {}, last: { kind: "vote" as const, out } };
  return settle(n, () => ({ ...n, phase: "night", day: s.day + 1, night: emptyNight(), deadline: iso(now + NIGHT_MS) }));
}

const nightDone = (s: MafiaState) =>
  aliveWith(s, "MAFIA").every((p) => s.night.kills[p.userId]) &&
  aliveWith(s, "DOCTOR").every(() => s.night.save) &&
  aliveWith(s, "DETECTIVE").every(() => s.night.check);
const dayDone = (s: MafiaState) => alive(s).every((p) => s.votes[p.userId]);

export class RuleError extends Error {}

// A night pick by a living Mafia, Doctor or Detective. Picks can change until the night ends.
export function nightAct(s: MafiaState, userId: string, target: string, now: number): MafiaState {
  if (s.phase !== "night") throw new RuleError("It's not night");
  if (!isAlive(s, userId)) throw new RuleError("You're out of this game");
  if (!isAlive(s, target)) throw new RuleError("Pick someone still in the game");
  const role = s.roles[userId];
  let night = s.night;
  if (role === "MAFIA") {
    if (s.roles[target] === "MAFIA") throw new RuleError("They're on your side");
    const { [userId]: _, ...rest } = night.kills; // re-picking moves this pick to the back for ties
    night = { ...night, kills: { ...rest, [userId]: target } };
  } else if (role === "DOCTOR") night = { ...night, save: target };
  else if (role === "DETECTIVE") {
    if (target === userId) throw new RuleError("Check someone else");
    night = { ...night, check: target };
  } else throw new RuleError("Villagers sleep at night");
  const n = { ...s, v: s.v + 1, night };
  return nightDone(n) ? resolveNight(n, now) : n;
}

export function vote(s: MafiaState, userId: string, target: string, now: number): MafiaState {
  if (s.phase !== "day") throw new RuleError("Voting is in the day");
  if (!isAlive(s, userId)) throw new RuleError("You're out of this game");
  if (target !== SKIP && (!isAlive(s, target) || target === userId)) throw new RuleError("Vote for someone else still in the game");
  const n = { ...s, v: s.v + 1, votes: { ...s.votes, [userId]: target } };
  return dayDone(n) ? resolveDay(n, now) : n;
}

// A player leaves (or loses their seat) mid-game: out, role shown, their picks and votes dropped.
export function removePlayer(s: MafiaState, userId: string, now: number): MafiaState {
  if ((s.phase !== "night" && s.phase !== "day") || !isAlive(s, userId)) return s;
  const { [userId]: _k, ...kills } = s.night.kills;
  const strip = (x: string | null) => (x === userId ? null : x);
  const night = { kills: Object.fromEntries(Object.entries(kills).filter(([, t]) => t !== userId)), save: strip(s.night.save), check: strip(s.night.check) };
  const votes = Object.fromEntries(Object.entries(s.votes).filter(([v, t]) => v !== userId && t !== userId));
  const n = { ...s, v: s.v + 1, players: kill(s, userId), night, votes, last: { kind: "left" as const, out: userId } };
  return settle(n, () => (n.phase === "night" ? (nightDone(n) ? resolveNight(n, now) : n) : dayDone(n) ? resolveDay(n, now) : n));
}

// Time's up for the current phase.
export const timeout = (s: MafiaState, now: number) => (s.phase === "night" ? resolveNight(s, now) : s.phase === "day" ? resolveDay(s, now) : s);

// What everyone sees: roles of the dead (all of them once the game is over), never the night's picks or checks.
export function publicView(s: MafiaState | null) {
  if (!s) return null;
  const shown = s.phase === "finished" ? s.roles : Object.fromEntries(s.players.filter((p) => !p.alive).map((p) => [p.userId, s.roles[p.userId]!]));
  return { ...s, roles: shown, night: undefined, checks: undefined };
}

// What one player may know: their role; a Mafia also sees the team and its picks; the Doctor and Detective their own
// pick, and the Detective their results.
export function privateView(s: MafiaState | null, userId: string) {
  const role = s?.roles[userId];
  if (!s || !role) return null;
  if (role === "MAFIA") return { role, team: Object.keys(s.roles).filter((id) => s.roles[id] === "MAFIA"), picks: s.night.kills };
  if (role === "DOCTOR") return { role, pick: s.night.save };
  if (role === "DETECTIVE") return { role, pick: s.night.check, checks: s.checks };
  return { role };
}
