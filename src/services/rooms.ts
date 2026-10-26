import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { config } from "../config";
import { db, isUniqueViolation, type Tx } from "../db";
import { blocks, chatMessages, directMessages, follows, giftTransactions, levelThresholds, roomAdmins, roomKicks, roomParticipants, rooms, roomSeats, users, type User } from "../db/schema";
import { emitToRoom, io, isOnline, roomChannel, userChannel } from "../io";
import { AppError } from "../lib/errors";
import { SEAT_LAYOUTS, seatPositions, type SeatCount } from "../lib/layout";
import { rateLimit } from "../lib/rateLimit";
import { generateToken04, roomPrivilege } from "../lib/zegoToken";
import { assertCanParticipate } from "./auth";
import { assertNotSvipProtected, avatarSql, frameSql, SVIP_PERKS, svipOf, svipSql } from "./svip";
import { cancelOpenPks, pkActive } from "./live";

const ZEGO_TOKEN_TTL_S = 3600;
type Room = typeof rooms.$inferSelect;
const levelSql = sql<number>`(select coalesce(max(${levelThresholds.level}), 0) from ${levelThresholds} where ${levelThresholds.xpRequired} <= ${users.xp})`.mapWith(Number);
export const userSummary = { userId: users.id, displayName: users.displayName, avatarUrl: avatarSql, level: levelSql, staffRole: users.staffRole, svip: svipSql, frameId: frameSql };

// ZEGO stream IDs allow [A-Za-z0-9_-]; one per publisher per room.
export const streamIdFor = (room: Room, userId: string) => `${room.zegoRoomId}_${userId.replaceAll("-", "")}`;

// ---------- reads ----------

export async function getSeats(roomId: string, q: Tx | typeof db = db) {
  return q
    .select({
      seatIndex: roomSeats.seatIndex,
      rowIndex: roomSeats.rowIndex,
      columnIndex: roomSeats.columnIndex,
      streamId: roomSeats.streamId,
      micMuted: roomSeats.micMuted,
      modMuted: roomSeats.modMuted,
      cameraOff: roomSeats.cameraOff,
      locked: roomSeats.locked,
      occupant: { ...userSummary, presence: roomParticipants.presence },
    })
    .from(roomSeats)
    .leftJoin(users, eq(users.id, roomSeats.occupantUserId))
    .leftJoin(
      roomParticipants,
      and(eq(roomParticipants.roomId, roomSeats.roomId), eq(roomParticipants.userId, roomSeats.occupantUserId), isNull(roomParticipants.leftAt)),
    )
    .where(eq(roomSeats.roomId, roomId))
    .orderBy(asc(roomSeats.seatIndex))
    .then((rows) =>
      rows.map((s) => ({ ...s, role: s.seatIndex === 0 ? "HOST" : "SPEAKER", occupant: s.occupant?.userId ? s.occupant : null })),
    );
}

export async function getSnapshot(roomId: string) {
  const room = await getRoom(roomId);
  const pkLive = !!room.pk && new Date(room.pk.endsAt) > new Date();
  if (room.pk && !pkLive) await finishPk(room.id, room.pk.startedAt); // overdue (missed timer)
  const [seats, participants, admins] = await Promise.all([
    getSeats(roomId),
    db
      .select({ ...userSummary, role: roomParticipants.role, presence: roomParticipants.presence })
      .from(roomParticipants)
      .innerJoin(users, eq(users.id, roomParticipants.userId))
      .where(and(eq(roomParticipants.roomId, roomId), isNull(roomParticipants.leftAt))),
    db.select({ userId: roomAdmins.userId }).from(roomAdmins).where(eq(roomAdmins.roomId, roomId)),
  ]);
  return {
    roomId: room.id,
    zegoRoomId: room.zegoRoomId,
    hostUserId: room.hostUserId,
    title: room.title,
    category: room.category,
    coverUrl: room.coverUrl,
    status: room.status,
    seatCount: room.seatCount,
    rowLayout: SEAT_LAYOUTS[room.seatCount as SeatCount],
    listenerCount: room.listenerCount,
    roomVersion: room.version,
    seats,
    participants,
    admins: admins.map((a) => a.userId),
    charisma: await charismaState(room.id, room.charismaStartedAt),
    pk: pkLive ? await pkState(room.id, room.pk) : null,
    background: room.background,
    showEntry: room.showEntry,
    giftAnimations: room.giftAnimations,
    privacy: room.privacy, // never the password
    kind: room.kind,
    pinned: room.pinSlot !== null,
    official: room.official,
    ludo: room.ludo !== null, // Ludo mode: seats in one row, board below (the board page follows the game itself)
  };
}

// ---------- room settings ----------
export const ROOM_BACKGROUNDS = ["night", "sunset", "ocean", "forest", "aurora", "rose"] as const;
export type RoomPrivacy = "PUBLIC" | "LOCKED" | "PRIVATE";
export type RoomSettings = {
  title?: string;
  coverUrl?: string;
  background?: (typeof ROOM_BACKGROUNDS)[number];
  showEntry?: boolean;
  giftAnimations?: boolean;
  privacy?: RoomPrivacy;
  password?: string; // 4 digits; sets / changes the LOCKED password
};

const PRIVACY_NOTICE: Record<RoomPrivacy, string> = {
  PUBLIC: "made the room public",
  LOCKED: "locked the room with a password",
  PRIVATE: "made the room private",
};

// Owner and admins change the room's settings; everyone in the room gets the new snapshot. Only the fields sent change.
export async function updateSettings(actor: User, roomId: string, settings: RoomSettings) {
  const { password, ...patch } = settings;
  // Hash before taking the room lock (it's deliberately slow).
  const passwordHash = password ? await Bun.password.hash(password) : undefined;
  const before = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    await assertAdmin(tx, room, actor.id);
    const privacy = patch.privacy ?? room.privacy;
    if (privacy === "LOCKED" && !passwordHash && !room.passwordHash) throw new AppError("PASSWORD_NEEDED", 400, "Set a 4-digit password to lock the room");
    const set = {
      ...patch,
      ...(passwordHash && { passwordHash }),
      ...(patch.privacy && patch.privacy !== "LOCKED" && { passwordHash: null }), // the old password doesn't carry over
    };
    if (Object.keys(set).length) {
      await tx.update(rooms).set(set).where(eq(rooms.id, roomId));
      await bumpVersion(tx, roomId);
    }
    return room;
  });
  const snap = await getSnapshot(roomId);
  emitToRoom(roomId, "room:state", snap);
  if (patch.title && patch.title !== before.title) await systemMessage(roomId, `${actor.displayName} renamed the room to "${patch.title}"`, { kind: "ROOM_RENAMED", userId: actor.id });
  if (patch.privacy && patch.privacy !== before.privacy) await systemMessage(roomId, `${actor.displayName} ${PRIVACY_NOTICE[patch.privacy]}`, { kind: "ROOM_PRIVACY", userId: actor.id });
  return snap;
}

