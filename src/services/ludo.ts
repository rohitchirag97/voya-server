import { randomInt } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { rooms, users, type User } from "../db/schema";
import { emitToRoom, io } from "../io";
import { AppError, toSafeError } from "../lib/errors";
import { autoToken, lobbyState, move, roll, startGame, TOKENS, type LudoState } from "../lib/ludo";
import { assertMember, assertRoomAdmin, getRoom, getSeats, systemMessage, userSummary } from "./rooms";

// Ludo mode for a room. The owner/admins switch it on; seated people join (2-4) and the owner/admins start the game.
// The server rolls the dice and enforces every rule (lib/ludo.ts); phones only ask to roll or to move a token.
// Everyone in the room can watch: the board page follows the `ludo:<roomId>` channel.
//
// shortcut: games live in memory (written through to rooms.ludo on every change) and the clock is one in-process
// ticker, so this is only correct with one server instance; move the clock to a shared scheduler before scaling out.

export const TURN_MS = Number(process.env.LUDO_TURN_MS ?? 15_000);
const AUTO_MS = Number(process.env.LUDO_AUTO_MS ?? 1_200); // pace of server-played moves, so watchers can follow them
const MAX_PLAYERS = 4;
export const channel = (roomId: string) => `ludo:${roomId}`;
export const tokenSchema = z.number().int().min(0).max(TOKENS - 1);

const games = new Map<string, LudoState>(); // rooms in Ludo mode -> current state (mirror of rooms.ludo)
// Rooms where the server is finishing the current turn for a player who timed out ("takes the wheel for that turn only").
const takeover = new Set<string>();

// One action per room at a time, in arrival order.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(roomId) ?? Promise.resolve()).then(fn, fn);
  queues.set(roomId, run.catch(() => {}));
  return run;
}

export const view = (roomId: string, s: LudoState | null) => ({ roomId, state: s, serverNow: new Date() });

async function load(roomId: string) {
  if (games.has(roomId)) return games.get(roomId)!;
  const room = await getRoom(roomId);
  if (room.ludo) games.set(roomId, room.ludo);
  return room.ludo;
}

async function save(roomId: string, s: LudoState | null) {
  await db.update(rooms).set({ ludo: s }).where(eq(rooms.id, roomId));
  if (s) games.set(roomId, s);
  else {
    games.delete(roomId);
    takeover.delete(roomId);
  }
  io.to(channel(roomId)).emit("ludo:state", view(roomId, s));
  return s;
}

const need = async (roomId: string) => {
  const s = await load(roomId);
  if (!s) throw new AppError("LUDO_OFF", 409, "Ludo isn't on in this room");
  return s;
};

const seatedIds = async (roomId: string) => new Set((await getSeats(roomId)).flatMap((x) => (x.occupant ? [x.occupant.userId] : [])));

async function person(userId: string) {
  const [u] = await db.select({ userId: userSummary.userId, displayName: userSummary.displayName, avatarUrl: userSummary.avatarUrl }).from(users).where(eq(users.id, userId));
  return u!;
}

// ---------- mode, lobby, start ----------

export async function setMode(actor: User, roomId: string, on: boolean) {
  await assertRoomAdmin(roomId, actor.id);
  if ((await getRoom(roomId)).kind === "LIVE") throw new AppError("LUDO_NOT_IN_LIVE", 400, "Ludo is for audio rooms");
  const changed = await serial(roomId, async () => {
    const cur = await load(roomId);
    if (!!cur === on) return false;
    await save(roomId, on ? lobbyState() : null);
    return true;
  });
  if (changed) {
    emitToRoom(roomId, "room:ludo", { roomId, on });
    await systemMessage(roomId, on ? `${actor.displayName} switched the room to Ludo. Take a seat and join the game!` : `${actor.displayName} turned Ludo off`, { kind: "LUDO", userId: actor.id });
  }
  return { on };
}

// The board page: the current state (and from then on every change on the channel), plus who is looking,
// so it shows Start only to the owner/admins. The server still checks every action.
export async function watch(user: User, roomId: string) {
  await assertMember(roomId, user.id);
  const admin = await assertRoomAdmin(roomId, user.id).then(() => true, () => false);
  return { ...view(roomId, await load(roomId)), me: { userId: user.id, admin } };
}

export const join = (user: User, roomId: string) =>
  serial(roomId, async () => {
    let s = await need(roomId);
    if (s.phase === "playing") throw new AppError("LUDO_IN_PROGRESS", 409, "A game is being played. Join the next one.");
    if (s.phase === "finished") s = { ...lobbyState(s.v) }; // the first join after a game opens the next lobby
    if (!(await seatedIds(roomId)).has(user.id)) throw new AppError("LUDO_SEAT_REQUIRED", 403, "Take a seat to play");
    if (s.lobby.some((p) => p.userId === user.id)) return s;
    if (s.lobby.length >= MAX_PLAYERS) throw new AppError("LUDO_FULL", 409, "This game already has 4 players");
    return save(roomId, { ...s, v: s.v + 1, lobby: [...s.lobby, await person(user.id)] });
  });

