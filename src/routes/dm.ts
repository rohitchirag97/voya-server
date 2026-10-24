import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db, isUniqueViolation } from "../db";
import { blocks, directMessages, follows, users } from "../db/schema";
import { json, requireAuth, schemas, type Env } from "../http";
import { io, userChannel } from "../io";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate } from "../services/auth";
import { cardsFor } from "../services/cp";
import { userSummary } from "../services/rooms";

export const dm = new Hono<Env>();
dm.use("/dm", requireAuth);
dm.use("/dm/*", requireAuth);

// Inbox: one row per person I've messaged with, newest conversation first, with the last message.
// shortcut: no read receipts or unread counts yet; add a per-pair lastReadId when needed.
dm.get("/dm", async (c) => {
  const me = c.get("user").id;
  const latest = await db.execute<{ peer: string; id: string }>(sql`
    select distinct on (peer) peer, id from (
      select case when ${directMessages.senderId} = ${me} then ${directMessages.recipientId} else ${directMessages.senderId} end as peer, ${directMessages.id} as id
      from ${directMessages} where ${directMessages.senderId} = ${me} or ${directMessages.recipientId} = ${me}
    ) t order by peer, id desc`);
  const ids = latest.rows.map((r) => Number(r.id));
  if (!ids.length) return c.json({ conversations: [] });
  const [msgs, people] = await Promise.all([
    db.select().from(directMessages).where(inArray(directMessages.id, ids)).orderBy(desc(directMessages.id)),
    db.select(userSummary).from(users).where(inArray(users.id, latest.rows.map((r) => r.peer))),
  ]);
  const byId = new Map(people.map((u) => [u.userId, u]));
  return c.json({
    conversations: msgs.map((m) => ({ user: byId.get(m.senderId === me ? m.recipientId : m.senderId)!, lastMessage: m })),
  });
});

const between = (a: string, b: string) =>
  or(
    and(eq(directMessages.senderId, a), eq(directMessages.recipientId, b)),
    and(eq(directMessages.senderId, b), eq(directMessages.recipientId, a)),
  );

const other = (c: { req: { param: (k: "userId") => string } }, me: string) => {
  const id = schemas.uuid.parse(c.req.param("userId"));
  if (id === me) throw new AppError("CANNOT_TARGET_SELF", 400);
  return id;
};

dm.get("/dm/:userId", async (c) => {
  const me = c.get("user").id;
  const them = other(c, me);
  const q = schemas.numericPage.parse(c.req.query());
  const rows = await db
    .select()
    .from(directMessages)
    .where(and(between(me, them), q.cursor ? lt(directMessages.id, q.cursor) : undefined))
    .orderBy(desc(directMessages.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const cards = await cardsFor(page.flatMap((m) => (m.cpProposalId ? [m.cpProposalId] : [])));
  return c.json({
    messages: page.map((m) => (m.cpProposalId ? { ...m, cp: cards.get(m.cpProposalId) ?? null } : m)),
    nextCursor: rows.length > q.limit ? String(page.at(-1)!.id) : null,
  });
});

// Friends only (both follow each other), and never across a block in either direction.
dm.post("/dm/:userId", async (c) => {
  const user = c.get("user");
  assertCanParticipate(user);
  const them = other(c, user.id);
  const b = await json(c, z.object({ body: z.string().trim().min(1).max(1000), clientMessageId: z.string().min(1).max(64) }));
  rateLimit(`dm:${user.id}`, 20, 10_000);

  const pairs = await db
    .select({ a: follows.followerId })
    .from(follows)
    .where(or(and(eq(follows.followerId, user.id), eq(follows.followedId, them)), and(eq(follows.followerId, them), eq(follows.followedId, user.id))));
  if (pairs.length < 2) throw new AppError("NOT_FRIENDS", 403, "You can only message friends (you follow each other)");
  const [blocked] = await db
    .select({ a: blocks.blockerId })
    .from(blocks)
    .where(or(and(eq(blocks.blockerId, user.id), eq(blocks.blockedId, them)), and(eq(blocks.blockerId, them), eq(blocks.blockedId, user.id))));
  if (blocked) throw new AppError("BLOCKED", 403, "You can't message this person");

  let msg;
  try {
    [msg] = await db.insert(directMessages).values({ senderId: user.id, recipientId: them, body: b.body, clientMessageId: b.clientMessageId }).returning();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Retry of a message we already stored.
    [msg] = await db
      .select()
      .from(directMessages)
      .where(and(eq(directMessages.senderId, user.id), eq(directMessages.clientMessageId, b.clientMessageId)));
    return c.json(msg, 200);
  }
  // Live delivery to both sides (the sender may have the chat open on another device).
  io.to(userChannel(them)).to(userChannel(user.id)).emit("dm:new", msg);
  return c.json(msg, 201);
});
