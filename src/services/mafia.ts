import { eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { rooms, users, type User } from "../db/schema";
import { emitToRoom, io } from "../io";
import { AppError, toSafeError } from "../lib/errors";
import { DAY_MS, lobbyState, MAX_PLAYERS, MIN_PLAYERS, NIGHT_MS, nightAct, privateView, publicView, removePlayer, RuleError, startGame, timeout, vote as castVote, type MafiaState, type Outcome } from "../lib/mafia";
import { assertCanModerateIn, assertMember, assertRoomAdmin, getRoom, getSeats, systemMessage, userSummary } from "./rooms";

// Mafia mode for a room, run like Draw & Guess mode: owner/admins switch it on, seated people join, the owner/admins
// start. Everyone watches the `mafia:<roomId>` channel, which never carries a secret; each page asks for its own role
// and picks (`mafia:me`) after every change. Discussion is the room's voice chat.
//
// shortcut: games live in memory (written through to rooms.mafia) with one in-process clock, so this is only correct
// with one server instance; move the clock to a shared scheduler before scaling out.

export const channel = (roomId: string) => `mafia:${roomId}`;
export const targetSchema = z.object({ target: z.string().min(1).max(64) });

const games = new Map<string, MafiaState>();
const queues = new Map<string, Promise<unknown>>();
function serial<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(roomId) ?? Promise.resolve()).then(fn, fn);
  queues.set(roomId, run.catch(() => {}));
  return run;
}

const view = (roomId: string, s: MafiaState | null) => ({ roomId, state: publicView(s), serverNow: new Date() });

async function load(roomId: string) {
  if (games.has(roomId)) return games.get(roomId)!;
  const room = await getRoom(roomId);
  if (room.mafia) games.set(roomId, room.mafia);
  return room.mafia;
}

async function save(roomId: string, s: MafiaState | null) {
  const before = games.get(roomId);
  await db.update(rooms).set({ mafia: s }).where(eq(rooms.id, roomId));
  if (s) games.set(roomId, s);
  else games.delete(roomId);
  io.to(channel(roomId)).emit("mafia:state", view(roomId, s));
  if (s && s.last !== before?.last && s.last) await news(roomId, s, s.last);
  if (s?.phase === "finished" && before && before.phase !== "finished") {
    await systemMessage(roomId, s.winner === "MAFIA" ? "🔪 Mafia: the Mafia took over the town!" : "🕵️ Mafia: the town found every member of the Mafia!", { kind: "MAFIA", userId: null });
  }
  return s;
}

// The morning and evening news in room chat, so listeners can follow too.
async function news(roomId: string, s: MafiaState, o: Outcome) {
  const name = (id: string | null) => s.players.find((p) => p.userId === id)?.displayName ?? "Someone";
  const role = (id: string) => ({ MAFIA: "Mafia", DOCTOR: "the Doctor", DETECTIVE: "the Detective", VILLAGER: "a Villager" })[s.roles[id]!];
  const text =
    o.kind === "night" ? (o.killed ? `🌅 ${name(o.killed)} was killed in the night. They were ${role(o.killed)}.` : o.saved ? "🌅 The Doctor saved someone last night. Nobody died." : "🌅 A quiet night. Nobody died.")
    : o.kind === "vote" ? (o.out ? `⚖️ The town voted out ${name(o.out)}. They were ${role(o.out)}.` : "⚖️ The town couldn't agree. Nobody was voted out.")
    : `🚪 ${name(o.out)} left the game. They were ${role(o.out)}.`;
  await systemMessage(roomId, text, { kind: "MAFIA", userId: null });
}

const need = async (roomId: string) => {
  const s = await load(roomId);
  if (!s) throw new AppError("MAFIA_OFF", 409, "Mafia isn't on in this room");
  return s;
};

const seatedIds = async (roomId: string) => new Set((await getSeats(roomId)).flatMap((x) => (x.occupant ? [x.occupant.userId] : [])));

async function person(userId: string) {
  const [u] = await db.select({ userId: userSummary.userId, displayName: userSummary.displayName, avatarUrl: userSummary.avatarUrl }).from(users).where(eq(users.id, userId));
  return u!;
}

// A rules refusal becomes a normal error for the page's toast.
function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RuleError) throw new AppError("MAFIA_NOT_ALLOWED", 409, e.message);
    throw e;
  }
}

// ---------- mode, lobby, start ----------

export async function setMode(actor: User, roomId: string, on: boolean) {
  await assertRoomAdmin(roomId, actor.id);
  const room = await getRoom(roomId);
  if (room.kind === "LIVE") throw new AppError("MAFIA_NOT_IN_LIVE", 400, "Mafia is for audio rooms");
  if (on && room.ludo) throw new AppError("LUDO_ON", 409, "Turn off Ludo first");
  if (on && room.karaoke) throw new AppError("KARAOKE_ON", 409, "Turn off Karaoke first");
  if (on && room.pool) throw new AppError("POOL_ON", 409, "Turn off 8 Ball Pool first");
  if (on && room.draw) throw new AppError("DRAW_ON", 409, "Turn off Draw & Guess first");
  if (on && room.video) throw new AppError("VIDEO_ON", 409, "Turn off Video mode first");
  const changed = await serial(roomId, async () => {
    const cur = await load(roomId);
    if (!!cur === on) return false;
    await save(roomId, on ? lobbyState() : null);
    return true;
  });
  if (changed) {
    emitToRoom(roomId, "room:mafia", { roomId, on });
    await systemMessage(roomId, on ? `${actor.displayName} switched the room to Mafia. Take a seat and join the game!` : `${actor.displayName} turned Mafia off`, { kind: "MAFIA", userId: actor.id });
  }
  return { on };
}

