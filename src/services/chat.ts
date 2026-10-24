import { and, desc, eq, gte, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, isUniqueViolation } from "../db";
import { blocks, chatMessages, roomParticipants, rooms, users, type User } from "../db/schema";
import { io, roomChannel } from "../io";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { levelOf } from "../lib/levels";
import { assertCanParticipate } from "./auth";
import { activeBadgeIds } from "./badges";
import { assertMember, getActiveParticipant } from "./rooms";
import { cosmeticMinSvip, svipOf, svipSql, visibleAvatar, wearable } from "./svip";

export type ChatInput = { body: string; mentions: { userId: string }[]; clientMessageId: string };

// Everyone who blocked `userId` or whom `userId` blocked: they never see each other's messages.
async function blockedWith(userId: string) {
  const rows = await db
    .select({ a: blocks.blockerId, b: blocks.blockedId })
    .from(blocks)
    .where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));
  return new Set(rows.map((r) => (r.a === userId ? r.b : r.a)));
}

type Sender = Pick<User, "id" | "displayName" | "avatarUrl" | "xp" | "chatBubbleId" | "avatarFrameId" | "staffRole"> & { svip: number | null };
// Badges and bubbles travel as ids; the app caches their artwork from /badges and /cosmetics.
const toWire = (m: typeof chatMessages.$inferSelect, sender: Sender | null, badges: string[] = []) => ({
  messageId: String(m.id),
  roomId: m.roomId,
  type: m.type,
  body: m.body,
  mentions: m.mentions,
  payload: m.payload,
  clientMessageId: m.clientMessageId,
  sender: sender && {
    userId: sender.id,
    displayName: sender.displayName,
    avatarUrl: visibleAvatar(sender.avatarUrl, sender.svip ?? 0),
    level: levelOf(sender.xp),
    bubbleId: sender.chatBubbleId,
    frameId: sender.avatarFrameId,
    staffRole: sender.staffRole,
    svip: sender.svip ?? 0,
    badges,
  },
  createdAt: m.createdAt,
});

export async function sendChat(user: User, roomId: string, input: ChatInput) {
  assertCanParticipate(user);
  rateLimit(`chat:${user.id}`, 10, 10_000);
  const body = input.body.trim();
  if (!body) throw new AppError("EMPTY_MESSAGE", 400);
  rateLimit(`chat:dup:${user.id}:${createHash("sha1").update(body).digest("hex")}`, 2, 30_000);

  const [room] = await db.select({ status: rooms.status }).from(rooms).where(eq(rooms.id, roomId));
  if (room?.status !== "LIVE") throw new AppError("ROOM_NOT_LIVE", 409);
  await assertMember(roomId, user.id);

  // A mention counts only if the target is a current participant and their @handle is in the text.
  const ids = [...new Set(input.mentions.map((m) => m.userId))].slice(0, 10);
  const targets = ids.length
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(roomParticipants)
        .innerJoin(users, eq(users.id, roomParticipants.userId))
        .where(and(eq(roomParticipants.roomId, roomId), isNull(roomParticipants.leftAt), inArray(roomParticipants.userId, ids)))
    : [];
  const mentions = targets.filter((t) => body.includes(`@${t.displayName}`)).map((t) => t.id);

  // SVIP bubbles and frames show only while the sender still has the tier.
  const svip = await svipOf(user.id);
  const mins = await cosmeticMinSvip();
  const sender = { ...user, svip, chatBubbleId: wearable(user.chatBubbleId, svip, mins), avatarFrameId: wearable(user.avatarFrameId, svip, mins) };

  let msg;
  try {
    [msg] = await db
      .insert(chatMessages)
      .values({ roomId, senderUserId: user.id, body, mentions, clientMessageId: input.clientMessageId })
      .returning();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Retry of a message we already stored: return it, don't re-broadcast.
    const [prior] = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.roomId, roomId), eq(chatMessages.senderUserId, user.id), eq(chatMessages.clientMessageId, input.clientMessageId)));
    return toWire(prior!, sender, (await activeBadgeIds([user.id])).get(user.id));
  }

  const wire = toWire(msg!, sender, (await activeBadgeIds([user.id])).get(user.id));
  const hidden = await blockedWith(user.id);
  for (const s of await io.in(roomChannel(roomId)).fetchSockets()) {
    if (!hidden.has(s.data.userId)) s.emit("room:chat:new", wire);
  }
  return wire;
}

export async function history(viewer: User, roomId: string, cursor: number | undefined, limit: number) {
  // Only what was said since you joined (this visit): new arrivals don't read earlier conversations.
  const me = await getActiveParticipant(roomId, viewer.id);
  if (!me) throw new AppError("NOT_IN_ROOM", 403);
  const hidden = [...(await blockedWith(viewer.id))];
  const rows = await db
    .select({
      m: chatMessages,
      sender: { id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, xp: users.xp, chatBubbleId: users.chatBubbleId, avatarFrameId: users.avatarFrameId, staffRole: users.staffRole, svip: sql<number | null>`case when ${users.id} is null then null else ${svipSql} end` },
    })
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.senderUserId))
    .where(
      and(
        eq(chatMessages.roomId, roomId),
        eq(chatMessages.moderationStatus, "VISIBLE"),
        gte(chatMessages.createdAt, me.joinedAt),
        // Notices we no longer show (older rows may still exist).
        sql`coalesce(${chatMessages.payload}->>'kind', '') not in ('LEAVE', 'ADMIN_GRANTED', 'ADMIN_REVOKED')`,
        cursor ? lt(chatMessages.id, cursor) : undefined,
        hidden.length ? or(isNull(chatMessages.senderUserId), notInArray(chatMessages.senderUserId, hidden)) : undefined,
      ),
    )
    .orderBy(desc(chatMessages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const badgeMap = await activeBadgeIds([...new Set(page.map((r) => r.sender?.id).filter((x): x is string => !!x))]);
  const mins = await cosmeticMinSvip();
  return {
    messages: page.map((r) => toWire(r.m, r.sender?.id ? { ...r.sender, chatBubbleId: wearable(r.sender.chatBubbleId, r.sender.svip ?? 0, mins), avatarFrameId: wearable(r.sender.avatarFrameId, r.sender.svip ?? 0, mins) } : null, r.sender?.id ? badgeMap.get(r.sender.id) : [])),
    nextCursor: rows.length > limit ? String(page.at(-1)!.m.id) : null,
  };
}

export const typingAllowed = (userId: string) => {
  try {
    rateLimit(`typing:${userId}`, 1, 2000);
    return true;
  } catch {
    return false;
  }
};

