import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { config } from "../config";
import { db, isUniqueViolation } from "../db";
import { adminGrants, badges, cosmetics, notices, specialIdVouchers, svipGrants, userCosmetics, users, walletAccounts, walletLedger, type RewardItem, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { grantBadge } from "./badges";
import { checkEffect } from "./giftAdmin";
import { normalizeSpecialId } from "./specialIds";

// Items made in the admin panel (Items): badges, avatar frames, profile card decorations, chat bubbles and entry
// effects, with uploaded artwork (PNG/WebP, or animated SVGA), each marked as an event prize and/or a Mall item. They're
// exclusive: only people who own one (user_cosmetics; won, given, or later bought) can wear it. Also: granting every
// kind of item, direct grants by the owner, Special ID vouchers, and expiry.

export const ITEM_FILES_DIR = () => join(config.uploadsDir, "items");
export type ItemKind = "BADGE" | "AVATAR_FRAME" | "CARD_DECOR" | "CHAT_BUBBLE" | "ENTRY_EFFECT";
const now = () => new Date();
const until = (days: number | null) => (days === null ? null : new Date(Date.now() + days * 86_400_000));

// What a file really is, from its first bytes (its name and the box it was chosen in can be wrong).
async function fileType(file: File) {
  const h = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const text = String.fromCharCode(...h);
  if (h[0] === 0x89 && h[1] === 0x50) return "png";
  if (h[0] === 0xff && h[1] === 0xd8) return "jpg";
  if (text.slice(8, 12) === "WEBP") return "webp";
  if ((h[0] === 0x50 && h[1] === 0x4b) || h[0] === 0x78) return "svga"; // SVGA 1 (zip) or SVGA 2 (zlib)
  if (text.startsWith("GIF")) return "gif";
  if (text.trimStart().startsWith("<")) return "svg";
  return null;
}
const NOT_OK: Record<string, string> = {
  gif: "That file is a GIF. Use a PNG, WebP or JPEG picture, or an SVGA for animation.",
  svg: "That file is an SVG drawing. Export it as a PNG (or an SVGA for animation).",
};

// Pictures (PNG, WebP, JPEG) up to 2 MB, SVGA animations up to 15 MB; fresh names, served at /games/items/<name>.
// `want` is what the caller needs; a picture where an animation is needed (or the other way round) is refused.
export async function saveItemFile(file: File, want: "image" | "svga") {
  const ext = await fileType(file);
  if (!ext || NOT_OK[ext]) throw new AppError("BAD_MEDIA", 400, (ext && NOT_OK[ext]) || "That file isn't a picture (PNG, WebP, JPEG) or an SVGA animation");
  if (want === "image" && ext === "svga") throw new AppError("BAD_MEDIA", 400, "That's an SVGA animation. Choose it under Animation, not Picture.");
  if (want === "svga" && ext !== "svga") throw new AppError("BAD_MEDIA", 400, "That's a picture, not an SVGA animation");
  if (want === "svga") await checkEffect(file); // SVGA 2.x only (the app can't play 1.x)
  if (file.size > (want === "image" ? 2 : 15) * 1024 * 1024) throw new AppError("MEDIA_TOO_LARGE", 413, want === "image" ? "Picture is too large (max 2 MB)" : "Animation is too large (max 15 MB)");
  const name = `${randomUUID()}.${ext}`;
  await mkdir(ITEM_FILES_DIR(), { recursive: true });
  await Bun.write(join(ITEM_FILES_DIR(), name), file);
  return `games/items/${name}`;
}

// A picture's or animation's own width and height, read from the file (PNG, JPEG, WebP, SVGA 2.x); null if unknown.
// Badges keep their shape (they're often wide), so the app needs it.
export async function artSize(file: File): Promise<{ w: number; h: number } | null> {
  const b = new Uint8Array(await file.arrayBuffer());
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u32 = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8);
  const le24 = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: u32(16), h: u32(20) }; // PNG IHDR
  if (b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the markers to the frame header (SOF0-15, not DHT/JPG/DAC).
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) };
      i += 2 + u16(i + 2);
    }
    return null;
  }
  if (String.fromCharCode(...b.slice(8, 12)) === "WEBP") {
    const chunk = String.fromCharCode(...b.slice(12, 16));
    if (chunk === "VP8X") return { w: le24(24) + 1, h: le24(27) + 1 };
    if (chunk === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    return null;
  }
  try {
    // SVGA 2.x: MovieEntity.params (field 2) holds viewBoxWidth (field 1) and viewBoxHeight (field 2) as floats.
    const m = new Uint8Array(inflateSync(b));
    const varint = (i: number) => {
      let v = 0, shift = 0, x;
      do { x = m[i++]!; v += (x & 0x7f) * 2 ** shift; shift += 7; } while (x & 0x80);
      return [v, i] as const;
    };
    for (let i = 0; i < m.length; ) {
      const [key, a] = varint(i);
      const field = key >> 3, type = key & 7;
      if (type === 2) {
        const [len, start] = varint(a);
        if (field === 2) {
          const view = new DataView(m.buffer, m.byteOffset + start, len);
          let w = 0, h = 0;
          for (let j = 0; j < len; ) {
            const k = view.getUint8(j);
            if ((k & 7) === 5) {
              const f = view.getFloat32(j + 1, true);
              if (k >> 3 === 1) w = f;
              if (k >> 3 === 2) h = f;
              j += 5;
            } else if ((k & 7) === 0) { j++; while (view.getUint8(j++) & 0x80); } else break;
          }
          return w > 0 && h > 0 ? { w, h } : null;
        }
        i = start + len;
      } else if (type === 0) i = varint(a)[1];
      else if (type === 5) i = a + 4;
      else if (type === 1) i = a + 8;
      else return null;
    }
  } catch {}
  return null;
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
  internal?: boolean; // never a prize or in the Mall: wins over forPrize/forMall
  minSvip?: number; // an SVIP item (admin panel > SVIP): free to wear from this tier up, never owned
};

