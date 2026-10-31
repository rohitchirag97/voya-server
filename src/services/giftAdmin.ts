import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { giftCatalog, giftChanges, users, type User } from "../db/schema";
import { AppError } from "../lib/errors";

// The admin panel's gift catalog: add gifts, change prices and limits, replace art, hide/show. Every change is logged.
// Uploaded files land in uploadsDir/gifts with fresh names and are served from /games/gifts/<name> (app.ts), the same
// "games/..." form the app already shows and plays (a replaced file gets a new name, so phones never keep a stale copy).

export const GIFT_FILES_DIR = () => join(config.uploadsDir, "gifts");
export const GIFT_FILE_NAME = /^[0-9a-f-]{36}\.(png|webp|svga)$/;
const MAX_ICON_BYTES = 1024 * 1024;
const MAX_EFFECT_BYTES = 15 * 1024 * 1024;

export type GiftFields = { name?: string; coinPrice?: number; maxQuantity?: number; sortOrder?: number; enabled?: boolean };
export type GiftFiles = { icon?: File; effect?: File };

async function iconExt(file: File) {
  if (file.size > MAX_ICON_BYTES) throw new AppError("MEDIA_TOO_LARGE", 413, "Icon is too large (max 1 MB)");
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  throw new AppError("BAD_MEDIA", 400, "Icon must be a PNG or WebP image");
}

// An SVGA 2.x file: zlib-compressed protobuf starting with its params. 1.x files (zip archives) aren't played by the app.
async function checkEffect(file: File) {
  if (file.size > MAX_EFFECT_BYTES) throw new AppError("MEDIA_TOO_LARGE", 413, "Animation is too large (max 15 MB)");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) throw new AppError("BAD_MEDIA", 400, "This is an SVGA 1.x file. Export it as SVGA 2.x");
  let movie: Uint8Array;
  try {
    movie = inflateSync(bytes);
  } catch {
    throw new AppError("BAD_MEDIA", 400, "Animation must be an .svga file (SVGA 2.x)");
  }
  // Every SVGA 2 movie carries fields 1 (version) and/or 2 (params) as length-delimited values up front.
  if (!movie.length || ![0x0a, 0x12].includes(movie[0]!)) throw new AppError("BAD_MEDIA", 400, "Animation must be an .svga file (SVGA 2.x)");
}

async function save(file: File, ext: string) {
  const name = `${randomUUID()}.${ext}`;
  await mkdir(GIFT_FILES_DIR(), { recursive: true });
  await Bun.write(join(GIFT_FILES_DIR(), name), file);
  return name;
}

// Every gift (hidden ones too), with its newest changes and who made them.
export async function listAllGifts() {
  const gifts = await db.select().from(giftCatalog).orderBy(asc(giftCatalog.sortOrder), asc(giftCatalog.createdAt));
  const log = gifts.length
    ? await db
        .select({ giftId: giftChanges.giftId, changes: giftChanges.changes, at: giftChanges.createdAt, by: users.displayName, byId: users.publicId })
        .from(giftChanges)
        .innerJoin(users, eq(users.id, giftChanges.actorId))
        .where(inArray(giftChanges.giftId, gifts.map((g) => g.id)))
        .orderBy(desc(giftChanges.createdAt))
    : [];
  return gifts.map((g) => ({ ...g, changes: log.filter((c) => c.giftId === g.id).slice(0, 20) }));
}

// New gifts start hidden, so the animation can be previewed before anyone can send it.
export async function createGift(actor: User, fields: Required<Omit<GiftFields, "enabled">>, files: GiftFiles) {
  if (!files.icon) throw new AppError("FILE_REQUIRED", 400, "Choose an icon");
  const iconName = await save(files.icon, await iconExt(files.icon));
  let effect: string | null = null;
  if (files.effect) {
    await checkEffect(files.effect);
    effect = `/games/gifts/${await save(files.effect, "svga")}`;
  }
  const id = `${fields.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "gift"}_${randomUUID().slice(0, 6)}`;
  const row = { id, ...fields, assetUrl: `games/gifts/${iconName}`, effect, enabled: false };
  return db.transaction(async (tx) => {
    const [gift] = await tx.insert(giftCatalog).values(row).returning();
    const changes = Object.fromEntries(
      (["name", "coinPrice", "maxQuantity", "sortOrder", "assetUrl", "effect"] as const).filter((k) => row[k] != null).map((k) => [k, [null, row[k]]]),
    ) as Record<string, [unknown, unknown]>;
    await tx.insert(giftChanges).values({ giftId: id, actorId: actor.id, changes });
    return gift!;
  });
}

export async function updateGift(actor: User, id: string, fields: GiftFields, files: GiftFiles) {
  const next: Partial<typeof giftCatalog.$inferInsert> = { ...fields };
  if (files.icon) next.assetUrl = `games/gifts/${await save(files.icon, await iconExt(files.icon))}`;
  if (files.effect) {
    await checkEffect(files.effect);
    next.effect = `/games/gifts/${await save(files.effect, "svga")}`;
  }
  return db.transaction(async (tx) => {
    const [gift] = await tx.select().from(giftCatalog).where(eq(giftCatalog.id, id)).for("update");
    if (!gift) throw new AppError("NOT_FOUND", 404, "No such gift");
    const changes: Record<string, [unknown, unknown]> = {};
    for (const [k, v] of Object.entries(next)) if (v !== undefined && gift[k as keyof typeof gift] !== v) changes[k] = [gift[k as keyof typeof gift], v];
    if (!Object.keys(changes).length) return gift;
    const [saved] = await tx.update(giftCatalog).set(next).where(eq(giftCatalog.id, id)).returning();
    await tx.insert(giftChanges).values({ giftId: id, actorId: actor.id, changes });
    return saved!;
  });
}
