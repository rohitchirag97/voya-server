import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { db, isUniqueViolation } from "../db";
import { blocks, directMessages, dmReads, follows, users, type User } from "../db/schema";
import { json, requireAuth, schemas, type Env } from "../http";
import { io, userChannel } from "../io";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate } from "../services/auth";
import { awardDm, cardsFor, relationshipsOf } from "../services/cp";
import { store } from "./posts";
import { userSummary } from "../services/rooms";

export const dm = new Hono<Env>();
dm.use("/dm", requireAuth);
dm.use("/dm/*", requireAuth);

// Unread messages to `me`, per sender: anything newer than the last one I opened in that chat.
async function unreadBySender(me: string) {
  const { rows } = await db.execute<{ peer: string; n: number }>(sql`
    select m.sender_id as peer, count(*)::int as n
    from ${directMessages} m
    left join ${dmReads} r on r.user_id = ${me} and r.peer_id = m.sender_id
    where m.recipient_id = ${me} and m.id > coalesce(r.last_read_id, 0)
    group by m.sender_id`);
  return new Map(rows.map((r) => [r.peer, Number(r.n)]));
}

// Everything from `them` up to now counts as read by `me`.
const markRead = (me: string, them: string) =>
  db.execute(sql`
    insert into ${dmReads} (user_id, peer_id, last_read_id)
    select ${me}, ${them}, coalesce(max(id), 0) from ${directMessages} where sender_id = ${them} and recipient_id = ${me}
    on conflict (user_id, peer_id) do update set last_read_id = greatest(${dmReads}.last_read_id, excluded.last_read_id)`);

// Total unread, for the badge on the Messages button (room bar, tabs).
dm.get("/dm/unread", async (c) => {
  const by = await unreadBySender(c.get("user").id);
  return c.json({ count: [...by.values()].reduce((a, b) => a + b, 0) });
});

// Inbox: one row per person I've messaged with, newest conversation first, with the last message and unread count.
dm.get("/dm", async (c) => {
  const me = c.get("user").id;
  const latest = await db.execute<{ peer: string; id: string }>(sql`
    select distinct on (peer) peer, id from (
      select case when ${directMessages.senderId} = ${me} then ${directMessages.recipientId} else ${directMessages.senderId} end as peer, ${directMessages.id} as id
      from ${directMessages} where ${directMessages.senderId} = ${me} or ${directMessages.recipientId} = ${me}
    ) t order by peer, id desc`);
  const ids = latest.rows.map((r) => Number(r.id));
  if (!ids.length) return c.json({ conversations: [] });
  const [msgs, people, cps, unread] = await Promise.all([
    db.select().from(directMessages).where(inArray(directMessages.id, ids)).orderBy(desc(directMessages.id)),
    db.select(userSummary).from(users).where(inArray(users.id, latest.rows.map((r) => r.peer))),
    relationshipsOf(me),
    unreadBySender(me),
  ]);
  const byId = new Map(people.map((u) => [u.userId, u]));
  // CP with this person, if any: type, how long, and its level.
  const cpWith = new Map(cps.map((r) => [r.user.userId, { type: r.type, label: r.label, since: r.since, level: r.level }]));
  return c.json({
    conversations: msgs.map((m) => {
      const peer = m.senderId === me ? m.recipientId : m.senderId;
      return { user: byId.get(peer)!, lastMessage: m, cp: cpWith.get(peer) ?? null, unread: unread.get(peer) ?? 0 };
    }),
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
  if (!q.cursor) await markRead(me, them); // opening the chat reads it
  const [cards, cps] = await Promise.all([cardsFor(page.flatMap((m) => (m.cpProposalId ? [m.cpProposalId] : []))), relationshipsOf(me)]);
  const cp = cps.find((r) => r.user.userId === them);
  return c.json({
    messages: page.map((m) => (m.cpProposalId ? { ...m, cp: cards.get(m.cpProposalId) ?? null } : m)),
    nextCursor: rows.length > q.limit ? String(page.at(-1)!.id) : null,
    cp: cp ? { type: cp.type, label: cp.label, since: cp.since, level: cp.level } : null, // your CP with them, for the chat header
  });
});

// The chat is open and a new message arrived in it.
dm.post("/dm/:userId/read", async (c) => {
  const me = c.get("user").id;
  await markRead(me, other(c, me));
  return c.json({ ok: true });
});

// Friends only (both follow each other), and never across a block in either direction.
async function assertCanMessage(user: User, them: string) {
  assertCanParticipate(user);
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
}

dm.post("/dm/:userId", async (c) => {
  const user = c.get("user");
  const them = other(c, user.id);
  const b = await json(c, z.object({ body: z.string().trim().min(1).max(1000), clientMessageId: z.string().min(1).max(64) }));
  await assertCanMessage(user, them);
  return deliver(c, { senderId: user.id, recipientId: them, body: b.body, clientMessageId: b.clientMessageId });
});

// A photo (multipart: "file" JPEG/PNG, "clientMessageId"). Same rules as text; stored like post photos.
dm.post("/dm/:userId/image", async (c) => {
  const user = c.get("user");
  const them = other(c, user.id);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  const clientMessageId = z.string().min(1).max(64).parse(form?.get("clientMessageId"));
  if (!(file instanceof File)) throw new AppError("FILE_REQUIRED", 400, "Choose a photo");
  await assertCanMessage(user, them);
  const prior = await priorMessage(user.id, clientMessageId);
  if (prior) return c.json(prior, 200); // retry: don't store the photo twice
  const { name } = await store(file, ["image"]);
  return deliver(c, { senderId: user.id, recipientId: them, body: "📷 Photo", imageUrl: `/v1/uploads/${name}`, clientMessageId });
});

const priorMessage = async (senderId: string, clientMessageId: string) =>
  (await db.select().from(directMessages).where(and(eq(directMessages.senderId, senderId), eq(directMessages.clientMessageId, clientMessageId))))[0];

async function deliver(c: Context<Env>, values: typeof directMessages.$inferInsert) {
  const { senderId: me, recipientId: them } = values;
  let msg;
  try {
    [msg] = await db.insert(directMessages).values(values).returning();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Retry of a message we already stored.
    return c.json(await priorMessage(me, values.clientMessageId!), 200);
  }
  // Live delivery to both sides (the sender may have the chat open on another device).
  io.to(userChannel(them)).to(userChannel(me)).emit("dm:new", { ...msg, senderName: c.get("user").displayName });
  await awardDm(me, them).catch(() => {}); // CP level points; never fails the message
  return c.json(msg, 201);
}
