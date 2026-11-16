import { randomUUID } from "node:crypto";
import { eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { rooms, songs, users, type User } from "../db/schema";
import { emitToRoom, io, roomChannel } from "../io";
import { AppError, toSafeError } from "../lib/errors";
import { add as addEntry, dropUnseated, emptyState, finish as finishTurn, remove as removeEntry, RuleError, started as startTurn, timeout, type KaraokeState } from "../lib/karaoke";
import { assertMember, assertRoomAdmin, getRoom, getSeats, systemMessage, userSummary } from "./rooms";
import { getSong, songLength } from "./songs";

// Karaoke mode for a room: owner/admins switch it on; seated people queue songs from the library and sing in turn. The
// singer's phone plays the backing track into their own mic stream, so everyone hears voice and music together; the
// phone also stamps the song position into the stream (Zego SEI) so listeners' lyrics follow what they hear. The state
// goes to the whole room on "karaoke:state" (nothing in it is secret) and is in the room snapshot.
//
// shortcut: state lives in memory (written through to rooms.karaoke) with one in-process clock, so this is only
// correct with one server instance; move the clock to a shared scheduler before scaling out.

export const entrySchema = z.object({ entryId: z.string().uuid() });
export const progressSchema = z.object({ entryId: z.string().uuid(), ms: z.number().int().min(0).max(3_600_000), playing: z.boolean() });

const games = new Map<string, KaraokeState>();
const queues = new Map<string, Promise<unknown>>();
function serial<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(roomId) ?? Promise.resolve()).then(fn, fn);
  queues.set(roomId, run.catch(() => {}));
  return run;
}

async function load(roomId: string) {
  if (games.has(roomId)) return games.get(roomId)!;
  const room = await getRoom(roomId);
  if (room.karaoke) games.set(roomId, room.karaoke);
  return room.karaoke;
}

async function save(roomId: string, s: KaraokeState | null) {
  const before = games.get(roomId)?.current?.id;
  await db.update(rooms).set({ karaoke: s }).where(eq(rooms.id, roomId));
  if (s) games.set(roomId, s);
  else games.delete(roomId);
  emitToRoom(roomId, "karaoke:state", { roomId, state: s });
  const c = s?.current;
  if (c && c.id !== before) await systemMessage(roomId, `🎤 Now singing: ${c.displayName ?? "Someone"} · ${c.title}${c.artist ? ` (${c.artist})` : ""}`, { kind: "KARAOKE", userId: c.userId });
  return s;
}

const need = async (roomId: string) => {
  const s = await load(roomId);
  if (!s) throw new AppError("KARAOKE_OFF", 409, "Karaoke isn't on in this room");
  return s;
};

const seatedIds = async (roomId: string) => new Set((await getSeats(roomId)).flatMap((x) => (x.occupant?.userId ? [x.occupant.userId] : [])));
const isAdmin = (roomId: string, userId: string) => assertRoomAdmin(roomId, userId).then(() => true, () => false);

function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RuleError) throw new AppError("KARAOKE_NOT_ALLOWED", 409, e.message);
    throw e;
  }
}

export async function setMode(actor: User, roomId: string, on: boolean) {
  await assertRoomAdmin(roomId, actor.id);
  const room = await getRoom(roomId);
  if (room.kind === "LIVE") throw new AppError("KARAOKE_NOT_IN_LIVE", 400, "Karaoke is for audio rooms");
  if (on && room.ludo) throw new AppError("LUDO_ON", 409, "Turn off Ludo first");
  if (on && room.pool) throw new AppError("POOL_ON", 409, "Turn off 8 Ball Pool first");
  if (on && room.draw) throw new AppError("DRAW_ON", 409, "Turn off Draw & Guess first");
  if (on && room.mafia) throw new AppError("MAFIA_ON", 409, "Turn off Mafia first");
  if (on && room.video) throw new AppError("VIDEO_ON", 409, "Turn off Video mode first");
  const changed = await serial(roomId, async () => {
    const cur = await load(roomId);
    if (!!cur === on) return false;
    await save(roomId, on ? emptyState() : null);
    return true;
  });
  if (changed) await systemMessage(roomId, on ? `${actor.displayName} switched the room to Karaoke. Take a seat and pick a song!` : `${actor.displayName} turned Karaoke off`, { kind: "KARAOKE", userId: actor.id });
  return { on };
}

