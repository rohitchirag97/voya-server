import { eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { rooms, users, type User } from "../db/schema";
import { emitToRoom, io } from "../io";
import { AppError, toSafeError } from "../lib/errors";
import { canPlace, forfeit, lobbyState, PLAYERS, startGame, takeShot, timeout, type PoolState } from "../lib/pool";
import { assertCanModerateIn, assertMember, assertRoomAdmin, getRoom, getSeats, systemMessage, userSummary } from "./rooms";

// 8 Ball Pool mode for a room, run like Ludo mode: the owner/admins switch it on, two seated people join, the
// owner/admins start. The server simulates every shot (lib/pool.ts + the shared physics) and decides the outcome;
// phones send only where they aim and how hard, and replay the shot they get back.
// Everyone in the room watches on the `pool:<roomId>` channel, including the shooter's aim as it moves.
//
// shortcut: games live in memory (written through to rooms.pool on every change) with one in-process clock, so this
// is only correct with one server instance; move the clock to a shared scheduler before scaling out.

export const TURN_MS = Number(process.env.POOL_TURN_MS ?? 30_000);
export const channel = (roomId: string) => `pool:${roomId}`;

const finite = z.number().finite();
const spot = z.object({ x: finite, y: finite });
export const shotSchema = z.object({ dx: finite, dy: finite, power: z.number().min(0).max(1), sx: z.number().min(-1).max(1), sy: z.number().min(-1).max(1), cue: spot.optional() });
// The shooter's aim while they line up, passed straight on to the watchers (never stored).
export const aimSchema = z.object({ dx: finite, dy: finite, power: z.number().min(0).max(1), cue: spot.optional() });

const games = new Map<string, PoolState>(); // rooms in Pool mode -> current state (mirror of rooms.pool)

// One action per room at a time, in arrival order.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(roomId) ?? Promise.resolve()).then(fn, fn);
  queues.set(roomId, run.catch(() => {}));
  return run;
}

export const view = (roomId: string, s: PoolState | null) => ({ roomId, state: s, serverNow: new Date() });

async function load(roomId: string) {
  if (games.has(roomId)) return games.get(roomId)!;
  const room = await getRoom(roomId);
  if (room.pool) games.set(roomId, room.pool);
  return room.pool;
}

async function save(roomId: string, s: PoolState | null) {
  await db.update(rooms).set({ pool: s }).where(eq(rooms.id, roomId));
  if (s) games.set(roomId, s);
  else games.delete(roomId);
  io.to(channel(roomId)).emit("pool:state", view(roomId, s));
  return s;
}

const need = async (roomId: string) => {
  const s = await load(roomId);
  if (!s) throw new AppError("POOL_OFF", 409, "8 Ball Pool isn't on in this room");
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
  const room = await getRoom(roomId);
  if (room.kind === "LIVE") throw new AppError("POOL_NOT_IN_LIVE", 400, "8 Ball Pool is for audio rooms");
  if (on && room.ludo) throw new AppError("LUDO_ON", 409, "Turn off Ludo first");
  if (on && room.video) throw new AppError("VIDEO_ON", 409, "Turn off Video mode first");
  const changed = await serial(roomId, async () => {
    const cur = await load(roomId);
    if (!!cur === on) return false;
    await save(roomId, on ? lobbyState() : null);
    return true;
  });
  if (changed) {
    emitToRoom(roomId, "room:pool", { roomId, on });
    await systemMessage(roomId, on ? `${actor.displayName} switched the room to 8 Ball Pool. Take a seat and join the game!` : `${actor.displayName} turned 8 Ball Pool off`, { kind: "POOL", userId: actor.id });
  }
  return { on };
}

// The table page: the current state (and from then on every change on the channel), plus who is looking, so it
// shows Start only to the owner/admins. The server still checks every action.
export async function watch(user: User, roomId: string) {
  await assertMember(roomId, user.id);
  const admin = await assertRoomAdmin(roomId, user.id).then(() => true, () => false);
  return { ...view(roomId, await load(roomId)), me: { userId: user.id, admin }, turnMs: TURN_MS };
}

export const join = (user: User, roomId: string) =>
  serial(roomId, async () => {
    let s = await need(roomId);
    if (s.phase === "playing") throw new AppError("POOL_IN_PROGRESS", 409, "A game is being played. Join the next one.");
    if (s.phase === "finished") s = lobbyState(s.v); // the first join after a game opens the next lobby
    if (!(await seatedIds(roomId)).has(user.id)) throw new AppError("POOL_SEAT_REQUIRED", 403, "Take a seat to play");
    if (s.lobby.some((p) => p.userId === user.id)) return s;
    if (s.lobby.length >= PLAYERS) throw new AppError("POOL_FULL", 409, "This game already has 2 players");
    return save(roomId, { ...s, v: s.v + 1, lobby: [...s.lobby, await person(user.id)] });
  });

// Before the start: leave the lobby. During a game: resign, and the other player wins.
export const leave = (user: User, roomId: string) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    if (s.phase === "playing" && s.players.some((p) => p.userId === user.id)) return finish(roomId, forfeit(s, user.id));
    if (s.phase !== "lobby" || !s.lobby.some((p) => p.userId === user.id)) return s;
    return save(roomId, { ...s, v: s.v + 1, lobby: s.lobby.filter((p) => p.userId !== user.id) });
  });

