import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import { directMessages, users, type CoinNotice } from "../db/schema";
import { io, userChannel } from "../io";

// Inbox messages live on phones, not here: the server only holds each one until the recipient's phone has it
// (it acks, and the row is deleted). These are the only places that hand a message to the phones.

type Msg = typeof directMessages.$inferSelect;
type Sender = { id: string; displayName: string | null; avatarUrl: string | null };

// Live delivery to both sides (the sender's phone keeps its own copy too), with who sent it so the recipient's inbox can
// show them without asking the server.
export function pushDm(msg: Msg, sender: Sender, extra: Record<string, unknown> = {}) {
  io.to(userChannel(msg.recipientId))
    .to(userChannel(msg.senderId))
    .emit("dm:new", { ...msg, ...extra, senderName: sender.displayName, sender: { userId: sender.id, displayName: sender.displayName, avatarUrl: sender.avatarUrl } });
}

// The recipient's phone saved these: forget them (only ones addressed to that user).
export async function ackDms(userId: string, ids: number[]) {
  if (!ids.length) return 0;
  const gone = await db
    .delete(directMessages)
    .where(and(eq(directMessages.recipientId, userId), inArray(directMessages.id, ids)))
    .returning({ id: directMessages.id });
  return gone.length;
}

export const DM_HOLD_DAYS = 30;
// Messages nobody picked up (phone never came back) don't stay forever.
export async function purgeUndelivered() {
  const gone = await db
    .delete(directMessages)
    .where(lt(directMessages.createdAt, new Date(Date.now() - DM_HOLD_DAYS * 86_400_000)))
    .returning({ id: directMessages.id });
  return gone.length;
}

// System sender for coin notices, shown as Support staff. Its phone fails the E.164 check (+ then 0), so no OTP can ever be
// requested for it, and it has no Google account: nobody can sign in as it. Created on first use; migrate seeds it to
// reserve the name.
const RECHARGE_BOT_PHONE = "+0000000000";
export async function rechargeBot() {
  await db.insert(users).values({ phone: RECHARGE_BOT_PHONE, displayName: "Recharge Notification", staffRole: "SUPPORT" }).onConflictDoNothing();
  const [bot] = await db.select().from(users).where(eq(users.phone, RECHARGE_BOT_PHONE));
  return bot!;
}

const STATUS_TEXT = { SUCCESS: "successful", PENDING: "pending", FAILED: "failed" } as const;

// Receipt card from the Recharge Notification account (bypasses the friends-only rule; replies are refused by it).
// The body is the plain-text version for push notifications and older apps; it never names the seller.
export async function notifyCoins(userId: string, notice: CoinNotice) {
  const bot = await rechargeBot();
  const what = notice.kind === "RECHARGE" ? "Recharge" : "Coin top-up";
  const body = `${what} ${STATUS_TEXT[notice.status]}: ${notice.coins} coins · ${notice.txnId}`;
  const [msg] = await db.insert(directMessages).values({ senderId: bot.id, recipientId: userId, body, notice }).returning();
  pushDm(msg!, bot);
}
