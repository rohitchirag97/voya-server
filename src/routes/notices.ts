import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { json, requireAuth, requireStaff, schemas, type Env } from "../http";
import { db } from "../db";
import { notices, users } from "../db/schema";
import { AppError } from "../lib/errors";
import { saveEventImage } from "../services/events";

// Notices (schema: notices): the app shows live ones in the home carousel and inbox ones under the Notices tile;
// the admin panel (owner/admin) writes them.
export const noticeRoutes = new Hono<Env>();
noticeRoutes.use("/notices", requireAuth);
noticeRoutes.use("/notices/*", requireAuth);
noticeRoutes.use("/admin/notices", requireAuth, requireStaff("OWNER", "ADMIN"));
noticeRoutes.use("/admin/notices/*", requireAuth, requireStaff("OWNER", "ADMIN"));

const card = { id: notices.id, title: notices.title, imageUrl: notices.imageUrl, color: notices.color, homeTab: notices.homeTab, startsAt: notices.startsAt, endsAt: notices.endsAt };
const started = and(eq(notices.published, true), lte(notices.startsAt, sql`now()`));
const forEveryone = isNull(notices.userId); // personal messages (a gift receipt) only go to their user's inbox

// Carousel: live now.
noticeRoutes.get("/notices", async (c) =>
  c.json({ notices: await db.select(card).from(notices).where(and(started, forEveryone, gt(notices.endsAt, sql`now()`))).orderBy(asc(notices.sortOrder), desc(notices.startsAt)) }),
);

// Inbox tile: every started inbox notice, newest first, and how many came since I last looked.
noticeRoutes.get("/notices/inbox", async (c) => {
  const seen = c.get("user").noticesSeenAt;
  const list = await db
    .select(card)
    .from(notices)
    .where(and(started, eq(notices.inInbox, true), or(isNull(notices.userId), eq(notices.userId, c.get("user").id))))
    .orderBy(desc(notices.startsAt))
    .limit(50);
  return c.json({ notices: list, unread: list.filter((n) => !seen || n.startsAt > seen).length });
});
noticeRoutes.post("/notices/seen", async (c) => {
  await db.update(users).set({ noticesSeenAt: new Date() }).where(eq(users.id, c.get("user").id));
  return c.json({ ok: true });
});

// One notice in full. Unpublished or not started yet: staff only (panel links).
noticeRoutes.get("/notices/:id", async (c) => {
  const [n] = await db.select().from(notices).where(eq(notices.id, schemas.uuid.parse(c.req.param("id"))));
  const me = c.get("user");
  if (!n || ((!n.published || n.startsAt > new Date() || (n.userId && n.userId !== me.id)) && !me.staffRole)) throw new AppError("NOT_FOUND", 404, "No such notice");
  return c.json({ id: n.id, title: n.title, body: n.body, imageUrl: n.imageUrl, color: n.color, startsAt: n.startsAt });
});

// ---------- admin ----------

const fields = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().max(4000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colour as #RRGGBB"),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  published: z.boolean(),
  inInbox: z.boolean(),
  homeTab: z.enum(["BOTH", "LIVE", "ROOMS"]).optional(), // unset: both (column default)
  sortOrder: z.number().int().min(0).max(100_000),
});
const checkWindow = (startsAt: Date, endsAt: Date) => {
  if (endsAt <= startsAt) throw new AppError("VALIDATION_ERROR", 400, "The notice must end after it starts");
};
async function getNotice(id: string) {
  const [n] = await db.select().from(notices).where(eq(notices.id, id));
  if (!n) throw new AppError("NOT_FOUND", 404, "No such notice");
  return n;
}

noticeRoutes.get("/admin/notices", async (c) => c.json({ notices: await db.select().from(notices).where(forEveryone).orderBy(desc(notices.createdAt)).limit(200) }));

noticeRoutes.post("/admin/notices", async (c) => {
  const b = await json(c, fields);
  checkWindow(b.startsAt, b.endsAt);
  const [n] = await db.insert(notices).values({ ...b, createdBy: c.get("user").id }).returning();
  return c.json(n, 201);
});

noticeRoutes.patch("/admin/notices/:id", async (c) => {
  const id = schemas.uuid.parse(c.req.param("id"));
  const b = await json(c, fields.partial());
  const n = await getNotice(id);
  checkWindow(b.startsAt ?? n.startsAt, b.endsAt ?? n.endsAt);
  const [saved] = await db.update(notices).set(b).where(eq(notices.id, id)).returning();
  return c.json(saved);
});

// Slide image (multipart "file"); "remove" in the form clears it, so the app draws the slide again.
noticeRoutes.post("/admin/notices/:id/image", async (c) => {
  const id = schemas.uuid.parse(c.req.param("id"));
  await getNotice(id);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  let imageUrl: string | null = null;
  if (!form?.get("remove")) {
    if (!(file instanceof File) || !file.size) throw new AppError("FILE_REQUIRED", 400, "Choose an image");
    imageUrl = await saveEventImage(file);
  }
  const [saved] = await db.update(notices).set({ imageUrl }).where(eq(notices.id, id)).returning();
  return c.json(saved);
});

noticeRoutes.delete("/admin/notices/:id", async (c) => {
  const id = schemas.uuid.parse(c.req.param("id"));
  await getNotice(id);
  await db.delete(notices).where(eq(notices.id, id));
  return c.json({ ok: true });
});