// The owner/admins take someone out of the lobby (same rules as any room moderation).
export async function removeFromLobby(actor: User, roomId: string, userId: string) {
  await assertCanModerateIn(roomId, actor.id, userId);
  return serial(roomId, async () => {
    const s = await need(roomId);
    if (s.phase !== "lobby") throw new AppError("POOL_NOT_LOBBY", 409, "Players can only be removed before the game starts");
    if (!s.lobby.some((p) => p.userId === userId)) return s;
    return save(roomId, { ...s, v: s.v + 1, lobby: s.lobby.filter((p) => p.userId !== userId) });
  });
}

const clock = (s: PoolState, readyAt: number) => ({ ...s, readyAt: new Date(readyAt).toISOString(), deadline: new Date(readyAt + TURN_MS).toISOString() });

export async function start(actor: User, roomId: string) {
  await assertRoomAdmin(roomId, actor.id);
  const s = await serial(roomId, async () => {
    const cur = await need(roomId);
    if (cur.phase !== "lobby") throw new AppError("POOL_NOT_READY", 409, "Open a new lobby first");
    const seated = await seatedIds(roomId);
    const people = cur.lobby.filter((p) => seated.has(p.userId)); // anyone who left their seat since joining is out
    if (people.length < PLAYERS) throw new AppError("POOL_NEED_PLAYERS", 409, "2 seated players must join");
    return save(roomId, clock(startGame(cur, people), Date.now()));
  });
  await systemMessage(roomId, `8 Ball Pool started: ${s!.players.map((p) => p.displayName).join(" vs ")}`, { kind: "POOL", userId: actor.id });
  return s;
}

// ---------- shots ----------

function shooter(s: PoolState, userId: string) {
  if (s.phase !== "playing") throw new AppError("POOL_NOT_PLAYING", 409, "No game is running");
  if (s.players[s.turn]!.userId !== userId) throw new AppError("POOL_NOT_YOUR_TURN", 409, "It's not your turn");
}

export async function aim(user: User, roomId: string, a: z.infer<typeof aimSchema>) {
  const s = games.get(roomId);
  if (!s || s.phase !== "playing" || s.players[s.turn]!.userId !== user.id) return null; // stale: quietly ignored
  io.to(channel(roomId)).volatile.emit("pool:aim", { roomId, userId: user.id, v: s.v, ...a });
  return null;
}

export const shoot = (user: User, roomId: string, p: z.infer<typeof shotSchema>) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    shooter(s, user.id);
    if (s.readyAt && Date.parse(s.readyAt) > Date.now() + 300) throw new AppError("POOL_BUSY", 409, "Wait for the balls to stop");
    if (p.cue && !canPlace(s, p.cue.x, p.cue.y)) throw new AppError("POOL_BAD_PLACE", 409, "The cue ball can't go there");
    let n: PoolState;
    try {
      n = takeShot(s, p, s.inHand ? p.cue : undefined);
    } catch {
      throw new AppError("POOL_BAD_SHOT", 400, "Aim somewhere first");
    }
    const ms = n.last?.kind === "shot" ? n.last.ms : 0;
    return n.phase === "finished" ? finish(roomId, n, ms) : save(roomId, clock(n, Date.now() + ms));
  });

// ms: how long the winning (or losing) shot rolls, so phones replay it before showing the result; 0 for a forfeit.
async function finish(roomId: string, s: PoolState, ms = 0) {
  await save(roomId, { ...s, readyAt: ms ? new Date(Date.now() + ms).toISOString() : null, deadline: null });
  const w = s.players.find((p) => p.userId === s.winner);
  await systemMessage(roomId, `🎱 ${w?.displayName ?? "Someone"} won the 8 Ball Pool game!`, { kind: "POOL", userId: s.winner });
  return s;
}

// The shot clock: a player who left their seat forfeits, one who ran out of time gives ball in hand.
const expire = (roomId: string, now: number) =>
  serial(roomId, async () => {
    const s = games.get(roomId);
    if (!s || s.phase !== "playing" || !s.deadline || Date.parse(s.deadline) > now) return;
    const cur = s.players[s.turn]!;
    if (!(await seatedIds(roomId)).has(cur.userId)) return finish(roomId, forfeit(s, cur.userId));
    await save(roomId, clock(timeout(s), now));
  });

// Exported so tests can run it with a chosen "now".
export async function tick(now = Date.now()) {
  for (const [roomId, s] of games) {
    if (s.phase === "playing" && s.deadline && Date.parse(s.deadline) <= now) await expire(roomId, now).catch(toSafeError);
  }
}

// On boot: pick up every room left in Pool mode; a running game gives the shooter a fresh clock.
export async function runPoolLoop() {
  for (const r of await db.select({ id: rooms.id, pool: rooms.pool }).from(rooms).where(isNotNull(rooms.pool))) {
    const s = r.pool!;
    games.set(r.id, s.phase === "playing" ? clock(s, Date.now()) : s);
  }
  setInterval(() => tick().catch(toSafeError), 500);
}
