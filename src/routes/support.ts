import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { db, isUniqueViolation } from "../db";
import { supportMessages, supportThreads, users, type User } from "../db/schema";
import { json, requireAuth, schemas, type Env } from "../http";
import { io, userChannel } from "../io";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { store } from "./posts";
import { userSummary } from "../services/rooms";
import { svipOf } from "../services/svip";

// Support chats pinned in every inbox. A user writes to a desk; whichever staff member is free answers, and the user
// sees the reply as "<desk name> (<staff name>)". GENERAL: every user; any staff role answers. SVIP: users with an active
// SVIP (the chat disappears when it ends; its history comes back if they're SVIP again); owner and admins answer.
// Unlike DMs these stay on the server, so every staff member sees the whole conversation.
export const support = new Hono<Env>();
support.use("/support/*", requireAuth);
support.use("/support", requireAuth);
support.use("/support-desk/*", requireAuth);
support.use("/support-desk", requireAuth);

type Desk = "GENERAL" | "SVIP";
const DESK_NAME: Record<Desk, string> = { GENERAL: "VoyaLive Support", SVIP: "SVIP Support" };
const STAFF: Record<Desk, NonNullable<User["staffRole"]>[]> = { GENERAL: ["OWNER", "ADMIN", "MODERATOR", "SUPPORT"], SVIP: ["OWNER", "ADMIN"] };
const deskParam = z.enum(["general", "svip"]).transform((d) => d.toUpperCase() as Desk);
const PAGE = 50;

const canAnswer = (user: User, desk: Desk) => !!user.staffRole && STAFF[desk].includes(user.staffRole);
async function assertCanWrite(user: User, desk: Desk) {
  if (desk === "SVIP" && !((await svipOf(user.id)) > 0)) throw new AppError("SVIP_ONLY", 403, "SVIP Support is for SVIP members");
}

// Messages with the sender's name (staff names show on their replies).
async function messagesOf(threadId: string, cursor?: number) {
  const rows = await db
    .select({ message: supportMessages, senderName: users.displayName })
    .from(supportMessages)
    .innerJoin(users, eq(users.id, supportMessages.senderId))
    .where(and(eq(supportMessages.threadId, threadId), cursor ? lt(supportMessages.id, cursor) : undefined))
    .orderBy(desc(supportMessages.id))
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE).map((r) => ({ ...r.message, senderName: r.senderName }));
  return { messages: page, nextCursor: rows.length > PAGE ? String(page.at(-1)!.id) : null };
}

// Live: to the user (all their phones) and to every staff member who answers that desk.
async function announce(thread: typeof supportThreads.$inferSelect, message: typeof supportMessages.$inferSelect, sender: User) {
  const staff = await db.select({ id: users.id }).from(users).where(inArray(users.staffRole, STAFF[thread.desk]));
  const event = { desk: thread.desk, deskName: DESK_NAME[thread.desk], threadId: thread.id, userId: thread.userId, message: { ...message, senderName: sender.displayName } };
  let to = io.to(userChannel(thread.userId));
  for (const s of staff) to = to.to(userChannel(s.id));
  to.emit("support:new", event);
}

async function post(c: Context<Env>, thread: typeof supportThreads.$inferSelect, fromStaff: boolean, values: { body: string; imageUrl?: string; clientMessageId: string }) {
  const user = c.get("user");
  rateLimit(`support:${user.id}`, 20, 10_000);
  let msg;
  try {
    [msg] = await db.insert(supportMessages).values({ threadId: thread.id, senderId: user.id, fromStaff, ...values }).returning();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const [prior] = await db.select().from(supportMessages).where(and(eq(supportMessages.senderId, user.id), eq(supportMessages.clientMessageId, values.clientMessageId)));
    return c.json({ ...prior!, senderName: user.displayName }, 200); // a retry
  }
  await db
    .update(supportThreads)
    .set({ open: !fromStaff, lastMessageAt: msg!.createdAt, ...(fromStaff && { lastStaffId: user.id }), ...(!fromStaff && { userLastReadId: msg!.id }) })
    .where(eq(supportThreads.id, thread.id));
  await announce(thread, msg!, user);
  return c.json({ ...msg!, senderName: user.displayName }, 201);
}

const text = z.object({ body: z.string().trim().min(1).max(1000), clientMessageId: z.string().min(1).max(64) });
async function photo(c: Context<Env>) {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  const clientMessageId = z.string().min(1).max(64).parse(form?.get("clientMessageId"));
  if (!(file instanceof File)) throw new AppError("FILE_REQUIRED", 400, "Choose a photo");
  const { name } = await store(file, ["image"]);
  return { body: "📷 Photo", imageUrl: `/v1/uploads/${name}`, clientMessageId };
}

// ---------- users ----------

async function myThread(user: User, desk: Desk) {
  await db.insert(supportThreads).values({ userId: user.id, desk, open: false }).onConflictDoNothing();
  const [t] = await db.select().from(supportThreads).where(and(eq(supportThreads.userId, user.id), eq(supportThreads.desk, desk)));
  return t!;
}

