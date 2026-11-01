import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { events, notices, rooms, splashes, users, type SplashAction } from "../db/schema";
import { requireAuth, schemas, type Env } from "../http";
import { AppError } from "../lib/errors";
import { fileType, saveItemFile } from "../services/items";
import { requirePerm } from "../services/roles";

// Splash screens: the app reads what's live (and starting within 3 days, so it can download ahead); staff with the
// "Splash screens" switch make them in the admin panel.
export const splashRoutes = new Hono<Env>();
splashRoutes.use("/admin/splashes", requireAuth, requirePerm("splash.manage"));
splashRoutes.use("/admin/splashes/*", requireAuth, requirePerm("splash.manage"));

// For the app (no sign-in: it shows before login): live and upcoming splashes, in turn order.
splashRoutes.get("/splashes", async (c) =>
  c.json({
    splashes: await db
      .select({ id: splashes.id, art: splashes.art, startsAt: splashes.startsAt, endsAt: splashes.endsAt, action: splashes.action, sortOrder: splashes.sortOrder })
      .from(splashes)
      .where(and(eq(splashes.enabled, true), gt(splashes.endsAt, sql`now()`), lt(splashes.startsAt, sql`now() + interval '3 days'`)))
      .orderBy(asc(splashes.sortOrder), asc(splashes.startsAt)),
  }),
);

// The panel: every splash, and what a tap can open (live and coming events and notices).
splashRoutes.get("/admin/splashes", async (c) => {
  const [list, ev, no] = await Promise.all([
    db.select().from(splashes).orderBy(desc(splashes.startsAt)).limit(100),
    db.select({ id: events.id, title: events.title }).from(events).where(and(eq(events.published, true), gt(events.endsAt, sql`now()`))).orderBy(asc(events.startsAt)),
    db.select({ id: notices.id, title: notices.title }).from(notices).where(and(eq(notices.published, true), gt(notices.endsAt, sql`now()`))).orderBy(desc(notices.startsAt)),
  ]);
  return c.json({ splashes: list, events: ev, notices: no });
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const fields = z.object({
  title: z.string().trim().min(1).max(60),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  sortOrder: z.coerce.number().int().min(0).max(100_000).default(0),
  enabled: z.enum(["true", "false"]).optional(),
  actionType: z.enum(["", "event", "notice", "room", "profile", "url"]).default(""),
  actionTarget: z.string().trim().max(300).default(""),
});

// What a tap opens, checked and turned into ids: a room link or id, a user's 10-digit or Special ID, an https link.
async function actionOf(type: string, raw: string): Promise<SplashAction | null> {
  if (!type) return null;
  if (!raw) throw new AppError("VALIDATION_ERROR", 400, "Choose what tapping the splash opens");
  if (type === "url") {
    if (!/^https:\/\/\S+$/i.test(raw)) throw new AppError("VALIDATION_ERROR", 400, "The link must start with https://");
    return { type: "url", target: raw };
  }
  if (type === "profile") {
    const n = /^\d{1,10}$/.test(raw) ? Number(raw) : null;
    const uuid = UUID.test(raw) ? raw.match(UUID)![0].toLowerCase() : null; // kept from before (editing)
    const [u] = await db
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(uuid ? eq(users.id, uuid) : n !== null ? eq(users.publicId, n) : eq(users.specialId, raw.toUpperCase()));
    if (!u) throw new AppError("USER_NOT_FOUND", 404, "No user with that ID");
    return { type: "profile", target: u.id, label: u.name ?? undefined };
  }
  const id = raw.match(UUID)?.[0]?.toLowerCase();
  if (!id) throw new AppError("VALIDATION_ERROR", 400, type === "room" ? "Paste the room's share link" : "Choose one from the list");
  const table = { event: events, notice: notices, room: rooms }[type as "event" | "notice" | "room"];
  const [row] = await db.select({ title: table.title }).from(table).where(eq(table.id, id));
  if (!row) throw new AppError("NOT_FOUND", 404, `No such ${type}`);
  return { type: type as SplashAction["type"], target: id, label: row.title };
}

async function form(c: Context<Env>) {
  const f = await c.req.formData().catch(() => null);
  if (!f) throw new AppError("VALIDATION_ERROR", 400, "Send the splash as a form");
  const str = (k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string) : undefined);
  const parsed = fields.safeParse(Object.fromEntries(["title", "startsAt", "endsAt", "sortOrder", "enabled", "actionType", "actionTarget"].map((k) => [k, str(k)]).filter(([, v]) => v !== undefined)));
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", 400, parsed.error.issues[0]?.message ?? "Check the splash's details");
  const b = parsed.data;
  if (b.endsAt <= b.startsAt) throw new AppError("VALIDATION_ERROR", 400, "The splash must end after it starts");
  const file = f.getAll("art").find((x): x is File => x instanceof File && x.size > 0);
  const art = file ? await saveItemFile(file, (await fileType(file)) === "svga" ? "svga" : "image") : null;
  return { title: b.title, startsAt: b.startsAt, endsAt: b.endsAt, sortOrder: b.sortOrder, ...(b.enabled && { enabled: b.enabled === "true" }), action: await actionOf(b.actionType, b.actionTarget), art };
}

splashRoutes.post("/admin/splashes", async (c) => {
  const { art, ...b } = await form(c);
  if (!art) throw new AppError("FILE_REQUIRED", 400, "Upload the splash artwork (SVGA, PNG or WebP)");
  const [row] = await db.insert(splashes).values({ ...b, art, createdBy: c.get("user").id }).returning();
  return c.json(row, 201);
});

splashRoutes.patch("/admin/splashes/:id", async (c) => {
  const { art, ...b } = await form(c);
  const [row] = await db.update(splashes).set({ ...b, ...(art && { art }) }).where(eq(splashes.id, schemas.uuid.parse(c.req.param("id")))).returning();
  if (!row) throw new AppError("NOT_FOUND", 404, "No such splash");
  return c.json(row);
});

splashRoutes.delete("/admin/splashes/:id", async (c) => {
  await db.delete(splashes).where(eq(splashes.id, schemas.uuid.parse(c.req.param("id"))));
  return c.json({ ok: true });
});