// Who may join: anyone already in (reconnecting), the owner and room admins always; else PUBLIC anyone,
// LOCKED with the right password, PRIVATE nobody. Checked before the join takes the room lock.
async function assertCanEnter(user: User, room: Room, password: string | undefined) {
  if (room.privacy === "PUBLIC" || room.hostUserId === user.id) return;
  if ((await getActiveParticipant(room.id, user.id)) || (await powerOf(db, room, user.id))) return;
  if (room.privacy === "PRIVATE") throw new AppError("ROOM_PRIVATE", 403, "This room is private");
  if (!password) throw new AppError("PASSWORD_REQUIRED", 403, "This room is locked");
  rateLimit(`roomPassword:${user.id}:${room.id}`, 5, 60_000); // 4 digits: keep guessing slow
  if (!room.passwordHash || !(await Bun.password.verify(password, room.passwordHash))) throw new AppError("WRONG_PASSWORD", 403, "Wrong password");
}

// ---------- charisma counter ----------
// While on, each person's charisma = coins of the gifts they received in this room since it was started (per person,
// so it follows them if they change seats). Off = null. Starting again begins from zero.
async function charismaState(roomId: string, startedAt: Date | null) {
  if (!startedAt) return null;
  const rows = await db
    .select({ userId: giftTransactions.recipientId, coins: sql<number>`sum(${giftTransactions.coinsDebited})::float8` })
    .from(giftTransactions)
    .where(and(eq(giftTransactions.roomId, roomId), gte(giftTransactions.createdAt, startedAt)))
    .groupBy(giftTransactions.recipientId);
  return { startedAt, totals: Object.fromEntries(rows.map((r) => [r.userId, r.coins])) as Record<string, number> };
}

// Owner and admins switch it on (from zero) or off; everyone in the room sees the change and a chat notice.
export async function setCharisma(actor: User, roomId: string, on: boolean) {
  const startedAt = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    await assertAdmin(tx, room, actor.id);
    const next = on ? new Date() : null;
    await tx.update(rooms).set({ charismaStartedAt: next }).where(eq(rooms.id, roomId));
    await bumpVersion(tx, roomId);
    return next;
  });
  const charisma = await charismaState(roomId, startedAt);
  emitToRoom(roomId, "room:charisma", { roomId, charisma });
  await systemMessage(roomId, on ? `${actor.displayName} started the charisma counter` : `${actor.displayName} stopped the charisma counter`, { kind: "CHARISMA", userId: actor.id });
  return { charisma };
}

// After a gift: fresh totals for everyone, if the counter is running.
export async function refreshCharisma(roomId: string) {
  const room = await getRoom(roomId);
  if (room.charismaStartedAt) emitToRoom(roomId, "room:charisma", { roomId, charisma: await charismaState(roomId, room.charismaStartedAt) });
}

// ---------- PK 1v1 ----------
// Owner/admins pit two seated people against each other for a few minutes. Score = coins of gifts each receives
// in this room during the battle. A timer ends it; a snapshot read also ends an overdue one (e.g. after a restart).
export const PK_MINUTES = [3, 5, 10, 15] as const;
type Pk = NonNullable<Room["pk"]>;

async function pkState(roomId: string, pk: Pk | null) {
  if (!pk) return null;
  const [people, scores] = await Promise.all([
    db.select({ userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(inArray(users.id, [pk.a, pk.b])),
    db
      .select({ userId: giftTransactions.recipientId, score: sql<number>`sum(${giftTransactions.coinsDebited})`.mapWith(Number) })
      .from(giftTransactions)
      .where(
        and(
          eq(giftTransactions.roomId, roomId),
          inArray(giftTransactions.recipientId, [pk.a, pk.b]),
          gte(giftTransactions.createdAt, new Date(pk.startedAt)),
          lt(giftTransactions.createdAt, new Date(pk.endsAt)),
        ),
      )
      .groupBy(giftTransactions.recipientId),
  ]);
  const side = (id: string) => ({
    ...(people.find((p) => p.userId === id) ?? { userId: id, displayName: null, avatarUrl: null }),
    score: scores.find((s) => s.userId === id)?.score ?? 0,
  });
  return { a: side(pk.a), b: side(pk.b), startedAt: pk.startedAt, endsAt: pk.endsAt };
}

export async function startPk(actor: User, roomId: string, a: string, b: string, minutes: (typeof PK_MINUTES)[number]) {
  if (a === b) throw new AppError("PK_SAME_PERSON", 400, "Pick two different people");
  const pk = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    await assertAdmin(tx, room, actor.id);
    if (room.kind === "LIVE") throw new AppError("NOT_FOR_LIVE", 400, "Live streams battle other live streams instead");
    if (room.pk && new Date(room.pk.endsAt) > new Date()) throw new AppError("PK_RUNNING", 409, "A PK is already running");
    const seated = await tx
      .select({ userId: roomSeats.occupantUserId })
      .from(roomSeats)
      .where(and(eq(roomSeats.roomId, roomId), inArray(roomSeats.occupantUserId, [a, b])));
    if (seated.length !== 2) throw new AppError("PK_NOT_SEATED", 409, "Both people must be on a seat");
    // Times from the database clock, the same clock that stamps gifts (the app server's can drift from it).
    const [row] = await tx
      .update(rooms)
      .set({ pk: sql`jsonb_build_object('a', ${a}::text, 'b', ${b}::text, 'startedAt', now(), 'endsAt', now() + ${`${minutes} minutes`}::interval)` })
      .where(eq(rooms.id, roomId))
      .returning({ pk: rooms.pk });
    await bumpVersion(tx, roomId);
    return row!.pk!;
  });
  const state = await pkState(roomId, pk);
  emitToRoom(roomId, "room:pk", { roomId, pk: state });
  await systemMessage(roomId, `PK started: ${state!.a.displayName} vs ${state!.b.displayName} · ${minutes} min`, { kind: "PK_START" });
  // shortcut: in-process timer, lost on restart (the next snapshot read finishes it); move to a job queue with more servers.
  setTimeout(() => finishPk(roomId, pk.startedAt).catch(() => {}), minutes * 60_000);
  return { pk: state };
}

export async function stopPk(actor: User, roomId: string) {
  const had = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    await assertAdmin(tx, room, actor.id);
    if (!room.pk) return false;
    await tx.update(rooms).set({ pk: null }).where(eq(rooms.id, roomId));
    await bumpVersion(tx, roomId);
    return true;
  });
  if (had) {
    emitToRoom(roomId, "room:pk", { roomId, pk: null });
    await systemMessage(roomId, `${actor.displayName} cancelled the PK`, { kind: "PK_END" });
  }
  return { pk: null };
}

// Ends the battle that started at `startedAt` (no-op if it was cancelled or replaced) and announces the result.
async function finishPk(roomId: string, startedAt: string) {
  const pk = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    if (room.pk?.startedAt !== startedAt) return null;
    await tx.update(rooms).set({ pk: null }).where(eq(rooms.id, roomId));
    await bumpVersion(tx, roomId);
    return room.pk;
  });
  if (!pk) return;
  const r = (await pkState(roomId, pk))!;
  emitToRoom(roomId, "room:pk", { roomId, pk: null, result: r });
  const [win, lose] = r.a.score >= r.b.score ? [r.a, r.b] : [r.b, r.a];
  const n = (x: number) => x.toLocaleString("en-IN");
  await systemMessage(
    roomId,
    win.score === lose.score ? `PK ended in a draw · ${n(win.score)} each` : `🏆 ${win.displayName} won the PK · ${n(win.score)} to ${n(lose.score)}`,
    { kind: "PK_END", winner: win.score === lose.score ? null : win.userId },
  );
}

