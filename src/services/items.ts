import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { config } from "../config";
import { db, isUniqueViolation } from "../db";
import { badges, cosmetics, specialIdVouchers, svipGrants, userCosmetics, users, type RewardItem } from "../db/schema";
import { AppError } from "../lib/errors";
import { grantBadge } from "./badges";
import { normalizeSpecialId } from "./specialIds";

// Prize items made in the admin panel (Items): badges, avatar frames, chat bubbles and entry effects, with uploaded
// artwork (PNG/WebP, or animated SVGA). Frames, bubbles and effects made here are exclusive: only people who won one
// (user_cosmetics) can wear it. Also: granting every kind of prize, Special ID vouchers, and expiry.

export const ITEM_FILES_DIR = () => join(config.uploadsDir, "items");
export type ItemKind = "BADGE" | "AVATAR_FRAME" | "CHAT_BUBBLE" | "ENTRY_EFFECT";
const now = () => new Date();
const until = (days: number | null) => (days === null ? null : new Date(Date.now() + days * 86_400_000));

// PNG/WebP up to 2 MB, SVGA up to 15 MB; fresh names, served at /games/items/<name>.
export async function saveItemFile(file: File, want: "image" | "svga") {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ext =
    head[0] === 0x89 && head[1] === 0x50 ? "png" : String.fromCharCode(...head.slice(8, 12)) === "WEBP" ? "webp" : head[0] === 0x50 && head[1] === 0x4b ? "svga" : head[0] === 0x78 ? "svga" : null;
  if (want === "image" && ext !== "png" && ext !== "webp") throw new AppError("BAD_MEDIA", 400, "Artwork must be a PNG or WebP image");
  if (want === "svga" && ext !== "svga") throw new AppError("BAD_MEDIA", 400, "Animation must be an SVGA file");
  if (file.size > (want === "image" ? 2 : 15) * 1024 * 1024) throw new AppError("MEDIA_TOO_LARGE", 413, want === "image" ? "Image is too large (max 2 MB)" : "Animation is too large (max 15 MB)");
  const name = `${randomUUID()}.${ext}`;
  await mkdir(ITEM_FILES_DIR(), { recursive: true });
  await Bun.write(join(ITEM_FILES_DIR(), name), file);
  return `games/items/${name}`;
}

// The app draws badges and frames as SVG: an uploaded picture goes in as an <image> (the app adds its server address
// to the relative link). Frames use a 200-unit box with the photo in the middle 70%; badges a square.
const imageSvg = (path: string, box: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}"><image href="/${path}" width="${box}" height="${box}"/></svg>`;

export type ItemInput = {
  kind: ItemKind;
  name: string;
  description?: string;
  image?: File | null;
  svga?: File | null;
  bubble?: { from: string; to: string; border: string; text: string };
  enabled?: boolean;
};

// Everything the panel can pick from, newest first within each kind.
export async function listItems() {
  const [b, c] = await Promise.all([
    db.select().from(badges).orderBy(desc(badges.createdAt)),
    db.select().from(cosmetics).where(inArray(cosmetics.kind, ["AVATAR_FRAME", "CHAT_BUBBLE", "ENTRY_EFFECT"])).orderBy(desc(cosmetics.createdAt)),
  ]);
  return [
    ...b.map((x) => ({ kind: "BADGE" as ItemKind, id: x.id, name: x.name, description: x.description, svg: x.svg, svga: x.svga, style: null, enabled: x.enabled, exclusive: true })),
    ...c.map((x) => ({ kind: x.kind as ItemKind, id: x.id, name: x.name, description: "", svg: x.svg, svga: x.svga, style: x.style, enabled: x.enabled, exclusive: x.exclusive })),
  ];
}

