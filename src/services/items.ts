import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { config } from "../config";
import { db, isUniqueViolation } from "../db";
import { adminGrants, badges, cosmetics, notices, specialIdVouchers, svipGrants, userCosmetics, users, walletAccounts, walletLedger, type RewardItem, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { grantBadge } from "./badges";
import { normalizeSpecialId } from "./specialIds";

// Items made in the admin panel (Items): badges, avatar frames, profile card decorations, chat bubbles and entry
// effects, with uploaded artwork (PNG/WebP, or animated SVGA), each marked as an event prize and/or a Mall item. They're
// exclusive: only people who own one (user_cosmetics; won, given, or later bought) can wear it. Also: granting every
// kind of item, direct grants by the owner, Special ID vouchers, and expiry.

export const ITEM_FILES_DIR = () => join(config.uploadsDir, "items");
export type ItemKind = "BADGE" | "AVATAR_FRAME" | "CARD_DECOR" | "CHAT_BUBBLE" | "ENTRY_EFFECT";
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
const imageSvg = (path: string, w: number, h = w) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><image href="/${path}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/></svg>`;

export type ItemInput = {
  kind: ItemKind;
  name: string;
  description?: string;
  image?: File | null;
  svga?: File | null;
  bubble?: { from: string; to: string; border: string; text: string };
  enabled?: boolean;
  forPrize?: boolean;
  forMall?: boolean;
  minSvip?: number; // an SVIP item (admin panel > SVIP): free to wear from this tier up, never owned
};

// Everything the panel can pick from, newest first within each kind.
export async function listItems() {
  const [b, c] = await Promise.all([
    db.select().from(badges).orderBy(desc(badges.createdAt)),
    db.select().from(cosmetics).where(eq(cosmetics.exclusive, true)).orderBy(desc(cosmetics.createdAt)),
  ]);
  const flags = (x: { forPrize: boolean; forMall: boolean; enabled: boolean }) => ({ forPrize: x.forPrize, forMall: x.forMall, enabled: x.enabled });
  return [
    ...b.map((x) => ({ kind: "BADGE" as ItemKind, id: x.id, name: x.name, description: x.description, svg: x.svg, svga: x.svga, style: null, ...flags(x) })),
    ...c.map((x) => ({ kind: x.kind as ItemKind, id: x.id, name: x.name, description: "", svg: x.svg, svga: x.svga, style: x.style, ...flags(x) })),
  ];
}

export async function createItem(i: ItemInput) {
  const art = await artwork(i);
  const id = randomUUID();
  if (i.kind === "BADGE") {
    if (!art.svg && !art.svga) throw new AppError("FILE_REQUIRED", 400, "Upload the badge's image or animation");
    await db.insert(badges).values({ id, name: i.name, description: i.description ?? "", svg: art.svg ?? "", svga: art.svga ?? null, forPrize: !!i.forPrize, forMall: !!i.forMall, sortOrder: 1000 });
  } else {
    if (i.kind === "AVATAR_FRAME" && !art.svg && !art.svga) throw new AppError("FILE_REQUIRED", 400, "Upload the frame's image or animation");
    if (i.kind === "CARD_DECOR" && !art.svg) throw new AppError("FILE_REQUIRED", 400, "Upload the card decoration's image");
    if (i.kind === "ENTRY_EFFECT" && !art.svga) throw new AppError("FILE_REQUIRED", 400, "Upload the entry effect's SVGA animation");
    if (i.kind === "CHAT_BUBBLE" && !i.bubble) throw new AppError("VALIDATION_ERROR", 400, "Pick the bubble's colours");
    await db.insert(cosmetics).values({ id, kind: i.kind, name: i.name, svg: art.svg ?? "", svga: art.svga ?? null, style: bubbleStyle(i), exclusive: !i.minSvip, minSvip: i.minSvip ?? 0, forPrize: !!i.forPrize, forMall: !!i.forMall, sortOrder: 1000 });
  }
  return id;
}

export async function updateItem(kind: ItemKind, id: string, i: Omit<ItemInput, "kind">) {
  const art = await artwork({ ...i, kind });
  const files = { ...(art.svg && { svg: art.svg }), ...(art.svga && { svga: art.svga }) };
  const flags = { ...(i.forPrize !== undefined && { forPrize: i.forPrize }), ...(i.forMall !== undefined && { forMall: i.forMall }) };
  const rows =
    kind === "BADGE"
      ? await db
          .update(badges)
          .set({ name: i.name, ...(i.description !== undefined && { description: i.description }), ...(i.enabled !== undefined && { enabled: i.enabled }), ...flags, ...files })
          .where(eq(badges.id, id))
          .returning({ id: badges.id })
      : await db
          .update(cosmetics)
          .set({ name: i.name, ...(i.enabled !== undefined && { enabled: i.enabled }), ...(i.bubble && { style: bubbleStyle({ ...i, kind }) }), ...flags, ...files })
          .where(and(eq(cosmetics.id, id), eq(cosmetics.kind, kind)))
          .returning({ id: cosmetics.id });
  if (!rows.length) throw new AppError("NOT_FOUND", 404, "No such item");
}

async function artwork(i: ItemInput) {
  const image = i.image && i.image.size ? await saveItemFile(i.image, "image") : null;
  const svga = i.svga && i.svga.size ? await saveItemFile(i.svga, "svga") : null;
  const box = { AVATAR_FRAME: [200, 200], CARD_DECOR: [400, 160], CHAT_BUBBLE: [44, 26], BADGE: [100, 100], ENTRY_EFFECT: [100, 100] }[i.kind] as [number, number];
  return { svg: image ? imageSvg(image, ...box) : null, svga };
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
  const lapsed = (col: typeof users.avatarFrameId | typeof users.cardDecorId | typeof users.chatBubbleId | typeof users.entryEffectId) =>
    sql`${col} is not null and ${col} in (select id from cosmetics where exclusive)
      and not exists (select 1 from user_cosmetics uc where uc.user_id = ${users.id} and uc.cosmetic_id = ${col} and (uc.expires_at is null or uc.expires_at > now()))`;
  await db.update(users).set({ avatarFrameId: null }).where(lapsed(users.avatarFrameId));
  await db.update(users).set({ cardDecorId: null }).where(lapsed(users.cardDecorId));
  await db.update(users).set({ chatBubbleId: null }).where(lapsed(users.chatBubbleId));
  await db.update(users).set({ entryEffectId: null }).where(lapsed(users.entryEffectId));
  await db.update(users).set({ specialId: null, specialIdExpiresAt: null }).where(and(isNotNull(users.specialIdExpiresAt), lte(users.specialIdExpiresAt, sql`now()`)));
}

export const runItemSweep = (ms = 60_000) => setInterval(() => sweepExpired().catch((e) => console.error(JSON.stringify({ level: "error", msg: "item-sweep-failed", err: String(e) }))), ms);

// ---------- direct grants (owner) ----------

const KIND_NAME: Record<string, string> = { AVATAR_FRAME: "frame", CARD_DECOR: "profile card", CHAT_BUBBLE: "chat bubble", ENTRY_EFFECT: "entry effect" };
// "5,000 coins + Gold ring frame (30 days) + Special ID of your choice".
export async function itemsText(items: RewardItem[]) {
  const L = await itemLabels({ badges: items.flatMap((i) => (i.type === "BADGE" ? [i.id] : [])), items: items.flatMap((i) => (i.type === "ITEM" ? [i.id] : [])) });
  const d = (n: number | null) => (n ? ` (${n} days)` : "");
  return items
    .map((i) =>
      i.type === "COINS"
        ? `${i.amount.toLocaleString("en-IN")} coins`
        : i.type === "BADGE"
          ? `${L.badges[i.id]?.name ?? "A"} badge${d(i.days)}`
          : i.type === "ITEM"
            ? `${L.items[i.id]?.name ?? "An"} ${KIND_NAME[L.items[i.id]?.kind ?? ""] ?? "item"}${d(i.days)}`
            : i.type === "SPECIAL_ID"
              ? `a Special ID of your choice${d(i.days)}`
              : `SVIP${i.tier} for ${i.days} days`,
    )
    .join(" + ");
}

// The owner gives coins and/or items to one person, with a reason: coins go to the wallet with the grant record in one
// transaction, then each item is granted; the person gets a message in their inbox (Notices). Logged in admin_grants.
export async function giveToUser(actor: User, userId: string, items: RewardItem[], reason: string) {
  const coins = items.reduce((n, i) => n + (i.type === "COINS" ? i.amount : 0), 0);
  const grant = await db.transaction(async (tx) => {
    const [g] = await tx.insert(adminGrants).values({ userId, items, reason, grantedBy: actor.id }).returning();
    if (coins > 0) {
      await tx.insert(walletAccounts).values({ userId, balance: 0 }).onConflictDoNothing();
      await tx.update(walletAccounts).set({ balance: sql`${walletAccounts.balance} + ${coins}`, version: sql`${walletAccounts.version} + 1` }).where(eq(walletAccounts.userId, userId));
      await tx.insert(walletLedger).values({ userId, entryType: "ADMIN_GRANT", amount: coins, referenceType: "ADMIN_GRANT", referenceId: String(g!.id) });
    }
    return g!;
  });
  const failures: string[] = [];
  for (const item of items) if (item.type !== "COINS") await grantItem(userId, item, `grant:${grant.id}`).catch(() => failures.push(item.type.toLowerCase()));
  if (failures.length) await db.update(adminGrants).set({ failures }).where(eq(adminGrants.id, grant.id));
  const now = new Date();
  await db.insert(notices).values({
    title: "A gift from VoyaLive",
    body: `You received ${await itemsText(items)}.\n\n${reason}\n\nCoins are in your wallet; frames, bubbles and effects are in My items.`,
    startsAt: now,
    endsAt: new Date(now.getTime() + 365 * 86_400_000),
    published: true,
    inInbox: true,
    userId,
    createdBy: actor.id,
  });
  return { id: grant.id, failures };
}

export const recentGrants = () =>
  db
    .select({ id: adminGrants.id, items: adminGrants.items, reason: adminGrants.reason, failures: adminGrants.failures, createdAt: adminGrants.createdAt, userId: adminGrants.userId, userName: users.displayName, publicId: users.publicId, by: sql<string | null>`(select display_name from users g where g.id = ${adminGrants.grantedBy})` })
    .from(adminGrants)
    .innerJoin(users, eq(users.id, adminGrants.userId))
    .orderBy(desc(adminGrants.id))
    .limit(100);
