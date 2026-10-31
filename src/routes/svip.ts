import { Hono } from "hono";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "../db";
import { cosmetics, svipAssets, type SvipFxKind } from "../db/schema";
import { requireAuth, type Env } from "../http";
import { AppError } from "../lib/errors";
import { createItem, saveItemFile, updateItem, type ItemKind } from "../services/items";
import { requirePerm } from "../services/roles";
import { itemForm } from "./items";

// SVIP designs: the animations each tier plays (entry banner, seat medal, name shimmer, profile title badge) and the
// tier-only frames, chat bubbles and profile cards. The app reads them from here, so changing a design needs no app
// update. Admin panel > SVIP (switch "SVIP designs").
export const svipRoutes = new Hono<Env>();
svipRoutes.use("/admin/svip", requireAuth, requirePerm("svip.manage"));
svipRoutes.use("/admin/svip/*", requireAuth, requirePerm("svip.manage"));

const KINDS: SvipFxKind[] = ["entry", "seat", "name", "badge"];
const tierOf = (raw: string) => {
  const t = Number(raw);
  if (!Number.isInteger(t) || t < 1 || t > 6) throw new AppError("VALIDATION_ERROR", 400, "Tier 1 to 6");
  return t;
};
const kindOf = (raw: string) => {
  if (!KINDS.includes(raw as SvipFxKind)) throw new AppError("VALIDATION_ERROR", 400, "Unknown SVIP animation");
  return raw as SvipFxKind;
};

// For the app (no sign-in needed: it's only design): { entry: { "1": "games/...svga", ... }, seat, name, badge }.
svipRoutes.get("/svip/assets", async (c) => {
  const rows = await db.select().from(svipAssets);
  const out: Record<string, Record<string, string>> = { entry: {}, seat: {}, name: {}, badge: {} };
  for (const r of rows) out[r.kind]![String(r.tier)] = r.svga;
  return c.json({ assets: out });
});

// For the panel: every tier animation, and every SVIP-only frame, bubble and profile card.
svipRoutes.get("/admin/svip", async (c) =>
  c.json({
    assets: await db.select().from(svipAssets).orderBy(asc(svipAssets.kind), asc(svipAssets.tier)),
    items: await db.select().from(cosmetics).where(gt(cosmetics.minSvip, 0)).orderBy(asc(cosmetics.minSvip), asc(cosmetics.kind)),
  }),
);

// Replace (or add) a tier's animation with an uploaded SVGA. A fresh file name, so phones fetch the new design.
svipRoutes.post("/admin/svip/fx/:kind/:tier", async (c) => {
  const kind = kindOf(c.req.param("kind"));
  const tier = tierOf(c.req.param("tier"));
  const file = (await c.req.formData().catch(() => null))?.get("svga");
  if (!(file instanceof File) || !file.size) throw new AppError("FILE_REQUIRED", 400, "Choose an SVGA file");
  const svga = await saveItemFile(file, "svga");
  await db.insert(svipAssets).values({ kind, tier, svga }).onConflictDoUpdate({ target: [svipAssets.kind, svipAssets.tier], set: { svga, updatedAt: new Date() } });
  return c.json({ kind, tier, svga });
});

// That tier stops having this animation.
svipRoutes.delete("/admin/svip/fx/:kind/:tier", async (c) => {
  await db.delete(svipAssets).where(and(eq(svipAssets.kind, kindOf(c.req.param("kind"))), eq(svipAssets.tier, tierOf(c.req.param("tier")))));
  return c.json({ ok: true });
});

// A new SVIP-only frame, chat bubble or profile card for a tier (and every tier above it).
svipRoutes.post("/admin/svip/items/:kind{AVATAR_FRAME|CHAT_BUBBLE|CARD_DECOR}/:tier", async (c) => {
  const id = await createItem({ kind: c.req.param("kind") as ItemKind, ...(await itemForm(c)), minSvip: tierOf(c.req.param("tier")) });
  return c.json({ id }, 201);
});

// Change one: name, picture, animation, bubble colours, shown or hidden.
svipRoutes.patch("/admin/svip/items/:kind{AVATAR_FRAME|CHAT_BUBBLE|CARD_DECOR}/:id", async (c) => {
  const id = c.req.param("id").slice(0, 64);
  const [row] = await db.select({ minSvip: cosmetics.minSvip }).from(cosmetics).where(eq(cosmetics.id, id));
  if (!row || row.minSvip < 1) throw new AppError("NOT_FOUND", 404, "No such SVIP item");
  await updateItem(c.req.param("kind") as ItemKind, id, await itemForm(c));
  return c.json({ ok: true });
});
