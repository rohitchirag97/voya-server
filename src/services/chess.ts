import { eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { rooms, users, type User } from "../db/schema";
import { emitToRoom, io } from "../io";
import { AppError, toSafeError } from "../lib/errors";
import { CLOCK_MS, lobbyState, move as playMove, offerDraw, PLAYERS, resign, RuleError, startGame, timeout, type ChessState } from "../lib/chess";
import { assertCanModerateIn, assertMember, assertRoomAdmin, getRoom, getSeats, systemMessage, userSummary } from "./rooms";

// Chess mode for a room, run like 8 Ball Pool mode: the owner/admins switch it on, two seated people join, the
// owner/admins start. The server checks every move (lib/chess.ts); everyone in the room watches on `chess:<roomId>`.
//
// shortcut: games live in memory (written through to rooms.chess) with one in-process clock, so this is only correct
// with one server instance; move the clock to a shared scheduler before scaling out.

export const channel = (roomId: string) => `chess:${roomId}`;
const square = z.string().regex(/^[a-h][1-8]$/);
export const moveSchema = z.object({ from: square, to: square, promotion: z.enum(["q", "r", "b", "n"]).optional() });

const games = new Map<string, ChessState>();
const queues = new Map<string, Promise<unknown>>();
function serial<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(roomId) ?? Promise.resolve()).then(fn, fn);
  queues.set(roomId, run.catch(() => {}));
  return run;
}

const view = (roomId: string, s: ChessState | null) => ({ roomId, state: s, serverNow: new Date() });

async function load(roomId: string) {
  if (games.has(roomId)) return games.get(roomId)!;
  const room = await getRoom(roomId);
  if (room.chess) games.set(roomId, room.chess);
  return room.chess;
}

const RESULT: Record<string, string> = { CHECKMATE: "by checkmate", RESIGN: "by resignation", TIMEOUT: "on time", LEFT: "(the other player left)" };
const DRAW: Record<string, string> = { STALEMATE: "stalemate", REPETITION: "repetition", FIFTY_MOVES: "the 50-move rule", MATERIAL: "not enough pieces to mate", AGREED: "agreement" };

async function save(roomId: string, s: ChessState | null) {
  const before = games.get(roomId);
  await db.update(rooms).set({ chess: s }).where(eq(rooms.id, roomId));
  if (s) games.set(roomId, s);
  else games.delete(roomId);
  io.to(channel(roomId)).emit("chess:state", view(roomId, s));
  if (s?.phase === "finished" && before?.phase === "playing") {
    const w = s.players.find((p) => p.userId === s.winner);
    await systemMessage(roomId, w ? `♟️ ${w.displayName ?? "Someone"} won the chess game ${RESULT[s.reason!] ?? ""}!` : `♟️ The chess game is a draw by ${DRAW[s.reason!] ?? "agreement"}.`, { kind: "CHESS", userId: s.winner });
  }
  return s;
}

const need = async (roomId: string) => {
  const s = await load(roomId);
  if (!s) throw new AppError("CHESS_OFF", 409, "Chess isn't on in this room");
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
    if (e instanceof RuleError) throw new AppError("CHESS_NOT_ALLOWED", 409, e.message);
    throw e;
  }
}

// ---------- mode, lobby, start ----------

export async function setMode(actor: User, roomId: string, on: boolean) {
  await assertRoomAdmin(roomId, actor.id);
  const room = await getRoom(roomId);
  if (room.kind === "LIVE") throw new AppError("CHESS_NOT_IN_LIVE", 400, "Chess is for audio rooms");
  if (on && room.ludo) throw new AppError("LUDO_ON", 409, "Turn off Ludo first");
  if (on && room.carrom) throw new AppError("CARROM_ON", 409, "Turn off Carrom first");
  if (on && room.wheel) throw new AppError("WHEEL_ON", 409, "Turn off the Wheel first");
  if (on && room.pool) throw new AppError("POOL_ON", 409, "Turn off 8 Ball Pool first");
  if (on && room.draw) throw new AppError("DRAW_ON", 409, "Turn off Draw & Guess first");
  if (on && room.mafia) throw new AppError("MAFIA_ON", 409, "Turn off Mafia first");
  if (on && room.karaoke) throw new AppError("KARAOKE_ON", 409, "Turn off Karaoke first");
  if (on && room.video) throw new AppError("VIDEO_ON", 409, "Turn off Video mode first");
  const changed = await serial(roomId, async () => {
    const cur = await load(roomId);
    if (!!cur === on) return false;
    await save(roomId, on ? lobbyState() : null);
    return true;
  });
  if (changed) {
    emitToRoom(roomId, "room:chess", { roomId, on });
    await systemMessage(roomId, on ? `${actor.displayName} switched the room to Chess. Take a seat and join the game!` : `${actor.displayName} turned Chess off`, { kind: "CHESS", userId: actor.id });
  }
  return { on };
}

