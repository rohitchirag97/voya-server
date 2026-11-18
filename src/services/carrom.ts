import { eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { rooms, users, type User } from "../db/schema";
import { emitToRoom, io } from "../io";
import { AppError, toSafeError } from "../lib/errors";
import { lobbyState, MAX_PLAYERS, MIN_PLAYERS, removePlayer, RuleError, startGame, takeShot, timeout, type CarromState } from "../lib/carrom";
import { assertCanModerateIn, assertMember, assertRoomAdmin, getRoom, getSeats, systemMessage, userSummary } from "./rooms";

// Carrom mode for a room, run like 8 Ball Pool mode: owner/admins switch it on, 2-4 seated people join, owner/admins
// start. The server simulates every shot (lib/carrom.ts + the shared physics); phones send only where the striker sits,
// where it's aimed and how hard, and replay the shot they get back. Aim is relayed live on `carrom:<roomId>`.
//
// shortcut: games live in memory (written through to rooms.carrom) with one in-process clock, so this is only correct
// with one server instance; move the clock to a shared scheduler before scaling out.

export const TURN_MS = Number(process.env.CARROM_TURN_MS ?? 30_000);
export const channel = (roomId: string) => `carrom:${roomId}`;
const finite = z.number().finite();
export const shotSchema = z.object({ t: z.number().min(0).max(1), dx: finite, dy: finite, power: z.number().min(0).max(1) });
export const aimSchema = shotSchema;

const games = new Map<string, CarromState>();
const queues = new Map<string, Promise<unknown>>();
function serial<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(roomId) ?? Promise.resolve()).then(fn, fn);
  queues.set(roomId, run.catch(() => {}));
  return run;
}

const view = (roomId: string, s: CarromState | null) => ({ roomId, state: s, serverNow: new Date() });

async function load(roomId: string) {
  if (games.has(roomId)) return games.get(roomId)!;
  const room = await getRoom(roomId);
  if (room.carrom) games.set(roomId, room.carrom);
  return room.carrom;
}

async function save(roomId: string, s: CarromState | null) {
  const before = games.get(roomId);
  await db.update(rooms).set({ carrom: s }).where(eq(rooms.id, roomId));
  if (s) games.set(roomId, s);
  else games.delete(roomId);
  io.to(channel(roomId)).emit("carrom:state", view(roomId, s));
  if (s?.phase === "finished" && before?.phase === "playing") {
    const w = s.players.find((p) => p.userId === s.winner);
    const table = s.players.map((p) => `${p.displayName ?? "Someone"} ${p.score}`).join(", ");
    await systemMessage(roomId, w ? `🎯 ${w.displayName ?? "Someone"} won the carrom game! (${table})` : `🎯 The carrom game ended in a tie (${table})`, { kind: "CARROM", userId: s.winner });
  }
  return s;
}

const need = async (roomId: string) => {
  const s = await load(roomId);
  if (!s) throw new AppError("CARROM_OFF", 409, "Carrom isn't on in this room");
  return s;
};

const seatedIds = async (roomId: string) => new Set((await getSeats(roomId)).flatMap((x) => (x.occupant?.userId ? [x.occupant.userId] : [])));

async function person(userId: string) {
  const [u] = await db.select({ userId: userSummary.userId, displayName: userSummary.displayName, avatarUrl: userSummary.avatarUrl }).from(users).where(eq(users.id, userId));
  return u!;
}

function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RuleError) throw new AppError("CARROM_NOT_ALLOWED", 409, e.message);
    throw e;
  }
}

// The player on turn gets TURN_MS, counted from when the last shot stops rolling on the phones.
const clock = (s: CarromState, readyAt: number) => ({ ...s, readyAt: new Date(readyAt).toISOString(), deadline: s.phase === "playing" ? new Date(readyAt + TURN_MS).toISOString() : null });

// ---------- mode, lobby, start ----------

export async function setMode(actor: User, roomId: string, on: boolean) {
  await assertRoomAdmin(roomId, actor.id);
  const room = await getRoom(roomId);
  if (room.kind === "LIVE") throw new AppError("CARROM_NOT_IN_LIVE", 400, "Carrom is for audio rooms");
  for (const [k, label] of [["ludo", "Ludo"], ["pool", "8 Ball Pool"], ["draw", "Draw & Guess"], ["mafia", "Mafia"], ["chess", "Chess"], ["wheel", "the Wheel"], ["karaoke", "Karaoke"], ["video", "Video mode"]] as const) {
    if (on && room[k]) throw new AppError(`${k.toUpperCase()}_ON`, 409, `Turn off ${label} first`);
  }
  const changed = await serial(roomId, async () => {
    const cur = await load(roomId);
    if (!!cur === on) return false;
    await save(roomId, on ? lobbyState() : null);
    return true;
  });
  if (changed) {
    emitToRoom(roomId, "room:carrom", { roomId, on });
    await systemMessage(roomId, on ? `${actor.displayName} switched the room to Carrom. Take a seat and join the game!` : `${actor.displayName} turned Carrom off`, { kind: "CARROM", userId: actor.id });
  }
  return { on };
}