// After a gift: fresh scores while a battle is on.
export async function refreshPk(roomId: string) {
  const room = await getRoom(roomId);
  if (room.pk && new Date(room.pk.endsAt) > new Date()) emitToRoom(roomId, "room:pk", { roomId, pk: await pkState(roomId, room.pk) });
}

// ---------- room rank & heart level ----------
// Rank: this week's gift coins received in the room vs every other room (Monday 00:00 India time; null = no gifts yet).
// Heart level: lifetime gift coins received in the room.
export const HEART_LEVELS = [0, 1_000, 10_000, 50_000, 2_00_000, 10_00_000, 50_00_000, 2_00_00_000, 5_00_00_000, 10_00_00_000];
const IST = sql.raw(`'Asia/Kolkata'`);
export async function roomStats(roomId: string) {
  await getRoom(roomId);
  const weekStart = sql`(date_trunc('week', now() at time zone ${IST}) at time zone ${IST})`;
  const { rows } = await db.execute<{ week: string; rank: string | null; lifetime: string; ends_at: Date }>(sql`
    with weekly as (
      select ${giftTransactions.roomId} as room_id, sum(${giftTransactions.coinsDebited}) as coins
      from ${giftTransactions} where ${giftTransactions.createdAt} >= ${weekStart} group by 1
    )
    select
      coalesce((select coins from weekly where room_id = ${roomId}), 0) as week,
      case when exists (select 1 from weekly where room_id = ${roomId})
        then (select 1 + count(*) from weekly where coins > (select coins from weekly where room_id = ${roomId})) end as rank,
      (select coalesce(sum(${giftTransactions.coinsDebited}), 0) from ${giftTransactions} where ${giftTransactions.roomId} = ${roomId}) as lifetime,
      ((date_trunc('week', now() at time zone ${IST}) + interval '1 week') at time zone ${IST}) as ends_at`);
  const r = rows[0]!;
  const lifetime = Number(r.lifetime);
  const level = HEART_LEVELS.filter((x) => lifetime >= x).length;
  return {
    rank: r.rank === null ? null : Number(r.rank),
    weekCoins: Number(r.week),
    weekEndsAt: new Date(r.ends_at),
    heart: { level, coins: lifetime, nextAt: HEART_LEVELS[level] ?? null },
  };
}

export async function getRoom(roomId: string, q: Tx | typeof db = db) {
  const [room] = await q.select().from(rooms).where(eq(rooms.id, roomId));
  if (!room) throw new AppError("ROOM_NOT_FOUND", 404);
  return room;
}

// Locks the room row so every seat/membership mutation in a room is serialized and versioned.
export async function lockRoom(tx: Tx, roomId: string) {
  const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for("update");
  if (!room) throw new AppError("ROOM_NOT_FOUND", 404);
  return room;
}

export const bumpVersion = async (tx: Tx, roomId: string) =>
  (await tx.update(rooms).set({ version: sql`${rooms.version} + 1` }).where(eq(rooms.id, roomId)).returning({ v: rooms.version }))[0]!.v;

const recountListeners = (tx: Tx, roomId: string) =>
  tx
    .update(rooms)
    .set({
      listenerCount: sql`(select count(*) from ${roomParticipants} where ${roomParticipants.roomId} = ${roomId} and ${roomParticipants.leftAt} is null)`,
    })
    .where(eq(rooms.id, roomId));

export async function getActiveParticipant(roomId: string, userId: string, q: Tx | typeof db = db) {
  const [p] = await q
    .select()
    .from(roomParticipants)
    .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.userId, userId), isNull(roomParticipants.leftAt)));
  return p;
}

export async function assertMember(roomId: string, userId: string) {
  if (!(await getActiveParticipant(roomId, userId))) throw new AppError("NOT_IN_ROOM", 403);
}

async function seatOf(roomId: string, userId: string, q: Tx | typeof db = db) {
  const [s] = await q.select().from(roomSeats).where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.occupantUserId, userId)));
  return s;
}

export async function zegoCredentials(roomId: string, userId: string) {
  const room = await getRoom(roomId);
  const seat = await seatOf(roomId, userId);
  return {
    appId: config.zegoAppId,
    zegoRoomId: room.zegoRoomId,
    zegoUserId: userId,
    token: generateToken04(config.zegoAppId, userId, config.zegoServerSecret, ZEGO_TOKEN_TTL_S, roomPrivilege(room.zegoRoomId, !!seat)),
    tokenExpiresInSeconds: ZEGO_TOKEN_TTL_S,
    streamId: seat?.streamId ?? null,
  };
}

const roomCard = {
  roomId: rooms.id,
  title: rooms.title,
  category: rooms.category,
  coverUrl: rooms.coverUrl,
  seatCount: rooms.seatCount,
  listenerCount: rooms.listenerCount,
  privacy: rooms.privacy,
  kind: rooms.kind,
  // Live streams: invited to or in a PK right now (shown greyed out in the PK picker).
  inPk: sql<boolean>`exists(select 1 from live_pks p where (p.room_a = ${rooms.id} or p.room_b = ${rooms.id}) and p.status in ('INVITED', 'ACTIVE'))`,
  pinned: sql<boolean>`${rooms.pinSlot} is not null`,
  official: rooms.official,
  // The first few people on stage (for the card's avatar row) and the open seats left for a guest.
  stage: sql<{ userId: string; displayName: string | null; avatarUrl: string | null }[]>`(select coalesce(json_agg(json_build_object('userId', x.id, 'displayName', x.display_name, 'avatarUrl', x.avatar_url) order by x.seat_index), '[]'::json)
    from (select s.seat_index, u.id, u.display_name, u.avatar_url from room_seats s join users u on u.id = s.occupant_user_id
          where s.room_id = ${rooms.id} order by s.seat_index limit 4) x)`,
  seatsFree: sql<number>`(select count(*) from room_seats s where s.room_id = ${rooms.id} and s.seat_index > 0 and s.occupant_user_id is null and not s.locked)`.mapWith(Number),
  host: userSummary,
};

// Room ranking (everything below the pinned rooms), computed on each list:
//   √(gift coins received in the last hour) × 2   heavy gifting counts, but √ stops one big spender burying everyone
// + people in the room right now           × 5   live activity matters most
// + different people who joined in 1 hour   × 2   rooms that pull newcomers in
// + chat messages in the last 15 minutes    × 0.5 a lively conversation
// + people on seats besides the host       × 3   people actually talking
// then × 0.1 when nobody is in the room, so yesterday's busy room doesn't sit above an active one.
// shortcut: five small correlated counts per room; precompute into a column every minute if the room list gets big.
const rankSql = sql<number>`(
  (sqrt((select coalesce(sum(g.coins_debited), 0) from gift_transactions g where g.room_id = ${rooms.id} and g.created_at > now() - interval '1 hour')) * 2
   + ${rooms.listenerCount} * 5
   + (select count(distinct p.user_id) from room_participants p where p.room_id = ${rooms.id} and p.created_at > now() - interval '1 hour') * 2
   + (select count(*) from chat_messages m where m.room_id = ${rooms.id} and m.type = 'USER' and m.created_at > now() - interval '15 minutes') * 0.5
   + (select count(*) from room_seats s where s.room_id = ${rooms.id} and s.seat_index > 0 and s.occupant_user_id is not null) * 3)
  * (case when ${rooms.listenerCount} > 0 then 1 else 0.1 end))`.mapWith(Number);