export async function watch(user: User, roomId: string) {
  await assertMember(roomId, user.id);
  const admin = await assertRoomAdmin(roomId, user.id).then(() => true, () => false);
  const s = await load(roomId);
  return { ...view(roomId, s), me: { userId: user.id, admin }, nightMs: NIGHT_MS, dayMs: DAY_MS, secret: privateView(s, user.id) };
}

// Your role and what you may know (see privateView); null for anyone not playing.
export async function me(user: User, roomId: string) {
  await assertMember(roomId, user.id);
  return { v: games.get(roomId)?.v ?? 0, secret: privateView(await load(roomId), user.id) };
}

export const join = (user: User, roomId: string) =>
  serial(roomId, async () => {
    let s = await need(roomId);
    if (s.phase === "night" || s.phase === "day") throw new AppError("MAFIA_IN_PROGRESS", 409, "A game is being played. Join the next one.");
    if (s.phase === "finished") s = lobbyState(s.v);
    if (!(await seatedIds(roomId)).has(user.id)) throw new AppError("MAFIA_SEAT_REQUIRED", 403, "Take a seat to play");
    if (s.lobby.some((p) => p.userId === user.id)) return s;
    if (s.lobby.length >= MAX_PLAYERS) throw new AppError("MAFIA_FULL", 409, `This game already has ${MAX_PLAYERS} players`);
    return save(roomId, { ...s, v: s.v + 1, lobby: [...s.lobby, await person(user.id)] });
  });

export const leave = (user: User, roomId: string) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    if (s.phase === "night" || s.phase === "day") return save(roomId, removePlayer(s, user.id, Date.now()));
    if (s.phase !== "lobby" || !s.lobby.some((p) => p.userId === user.id)) return s;
    return save(roomId, { ...s, v: s.v + 1, lobby: s.lobby.filter((p) => p.userId !== user.id) });
  });

export async function removeFromLobby(actor: User, roomId: string, userId: string) {
  await assertCanModerateIn(roomId, actor.id, userId);
  return serial(roomId, async () => {
    const s = await need(roomId);
    if (s.phase !== "lobby") throw new AppError("MAFIA_NOT_LOBBY", 409, "Players can only be removed before the game starts");
    if (!s.lobby.some((p) => p.userId === userId)) return s;
    return save(roomId, { ...s, v: s.v + 1, lobby: s.lobby.filter((p) => p.userId !== userId) });
  });
}

export async function start(actor: User, roomId: string) {
  await assertRoomAdmin(roomId, actor.id);
  const s = await serial(roomId, async () => {
    const cur = await need(roomId);
    if (cur.phase !== "lobby") throw new AppError("MAFIA_NOT_READY", 409, "Open a new lobby first");
    const seated = await seatedIds(roomId);
    const people = cur.lobby.filter((p) => seated.has(p.userId));
    if (people.length < MIN_PLAYERS) throw new AppError("MAFIA_NEED_PLAYERS", 409, `${MIN_PLAYERS} seated players must join`);
    return save(roomId, startGame(cur, people, Date.now()));
  });
  await systemMessage(roomId, `🌙 Mafia started with ${s!.players.length} players. Night falls… check your role on the board.`, { kind: "MAFIA", userId: actor.id });
  return s;
}

// ---------- night picks and day votes ----------

export const act = (user: User, roomId: string, target: string) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    await save(roomId, rule(() => nightAct(s, user.id, target, Date.now())));
    return null; // the page reads its new pick from mafia:me
  });

export const vote = (user: User, roomId: string, target: string) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    await save(roomId, rule(() => castVote(s, user.id, target, Date.now())));
    return null;
  });

// ---------- the clock ----------

// The phase ran out, or someone in the game left their seat (they're out).
const expire = (roomId: string, now: number, seatCheck: boolean) =>
  serial(roomId, async () => {
    let s = games.get(roomId);
    if (!s || (s.phase !== "night" && s.phase !== "day")) return;
    if (Date.parse(s.deadline!) <= now) return save(roomId, timeout(s, now));
    if (!seatCheck) return;
    const seated = await seatedIds(roomId);
    const gone = s.players.filter((p) => p.alive && !seated.has(p.userId));
    if (!gone.length) return;
    for (const p of gone) s = removePlayer(s, p.userId, now);
    return save(roomId, s);
  });

let checks = 0;
export async function tick(now = Date.now()) {
  const seatCheck = ++checks % 6 === 0; // seats every 3 s: a database read, the deadline is free
  for (const [roomId, s] of games) {
    if ((s.phase === "night" || s.phase === "day") && (seatCheck || Date.parse(s.deadline!) <= now)) await expire(roomId, now, seatCheck).catch(toSafeError);
  }
}

// On boot: every room left in Mafia mode; a running phase gets a fresh clock.
export async function runMafiaLoop() {
  for (const r of await db.select({ id: rooms.id, mafia: rooms.mafia }).from(rooms).where(isNotNull(rooms.mafia))) {
    const s = r.mafia!;
    const ms = s.phase === "night" ? NIGHT_MS : DAY_MS;
    games.set(r.id, s.phase === "night" || s.phase === "day" ? { ...s, deadline: new Date(Date.now() + ms).toISOString() } : s);
  }
  setInterval(() => tick().catch(toSafeError), 500);
}
