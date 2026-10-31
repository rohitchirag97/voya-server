import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireStaff, type Env } from "../http";
import { AppError } from "../lib/errors";
import { createItem, listItems, updateItem, type ItemKind } from "../services/items";

// Admin panel > Items (owner/admin): prize badges, frames, chat bubbles and entry effects with uploaded artwork.
export const itemRoutes = new Hono<Env>();
itemRoutes.use("/admin/items", requireAuth, requireStaff("OWNER", "ADMIN"));
itemRoutes.use("/admin/items/*", requireAuth, requireStaff("OWNER", "ADMIN"));

const KINDS = ["BADGE", "AVATAR_FRAME", "CHAT_BUBBLE", "ENTRY_EFFECT"] as const;
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colour as #RRGGBB");
const fields = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(120).optional(),
  enabled: z.enum(["true", "false"]).optional(),
  from: colour.optional(),
  to: colour.optional(),
  border: colour.optional(),
  text: colour.optional(),
});

// Multipart: name, description (badges), enabled, bubble colours (from, to, border, text), files "image" and "svga".
async function itemForm(c: { req: { formData: () => Promise<FormData> } }) {
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new AppError("VALIDATION_ERROR", 400, "Send the item as a form");
  const str = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);
  const parsed = fields.safeParse({ name: str("name"), description: str("description"), enabled: str("enabled"), from: str("from"), to: str("to"), border: str("border"), text: str("text") });
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", 400, parsed.error.issues[0]?.message ?? "Check the item's details");
  const f = parsed.data;
  const file = (k: string) => (form.get(k) instanceof File ? (form.get(k) as File) : null);
  return {
    name: f.name,
    description: f.description,
    enabled: f.enabled === undefined ? undefined : f.enabled === "true",
    bubble: f.from && f.to && f.border && f.text ? { from: f.from, to: f.to, border: f.border, text: f.text } : undefined,
    image: file("image"),
    svga: file("svga"),
  };
}

itemRoutes.get("/admin/items", async (c) => c.json({ items: await listItems() }));

itemRoutes.post("/admin/items/:kind{BADGE|AVATAR_FRAME|CHAT_BUBBLE|ENTRY_EFFECT}", async (c) => {
  const id = await createItem({ kind: c.req.param("kind") as ItemKind, ...(await itemForm(c)) });
  return c.json({ id }, 201);
});

itemRoutes.patch("/admin/items/:kind{BADGE|AVATAR_FRAME|CHAT_BUBBLE|ENTRY_EFFECT}/:id", async (c) => {
  const kind = c.req.param("kind") as (typeof KINDS)[number];
  await updateItem(kind, c.req.param("id").slice(0, 64), await itemForm(c));
  return c.json({ ok: true });
});