// Discovery: pinned rooms first (slot 1 = the official help room), then every other open room by rank.
// Live streams have no pins, so they're simply ranked.
// shortcut: offset paging can skip or repeat a room when ranks change between pages; snapshot ranks per session if the list gets long.
export async function listRooms(cursor: string | undefined, limit: number, kind: "AUDIO" | "LIVE" = "AUDIO", category?: string) {
  const offset = Math.max(0, Number(cursor) || 0);
  const rows = await db
    .select({ ...roomCard, rank: rankSql })
    .from(rooms)
    .innerJoin(users, eq(users.id, rooms.hostUserId))
    .where(
      and(
        eq(rooms.status, "LIVE"),
        eq(rooms.kind, kind),
        ne(rooms.privacy, "PRIVATE"), // private rooms are never listed
        category ? sql`lower(${rooms.category}) = lower(${category})` : undefined,
      ),
    )
    .orderBy(sql`${rooms.pinSlot} asc nulls last`, desc(rankSql), desc(rooms.createdAt), desc(rooms.id))
    .limit(limit + 1)
    .offset(offset);
  return { rooms: rows.slice(0, limit), nextCursor: rows.length > limit ? String(offset + limit) : null };
}

// Home "Friends": live streams and rooms where people you follow are right now (never private ones),
// busiest-with-friends first, live streams before rooms on a tie.
export async function friendsActivity(userId: string) {
  const rows = await db
    .select({ ...roomCard, friend: { userId: follows.followedId, displayName: sql<string | null>`fu.display_name`, avatarUrl: sql<string | null>`fu.avatar_url` } })
    .from(follows)
    .innerJoin(roomParticipants, and(eq(roomParticipants.userId, follows.followedId), isNull(roomParticipants.leftAt)))
    .innerJoin(rooms, eq(rooms.id, roomParticipants.roomId))
    .innerJoin(users, eq(users.id, rooms.hostUserId))
    .innerJoin(sql`${users} fu`, sql`fu.id = ${follows.followedId}`)
    .where(and(eq(follows.followerId, userId), eq(rooms.status, "LIVE"), ne(rooms.privacy, "PRIVATE")));
  const byRoom = new Map<string, { room: Omit<(typeof rows)[number], "friend">; friends: (typeof rows)[number]["friend"][] }>();
  for (const { friend, ...room } of rows) {
    const entry = byRoom.get(room.roomId) ?? { room, friends: [] };
    entry.friends.push(friend);
    byRoom.set(room.roomId, entry);
  }
  return [...byRoom.values()].sort((a, b) => b.friends.length - a.friends.length || (a.room.kind === "LIVE" ? -1 : 1) - (b.room.kind === "LIVE" ? -1 : 1));
}

// ---------- pinning (staff) ----------
export const MAX_PINS = 4;

// Staff pin a room into the first free slot (2-4; slot 1 belongs to the official room) or unpin it.
export async function setPinned(actor: User, roomId: string, pinned: boolean) {
  if (!actor.staffRole) throw new AppError("NOT_STAFF", 403, "Only VoyaLive staff can pin rooms");
  const room = await getRoom(roomId);
  if (room.official) throw new AppError("OFFICIAL_ROOM", 400, "The official room is always pinned");
  if (room.kind !== "AUDIO") throw new AppError("NOT_PINNABLE", 400, "Only party rooms can be pinned");
  if (!pinned) {
    await db.update(rooms).set({ pinSlot: null }).where(eq(rooms.id, roomId));
    return { pinned: false, pinSlot: null };
  }
  if (room.pinSlot) return { pinned: true, pinSlot: room.pinSlot };
  const taken = new Set((await db.select({ s: rooms.pinSlot }).from(rooms).where(sql`${rooms.pinSlot} is not null`)).map((r) => r.s));
  const slot = [2, 3, 4].find((s) => !taken.has(s));
  if (!slot) throw new AppError("PIN_LIMIT", 409, `Up to ${MAX_PINS} rooms can be pinned. Unpin one first.`);
  try {
    await db.update(rooms).set({ pinSlot: slot }).where(eq(rooms.id, roomId));
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("PIN_LIMIT", 409, "That slot was just taken, try again");
    throw e;
  }
  return { pinned: true, pinSlot: slot };
}

// Each user owns at most one room, kept forever.
export async function getMyRoom(user: User, kind: "AUDIO" | "LIVE" = "AUDIO") {
  const [room] = await db
    .select(roomCard)
    .from(rooms)
    .innerJoin(users, eq(users.id, rooms.hostUserId))
    .where(and(eq(rooms.hostUserId, user.id), eq(rooms.status, "LIVE"), eq(rooms.kind, kind)));
  return room ?? null;
}

// ---------- permissions ----------

type Power = "OWNER" | "ADMIN";

async function powerOf(q: Tx | typeof db, room: Room, userId: string): Promise<Power | null> {
  if (room.hostUserId === userId) return "OWNER";
  const [a] = await q
    .select({ userId: roomAdmins.userId })
    .from(roomAdmins)
    .where(and(eq(roomAdmins.roomId, room.id), eq(roomAdmins.userId, userId)));
  return a ? "ADMIN" : null;
}

async function assertAdmin(q: Tx | typeof db, room: Room, userId: string) {
  const power = await powerOf(q, room, userId);
  if (!power) throw new AppError("NOT_ROOM_ADMIN", 403);
  return power;
}

// For other services (e.g. Ludo): the room's owner or one of its admins, else NOT_ROOM_ADMIN.
export const assertRoomAdmin = async (roomId: string, userId: string) => assertAdmin(db, await getRoom(roomId), userId);

// The owner can act on anyone else; admins can't act on the owner or on other admins; nobody below an SVIP5+ member's tier can act on them.
async function assertCanModerate(q: Tx | typeof db, room: Room, actorId: string, targetId: string) {
  const power = await assertAdmin(q, room, actorId);
  if (targetId === room.hostUserId) throw new AppError("CANNOT_TARGET_OWNER", 403);
  if (power === "ADMIN" && (await powerOf(q, room, targetId))) throw new AppError("CANNOT_TARGET_ADMIN", 403);
  await assertNotSvipProtected(actorId, targetId);
}

// ---------- system messages ----------

