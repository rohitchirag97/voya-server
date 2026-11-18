import { eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { rooms, users, type User } from "../db/schema";
import { emitToRoom, io } from "../io";
import { AppError, toSafeError } from "../lib/errors";
import { drawerOf, endTurn, guess as judge, lobbyState, MAX_PLAYERS, MIN_PLAYERS, publicView, removePlayer, startGame, TURN_MS, type DrawState } from "../lib/draw";
import { assertCanModerateIn, assertMember, assertRoomAdmin, getRoom, getSeats, systemMessage, userSummary } from "./rooms";

// Draw & Guess mode for a room, run like 8 Ball Pool mode: owner/admins switch it on, seated people join, the
// owner/admins start. The drawer's strokes are relayed on the `draw:<roomId>` channel and kept in memory for the turn
// (so late watchers see the picture); guesses are room chat, judged in chat.ts before a message is posted.
//
// shortcut: games and strokes live in memory (state written through to rooms.draw; strokes are not) with one
// in-process clock, so this is only correct with one server instance; move both to shared storage before scaling out.

export const channel = (roomId: string) => `draw:${roomId}`;

const coord = z.number().min(0).max(1);
// Part of one stroke: its id, colour and width, and more points as flat [x, y, x, y, ...] in 0..1 of the canvas.
export const strokeSchema = z.object({
  id: z.string().min(1).max(40),
  c: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  w: z.number().min(1).max(40),
  pts: z.array(coord).min(2).max(400),
});
type Stroke = z.infer<typeof strokeSchema>;
const MAX_POINTS = 40_000; // per turn: plenty for a sketch, small enough to resend to a late watcher

const games = new Map<string, DrawState>();
const strokes = new Map<string, Stroke[]>(); // this turn's picture, by room

const queues = new Map<string, Promise<unknown>>();
function serial<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(roomId) ?? Promise.resolve()).then(fn, fn);
  queues.set(roomId, run.catch(() => {}));
  return run;
}

const view = (roomId: string, s: DrawState | null) => ({ roomId, state: publicView(s), serverNow: new Date() });

async function load(roomId: string) {
  if (games.has(roomId)) return games.get(roomId)!;
  const room = await getRoom(roomId);
  if (room.draw) games.set(roomId, room.draw);
  return room.draw;
}

async function save(roomId: string, s: DrawState | null) {
  const before = games.get(roomId);
  await db.update(rooms).set({ draw: s }).where(eq(rooms.id, roomId));
  if (s) games.set(roomId, s);
  else games.delete(roomId);
  if (!s || before?.turn !== s.turn || before?.phase !== s.phase) strokes.delete(roomId); // a new turn: a clean canvas
  io.to(channel(roomId)).emit("draw:state", view(roomId, s));
  if (s?.phase === "finished" && before?.phase === "playing") await announce(roomId, s);
  return s;
}

async function announce(roomId: string, s: DrawState) {
  const top = Math.max(...s.players.map((p) => p.score));
  const winners = s.players.filter((p) => p.score === top).map((p) => p.displayName ?? "Someone");
  await systemMessage(roomId, `🎨 Draw & Guess: ${winners.join(" & ")} won with ${top} points!`, { kind: "DRAW", userId: null });
}

const need = async (roomId: string) => {
  const s = await load(roomId);
  if (!s) throw new AppError("DRAW_OFF", 409, "Draw & Guess isn't on in this room");
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
  if (room.kind === "LIVE") throw new AppError("DRAW_NOT_IN_LIVE", 400, "Draw & Guess is for audio rooms");
  if (on && room.ludo) throw new AppError("LUDO_ON", 409, "Turn off Ludo first");
  if (on && room.carrom) throw new AppError("CARROM_ON", 409, "Turn off Carrom first");
  if (on && room.wheel) throw new AppError("WHEEL_ON", 409, "Turn off the Wheel first");
  if (on && room.chess) throw new AppError("CHESS_ON", 409, "Turn off Chess first");
  if (on && room.karaoke) throw new AppError("KARAOKE_ON", 409, "Turn off Karaoke first");
  if (on && room.mafia) throw new AppError("MAFIA_ON", 409, "Turn off Mafia first");
  if (on && room.pool) throw new AppError("POOL_ON", 409, "Turn off 8 Ball Pool first");
  if (on && room.video) throw new AppError("VIDEO_ON", 409, "Turn off Video mode first");
  const changed = await serial(roomId, async () => {
    const cur = await load(roomId);
    if (!!cur === on) return false;
    await save(roomId, on ? lobbyState() : null);
    return true;
  });
  if (changed) {
    emitToRoom(roomId, "room:draw", { roomId, on });
    await systemMessage(roomId, on ? `${actor.displayName} switched the room to Draw & Guess. Take a seat and join the game!` : `${actor.displayName} turned Draw & Guess off`, { kind: "DRAW", userId: actor.id });
  }
  return { on };
}

