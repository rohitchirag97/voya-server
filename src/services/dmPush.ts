import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import { directMessages } from "../db/schema";
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
