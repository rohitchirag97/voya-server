import { Hono } from "hono";
import { z } from "zod";
import { json, requireAuth, requireStaff, schemas, type Env } from "../http";
import { db } from "../db";
import { events, giftCategories } from "../db/schema";
import { eq } from "drizzle-orm";
import { AppError } from "../lib/errors";
import * as ev from "../services/events";
import { listItems } from "../services/items";

// Events: the app reads live ones (banners) and an event's page; the admin panel (owner/admin) makes and runs them.
export const eventRoutes = new Hono<Env>();
eventRoutes.use("/events", requireAuth);
eventRoutes.use("/events/*", requireAuth);
eventRoutes.use("/admin/events", requireAuth, requireStaff("OWNER", "ADMIN"));
eventRoutes.use("/admin/events/*", requireAuth, requireStaff("OWNER", "ADMIN"));

eventRoutes.get("/events", async (c) => c.json({ events: await ev.liveEvents() }));
eventRoutes.get("/events/:id", async (c) => c.json(await ev.eventPage(schemas.uuid.parse(c.req.param("id")), c.get("user"))));

// ---------- admin ----------

const days = z.number().int().min(1).max(3650).nullable();
export const rewardItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("COINS"), amount: z.number().int().min(1).max(100_000_000) }),
  z.object({ type: z.literal("BADGE"), id: z.string().min(1).max(64), days }),
  z.object({ type: z.literal("ITEM"), id: z.string().min(1).max(64), days }),
  z.object({ type: z.literal("SPECIAL_ID"), days }),
  z.object({ type: z.literal("SVIP"), tier: z.number().int().min(1).max(6), days: z.number().int().min(1).max(365) }),
]);
const reward = z.object({ items: z.array(rewardItem).max(10) });
const filter = z.discriminatedUnion("type", [
  z.object({ type: z.literal("EVENT_GIFTS") }),
  z.object({ type: z.literal("GIFT_CATEGORIES"), ids: z.array(z.number().int().positive()).min(1).max(20) }),
  z.object({ type: z.literal("HOSTS_ONLY") }),
  z.object({ type: z.literal("JOINED_AFTER"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/,"Date as YYYY-MM-DD") }),
  z.object({ type: z.literal("MIN_LEVEL"), level: z.number().int().min(1).max(200) }),
]);
const counting = {
  game: z.enum(["ALL", "GREEDY_JUNGLE", "GREEDY_GALAXY", "ROCKET"]).default("ALL"),
  filters: z.array(filter).max(8).default([]),
};
const configSchema = z.object({
  page: z.object({
    headerUrl: z.string().max(200).nullable(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colour as #RRGGBB"),
    description: z.string().max(2000),
    rules: z.string().max(4000),
  }),
  boards: z
    .array(
      z.object({
        id: z.string().max(16).default(""),
        title: z.string().trim().min(1).max(40),
        metric: z.enum(["GIFTS_SENT", "GIFTS_RECEIVED", "ROOM_GIFTS", "RECHARGE", "GAME_WINS", "CP_POINTS"]),
        ...counting,
        size: z.number().int().min(1).max(100),
        rewards: z.array(reward.extend({ from: z.number().int().min(1), to: z.number().int().min(1), min: z.number().int().min(0).max(1_000_000_000).optional() })).max(20),
      }),
    )
    .max(6),
  tasks: z
    .array(
      z.object({
        id: z.string().max(16).default(""),
        title: z.string().trim().min(1).max(60),
        metric: z.enum(["GIFTS_SENT", "GIFTS_RECEIVED", "RECHARGE", "GAME_WINS"]),
        ...counting,
        target: z.number().int().min(1).max(100_000_000),
        daily: z.boolean(),
        reward,
      }),
    )
    .max(20),
});
const eventFields = z.object({
  title: z.string().trim().min(1).max(60),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  published: z.boolean(),
  bannerHome: z.boolean(),
  bannerRoom: z.boolean(),
  homeTab: z.enum(["BOTH", "LIVE", "ROOMS"]).optional(), // unset: both (column default)
  sortOrder: z.number().int().min(0).max(100_000),
  giftCategoryId: z.number().int().positive().nullable(),
  repeat: z.enum(["NONE", "WEEKLY", "MONTHLY"]).optional(), // unset: never (column default)
  config: configSchema,
});
const checkWindow = (b: { startsAt?: Date; endsAt?: Date }) => {
  if (b.startsAt && b.endsAt && b.endsAt <= b.startsAt) throw new AppError("VALIDATION_ERROR", 400, "The event must end after it starts");
};

eventRoutes.get("/admin/events", async (c) => c.json({ events: await ev.listAllEvents() }));
eventRoutes.get("/admin/events/:id", async (c) => c.json(await ev.getEvent(schemas.uuid.parse(c.req.param("id")))));

eventRoutes.post("/admin/events", async (c) => {
  const b = await json(c, eventFields);
  checkWindow(b);
  const [e] = await db.insert(events).values({ ...b, config: ev.withIds(b.config) }).returning();
  return c.json(e, 201);
});

eventRoutes.patch("/admin/events/:id", async (c) => {
  const id = schemas.uuid.parse(c.req.param("id"));
  const b = await json(c, eventFields.partial());
  const e = await ev.getEvent(id);
  checkWindow({ startsAt: b.startsAt ?? e.startsAt, endsAt: b.endsAt ?? e.endsAt });
  const [saved] = await db.update(events).set({ ...b, ...(b.config && { config: ev.withIds(b.config) }) }).where(eq(events.id, id)).returning();
  return c.json(saved);
});

// Banner or page header image (multipart "file").
eventRoutes.post("/admin/events/:id/:slot{banner|header}", async (c) => {
  const id = schemas.uuid.parse(c.req.param("id"));
  const e = await ev.getEvent(id);
  const file = (await c.req.formData().catch(() => null))?.get("file");
  if (!(file instanceof File) || !file.size) throw new AppError("FILE_REQUIRED", 400, "Choose an image");
  const url = await ev.saveEventImage(file);
  const set = c.req.param("slot") === "banner" ? { bannerUrl: url } : { config: { ...e.config, page: { ...e.config.page, headerUrl: url } } };
  const [saved] = await db.update(events).set(set).where(eq(events.id, id)).returning();
  return c.json(saved);
});

eventRoutes.get("/admin/events/:id/payouts", async (c) => c.json(await ev.payoutPreview(schemas.uuid.parse(c.req.param("id")))));
eventRoutes.post("/admin/events/:id/payouts/approve", async (c) => c.json(await ev.approvePayouts(c.get("user"), schemas.uuid.parse(c.req.param("id")))));

// What the panel's event form can pick from: items marked as event prizes (admin panel > Items) and gift categories.
eventRoutes.get("/admin/event-options", async (c) => {
  const [items, categories] = await Promise.all([
    listItems(),
    db.select({ id: giftCategories.id, name: giftCategories.name }).from(giftCategories).orderBy(giftCategories.sortOrder),
  ]);
  return c.json({ items: items.filter((i) => i.enabled && i.forPrize), categories });
});