export async function systemMessage(roomId: string, body: string, payload: Record<string, unknown>) {
  try {
    const [m] = await db.insert(chatMessages).values({ roomId, body, type: "SYSTEM", payload }).returning();
    emitToRoom(roomId, "room:system", { messageId: String(m!.id), roomId, body, payload, createdAt: m!.createdAt });
  } catch (e) {
    // Never fail the main action because a notice could not be written.
    console.error(JSON.stringify({ level: "error", msg: "system-message-failed", roomId, err: String(e) }));
  }
}

async function broadcastSeats(roomId: string, roomVersion: number) {
  emitToRoom(roomId, "room:seat:state", { roomId, roomVersion, seats: await getSeats(roomId) });
}

// Live PK starting: co-hosts (seats 1-3) step off so the battle is host vs host; each gets a "room:unseated" notice.
export async function clearCoHosts(roomId: string) {
  const result = await db.transaction(async (tx) => {
    await lockRoom(tx, roomId);
    const freed = await tx
      .update(roomSeats)
      .set({ occupantUserId: null, streamId: null, micMuted: false, modMuted: false, cameraOff: false, assignedAt: null, updatedAt: new Date() })
      .where(and(eq(roomSeats.roomId, roomId), sql`${roomSeats.seatIndex} > 0`, sql`${roomSeats.occupantUserId} is not null`))
      .returning({ userId: roomSeats.occupantUserId });
    return freed.length ? { freed, roomVersion: await bumpVersion(tx, roomId) } : null;
  });
  if (!result) return;
  await broadcastSeats(roomId, result.roomVersion);
  for (const { userId } of result.freed) io.to(userChannel(userId!)).emit("room:unseated", { roomId, seatIndex: null, by: "PK", reason: "PK_STARTED" });
}

// Live streams: switch your own seat's camera off (audio only; viewers see your avatar) or back on.
export async function setCameraOff(user: User, roomId: string, off: boolean) {
  const roomVersion = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    if (room.kind !== "LIVE") throw new AppError("NOT_LIVE", 400);
    const [seat] = await tx
      .update(roomSeats)
      .set({ cameraOff: off, updatedAt: new Date() })
      .where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.occupantUserId, user.id)))
      .returning({ seatIndex: roomSeats.seatIndex });
    if (!seat) throw new AppError("NOT_SEATED", 409, "You're not on a seat");
    return bumpVersion(tx, roomId);
  });
  await broadcastSeats(roomId, roomVersion);
  return { cameraOff: off };
}

// Live streams: no co-hosting while a PK battle is on.
async function assertCoHostAllowed(room: Room, seatIndex: number) {
  if (room.kind === "LIVE" && seatIndex > 0 && (await pkActive(room.id))) throw new AppError("PK_IN_PROGRESS", 409, "Co-hosting is paused during a PK battle");
}

// ---------- commands ----------

export async function createRoom(user: User, input: { title: string; category?: string; coverUrl?: string; seatCount: SeatCount; kind?: "AUDIO" | "LIVE" }) {
  assertCanParticipate(user);
  rateLimit(`room:create:${user.id}`, 5, 10 * 60_000);
  try {
    const roomId = await db.transaction(async (tx) => {
      const [room] = await tx
        .insert(rooms)
        .values({ ...input, hostUserId: user.id, status: "LIVE", startedAt: new Date(), zegoRoomId: `${input.kind === "LIVE" ? "l" : "r"}_${crypto.randomUUID().replaceAll("-", "")}` })
        .returning();
      const now = new Date();
      await tx.insert(roomSeats).values(
        seatPositions(input.seatCount).map((p) => ({
          roomId: room!.id,
          ...p,
          ...(p.seatIndex === 0 && { occupantUserId: user.id, streamId: streamIdFor(room!, user.id), assignedAt: now }),
        })),
      );
      await tx.insert(roomParticipants).values({ roomId: room!.id, userId: user.id, role: "HOST" });
      await recountListeners(tx, room!.id);
      return room!.id;
    });
    return { room: await getSnapshot(roomId), zego: await zegoCredentials(roomId, user.id) };
  } catch (e) {
    if (isUniqueViolation(e)) throw input.kind === "LIVE" ? new AppError("ALREADY_LIVE", 409, "You're already live") : new AppError("ALREADY_HAS_ROOM", 409, "You already have a room");
    throw e;
  }
}

export async function joinRoom(user: User, roomId: string, password?: string) {
  assertCanParticipate(user);
  await assertCanEnter(user, await getRoom(roomId), password);
  const { isNew, roomVersion } = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    const isHost = room.hostUserId === user.id;
    if (room.status !== "LIVE") throw new AppError("ROOM_NOT_LIVE", 409);
    const [kicked] = await tx
      .select({ userId: roomKicks.userId })
      .from(roomKicks)
      .where(and(eq(roomKicks.roomId, roomId), eq(roomKicks.userId, user.id)));
    if (kicked) throw new AppError("REMOVED_FROM_ROOM", 403);

    const existing = await getActiveParticipant(roomId, user.id, tx);
    if (existing) {
      await tx.update(roomParticipants).set({ presence: "CONNECTED", lastSeenAt: new Date() }).where(eq(roomParticipants.id, existing.id));
    } else {
      await tx.insert(roomParticipants).values({ roomId, userId: user.id, role: isHost ? "HOST" : "AUDIENCE" });
      await recountListeners(tx, roomId);
    }
    return { isNew: !existing, roomVersion: await bumpVersion(tx, roomId) };
  });

  if (isNew) {
    const svip = await svipOf(user.id);
    emitToRoom(roomId, "room:participant:joined", {
      roomId,
      roomVersion,
      user: { userId: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl, svip },
      role: "AUDIENCE",
      at: new Date(),
    });
    // "X joined" notices can be switched off in the room's settings; SVIP2+ entrances are always announced (and animated in the app).
    const grand = svip >= SVIP_PERKS.entrance;
    if (grand || (await getRoom(roomId)).showEntry)
      await systemMessage(roomId, grand ? `SVIP${svip} ${user.displayName} entered the room` : `${user.displayName} joined`, { kind: "JOIN", userId: user.id, svip });
  }
  return { room: await getSnapshot(roomId), zego: await zegoCredentials(roomId, user.id) };
}

// Frees the user's seat inside an open transaction. Returns the freed seat index, if any.
async function freeSeatOf(tx: Tx, roomId: string, userId: string) {
  const [s] = await tx
    .update(roomSeats)
    .set({ occupantUserId: null, streamId: null, micMuted: false, modMuted: false, cameraOff: false, assignedAt: null, updatedAt: new Date() })
    .where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.occupantUserId, userId)))
    .returning({ seatIndex: roomSeats.seatIndex });
  return s?.seatIndex;
}

function assertGuestSeat(room: Room, seatIndex: number) {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= room.seatCount) throw new AppError("INVALID_SEAT", 400);
  if (seatIndex === 0) throw new AppError("HOST_SEAT_RESERVED", 403);
}

// shortcut: pending seat invites live in memory (60s TTL), so they're single-instance and lost on restart; move to Redis before scaling out.
const INVITE_TTL_MS = 60_000;
const invites = new Map<string, { seatIndex: number; expiresAt: number; invitedBy: string }>();
const inviteKey = (roomId: string, userId: string) => `${roomId}:${userId}`;

