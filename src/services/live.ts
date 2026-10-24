import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { giftTransactions, livePks, rooms, roomSeats, users, type User } from "../db/schema";
import { emitToRoom, io, userChannel } from "../io";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { clearCoHosts, createRoom, endRoom, getRoom, listRooms, systemMessage, userSummary } from "./rooms";

// ---------- live streams ----------
// A live stream is a room of kind LIVE with 4 seats: seat 0 = the host's camera, seats 1-3 = co-hosts (invited like
// stage seats). It's created on "Go live" and ends when the host stops or leaves.
export const startLive = (user: User, title: string) => createRoom(user, { title, seatCount: 4, kind: "LIVE", category: "Live" });

export async function endLive(user: User, roomId: string) {
  const room = await getRoom(roomId);
  if (room.kind !== "LIVE") throw new AppError("NOT_LIVE", 400);
  if (room.hostUserId !== user.id) throw new AppError("NOT_HOST", 403);
  await cancelOpenPks(roomId);
  return endRoom(roomId);
}

export const listLives = (cursor: string | undefined, limit: number) => listRooms(cursor, limit, "LIVE");

// ---------- live PK ----------
export const LIVE_PK_MINUTES = [3, 5, 10] as const;
const INVITE_TTL_MS = 30_000;
type LivePk = typeof livePks.$inferSelect;

async function assertLiveHost(user: User, roomId: string) {
  const room = await getRoom(roomId);
  if (room.kind !== "LIVE" || room.status !== "LIVE") throw new AppError("NOT_LIVE", 409, "That live stream has ended");
  if (room.hostUserId !== user.id) throw new AppError("NOT_HOST", 403, "Only the host can do that");
  return room;
}

// Invites nobody answered in time no longer block either room.
async function expireStaleInvites() {
  await db
    .update(livePks)
    .set({ status: "CANCELLED" })
    .where(and(eq(livePks.status, "INVITED"), lt(livePks.createdAt, sql`now() - ${`${INVITE_TTL_MS / 1000} seconds`}::interval`)));
}

const openPkOf = async (roomId: string) =>
  (
    await db
      .select()
      .from(livePks)
      .where(and(or(eq(livePks.roomA, roomId), eq(livePks.roomB, roomId)), inArray(livePks.status, ["INVITED", "ACTIVE"])))
      .limit(1)
  )[0] ?? null;

// A battle is running for this room right now.
export async function pkActive(roomId: string) {
  const pk = await openPkOf(roomId);
  return pk?.status === "ACTIVE" && !!pk.endsAt && pk.endsAt.getTime() > Date.now();
}

// Both sides: room title, host, the host's camera stream (each room plays the other's), and the gift score.
async function pkState(pk: LivePk) {
  const side = async (roomId: string) => {
    const room = await getRoom(roomId);
    const [host] = await db.select(userSummary).from(users).where(eq(users.id, room.hostUserId));
    const [seat] = await db.select({ streamId: roomSeats.streamId }).from(roomSeats).where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.seatIndex, 0)));
    const [s] = pk.startedAt
      ? await db
          .select({ score: sql<number>`coalesce(sum(${giftTransactions.coinsDebited}), 0)`.mapWith(Number) })
          .from(giftTransactions)
          .where(and(eq(giftTransactions.roomId, roomId), gte(giftTransactions.createdAt, pk.startedAt), lt(giftTransactions.createdAt, pk.endsAt!)))
      : [{ score: 0 }];
    return { roomId, title: room.title, host: host!, streamId: seat?.streamId ?? null, score: s!.score };
  };
  const [a, b] = await Promise.all([side(pk.roomA), side(pk.roomB)]);
  return { pkId: pk.id, status: pk.status, minutes: pk.minutes, startedAt: pk.startedAt, endsAt: pk.endsAt, a, b };
}
const emitPk = (pk: LivePk, payload: unknown) => {
  emitToRoom(pk.roomA, "live:pk", payload);
  emitToRoom(pk.roomB, "live:pk", payload);
};

export async function invitePk(user: User, roomId: string, targetRoomId: string, minutes: (typeof LIVE_PK_MINUTES)[number]) {
  if (roomId === targetRoomId) throw new AppError("PK_SAME_ROOM", 400, "Pick another live stream");
  rateLimit(`livepk:invite:${user.id}`, 10, 60_000);
  const room = await assertLiveHost(user, roomId);
  const target = await getRoom(targetRoomId);
  if (target.kind !== "LIVE" || target.status !== "LIVE") throw new AppError("NOT_LIVE", 409, "That live stream has ended");
  await expireStaleInvites();
  const [pk] = await db
    .insert(livePks)
    .values({ roomA: roomId, roomB: targetRoomId, minutes })
    .returning()
    .catch((e) => {
      throw e?.cause?.code === "23505" || e?.code === "23505" ? new AppError("PK_BUSY", 409, "One of you is already in a PK") : e;
    });
  const [host] = await db.select(userSummary).from(users).where(eq(users.id, user.id));
  io.to(userChannel(target.hostUserId)).emit("live:pk:invite", { pkId: pk!.id, minutes, from: { roomId, title: room.title, host }, expiresInMs: INVITE_TTL_MS });
  return { pkId: pk!.id };
}

async function invitedPk(user: User, pkId: string) {
  const [pk] = await db.select().from(livePks).where(eq(livePks.id, pkId));
  if (!pk) throw new AppError("PK_NOT_FOUND", 404);
  await assertLiveHost(user, pk.roomB);
  if (pk.status !== "INVITED" || Date.now() - pk.createdAt.getTime() > INVITE_TTL_MS) throw new AppError("PK_INVITE_EXPIRED", 409, "This PK invite has expired");
  return pk;
}

