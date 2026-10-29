import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { db, isUniqueViolation } from "../db";
import { chatMessages, roomParticipants, rooms, users, type User } from "../db/schema";
import { emitToRoom, io, roomChannel } from "../io";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { levelOf } from "../lib/levels";
import { store } from "../routes/posts";
import { assertCanParticipate } from "./auth";
import { activeBadgeIds } from "./badges";
import { assertMember, assertRoomAdmin, getActiveParticipant, systemMessage } from "./rooms";
import { cosmeticMinSvip, svipOf, svipSql, visibleAvatar, wearable } from "./svip";

export type ChatInput = { body: string; mentions: { userId: string }[]; clientMessageId: string };

type Sender = Pick<User, "id" | "displayName" | "avatarUrl" | "xp" | "chatBubbleId" | "avatarFrameId" | "staffRole"> & { svip: number | null };
// Badges and bubbles travel as ids; the app caches their artwork from /badges and /cosmetics.
// userId -> display name for everyone mentioned in these messages, so a mention stays tappable for people who've
// since left the room or gone offline (the app can't look them up among who's here).
async function mentionNamesFor(rows: { mentions: string[] }[]) {
  const ids = [...new Set(rows.flatMap((m) => m.mentions))];
  if (!ids.length) return new Map<string, string>();
  const people = await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, ids));
  return new Map(people.flatMap((p) => (p.name ? [[p.id, p.name] as const] : [])));
}

const toWire = (m: typeof chatMessages.$inferSelect, sender: Sender | null, badges: string[] = [], names = new Map<string, string>()) => ({
  messageId: String(m.id),
  roomId: m.roomId,
  type: m.type,
  body: m.body,
  mentions: m.mentions,
  mentionNames: Object.fromEntries(m.mentions.flatMap((id) => (names.has(id) ? [[id, names.get(id)!]] : []))) as Record<string, string>,
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
  const sender = await speaker(user, roomId);

  // A mention counts if that person exists and their @handle is in the text. They needn't be in the room now (someone
  // who just left, or is offline), so everyone can still tap the name for their profile.
  const ids = [...new Set(input.mentions.map((m) => m.userId))].slice(0, 10);
  const targets = ids.length ? await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, ids)) : [];
  const mentions = targets.filter((t) => body.includes(`@${t.displayName}`)).map((t) => t.id);
  return post(user, roomId, sender, { body, mentions, clientMessageId: input.clientMessageId });
}

// Photos in room chat, for users above Lv 10 (the app shows the button from then on). A chat message whose payload holds
// the photo; stored like post photos. Checks come before the upload is saved, and a retry doesn't save it twice.
export const CHAT_IMAGE_MIN_LEVEL = 11;
export async function sendChatImage(user: User, roomId: string, clientMessageId: string, file: File) {
  assertCanParticipate(user);
  if (levelOf(user.xp) < CHAT_IMAGE_MIN_LEVEL) throw new AppError("LEVEL_TOO_LOW", 403, `Photos in room chat unlock at Lv ${CHAT_IMAGE_MIN_LEVEL}`);
  rateLimit(`chatimg:${user.id}`, 3, 30_000);
  const sender = await speaker(user, roomId);
  const [prior] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(eq(chatMessages.roomId, roomId), eq(chatMessages.senderUserId, user.id), eq(chatMessages.clientMessageId, clientMessageId)));
  const imageUrl = prior ? null : `/v1/uploads/${(await store(file, ["image"])).name}`;
  return post(user, roomId, sender, { body: "📷 Photo", mentions: [], clientMessageId, payload: { imageUrl } });
}

// Animated emotes: a chat message from the sender whose payload names the emote; phones play it on the sender's seat
// (if seated) and keep the line in chat. Dice, roller and coin results are drawn here so nobody can fake them.
export const EMOTES = ["hand", "smile", "kiss", "angry", "heart", "laugh", "cry", "dice", "roller", "coin"] as const;
export const emoteSchema = z.object({ emote: z.enum(EMOTES), clientMessageId: z.string().min(1).max(64) });
const FACES: Record<string, string> = { hand: "✋", smile: "😊", kiss: "😘", angry: "😠", heart: "❤️", laugh: "😂", cry: "😭" };