// `invited`: the user is accepting an invite for this seat; that is the only way onto a locked seat.
export async function claimSeat(user: User, roomId: string, seatIndex: number, { invited = false } = {}) {
  assertCanParticipate(user);
  rateLimit(`seat:${user.id}`, 10, 10_000);
  if (invited) {
    const inv = invites.get(inviteKey(roomId, user.id));
    if (!inv || inv.seatIndex !== seatIndex || inv.expiresAt < Date.now()) throw new AppError("INVITE_EXPIRED", 410);
  }
  await assertCoHostAllowed(await getRoom(roomId), seatIndex);
  const result = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    if (room.status !== "LIVE") throw new AppError("ROOM_NOT_LIVE", 409);
    if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= room.seatCount) throw new AppError("INVALID_SEAT", 400);
    if (!(await getActiveParticipant(roomId, user.id, tx))) throw new AppError("NOT_IN_ROOM", 403);
    // Seat 0 is the owner seat: only the owner and admins sit there.
    const power = await powerOf(tx, room, user.id);
    if (seatIndex === 0 && !power) throw new AppError("HOST_SEAT_RESERVED", 403, "Only the owner or an admin can sit here");
    const current = await seatOf(roomId, user.id, tx);
    if (current?.seatIndex === seatIndex) return null; // idempotent retry

    // Moving seats: free the old one first (one seat per user is a unique index); a failed claim rolls it back.
    // The stream ID is per user, so audio keeps flowing and the mute state carries over.
    if (current) await freeSeatOf(tx, roomId, user.id);
    const [won] = await tx
      .update(roomSeats)
      .set({
        occupantUserId: user.id,
        streamId: streamIdFor(room, user.id),
        micMuted: current?.micMuted ?? false,
        modMuted: current?.modMuted ?? false,
        assignedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(roomSeats.roomId, roomId),
          eq(roomSeats.seatIndex, seatIndex),
          isNull(roomSeats.occupantUserId),
          invited ? undefined : eq(roomSeats.locked, false), // locked: only via an invite, owner/admins included
        ),
      )
      .returning();
    if (!won) {
      const [seat] = await tx.select().from(roomSeats).where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.seatIndex, seatIndex)));
      throw seat?.occupantUserId ? new AppError("SEAT_TAKEN", 409) : new AppError("SEAT_LOCKED", 403);
    }
    await tx
      .update(roomParticipants)
      .set({ role: "SPEAKER" })
      .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.userId, user.id), isNull(roomParticipants.leftAt), ne(roomParticipants.role, "HOST")));
    return { from: current?.seatIndex, roomVersion: await bumpVersion(tx, roomId) };
  });

  invites.delete(inviteKey(roomId, user.id));
  // No chat notice for taking/moving seats; the seat grid already shows it.
  if (result) await broadcastSeats(roomId, result.roomVersion);
  // Fresh token with publish privilege; client must only start publishing after this returns.
  return { seatIndex, zego: await zegoCredentials(roomId, user.id) };
}

// Owner/admins, empty guest seats only; a locked seat can still be filled through an invite.
export async function setSeatLocked(actor: User, roomId: string, seatIndex: number, locked: boolean) {
  const roomVersion = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    await assertAdmin(tx, room, actor.id);
    assertGuestSeat(room, seatIndex);
    const [s] = await tx
      .update(roomSeats)
      .set({ locked, updatedAt: new Date() })
      .where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.seatIndex, seatIndex), isNull(roomSeats.occupantUserId)))
      .returning();
    if (!s) throw new AppError("SEAT_OCCUPIED", 409, "Remove the speaker before locking this seat");
    return bumpVersion(tx, roomId);
  });
  await broadcastSeats(roomId, roomVersion);
  return { seatIndex, locked };
}

export async function inviteToSeat(actor: User, roomId: string, seatIndex: number, targetUserId: string) {
  const room = await getRoom(roomId);
  await assertAdmin(db, room, actor.id);
  if (room.status !== "LIVE") throw new AppError("ROOM_NOT_LIVE", 409);
  assertGuestSeat(room, seatIndex);
  await assertCoHostAllowed(room, seatIndex);
  if (targetUserId === actor.id) throw new AppError("CANNOT_TARGET_SELF", 400);
  rateLimit(`invite:${actor.id}`, 20, 60_000);
  if (!(await getActiveParticipant(roomId, targetUserId))) throw new AppError("NOT_IN_ROOM", 404);
  if (await seatOf(roomId, targetUserId)) throw new AppError("ALREADY_SEATED", 409);
  const [seat] = await db.select().from(roomSeats).where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.seatIndex, seatIndex)));
  if (seat?.occupantUserId) throw new AppError("SEAT_TAKEN", 409);

  const expiresAt = Date.now() + INVITE_TTL_MS;
  invites.set(inviteKey(roomId, targetUserId), { seatIndex, expiresAt, invitedBy: actor.id });
  io.to(userChannel(targetUserId)).emit("room:seat:invite", {
    roomId,
    seatIndex,
    from: { userId: actor.id, displayName: actor.displayName },
    expiresAt: new Date(expiresAt),
  });
  return { invited: true, seatIndex, expiresAt: new Date(expiresAt) };
}

export async function declineInvite(user: User, roomId: string) {
  const inv = invites.get(inviteKey(roomId, user.id));
  if (!invites.delete(inviteKey(roomId, user.id))) return { declined: false };
  io.to(userChannel(inv!.invitedBy)).emit("room:seat:invite:declined", {
    roomId,
    seatIndex: inv!.seatIndex,
    user: { userId: user.id, displayName: user.displayName },
  });
  return { declined: true };
}

// Anyone, the owner included, can step off stage; the owner keeps running the room as a listener.
export async function releaseSeat(user: User, roomId: string, seatIndex: number) {
  const roomVersion = await db.transaction(async (tx) => {
    await lockRoom(tx, roomId);
    const seat = await seatOf(roomId, user.id, tx);
    if (!seat) return null; // already free: idempotent
    if (seat.seatIndex !== seatIndex) throw new AppError("NOT_YOUR_SEAT", 403);
    await freeSeatOf(tx, roomId, user.id);
    await tx
      .update(roomParticipants)
      .set({ role: "AUDIENCE" })
      .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.userId, user.id), isNull(roomParticipants.leftAt), ne(roomParticipants.role, "HOST")));
    return bumpVersion(tx, roomId);
  });
  if (roomVersion !== null) await broadcastSeats(roomId, roomVersion); // no chat notice; the seat grid shows it
  return { released: roomVersion !== null };
}

// Two independent switches; the mic is live only when both are off.
// Self (micMuted): always yours to toggle. Moderator (modMuted): owner on anyone, admins on listeners.
// Lifting an admin mute never touches the self mute, so nobody is unmuted by surprise.
export async function setMicMuted(actor: User, roomId: string, targetUserId: string, muted: boolean) {
  const self = actor.id === targetUserId;
  const result = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    if (!self) await assertCanModerate(tx, room, actor.id, targetUserId);
    const [seat] = await tx
      .select()
      .from(roomSeats)
      .where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.occupantUserId, targetUserId)));
    if (!seat) throw new AppError("NOT_SEATED", 409);
    const [after] = await tx
      .update(roomSeats)
      .set({ ...(self ? { micMuted: muted } : { modMuted: muted }), updatedAt: new Date() })
      .where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.seatIndex, seat.seatIndex)))
      .returning();
    return { after: after!, roomVersion: await bumpVersion(tx, roomId) };
  });
  // shortcut: mute is enforced by the client reacting to this event; server-side media mute needs the ZEGO server API.
  await broadcastSeats(roomId, result.roomVersion);
  return { micMuted: result.after.micMuted, modMuted: result.after.modMuted };
}