export async function createItem(i: ItemInput) {
  const art = await artwork(i);
  const id = randomUUID();
  if (i.kind === "BADGE") {
    if (!art.svg && !art.svga) throw new AppError("FILE_REQUIRED", 400, "Upload the badge's image or animation");
    await db.insert(badges).values({ id, name: i.name, description: i.description ?? "", svg: art.svg ?? "", svga: art.svga ?? null, sortOrder: 1000 });
  } else {
    if (i.kind === "AVATAR_FRAME" && !art.svg && !art.svga) throw new AppError("FILE_REQUIRED", 400, "Upload the frame's image or animation");
    if (i.kind === "ENTRY_EFFECT" && !art.svga) throw new AppError("FILE_REQUIRED", 400, "Upload the entry effect's SVGA animation");
    if (i.kind === "CHAT_BUBBLE" && !i.bubble) throw new AppError("VALIDATION_ERROR", 400, "Pick the bubble's colours");
    await db.insert(cosmetics).values({ id, kind: i.kind, name: i.name, svg: art.svg ?? "", svga: art.svga ?? null, style: bubbleStyle(i), exclusive: true, sortOrder: 1000 });
  }
  return id;
}

export async function updateItem(kind: ItemKind, id: string, i: Omit<ItemInput, "kind">) {
  const art = await artwork({ ...i, kind });
  const files = { ...(art.svg && { svg: art.svg }), ...(art.svga && { svga: art.svga }) };
  const rows =
    kind === "BADGE"
      ? await db
          .update(badges)
          .set({ name: i.name, ...(i.description !== undefined && { description: i.description }), ...(i.enabled !== undefined && { enabled: i.enabled }), ...files })
          .where(eq(badges.id, id))
          .returning({ id: badges.id })
      : await db
          .update(cosmetics)
          .set({ name: i.name, ...(i.enabled !== undefined && { enabled: i.enabled }), ...(i.bubble && { style: bubbleStyle({ ...i, kind }) }), ...files })
          .where(and(eq(cosmetics.id, id), eq(cosmetics.kind, kind)))
          .returning({ id: cosmetics.id });
  if (!rows.length) throw new AppError("NOT_FOUND", 404, "No such item");
}

async function artwork(i: ItemInput) {
  const image = i.image && i.image.size ? await saveItemFile(i.image, "image") : null;
  const svga = i.svga && i.svga.size ? await saveItemFile(i.svga, "svga") : null;
  return { svg: image ? imageSvg(image, i.kind === "AVATAR_FRAME" ? 200 : i.kind === "CHAT_BUBBLE" ? 44 : 100) : null, svga };
}
const bubbleStyle = (i: ItemInput) => (i.bubble ? { gradient: [i.bubble.from, i.bubble.to], border: i.bubble.border, text: i.bubble.text } : null);

// Names and art for the items prizes mention, for the event page and the panel (missing ones are skipped).
export async function itemLabels(ids: { badges: string[]; items: string[] }) {
  const [b, c] = await Promise.all([
    ids.badges.length ? db.select({ id: badges.id, name: badges.name, svg: badges.svg, svga: badges.svga }).from(badges).where(inArray(badges.id, ids.badges)) : [],
    ids.items.length ? db.select({ id: cosmetics.id, kind: cosmetics.kind, name: cosmetics.name, svg: cosmetics.svg, svga: cosmetics.svga }).from(cosmetics).where(inArray(cosmetics.id, ids.items)) : [],
  ]);
  return { badges: Object.fromEntries(b.map((x) => [x.id, x])), items: Object.fromEntries(c.map((x) => [x.id, x])) };
}

// ---------- granting ----------

// Give one prize item. Owning the same item again keeps whichever expiry is later (forever beats any date).
export async function grantItem(userId: string, item: RewardItem, source: string) {
  switch (item.type) {
    case "COINS":
      return; // coins go through the wallet with the payout (services/events.ts)
    case "BADGE":
      await grantBadge(userId, item.id, item.days);
      return;
    case "ITEM": {
      const [c] = await db.select({ id: cosmetics.id }).from(cosmetics).where(eq(cosmetics.id, item.id));
      if (!c) throw new AppError("COSMETIC_NOT_FOUND", 404);
      const expiresAt = until(item.days);
      await db
        .insert(userCosmetics)
        .values({ userId, cosmeticId: item.id, expiresAt })
        .onConflictDoUpdate({
          target: [userCosmetics.userId, userCosmetics.cosmeticId],
          set: { grantedAt: now(), expiresAt: expiresAt === null ? null : sql`case when ${userCosmetics.expiresAt} is null then null else greatest(${userCosmetics.expiresAt}, ${expiresAt}) end` },
        });
      return;
    }
    case "SVIP":
      await db.insert(svipGrants).values({ userId, tier: item.tier, expiresAt: until(item.days)!, source });
      return;
    case "SPECIAL_ID":
      await db.insert(specialIdVouchers).values({ userId, days: item.days, claimBy: until(30)!, source });
      return;
  }
}

