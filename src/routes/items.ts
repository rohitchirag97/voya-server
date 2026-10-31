import { Hono } from "hono";
import { z } from "zod";
import { eq, or } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { json, requireAuth, type Env } from "../http";
import { AppError } from "../lib/errors";
import { requirePerm } from "../services/roles";
import { createItem, giveToUser, listItems, recentGrants, updateItem, type ItemKind } from "../services/items";
import { normalizeSpecialId } from "../services/specialIds";
import { rewardItem } from "./events";

// Admin panel > Items (owner/admin): badges, frames, profile card decorations, chat bubbles and entry effects with
// uploaded artwork, each an event prize and/or a Mall item. Give to user (owner only): coins and items, with a reason.
export const itemRoutes = new Hono<Env>();
itemRoutes.use("/admin/items", requireAuth, requirePerm("items.manage"));
itemRoutes.use("/admin/items/*", requireAuth, requirePerm("items.manage"));

const KINDS = ["BADGE", "AVATAR_FRAME", "CARD_DECOR", "CHAT_BUBBLE", "ENTRY_EFFECT"] as const;
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colour as #RRGGBB");
const fields = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(120).optional(),
  enabled: z.enum(["true", "false"]).optional(),
  forPrize: z.enum(["true", "false"]).optional(),
  forMall: z.enum(["true", "false"]).optional(),
  from: colour.optional(),
  to: colour.optional(),
  border: colour.optional(),
  text: colour.optional(),
});

// Multipart: name, description (badges), enabled, bubble colours (from, to, border, text), files "image" and "svga".
export async function itemForm(c: { req: { formData: () => Promise<FormData> } }) {
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new AppError("VALIDATION_ERROR", 400, "Send the item as a form");
  const str = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);
  const parsed = fields.safeParse({ name: str("name"), description: str("description"), enabled: str("enabled"), forPrize: str("forPrize"), forMall: str("forMall"), from: str("from"), to: str("to"), border: str("border"), text: str("text") });
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", 400, parsed.error.issues[0]?.message ?? "Check the item's details");
  const f = parsed.data;
  const file = (k: string) => (form.get(k) instanceof File ? (form.get(k) as File) : null);
  return {
    name: f.name,
    description: f.description,
    enabled: f.enabled === undefined ? undefined : f.enabled === "true",
    forPrize: f.forPrize === undefined ? undefined : f.forPrize === "true",
    forMall: f.forMall === undefined ? undefined : f.forMall === "true",
    bubble: f.from && f.to && f.border && f.text ? { from: f.from, to: f.to, border: f.border, text: f.text } : undefined,
    image: file("image"),
    svga: file("svga"),
  };
}

itemRoutes.get("/admin/items", async (c) => c.json({ items: await listItems() }));

itemRoutes.post("/admin/items/:kind{BADGE|AVATAR_FRAME|CARD_DECOR|CHAT_BUBBLE|ENTRY_EFFECT}", async (c) => {
  const id = await createItem({ kind: c.req.param("kind") as ItemKind, ...(await itemForm(c)) });
  return c.json({ id }, 201);
});

itemRoutes.patch("/admin/items/:kind{BADGE|AVATAR_FRAME|CARD_DECOR|CHAT_BUBBLE|ENTRY_EFFECT}/:id", async (c) => {
  const kind = c.req.param("kind") as (typeof KINDS)[number];
  await updateItem(kind, c.req.param("id").slice(0, 64), await itemForm(c));
  return c.json({ ok: true });
});

// ---------- give to user (owner only) ----------

itemRoutes.use("/admin/grants", requireAuth, requirePerm("grants.give"));
// Recent grants, and every item that can be given (so this works without the Items switch).
itemRoutes.get("/admin/grants", async (c) => c.json({ grants: await recentGrants(), items: await listItems() }));
itemRoutes.post("/admin/grants", async (c) => {
  const b = await json(c, z.object({ user: z.string().trim().min(3).max(20), reason: z.string().trim().min(3, "Write a reason").max(300), items: z.array(rewardItem).min(1, "Add something to give").max(10) }));
  // The person by their 10-digit ID or their Special ID.
  const id = /^\d{1,10}$/.test(b.user) ? Number(b.user) : null;
  const [u] = await db
    .select({ id: users.id, name: users.displayName })
    .from(users)
    .where(id !== null ? or(eq(users.publicId, id), eq(users.specialId, b.user)) : eq(users.specialId, normalizeSpecialId(b.user)));
  if (!u) throw new AppError("USER_NOT_FOUND", 404, "No user with that ID");
  return c.json({ ...(await giveToUser(c.get("user"), u.id, b.items, b.reason)), user: u });
});