export const leaveLobby = (user: User, roomId: string) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    if (s.phase !== "lobby" || !s.lobby.some((p) => p.userId === user.id)) return s;
    return save(roomId, { ...s, v: s.v + 1, lobby: s.lobby.filter((p) => p.userId !== user.id) });
  });

export async function start(actor: User, roomId: string) {
  await assertRoomAdmin(roomId, actor.id);
  const s = await serial(roomId, async () => {
    const cur = await need(roomId);
    if (cur.phase !== "lobby") throw new AppError("LUDO_NOT_READY", 409, "Open a new lobby first");
    const seated = await seatedIds(roomId);
    const people = cur.lobby.filter((p) => seated.has(p.userId)); // anyone who left their seat since joining is out
    if (people.length < 2) throw new AppError("LUDO_NEED_PLAYERS", 409, "At least 2 seated players must join");
    return next(roomId, startGame(cur, people));
  });
  await systemMessage(roomId, `Ludo started: ${s!.players.map((p) => p.displayName).join(" vs ")}`, { kind: "LUDO", userId: actor.id });
  return s;
}

// ---------- turns ----------

const dice = () => randomInt(1, 7);

function current(s: LudoState, userId: string, step: "roll" | "move") {
  if (s.phase !== "playing") throw new AppError("LUDO_NOT_PLAYING", 409, "No game is running");
  if (s.players[s.turn]!.userId !== userId) throw new AppError("LUDO_NOT_YOUR_TURN", 409, "It's not your turn");
  if (s.step !== step) throw new AppError("LUDO_WRONG_STEP", 409, step === "roll" ? "Move a token first" : "Roll the dice first");
}

export const rollDice = (user: User, roomId: string) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    current(s, user.id, "roll");
    return next(roomId, roll(s, dice()));
  });

export const moveToken = (user: User, roomId: string, token: number) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    current(s, user.id, "move");
    if (!s.legal.includes(token)) throw new AppError("LUDO_ILLEGAL_MOVE", 409, "That token can't move");
    return next(roomId, move(s, token));
  });

// After every change: end the game, or set up the next step and its clock. A player who is no longer seated becomes
// server-played for the rest of the game; a timed-out player only for the rest of the current turn.
async function next(roomId: string, s: LudoState) {
  if (s.phase === "finished") {
    takeover.delete(roomId);
    await save(roomId, s);
    const w = s.players.find((p) => p.userId === s.winner);
    await systemMessage(roomId, `🏆 ${w?.displayName ?? "Someone"} won the Ludo game!`, { kind: "LUDO", userId: s.winner });
    return s;
  }
  if (s.last && s.last.kind !== "roll") takeover.delete(roomId); // that turn is over
  const seated = await seatedIds(roomId);
  const players = s.players.map((p, i) => (i === s.turn && !p.auto && !seated.has(p.userId) ? { ...p, auto: true } : p));
  const fast = players[s.turn]!.auto || takeover.has(roomId);
  return save(roomId, { ...s, players, deadline: new Date(Date.now() + (fast ? AUTO_MS : TURN_MS)).toISOString() });
}

// Plays the current step for the server: an absent player, or one whose 15 seconds ran out.
const autoStep = (roomId: string, now: number) =>
  serial(roomId, async () => {
    const s = games.get(roomId);
    if (!s || s.phase !== "playing" || !s.deadline || Date.parse(s.deadline) > now) return;
    if (!s.players[s.turn]!.auto) takeover.add(roomId);
    await next(roomId, s.step === "roll" ? roll(s, dice(), true) : move(s, autoToken(s), true));
  });

// The clock: anything past its deadline gets played. Exported so tests can run it with a chosen "now".
export async function tick(now = Date.now()) {
  for (const [roomId, s] of games) {
    if (s.phase === "playing" && s.deadline && Date.parse(s.deadline) <= now) await autoStep(roomId, now).catch(toSafeError);
  }
}

// On boot: pick up every room left in Ludo mode; running games get a fresh clock for the player on turn.
export async function runLudoLoop() {
  for (const r of await db.select({ id: rooms.id, ludo: rooms.ludo }).from(rooms).where(isNotNull(rooms.ludo))) {
    const s = r.ludo!;
    games.set(r.id, s.phase === "playing" ? { ...s, deadline: new Date(Date.now() + TURN_MS).toISOString() } : s);
  }
  setInterval(() => tick().catch(toSafeError), 250);
}