// ---------- what I own ----------

const live = (col: typeof userCosmetics.expiresAt) => or(isNull(col), gt(col, sql`now()`));

export const ownedCosmetics = (userId: string) =>
  db
    .select({ id: cosmetics.id, kind: cosmetics.kind, name: cosmetics.name, svg: cosmetics.svg, svga: cosmetics.svga, style: cosmetics.style, expiresAt: userCosmetics.expiresAt })
    .from(userCosmetics)
    .innerJoin(cosmetics, eq(cosmetics.id, userCosmetics.cosmeticId))
    .where(and(eq(userCosmetics.userId, userId), eq(cosmetics.enabled, true), live(userCosmetics.expiresAt)))
    .orderBy(asc(cosmetics.kind), desc(userCosmetics.grantedAt));

export async function ownsCosmetic(userId: string, cosmeticId: string) {
  const [row] = await db
    .select({ id: userCosmetics.cosmeticId })
    .from(userCosmetics)
    .where(and(eq(userCosmetics.userId, userId), eq(userCosmetics.cosmeticId, cosmeticId), live(userCosmetics.expiresAt)));
  return !!row;
}

export const openVouchers = (userId: string) =>
  db
    .select({ id: specialIdVouchers.id, days: specialIdVouchers.days, claimBy: specialIdVouchers.claimBy })
    .from(specialIdVouchers)
    .where(and(eq(specialIdVouchers.userId, userId), isNull(specialIdVouchers.usedAt), gt(specialIdVouchers.claimBy, sql`now()`)))
    .orderBy(asc(specialIdVouchers.claimBy));

// Use a voucher: the chosen ID (3-9 letters/digits, not anyone else's) becomes mine for the voucher's days.
export async function claimSpecialId(userId: string, voucherId: string, raw: string) {
  const specialId = normalizeSpecialId(raw);
  if (!/^[A-Z0-9]{3,9}$/.test(specialId)) throw new AppError("BAD_SPECIAL_ID", 400, "Special ID must be 3-9 letters or numbers");
  try {
    return await db.transaction(async (tx) => {
      const [v] = await tx
        .update(specialIdVouchers)
        .set({ usedAt: now(), specialId })
        .where(and(eq(specialIdVouchers.id, voucherId), eq(specialIdVouchers.userId, userId), isNull(specialIdVouchers.usedAt), gt(specialIdVouchers.claimBy, sql`now()`)))
        .returning();
      if (!v) throw new AppError("VOUCHER_NOT_FOUND", 404, "This voucher was used or has expired");
      const expiresAt = until(v.days);
      await tx.update(users).set({ specialId, specialIdExpiresAt: expiresAt, updatedAt: now() }).where(eq(users.id, userId));
      return { specialId, expiresAt };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("SPECIAL_ID_TAKEN", 409, "That Special ID belongs to someone else. Try another.");
    throw e;
  }
}

// ---------- expiry ----------

// Every minute: take off prize items whose ownership ran out, and remove Special IDs whose time is up.
export async function sweepExpired() {
  const lapsed = (col: typeof users.avatarFrameId | typeof users.chatBubbleId | typeof users.entryEffectId) =>
    sql`${col} is not null and ${col} in (select id from cosmetics where exclusive)
      and not exists (select 1 from user_cosmetics uc where uc.user_id = ${users.id} and uc.cosmetic_id = ${col} and (uc.expires_at is null or uc.expires_at > now()))`;
  await db.update(users).set({ avatarFrameId: null }).where(lapsed(users.avatarFrameId));
  await db.update(users).set({ chatBubbleId: null }).where(lapsed(users.chatBubbleId));
  await db.update(users).set({ entryEffectId: null }).where(lapsed(users.entryEffectId));
  await db.update(users).set({ specialId: null, specialIdExpiresAt: null }).where(and(isNotNull(users.specialIdExpiresAt), lte(users.specialIdExpiresAt, sql`now()`)));
}

export const runItemSweep = (ms = 60_000) => setInterval(() => sweepExpired().catch((e) => console.error(JSON.stringify({ level: "error", msg: "item-sweep-failed", err: String(e) }))), ms);