export async function acceptPk(user: User, pkId: string) {
  const pk = await invitedPk(user, pkId);
  await getRoom(pk.roomA).then((r) => {
    if (r.status !== "LIVE") throw new AppError("NOT_LIVE", 409, "That live stream has ended");
  });
  // Times from the database clock, the same one that stamps gifts.
  const [active] = await db
    .update(livePks)
    .set({ status: "ACTIVE", startedAt: sql`now()`, endsAt: sql`now() + ${`${pk.minutes} minutes`}::interval` })
    .where(and(eq(livePks.id, pkId), eq(livePks.status, "INVITED")))
    .returning();
  if (!active) throw new AppError("PK_INVITE_EXPIRED", 409, "This PK invite has expired");
  // Host vs host: co-hosts in both rooms step off for the battle.
  await Promise.all([clearCoHosts(active.roomA), clearCoHosts(active.roomB)]);
  const state = await pkState(active);
  emitPk(active, { pk: state });
  const text = `PK started: ${state.a.host.displayName} vs ${state.b.host.displayName} · ${active.minutes} min`;
  await Promise.all([systemMessage(active.roomA, text, { kind: "PK_START" }), systemMessage(active.roomB, text, { kind: "PK_START" })]);
  // shortcut: in-process timer, lost on restart (reading the PK finishes an overdue one); use a job queue with more servers.
  setTimeout(() => finishPk(active.id).catch(() => {}), active.minutes * 60_000);
  return { pk: state };
}

export async function declinePk(user: User, pkId: string) {
  const pk = await invitedPk(user, pkId);
  await db.update(livePks).set({ status: "DECLINED" }).where(eq(livePks.id, pk.id));
  const [room] = await db.select({ hostUserId: rooms.hostUserId }).from(rooms).where(eq(rooms.id, pk.roomA));
  io.to(userChannel(room!.hostUserId)).emit("live:pk:declined", { pkId: pk.id, by: user.displayName });
  return { declined: true };
}

// Either host stops the battle early (or withdraws an invite); no winner.
export async function cancelPk(user: User, pkId: string) {
  const [pk] = await db.select().from(livePks).where(eq(livePks.id, pkId));
  if (!pk) throw new AppError("PK_NOT_FOUND", 404);
  const hosts = await db.select({ id: rooms.id, hostUserId: rooms.hostUserId }).from(rooms).where(inArray(rooms.id, [pk.roomA, pk.roomB]));
  if (!hosts.some((h) => h.hostUserId === user.id)) throw new AppError("NOT_HOST", 403);
  const [done] = await db
    .update(livePks)
    .set({ status: "CANCELLED" })
    .where(and(eq(livePks.id, pkId), inArray(livePks.status, ["INVITED", "ACTIVE"])))
    .returning();
  if (done?.startedAt) {
    emitPk(done, { pk: null });
    const text = `${user.displayName} ended the PK early`;
    await Promise.all([systemMessage(done.roomA, text, { kind: "PK_END" }), systemMessage(done.roomB, text, { kind: "PK_END" })]);
  }
  return { cancelled: !!done };
}

export async function cancelOpenPks(roomId: string) {
  const open = await openPkOf(roomId);
  if (!open) return;
  await db.update(livePks).set({ status: "CANCELLED" }).where(eq(livePks.id, open.id));
  if (open.startedAt) emitPk(open, { pk: null });
}

// Time's up: the higher score wins (draw if equal); both rooms hear the result.
async function finishPk(pkId: string) {
  const [pk] = await db.select().from(livePks).where(and(eq(livePks.id, pkId), eq(livePks.status, "ACTIVE")));
  if (!pk) return;
  const state = await pkState(pk);
  const winner = state.a.score === state.b.score ? null : state.a.score > state.b.score ? state.a : state.b;
  const [done] = await db
    .update(livePks)
    .set({ status: "ENDED", winnerRoom: winner?.roomId ?? null })
    .where(and(eq(livePks.id, pkId), eq(livePks.status, "ACTIVE")))
    .returning();
  if (!done) return; // someone else finished it
  emitPk(pk, { pk: null, result: { ...state, winnerRoomId: winner?.roomId ?? null } });
  const n = (x: number) => x.toLocaleString("en-IN");
  const text = winner
    ? `🏆 ${winner.host.displayName} won the PK · ${n(Math.max(state.a.score, state.b.score))} to ${n(Math.min(state.a.score, state.b.score))}`
    : `PK ended in a draw · ${n(state.a.score)} each`;
  await Promise.all([systemMessage(pk.roomA, text, { kind: "PK_END" }), systemMessage(pk.roomB, text, { kind: "PK_END" })]);
}

// The running battle for a room (finishing it if overdue), for the live screen.
export async function livePkFor(roomId: string) {
  const pk = await openPkOf(roomId);
  if (!pk || pk.status !== "ACTIVE") return null;
  if (pk.endsAt && pk.endsAt.getTime() <= Date.now()) {
    await finishPk(pk.id);
    return null;
  }
  return pkState(pk);
}

// After a gift in a live room: fresh scores for both sides.
export async function refreshLivePk(roomId: string) {
  const pk = await openPkOf(roomId);
  if (pk?.status === "ACTIVE" && pk.endsAt && pk.endsAt.getTime() > Date.now()) emitPk(pk, { pk: await pkState(pk) });
}