// The canvas page: the state, this turn's strokes so far, who is looking (admin: shows Start), and the word if they draw.
export async function watch(user: User, roomId: string) {
  await assertMember(roomId, user.id);
  const admin = await assertRoomAdmin(roomId, user.id).then(() => true, () => false);
  const s = await load(roomId);
  return { ...view(roomId, s), me: { userId: user.id, admin }, turnMs: TURN_MS, strokes: strokes.get(roomId) ?? [], word: wordFor(s, user.id) };
}

const wordFor = (s: DrawState | null, userId: string) => (s && drawerOf(s)?.userId === userId ? s.word : null);
// The drawer's page asks for the word on each new turn (it never goes out on the shared channel).
export async function myWord(user: User, roomId: string) {
  await assertMember(roomId, user.id);
  return { word: wordFor(await need(roomId), user.id) };
}

export const join = (user: User, roomId: string) =>
  serial(roomId, async () => {
    let s = await need(roomId);
    if (s.phase === "playing") throw new AppError("DRAW_IN_PROGRESS", 409, "A game is being played. Join the next one.");
    if (s.phase === "finished") s = lobbyState(s.v); // the first join after a game opens the next lobby
    if (!(await seatedIds(roomId)).has(user.id)) throw new AppError("DRAW_SEAT_REQUIRED", 403, "Take a seat to play");
    if (s.lobby.some((p) => p.userId === user.id)) return s;
    if (s.lobby.length >= MAX_PLAYERS) throw new AppError("DRAW_FULL", 409, `This game already has ${MAX_PLAYERS} players`);
    return save(roomId, { ...s, v: s.v + 1, lobby: [...s.lobby, await person(user.id)] });
  });

// Before the start: leave the lobby. During a game: leave the scoreboard (see removePlayer).
export const leave = (user: User, roomId: string) =>
  serial(roomId, async () => {
    const s = await need(roomId);
    if (s.phase === "playing") return save(roomId, removePlayer(s, user.id, Date.now()));
    if (s.phase !== "lobby" || !s.lobby.some((p) => p.userId === user.id)) return s;
    return save(roomId, { ...s, v: s.v + 1, lobby: s.lobby.filter((p) => p.userId !== user.id) });
  });

export async function removeFromLobby(actor: User, roomId: string, userId: string) {
  await assertCanModerateIn(roomId, actor.id, userId);
  return serial(roomId, async () => {
    const s = await need(roomId);
    if (s.phase !== "lobby") throw new AppError("DRAW_NOT_LOBBY", 409, "Players can only be removed before the game starts");
    if (!s.lobby.some((p) => p.userId === userId)) return s;
    return save(roomId, { ...s, v: s.v + 1, lobby: s.lobby.filter((p) => p.userId !== userId) });
  });
}

export async function start(actor: User, roomId: string) {
  await assertRoomAdmin(roomId, actor.id);
  const s = await serial(roomId, async () => {
    const cur = await need(roomId);
    if (cur.phase !== "lobby") throw new AppError("DRAW_NOT_READY", 409, "Open a new lobby first");
    const seated = await seatedIds(roomId);
    const people = cur.lobby.filter((p) => seated.has(p.userId));
    if (people.length < MIN_PLAYERS) throw new AppError("DRAW_NEED_PLAYERS", 409, `${MIN_PLAYERS} seated players must join`);
    return save(roomId, startGame(cur, people, Date.now()));
  });
  await systemMessage(roomId, `🎨 Draw & Guess started: ${s!.players.map((p) => p.displayName).join(", ")}. Type your guesses in chat!`, { kind: "DRAW", userId: actor.id });
  return s;
}