// Sends a seated user back to the audience (they stay in the room). Same rules as other moderation.
export async function removeFromSeat(actor: User, roomId: string, targetUserId: string) {
  const result = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    await assertCanModerate(tx, room, actor.id, targetUserId);
    const freed = await freeSeatOf(tx, roomId, targetUserId);
    if (freed === undefined) throw new AppError("NOT_SEATED", 409);
    await tx
      .update(roomParticipants)
      .set({ role: "AUDIENCE" })
      .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.userId, targetUserId), isNull(roomParticipants.leftAt)));
    const [target] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, targetUserId));
    return { freed, name: target?.displayName, roomVersion: await bumpVersion(tx, roomId) };
  });
  io.to(userChannel(targetUserId)).emit("room:unseated", { roomId, seatIndex: result.freed, by: actor.displayName });
  await broadcastSeats(roomId, result.roomVersion);
  await systemMessage(roomId, `${result.name} was moved off seat ${result.freed + 1}`, {
    kind: "UNSEATED",
    userId: targetUserId,
    seatIndex: result.freed,
  });
  return { unseated: true, seatIndex: result.freed };
}

async function markLeft(tx: Tx, roomId: string, userId: string, presence: "LEFT" | "REMOVED") {
  await tx
    .update(roomParticipants)
    .set({ presence, leftAt: new Date() })
    .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.userId, userId), isNull(roomParticipants.leftAt)));
  await recountListeners(tx, roomId);
}

// Everyone, the owner included, just leaves: rooms are permanent and stay open for anyone to join.
// Closes a room for good (live streams when the host stops): everyone leaves, seats clear, apps get "room:ended".
export async function endRoom(roomId: string) {
  const ended = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    if (room.status !== "LIVE") return false;
    await tx.update(rooms).set({ status: "ENDED", endedAt: new Date(), pk: null }).where(eq(rooms.id, roomId));
    await tx
      .update(roomSeats)
      .set({ occupantUserId: null, streamId: null, micMuted: false, modMuted: false, cameraOff: false, assignedAt: null, updatedAt: new Date() })
      .where(eq(roomSeats.roomId, roomId));
    await tx.update(roomParticipants).set({ leftAt: new Date(), presence: "LEFT" }).where(and(eq(roomParticipants.roomId, roomId), isNull(roomParticipants.leftAt)));
    await tx.update(rooms).set({ listenerCount: 0 }).where(eq(rooms.id, roomId));
    await bumpVersion(tx, roomId);
    return true;
  });
  if (ended) {
    emitToRoom(roomId, "room:ended", { roomId });
    io.in(roomChannel(roomId)).socketsLeave(roomChannel(roomId));
  }
  return { ended };
}

export async function leaveRoom(user: User, roomId: string) {
  // A live stream ends when its host leaves.
  const room = await getRoom(roomId);
  if (room.kind === "LIVE" && room.hostUserId === user.id) {
    await cancelOpenPks(roomId);
    return { left: true, ...(await endRoom(roomId)) };
  }
  const result = await db.transaction(async (tx) => {
    await lockRoom(tx, roomId);
    if (!(await getActiveParticipant(roomId, user.id, tx))) return null;
    const freed = await freeSeatOf(tx, roomId, user.id);
    await markLeft(tx, roomId, user.id, "LEFT");
    return { freed, roomVersion: await bumpVersion(tx, roomId) };
  });
  if (result) {
    io.in(userChannel(user.id)).socketsLeave(roomChannel(roomId));
    emitToRoom(roomId, "room:participant:left", { roomId, roomVersion: result.roomVersion, userId: user.id, at: new Date() });
    if (result.freed !== undefined) await broadcastSeats(roomId, result.roomVersion);
  }
  return { left: true };
}

// Kicks the target: frees their seat, drops admin, and puts them on the room's kicked-out list.
export async function removeParticipant(actor: User, roomId: string, targetUserId: string) {
  const result = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    await assertCanModerate(tx, room, actor.id, targetUserId);
    if (!(await getActiveParticipant(roomId, targetUserId, tx))) throw new AppError("NOT_IN_ROOM", 404);
    const freed = await freeSeatOf(tx, roomId, targetUserId);
    await markLeft(tx, roomId, targetUserId, "REMOVED");
    await tx.delete(roomAdmins).where(and(eq(roomAdmins.roomId, roomId), eq(roomAdmins.userId, targetUserId)));
    await tx.insert(roomKicks).values({ roomId, userId: targetUserId, kickedBy: actor.id }).onConflictDoNothing();
    const [target] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, targetUserId));
    return { freed, name: target?.displayName, roomVersion: await bumpVersion(tx, roomId) };
  });
  // Tell the target to stop publishing/leave media, then cut them off the room channel.
  // shortcut: their ZEGO token stays valid until expiry; kicking from media needs the ZEGO server API.
  io.to(userChannel(targetUserId)).emit("room:removed", { roomId, roomVersion: result.roomVersion });
  io.in(userChannel(targetUserId)).socketsLeave(roomChannel(roomId));
  emitToRoom(roomId, "room:participant:left", { roomId, roomVersion: result.roomVersion, userId: targetUserId, at: new Date() });
  if (result.freed !== undefined) await broadcastSeats(roomId, result.roomVersion);
  await systemMessage(roomId, `${result.name} was removed from the room`, { kind: "REMOVED", userId: targetUserId });
  return { removed: true };
}

export async function setAdmin(owner: User, roomId: string, targetUserId: string, admin: boolean) {
  const result = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    if (room.hostUserId !== owner.id) throw new AppError("NOT_HOST", 403);
    if (targetUserId === owner.id) throw new AppError("CANNOT_TARGET_SELF", 400);
    if (admin) {
      if (!(await getActiveParticipant(roomId, targetUserId, tx))) throw new AppError("NOT_IN_ROOM", 404);
      const [added] = await tx.insert(roomAdmins).values({ roomId, userId: targetUserId, grantedBy: owner.id }).onConflictDoNothing().returning();
      if (!added) return null; // already an admin
    } else {
      const [gone] = await tx
        .delete(roomAdmins)
        .where(and(eq(roomAdmins.roomId, roomId), eq(roomAdmins.userId, targetUserId)))
        .returning();
      if (!gone) return null;
    }
    const [target] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, targetUserId));
    return { name: target?.displayName, roomVersion: await bumpVersion(tx, roomId) };
  });
  if (result) {
    emitToRoom(roomId, "room:state", await getSnapshot(roomId)); // badges update for everyone, quietly
    io.to(userChannel(targetUserId)).emit("room:admin:changed", { roomId, admin, by: owner.displayName });
  }
  return { userId: targetUserId, admin };
}