// Queue a song from the library (seated people only).
export async function queueSong(user: User, roomId: string, songId: string) {
  await assertMember(roomId, user.id);
  const song = await getSong(songId);
  const [me] = await db.select({ displayName: userSummary.displayName, avatarUrl: userSummary.avatarUrl }).from(users).where(eq(users.id, user.id));
  return serial(roomId, async () => {
    const s = await need(roomId);
    if (!(await seatedIds(roomId)).has(user.id)) throw new AppError("KARAOKE_SEAT_REQUIRED", 403, "Take a seat to sing");
    const entry = { id: randomUUID(), userId: user.id, displayName: me!.displayName, avatarUrl: me!.avatarUrl, songId: song.id, title: song.title, artist: song.artist, cover: song.cover ? `/v1/uploads/${song.cover}` : null, durationMs: songLength(song) };
    return save(roomId, rule(() => addEntry(s, entry, Date.now())));
  });
}

// The singer's phone has the track playing: count the play and start the turn's clock.
export const started = (user: User, roomId: string, entryId: string) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    const n = rule(() => startTurn(s, user.id, entryId, Date.now()));
    if (n === s) return s;
    await db.update(songs).set({ plays: sql`${songs.plays} + 1` }).where(eq(songs.id, n.current!.songId));
    return save(roomId, n);
  });

// "done": the song ended on the singer's phone. "skip": the singer or a room admin stops it early.
export async function finish(user: User, roomId: string, entryId: string) {
  const force = await isAdmin(roomId, user.id);
  return serial(roomId, async () => {
    const s = await need(roomId);
    const n = rule(() => finishTurn(s, user.id, entryId, Date.now(), force));
    return n === s ? s : save(roomId, n);
  });
}

export async function remove(user: User, roomId: string, entryId: string) {
  const force = await isAdmin(roomId, user.id);
  return serial(roomId, async () => {
    const s = await need(roomId);
    const n = rule(() => removeEntry(s, user.id, entryId, force));
    return n === s ? s : save(roomId, n);
  });
}

// The singer's song position, passed straight on (never stored): the lyrics' fallback clock for phones that don't get
// the in-stream position.
export async function progress(user: User, roomId: string, p: z.infer<typeof progressSchema>) {
  const c = games.get(roomId)?.current;
  if (!c || c.id !== p.entryId || c.userId !== user.id) return null; // stale: quietly ignored
  io.to(roomChannel(roomId)).volatile.emit("karaoke:progress", { roomId, ...p });
  return null;
}

// ---------- the clock ----------

const check = (roomId: string, now: number, seats: boolean) =>
  serial(roomId, async () => {
    const s = games.get(roomId);
    if (!s) return;
    let n = timeout(s, now);
    if (seats && (n.current || n.queue.length)) n = dropUnseated(n, await seatedIds(roomId), now);
    if (n !== s) await save(roomId, n);
  });

let ticks = 0;
export async function tick(now = Date.now()) {
  const seats = ++ticks % 6 === 0; // seats every 3 s: a database read, the deadline is free
  for (const [roomId, s] of games) {
    if (s.current && (seats || Date.parse(s.current.deadline) <= now)) await check(roomId, now, seats).catch(toSafeError);
  }
}

// On boot: every room left in Karaoke mode; a song in progress gets a fresh chance to start (the phones reconnect).
export async function runKaraokeLoop() {
  for (const r of await db.select({ id: rooms.id, karaoke: rooms.karaoke }).from(rooms).where(isNotNull(rooms.karaoke))) {
    const s = r.karaoke!;
    games.set(r.id, s.current ? { ...s, current: { ...s.current, deadline: new Date(Date.now() + s.current.durationMs + 120_000).toISOString() } } : s);
  }
  setInterval(() => tick().catch(toSafeError), 500);
}