export function drawEmote(emote: (typeof EMOTES)[number]): { body: string; result?: string } {
  if (emote === "dice") {
    const result = String(randomInt(1, 7));
    return { body: `🎲 rolled ${result}`, result };
  }
  if (emote === "roller") {
    const result = String(randomInt(0, 1000)).padStart(3, "0");
    return { body: `🎰 rolled ${result}`, result };
  }
  if (emote === "coin") {
    const result = randomInt(2) ? "Heads" : "Tails";
    return { body: `🪙 ${result}`, result };
  }
  return { body: FACES[emote]! };
}

export async function sendEmote(user: User, roomId: string, input: z.infer<typeof emoteSchema>) {
  assertCanParticipate(user);
  rateLimit(`emote:${user.id}`, 3, 5_000);
  const sender = await speaker(user, roomId);
  const { body, result } = drawEmote(input.emote);
  return post(user, roomId, sender, { body, mentions: [], clientMessageId: input.clientMessageId, payload: { emote: input.emote, result } });
}

// The sender as others see them, after checking they may talk here now.
async function speaker(user: User, roomId: string): Promise<Sender> {
  const [room] = await db.select({ status: rooms.status }).from(rooms).where(eq(rooms.id, roomId));
  if (room?.status !== "LIVE") throw new AppError("ROOM_NOT_LIVE", 409);
  await assertMember(roomId, user.id);
  // SVIP bubbles and frames show only while the sender still has the tier.
  const svip = await svipOf(user.id);
  const mins = await cosmeticMinSvip();
  return { ...user, svip, chatBubbleId: wearable(user.chatBubbleId, svip, mins), avatarFrameId: wearable(user.avatarFrameId, svip, mins) };
}

// Stores the message and sends it to everyone in the room. Blocks don't apply here: room chat is shared, and a block
// only stops private messages (dm.ts).
async function post(user: User, roomId: string, sender: Sender, values: { body: string; mentions: string[]; clientMessageId: string; payload?: Record<string, unknown> }) {
  let msg;
  try {
    [msg] = await db
      .insert(chatMessages)
      .values({ roomId, senderUserId: user.id, ...values })
      .returning();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Retry of a message we already stored: return it, don't re-broadcast.
    const [prior] = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.roomId, roomId), eq(chatMessages.senderUserId, user.id), eq(chatMessages.clientMessageId, values.clientMessageId)));
    return toWire(prior!, sender, (await activeBadgeIds([user.id])).get(user.id), await mentionNamesFor([prior!]));
  }

  const wire = toWire(msg!, sender, (await activeBadgeIds([user.id])).get(user.id), await mentionNamesFor([msg!]));
  io.to(roomChannel(roomId)).emit("room:chat:new", wire);
  return wire;
}

export async function history(viewer: User, roomId: string, cursor: number | undefined, limit: number) {
  // Only what was said since you joined (this visit): new arrivals don't read earlier conversations.
  const me = await getActiveParticipant(roomId, viewer.id);
  if (!me) throw new AppError("NOT_IN_ROOM", 403);
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
      ),
    )
    .orderBy(desc(chatMessages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const badgeMap = await activeBadgeIds([...new Set(page.map((r) => r.sender?.id).filter((x): x is string => !!x))]);
  const names = await mentionNamesFor(page.map((r) => r.m));
  const mins = await cosmeticMinSvip();
  return {
    messages: page.map((r) => toWire(r.m, r.sender?.id ? { ...r.sender, chatBubbleId: wearable(r.sender.chatBubbleId, r.sender.svip ?? 0, mins), avatarFrameId: wearable(r.sender.avatarFrameId, r.sender.svip ?? 0, mins) } : null, r.sender?.id ? badgeMap.get(r.sender.id) : [], names)),
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


// Owner/admins: clear the room's chat for everyone, including people who join later. The rows stay (moderation
// history), just hidden like moderated messages; phones empty their chat on "room:chat:cleared".
export async function clearChat(user: User, roomId: string) {
  await assertRoomAdmin(roomId, user.id);
  await db
    .update(chatMessages)
    .set({ moderationStatus: "CLEARED" })
    .where(and(eq(chatMessages.roomId, roomId), eq(chatMessages.moderationStatus, "VISIBLE")));
  emitToRoom(roomId, "room:chat:cleared", { roomId, by: user.displayName });
  await systemMessage(roomId, `${user.displayName ?? "An admin"} cleared the chat`, { kind: "CHAT_CLEARED", userId: user.id });
  return { cleared: true };
}