// Owner or admins. Growing adds empty seats; shrinking moves people on removed seats to free seats
// (keeping their stream and mute flags) or, if none are free, back to the audience.
export async function setSeatCount(actor: User, roomId: string, seatCount: SeatCount) {
  const result = await db.transaction(async (tx) => {
    const room = await lockRoom(tx, roomId);
    await assertAdmin(tx, room, actor.id);
    if (room.kind === "LIVE") throw new AppError("NOT_FOR_LIVE", 400, "Live streams always have the host and 3 co-hosts");
    if (room.seatCount === seatCount) return null;

    const seats = await tx.select().from(roomSeats).where(eq(roomSeats.roomId, roomId)).orderBy(asc(roomSeats.seatIndex));
    const removed = seats.filter((x) => x.seatIndex >= seatCount && x.occupantUserId);
    const free = seats.filter((x) => x.seatIndex > 0 && x.seatIndex < seatCount && !x.occupantUserId && !x.locked).map((x) => x.seatIndex); // never onto a locked seat
    const unseated: string[] = [];
    // Clear the seats being removed first (one-seat-per-user is a unique index), then re-place their people.
    await tx.delete(roomSeats).where(and(eq(roomSeats.roomId, roomId), gte(roomSeats.seatIndex, seatCount)));
    for (const s of removed) {
      const to = free.shift();
      if (to === undefined) {
        unseated.push(s.occupantUserId!);
        continue;
      }
      await tx
        .update(roomSeats)
        .set({ occupantUserId: s.occupantUserId, streamId: s.streamId, micMuted: s.micMuted, modMuted: s.modMuted, assignedAt: s.assignedAt, updatedAt: new Date() })
        .where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.seatIndex, to)));
    }
    if (unseated.length) {
      await tx
        .update(roomParticipants)
        .set({ role: "AUDIENCE" })
        .where(and(eq(roomParticipants.roomId, roomId), inArray(roomParticipants.userId, unseated), isNull(roomParticipants.leftAt), ne(roomParticipants.role, "HOST")));
    }
    // New seats for growth, and fresh row/column positions for the new layout.
    const positions = seatPositions(seatCount);
    const have = new Set(seats.filter((x) => x.seatIndex < seatCount).map((x) => x.seatIndex));
    const added = positions.filter((p) => !have.has(p.seatIndex));
    if (added.length) await tx.insert(roomSeats).values(added.map((p) => ({ roomId, ...p })));
    for (const p of positions.filter((p) => have.has(p.seatIndex))) {
      await tx
        .update(roomSeats)
        .set({ rowIndex: p.rowIndex, columnIndex: p.columnIndex })
        .where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.seatIndex, p.seatIndex)));
    }
    await tx.update(rooms).set({ seatCount }).where(eq(rooms.id, roomId));
    return { unseated, roomVersion: await bumpVersion(tx, roomId) };
  });
  if (result) {
    emitToRoom(roomId, "room:state", await getSnapshot(roomId));
    for (const id of result.unseated) {
      io.to(userChannel(id)).emit("room:unseated", { roomId, seatIndex: null, by: actor.displayName, reason: "LAYOUT_CHANGED" });
    }
  }
  return { seatCount, rowLayout: SEAT_LAYOUTS[seatCount], unseated: result?.unseated ?? [] };
}

export async function listKicked(actor: User, roomId: string) {
  await assertAdmin(db, await getRoom(roomId), actor.id);
  return db
    .select({ ...userSummary, kickedAt: roomKicks.createdAt })
    .from(roomKicks)
    .innerJoin(users, eq(users.id, roomKicks.userId))
    .where(eq(roomKicks.roomId, roomId))
    .orderBy(desc(roomKicks.createdAt));
}

// Takes the user off the kicked-out list so they can join again.
export async function unkick(actor: User, roomId: string, targetUserId: string) {
  await assertAdmin(db, await getRoom(roomId), actor.id);
  const [row] = await db
    .delete(roomKicks)
    .where(and(eq(roomKicks.roomId, roomId), eq(roomKicks.userId, targetUserId)))
    .returning();
  return { unkicked: !!row };
}

// Presence: socket dropped / reconnected. Only affects UI state; grace timers decide release.
export async function setPresence(roomId: string, userId: string, presence: "CONNECTED" | "DISCONNECTED") {
  const roomVersion = await db.transaction(async (tx) => {
    await lockRoom(tx, roomId);
    const [p] = await tx
      .update(roomParticipants)
      .set({ presence, lastSeenAt: new Date() })
      .where(
        and(
          eq(roomParticipants.roomId, roomId),
          eq(roomParticipants.userId, userId),
          isNull(roomParticipants.leftAt),
          ne(roomParticipants.presence, presence),
        ),
      )
      .returning();
    return p ? bumpVersion(tx, roomId) : null;
  });
  if (roomVersion !== null && (await seatOf(roomId, userId))) await broadcastSeats(roomId, roomVersion);
}

export async function eligibleRecipients(user: User, roomId: string) {
  await assertMember(roomId, user.id);
  return (await getSeats(roomId)).filter((s) => s.occupant);
}

// Invite friends (mutual follows, no block either way) to the room you're in. Online friends get a live
// "room:invite" banner on whatever screen they're on; offline ones get it as a message with a Join button in their
// inbox. A heads-up only: joining still follows the room's normal rules.
export async function inviteFriends(user: User, roomId: string, userIds: string[]) {
  assertCanParticipate(user);
  rateLimit(`invite:${user.id}`, 30, 60_000);
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
  if (room?.status !== "LIVE") throw new AppError("ROOM_NOT_LIVE", 409);
  await assertMember(roomId, user.id);
  const ids = [...new Set(userIds)].filter((id) => id !== user.id);
  if (!ids.length) return { invited: 0 };
  const friends = await db
    .select({ id: follows.followedId })
    .from(follows)
    .where(
      and(
        eq(follows.followerId, user.id),
        inArray(follows.followedId, ids),
        sql`exists (select 1 from ${follows} f2 where f2.follower_id = ${follows.followedId} and f2.followed_id = ${user.id})`,
        sql`not exists (select 1 from ${blocks} b where (b.blocker_id = ${user.id} and b.blocked_id = ${follows.followedId}) or (b.blocker_id = ${follows.followedId} and b.blocked_id = ${user.id}))`,
      ),
    );
  const invite = {
    roomId,
    title: room.title,
    coverUrl: room.coverUrl,
    kind: room.kind,
    from: { userId: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl },
  };
  let invited = 0;
  let notified = 0;
  for (const f of friends) {
    if (isOnline(f.id)) {
      io.to(userChannel(f.id)).emit("room:invite", invite);
      invited++;
      continue;
    }
    const [msg] = await db
      .insert(directMessages)
      .values({ senderId: user.id, recipientId: f.id, body: `📣 Join me in "${room.title}"`, roomId })
      .returning();
    io.to(userChannel(f.id)).to(userChannel(user.id)).emit("dm:new", { ...msg, senderName: user.displayName });
    notified++;
  }
  return { invited, notified };
}