// Everything the panel can pick from, newest first within each kind.
export async function listItems() {
  const [b, c] = await Promise.all([
    db.select().from(badges).orderBy(desc(badges.createdAt)),
    db.select().from(cosmetics).where(eq(cosmetics.exclusive, true)).orderBy(desc(cosmetics.createdAt)),
  ]);
  const flags = (x: { forPrize: boolean; forMall: boolean; internal: boolean; enabled: boolean }) => ({ forPrize: x.forPrize, forMall: x.forMall, internal: x.internal, enabled: x.enabled });
  return [
    ...b.map((x) => ({ kind: "BADGE" as ItemKind, id: x.id, name: x.name, description: x.description, svg: x.svg, svga: x.svga, style: null, ...flags(x) })),
    ...c.map((x) => ({ kind: x.kind as ItemKind, id: x.id, name: x.name, description: "", svg: x.svg, svga: x.svga, style: x.style, ...flags(x) })),
  ];
}

// Internal-only items can't also be prizes or Mall items.
const placement = (i: Pick<ItemInput, "forPrize" | "forMall" | "internal">) =>
  i.internal ? { internal: true, forPrize: false, forMall: false } : { internal: false, forPrize: !!i.forPrize, forMall: !!i.forMall };

export async function createItem(i: ItemInput) {
  const art = await artwork(i);
  const id = randomUUID();
  if (i.kind === "BADGE") {
    if (!art.svg && !art.svga) throw new AppError("FILE_REQUIRED", 400, "Upload the badge's image or animation");
    await db.insert(badges).values({ id, name: i.name, description: i.description ?? "", svg: art.svg ?? "", svga: art.svga ?? null, ...placement(i), sortOrder: 1000 });
  } else {
    if (i.kind === "AVATAR_FRAME" && !art.svg && !art.svga) throw new AppError("FILE_REQUIRED", 400, "Upload the frame's image or animation");
    if ((i.kind === "CARD_DECOR" || i.kind === "ENTRY_EFFECT") && !art.svg && !art.svga) throw new AppError("FILE_REQUIRED", 400, "Upload its artwork (SVGA, PNG or WebP)");
    if (i.kind === "CHAT_BUBBLE" && !i.bubble) throw new AppError("VALIDATION_ERROR", 400, "Pick the bubble's colours");
    await db.insert(cosmetics).values({ id, kind: i.kind, name: i.name, svg: art.svg ?? "", svga: art.svga ?? null, style: bubbleStyle(i), exclusive: !i.minSvip, minSvip: i.minSvip ?? 0, ...placement(i), sortOrder: 1000 });
  }
  return id;
}

export async function updateItem(kind: ItemKind, id: string, i: Omit<ItemInput, "kind">) {
  const art = await artwork({ ...i, kind });
  const files = { ...(art.svg && { svg: art.svg }), ...(art.svga && { svga: art.svga }) };
  const flags = i.forPrize !== undefined || i.forMall !== undefined || i.internal !== undefined ? placement(i) : {};
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

// The item's files, sorted by what each really is: an SVGA chosen as the picture is used as the animation, and a
// picture chosen as the animation is used as the picture.
async function artwork(i: ItemInput) {
  const files = [i.image, i.svga].filter((f): f is File => !!f && f.size > 0);
  const kinds = await Promise.all(files.map(fileType));
  const pic = files.find((_, k) => kinds[k] !== "svga");
  const anim = files.find((_, k) => kinds[k] === "svga");
  const image = pic ? await saveItemFile(pic, "image") : null;
  const svga = anim ? await saveItemFile(anim, "svga") : null;
  const box = { AVATAR_FRAME: [200, 200], CARD_DECOR: [400, 160], CHAT_BUBBLE: [44, 26], BADGE: [100, 100], ENTRY_EFFECT: [100, 100] }[i.kind] as [number, number];
  if (i.kind === "BADGE") {
    // Badges keep their own shape (often wide): 100 high, as wide as the art; the picture is never cropped.
    const size = (pic && (await artSize(pic))) || (anim && (await artSize(anim)));
    const w = size ? Math.round(Math.min(5, Math.max(0.2, size.w / size.h)) * 100) : 100;
    const svg = image
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 100"><image href="/${image}" width="${w}" height="100" preserveAspectRatio="xMidYMid meet"/></svg>`
      : svga
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 100"/>` // only carries the shape
        : null;
    return { svg, svga };
  }
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