export async function watch(user: User, roomId: string) {
  await assertMember(roomId, user.id);
  const admin = await assertRoomAdmin(roomId, user.id).then(() => true, () => false);
  return { ...view(roomId, await load(roomId)), me: { userId: user.id, admin }, clockMs: CLOCK_MS };
}

export const join = (user: User, roomId: string) =>
  serial(roomId, async () => {
    let s = await need(roomId);
    if (s.phase === "playing") throw new AppError("CHESS_IN_PROGRESS", 409, "A game is being played. Join the next one.");
    if (s.phase === "finished") s = lobbyState(s.v); // the first join after a game opens the next lobby
    if (!(await seatedIds(roomId)).has(user.id)) throw new AppError("CHESS_SEAT_REQUIRED", 403, "Take a seat to play");
    if (s.lobby.some((p) => p.userId === user.id)) return s;
    if (s.lobby.length >= PLAYERS) throw new AppError("CHESS_FULL", 409, "This game already has 2 players");
    return save(roomId, { ...s, v: s.v + 1, lobby: [...s.lobby, await person(user.id)] });
  });

// Before the start: leave the lobby. During a game: resign.
export const leave = (user: User, roomId: string) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    if (s.phase === "playing") return save(roomId, resign(s, user.id));
    if (s.phase !== "lobby" || !s.lobby.some((p) => p.userId === user.id)) return s;
    return save(roomId, { ...s, v: s.v + 1, lobby: s.lobby.filter((p) => p.userId !== user.id) });
  });

export async function removeFromLobby(actor: User, roomId: string, userId: string) {
  await assertCanModerateIn(roomId, actor.id, userId);
  return serial(roomId, async () => {
    const s = await need(roomId);
    if (s.phase !== "lobby") throw new AppError("CHESS_NOT_LOBBY", 409, "Players can only be removed before the game starts");
    if (!s.lobby.some((p) => p.userId === userId)) return s;
    return save(roomId, { ...s, v: s.v + 1, lobby: s.lobby.filter((p) => p.userId !== userId) });
  });
}

export async function start(actor: User, roomId: string) {
  await assertRoomAdmin(roomId, actor.id);
  const s = await serial(roomId, async () => {
    const cur = await need(roomId);
    if (cur.phase !== "lobby") throw new AppError("CHESS_NOT_READY", 409, "Open a new lobby first");
    const seated = await seatedIds(roomId);
    const people = cur.lobby.filter((p) => seated.has(p.userId));
    if (people.length < PLAYERS) throw new AppError("CHESS_NEED_PLAYERS", 409, "2 seated players must join");
    return save(roomId, startGame(cur, people, Date.now()));
  });
  await systemMessage(roomId, `♟️ Chess started: ${s!.players[0]!.displayName} (white) vs ${s!.players[1]!.displayName} (black)`, { kind: "CHESS", userId: actor.id });
  return s;
}

// ---------- play ----------

export const move = (user: User, roomId: string, m: z.infer<typeof moveSchema>) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    return save(roomId, rule(() => playMove(s, user.id, m, Date.now())));
  });

export const draw = (user: User, roomId: string) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    const n = rule(() => offerDraw(s, user.id));
    return n === s ? s : save(roomId, n);
  });

// ---------- the clock ----------

// A flag fell, or a player left their seat (they lose).
const check = (roomId: string, now: number, seats: boolean) =>
  serial(roomId, async () => {
    const s = games.get(roomId);
    if (!s || s.phase !== "playing") return;
    const t = timeout(s, now);
    if (t !== s) return save(roomId, t);
    if (!seats) return;
    const seated = await seatedIds(roomId);
    const gone = s.players.find((p) => !seated.has(p.userId));
    if (gone) return save(roomId, resign(s, gone.userId, "LEFT"));
  });

let ticks = 0;
export async function tick(now = Date.now()) {
  const seats = ++ticks % 6 === 0; // seats every 3 s: a database read
  for (const [roomId, s] of games) if (s.phase === "playing") await check(roomId, now, seats).catch(toSafeError);
}

// On boot: every room left in Chess mode; a running game's clock restarts from now (the downtime isn't charged).
export async function runChessLoop() {
  for (const r of await db.select({ id: rooms.id, chess: rooms.chess }).from(rooms).where(isNotNull(rooms.chess))) {
    const s = r.chess!;
    games.set(r.id, s.phase === "playing" ? { ...s, turnAt: new Date().toISOString() } : s);
  }
  setInterval(() => tick().catch(toSafeError), 500);
}