export async function watch(user: User, roomId: string) {
  await assertMember(roomId, user.id);
  const admin = await assertRoomAdmin(roomId, user.id).then(() => true, () => false);
  return { ...view(roomId, await load(roomId)), me: { userId: user.id, admin }, turnMs: TURN_MS };
}

export const join = (user: User, roomId: string) =>
  serial(roomId, async () => {
    let s = await need(roomId);
    if (s.phase === "playing") throw new AppError("CARROM_IN_PROGRESS", 409, "A game is being played. Join the next one.");
    if (s.phase === "finished") s = lobbyState(s.v);
    if (!(await seatedIds(roomId)).has(user.id)) throw new AppError("CARROM_SEAT_REQUIRED", 403, "Take a seat to play");
    if (s.lobby.some((p) => p.userId === user.id)) return s;
    if (s.lobby.length >= MAX_PLAYERS) throw new AppError("CARROM_FULL", 409, `This game already has ${MAX_PLAYERS} players`);
    return save(roomId, { ...s, v: s.v + 1, lobby: [...s.lobby, await person(user.id)] });
  });

// Before the start: leave the lobby. During a game: leave it (out of the game; the last one left wins).
export const leave = (user: User, roomId: string) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    if (s.phase === "playing") return save(roomId, clock(removePlayer(s, user.id), Date.now()));
    if (s.phase !== "lobby" || !s.lobby.some((p) => p.userId === user.id)) return s;
    return save(roomId, { ...s, v: s.v + 1, lobby: s.lobby.filter((p) => p.userId !== user.id) });
  });

export async function removeFromLobby(actor: User, roomId: string, userId: string) {
  await assertCanModerateIn(roomId, actor.id, userId);
  return serial(roomId, async () => {
    const s = await need(roomId);
    if (s.phase !== "lobby") throw new AppError("CARROM_NOT_LOBBY", 409, "Players can only be removed before the game starts");
    if (!s.lobby.some((p) => p.userId === userId)) return s;
    return save(roomId, { ...s, v: s.v + 1, lobby: s.lobby.filter((p) => p.userId !== userId) });
  });
}

export async function start(actor: User, roomId: string) {
  await assertRoomAdmin(roomId, actor.id);
  const s = await serial(roomId, async () => {
    const cur = await need(roomId);
    if (cur.phase !== "lobby") throw new AppError("CARROM_NOT_READY", 409, "Open a new lobby first");
    const seated = await seatedIds(roomId);
    const people = cur.lobby.filter((p) => seated.has(p.userId));
    if (people.length < MIN_PLAYERS) throw new AppError("CARROM_NEED_PLAYERS", 409, `${MIN_PLAYERS} seated players must join`);
    return save(roomId, clock(startGame(cur, people), Date.now()));
  });
  await systemMessage(roomId, `🎯 Carrom started: ${s!.players.map((p) => p.displayName).join(" vs ")}`, { kind: "CARROM", userId: actor.id });
  return s;
}

// ---------- shots ----------

export async function aim(user: User, roomId: string, a: z.infer<typeof aimSchema>) {
  const s = games.get(roomId);
  if (!s || s.phase !== "playing" || s.players[s.turn]!.userId !== user.id) return null; // stale: quietly ignored
  io.to(channel(roomId)).volatile.emit("carrom:aim", { roomId, userId: user.id, v: s.v, ...a });
  return null;
}

export const shoot = (user: User, roomId: string, p: z.infer<typeof shotSchema>) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    if (s.readyAt && Date.parse(s.readyAt) > Date.now() + 300) throw new AppError("CARROM_BUSY", 409, "Wait for the coins to stop");
    const n = rule(() => takeShot(s, user.id, p));
    const ms = n.last?.kind === "shot" ? n.last.ms : 0;
    return save(roomId, clock(n, Date.now() + ms));
  });

// ---------- the clock ----------

// The player on turn ran out of time (the turn passes), or someone in the game left their seat (they're out).
const check = (roomId: string, now: number, seats: boolean) =>
  serial(roomId, async () => {
    let s = games.get(roomId);
    if (!s || s.phase !== "playing") return;
    if (seats) {
      const seated = await seatedIds(roomId);
      const gone = s.players.filter((p) => !seated.has(p.userId));
      if (gone.length) {
        for (const p of gone) s = removePlayer(s, p.userId);
        return save(roomId, clock(s, now));
      }
    }
    if (s.deadline && Date.parse(s.deadline) <= now) await save(roomId, clock(timeout(s), now));
  });

let ticks = 0;
export async function tick(now = Date.now()) {
  const seats = ++ticks % 6 === 0; // seats every 3 s: a database read
  for (const [roomId, s] of games) {
    if (s.phase === "playing" && (seats || (s.deadline && Date.parse(s.deadline) <= now))) await check(roomId, now, seats).catch(toSafeError);
  }
}

// On boot: every room left in Carrom mode; a running game gives the player on turn a fresh clock.
export async function runCarromLoop() {
  for (const r of await db.select({ id: rooms.id, carrom: rooms.carrom }).from(rooms).where(isNotNull(rooms.carrom))) {
    const s = r.carrom!;
    games.set(r.id, s.phase === "playing" ? clock(s, Date.now()) : s);
  }
  setInterval(() => tick().catch(toSafeError), 500);
}