// The pinned chats for my inbox: General always, SVIP while I'm SVIP; each with its last message and my unread count.
support.get("/support", async (c) => {
  const user = c.get("user");
  const desks: Desk[] = (await svipOf(user.id)) > 0 ? ["GENERAL", "SVIP"] : ["GENERAL"];
  const threads = await db.select().from(supportThreads).where(and(eq(supportThreads.userId, user.id), inArray(supportThreads.desk, desks)));
  const chats = await Promise.all(
    desks.map(async (desk) => {
      const t = threads.find((x) => x.desk === desk);
      if (!t) return { desk, name: DESK_NAME[desk], lastMessage: null, unread: 0 };
      const [last] = await db.select().from(supportMessages).where(eq(supportMessages.threadId, t.id)).orderBy(desc(supportMessages.id)).limit(1);
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(supportMessages)
        .where(and(eq(supportMessages.threadId, t.id), eq(supportMessages.fromStaff, true), gt(supportMessages.id, t.userLastReadId)));
      return { desk, name: DESK_NAME[desk], lastMessage: last ?? null, unread: row?.n ?? 0 };
    }),
  );
  return c.json({ chats });
});

// My conversation with a desk, newest first; the first page marks staff replies read.
support.get("/support/:desk/messages", async (c) => {
  const user = c.get("user");
  const desk = deskParam.parse(c.req.param("desk"));
  await assertCanWrite(user, desk);
  const thread = await myThread(user, desk);
  const q = schemas.numericPage.parse(c.req.query());
  const page = await messagesOf(thread.id, q.cursor);
  if (!q.cursor && page.messages[0])
    await db.update(supportThreads).set({ userLastReadId: sql`greatest(${supportThreads.userLastReadId}, ${page.messages[0].id})` }).where(eq(supportThreads.id, thread.id));
  return c.json({ ...page, name: DESK_NAME[desk] });
});

support.post("/support/:desk/messages", async (c) => {
  const user = c.get("user");
  const desk = deskParam.parse(c.req.param("desk"));
  const b = await json(c, text);
  await assertCanWrite(user, desk);
  return post(c, await myThread(user, desk), false, b);
});

support.post("/support/:desk/image", async (c) => {
  const user = c.get("user");
  const desk = deskParam.parse(c.req.param("desk"));
  await assertCanWrite(user, desk);
  return post(c, await myThread(user, desk), false, await photo(c));
});

// ---------- staff ----------

// The desks this staff member answers, with how many conversations wait on each.
support.get("/support-desk", async (c) => {
  const user = c.get("user");
  const desks = (["GENERAL", "SVIP"] as Desk[]).filter((d) => canAnswer(user, d));
  if (!desks.length) throw new AppError("FORBIDDEN", 403, "Not allowed");
  const open = await db
    .select({ desk: supportThreads.desk, n: sql<number>`count(*)::int` })
    .from(supportThreads)
    .where(and(inArray(supportThreads.desk, desks), eq(supportThreads.open, true)))
    .groupBy(supportThreads.desk);
  return c.json({ desks: desks.map((d) => ({ desk: d, name: DESK_NAME[d], open: open.find((o) => o.desk === d)?.n ?? 0 })) });
});

// One desk's conversations: waiting ones first, then newest. Each with the user, the last message and who answered last.
support.get("/support-desk/:desk", async (c) => {
  const user = c.get("user");
  const desk = deskParam.parse(c.req.param("desk"));
  if (!canAnswer(user, desk)) throw new AppError("FORBIDDEN", 403, "Not allowed");
  const threads = await db
    .select()
    .from(supportThreads)
    .where(eq(supportThreads.desk, desk))
    .orderBy(desc(supportThreads.open), desc(supportThreads.lastMessageAt))
    .limit(200);
  const ids = threads.map((t) => t.id);
  if (!ids.length) return c.json({ threads: [] });
  const people = [...new Set(threads.flatMap((t) => [t.userId, ...(t.lastStaffId ? [t.lastStaffId] : [])]))];
  const [who, lasts] = await Promise.all([
    db.select(userSummary).from(users).where(inArray(users.id, people)),
    db.execute<{ thread_id: string; body: string; from_staff: boolean }>(sql`
      select distinct on (thread_id) thread_id, body, from_staff from ${supportMessages}
      where thread_id in ${ids} order by thread_id, id desc`),
  ]);
  const byId = new Map(who.map((u) => [u.userId, u]));
  const last = new Map(lasts.rows.map((r) => [r.thread_id, r]));
  return c.json({
    threads: threads
      .filter((t) => last.has(t.id)) // opened but never written in
      .map((t) => ({
        threadId: t.id,
        user: byId.get(t.userId)!,
        open: t.open,
        lastMessageAt: t.lastMessageAt,
        lastMessage: { body: last.get(t.id)!.body, fromStaff: last.get(t.id)!.from_staff },
        lastStaff: t.lastStaffId ? (byId.get(t.lastStaffId)?.displayName ?? null) : null,
      })),
  });
});

async function staffThread(c: Context<Env>) {
  const [t] = await db.select().from(supportThreads).where(eq(supportThreads.id, schemas.uuid.parse(c.req.param("threadId"))));
  if (!t) throw new AppError("NOT_FOUND", 404, "No such conversation");
  if (!canAnswer(c.get("user"), t.desk)) throw new AppError("FORBIDDEN", 403, "Not allowed");
  return t;
}

support.get("/support-desk/threads/:threadId", async (c) => {
  const t = await staffThread(c);
  const q = schemas.numericPage.parse(c.req.query());
  const [user] = await db.select(userSummary).from(users).where(eq(users.id, t.userId));
  return c.json({ ...(await messagesOf(t.id, q.cursor)), user, desk: t.desk, name: DESK_NAME[t.desk], open: t.open });
});

support.post("/support-desk/threads/:threadId/messages", async (c) => {
  const t = await staffThread(c);
  return post(c, t, true, await json(c, text));
});

support.post("/support-desk/threads/:threadId/image", async (c) => {
  const t = await staffThread(c);
  return post(c, t, true, await photo(c));
});