// ---------- drawing ----------

function assertDrawing(s: DrawState | undefined, userId: string): asserts s is DrawState {
  if (!s || s.phase !== "playing" || drawerOf(s)!.userId !== userId) throw new AppError("DRAW_NOT_YOUR_TURN", 409, "It's not your turn to draw");
  if (Date.parse(s.startsAt!) > Date.now()) throw new AppError("DRAW_NOT_YET", 409, "Wait for your turn to start");
}

export async function stroke(user: User, roomId: string, p: Stroke) {
  const s = games.get(roomId);
  assertDrawing(s, user.id);
  if (p.pts.length % 2) throw new AppError("DRAW_BAD_STROKE", 400);
  const pic = strokes.get(roomId) ?? [];
  if (pic.reduce((n, x) => n + x.pts.length, 0) + p.pts.length > MAX_POINTS) throw new AppError("DRAW_FULL_CANVAS", 409, "The canvas is full. Clear it to keep drawing.");
  const cur = pic.find((x) => x.id === p.id);
  if (cur) cur.pts.push(...p.pts);
  else pic.push({ ...p, pts: [...p.pts] });
  strokes.set(roomId, pic);
  io.to(channel(roomId)).emit("draw:stroke", { roomId, turn: s.turn, ...p });
  return null;
}

// clear: wipe the canvas; undo: drop the last stroke. Both resend the whole picture.
export async function edit(user: User, roomId: string, what: "clear" | "undo") {
  const s = games.get(roomId);
  assertDrawing(s, user.id);
  const pic = what === "clear" ? [] : (strokes.get(roomId) ?? []).slice(0, -1);
  strokes.set(roomId, pic);
  io.to(channel(roomId)).emit("draw:picture", { roomId, turn: s.turn, strokes: pic });
  return null;
}

// ---------- guessing (from room chat) ----------

// Called by sendChat before posting. "hit": post "guessed the word" instead of the text; "spoiler": refuse the message.
// Only rooms with a running game do any work here; everyone else's chat is untouched.
export async function guess(user: User, roomId: string, text: string): Promise<"hit" | "spoiler" | "none"> {
  if (games.get(roomId)?.phase !== "playing") return "none";
  return serial(roomId, async () => {
    const s = games.get(roomId);
    if (!s) return "none";
    const r = judge(s, user.id, text, Date.now());
    if (r.result === "spoiler") throw new AppError("DRAW_NO_SPOILERS", 409, "No giving away the word!");
    if (r.state !== s) await save(roomId, r.state);
    return r.result;
  });
}

// ---------- the clock ----------

// A turn ran out, or the drawer left their seat: on to the next turn.
const expire = (roomId: string, now: number) =>
  serial(roomId, async () => {
    const s = games.get(roomId);
    if (!s || s.phase !== "playing") return;
    const drawer = drawerOf(s)!.userId;
    if (Date.parse(s.deadline!) <= now) return save(roomId, endTurn(s, now));
    if (!(await seatedIds(roomId)).has(drawer)) return save(roomId, removePlayer(s, drawer, now));
  });

let checks = 0;
export async function tick(now = Date.now()) {
  const seatCheck = ++checks % 6 === 0; // seats every 3 s: a database read, the deadline is free
  for (const [roomId, s] of games) {
    if (s.phase === "playing" && (seatCheck || Date.parse(s.deadline!) <= now)) await expire(roomId, now).catch(toSafeError);
  }
}

// On boot: every room left in Draw & Guess mode; a running turn starts over with a fresh clock (its strokes are gone).
export async function runDrawLoop() {
  for (const r of await db.select({ id: rooms.id, draw: rooms.draw }).from(rooms).where(isNotNull(rooms.draw))) {
    const s = r.draw!;
    games.set(r.id, s.phase === "playing" ? { ...s, startsAt: new Date().toISOString(), deadline: new Date(Date.now() + TURN_MS).toISOString() } : s);
  }
  setInterval(() => tick().catch(toSafeError), 500);
}
