import { eq, ilike, or, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { db } from "../db";
import { coinSellers, users, walletAccounts } from "../db/schema";
import { PERMISSIONS } from "../lib/permissions";
import { listItems } from "../services/items";
import { assignRole, createRole, deleteRole, listRoles, requireAnyStaff, requirePerm, updateRole } from "../services/roles";
import { io, userChannel } from "../io";
import { json, requireAuth, schemas, type Env } from "../http";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import * as agencies from "../services/agencies";
import * as cash from "../services/cash";
import * as giftAdmin from "../services/giftAdmin";
import * as salaries from "../services/salaries";
import { findUserByRef } from "../services/auth";
import { userSummary } from "../services/rooms";
import { store } from "./posts";
import { decideCoinSeller, listSellers, mint } from "../services/sellers";
import { setSpecialId } from "../services/specialIds";

// Staff console API. OWNER and ADMIN get in; only the OWNER changes staff roles.
export const admin = new Hono<Env>();
admin.use("/admin/*", requireAuth, requireAnyStaff); // and each route needs its own switch

// Search by profile ID, special ID, or the start of a display name.
admin.get("/admin/users", requirePerm("users.view"), async (c) => {
  const q = z.string().trim().min(1).max(40).parse(c.req.query("q"));
  const byId = [eq(users.specialId, q.toUpperCase()), ...(/^\d{10}$/.test(q) ? [eq(users.publicId, Number(q))] : [])];
  const rows = await db
    .select({
      ...userSummary,
      publicId: users.publicId,
      specialId: users.specialId,
      status: users.status,
      bannedUntil: users.bannedUntil,
      banReason: users.banReason,
      coins: walletAccounts.balance,
      seller: { status: coinSellers.status, balance: coinSellers.balance, parentId: coinSellers.parentId },
    })
    .from(users)
    .leftJoin(walletAccounts, eq(walletAccounts.userId, users.id))
    .leftJoin(coinSellers, eq(coinSellers.userId, users.id))
    .where(or(...byId, ilike(users.displayName, `${q.replace(/[\\%_]/g, "\\$&")}%`)))
    .orderBy(sql`lower(${users.displayName})`)
    .limit(20);
  return c.json({ users: rows });
});

// Give, change or remove (null) someone's staff role; the rules are in services/roles.ts assignRole. Role "OWNER" hands
// ownership over (owner only): the current owner becomes an Admin.
admin.post("/admin/users/:userId/staff-role", requirePerm("roles.assign"), async (c) => {
  const { role } = await json(c, z.object({ role: z.string().max(40).nullable() }));
  return c.json(await assignRole(c.get("user"), schemas.uuid.parse(c.req.param("userId")), role));
});

// Roles: every role with its switches, look and member count, plus the list of switches to pick from.
const roleBody = z.object({
  name: z.string().trim().min(1).max(30),
  color: z.string(),
  permissions: z.array(z.string().max(40)).max(PERMISSIONS.length),
  showTag: z.boolean(),
  badgeId: z.string().max(64).nullable(),
  frameId: z.string().max(64).nullable(),
});
admin.get("/admin/roles", requirePerm("roles.assign"), async (c) =>
  c.json({ roles: await listRoles(), permissions: PERMISSIONS, items: (await listItems()).filter((i) => i.kind === "BADGE" || i.kind === "AVATAR_FRAME") }),
);
admin.post("/admin/roles", requirePerm("roles.manage"), async (c) => c.json(await createRole(c.get("user"), await json(c, roleBody)), 201));
admin.patch("/admin/roles/:id", requirePerm("roles.manage"), async (c) => {
  await updateRole(c.get("user"), c.req.param("id").slice(0, 40), await json(c, roleBody));
  return c.json({ ok: true });
});
admin.delete("/admin/roles/:id", requirePerm("roles.manage"), async (c) => c.json(await deleteRole(c.get("user"), c.req.param("id").slice(0, 40))));

// Ban for a while or for good, with a reason. An open app is told at once (it signs out and shows until when) and its
// live connections drop; every later request is refused with the same details (see assertNotBanned), so a phone
// that was offline finds out on its next request. Sessions are kept, so when the ban ends they're simply back.
// Staff can't be banned here (change their role first); nobody bans themselves.
const BAN_LENGTHS = { "24h": 86_400_000, "3d": 3 * 86_400_000, "7d": 7 * 86_400_000, "1m": 30 * 86_400_000, "1y": 365 * 86_400_000, life: null } as const;
admin.post("/admin/users/:userId/ban", requirePerm("users.ban"), async (c) => {
  const me = c.get("user");
  const targetId = schemas.uuid.parse(c.req.param("userId"));
  const { duration, reason } = await json(c, z.object({ duration: z.enum(Object.keys(BAN_LENGTHS) as [keyof typeof BAN_LENGTHS]), reason: z.string().trim().min(3).max(300) }));
  if (targetId === me.id) throw new AppError("CANNOT_BAN_SELF", 400, "You can't ban yourself");
  const [target] = await db.select({ staffRole: users.staffRole }).from(users).where(eq(users.id, targetId));
  if (!target) throw new AppError("USER_NOT_FOUND", 404);
  if (target.staffRole) throw new AppError("CANNOT_BAN_STAFF", 400, "Remove their staff role before banning them");
  const ms = BAN_LENGTHS[duration];
  const bannedUntil = ms === null ? null : new Date(Date.now() + ms);
  await db.update(users).set({ status: "BANNED", bannedUntil, banReason: reason, updatedAt: new Date() }).where(eq(users.id, targetId));
  io.to(userChannel(targetId)).emit("account:banned", { until: bannedUntil?.toISOString() ?? null, reason });
  setTimeout(() => io.in(userChannel(targetId)).disconnectSockets(true), 500); // after the notice lands; frees their seat at once
  return c.json({ userId: targetId, status: "BANNED", bannedUntil, banReason: reason });
});

admin.post("/admin/users/:userId/unban", requirePerm("users.ban"), async (c) => {
  const targetId = schemas.uuid.parse(c.req.param("userId"));
  const [u] = await db
    .update(users)
    .set({ status: "ACTIVE", bannedUntil: null, banReason: null, updatedAt: new Date() })
    .where(eq(users.id, targetId))
    .returning({ userId: users.id, status: users.status });
  if (!u) throw new AppError("USER_NOT_FOUND", 404);
  return c.json(u);
});

// Give a special ID (3-9 letters/digits, stored uppercase) or remove it (null).
admin.post("/admin/users/:userId/special-id", requirePerm("users.specialId"), async (c) => {
  const { specialId } = await json(c, z.object({ specialId: z.string().trim().nullable() }));
  const u = await setSpecialId(schemas.uuid.parse(c.req.param("userId")), specialId || null);
  return c.json({ userId: u.id, specialId: u.specialId });
});

admin.get("/admin/coin-sellers", requirePerm("sellers.manage"), async (c) => {
  const status = z.enum(["PENDING", "APPROVED", "REJECTED"]).default("APPROVED").parse(c.req.query("status"));
  return c.json({ sellers: await listSellers(status) });
});

// Approve an application or appoint anyone directly (approve: true); revoke any seller (approve: false).
admin.post("/admin/coin-sellers/:userId/decision", requirePerm("sellers.manage"), async (c) => {
  const { approve } = await json(c, z.object({ approve: z.boolean() }));
  return c.json(await decideCoinSeller(schemas.uuid.parse(c.req.param("userId")), approve));
});

// ---------- agencies ----------

admin.get("/admin/agencies", requirePerm("agencies.manage"), async (c) => c.json({ agencies: await agencies.listAgencies() }));

// Create an agency for a user (profile ID, special ID or name); they become its owner.
admin.post("/admin/agencies", requirePerm("agencies.manage"), async (c) => {
  const b = await json(c, z.object({ owner: z.string().trim().min(1).max(40), name: z.string().trim().min(2).max(30) }));
  return c.json(await agencies.createAgency(await findUserByRef(b.owner), b.name), 201);
});

admin.patch("/admin/agencies/:agencyId", requirePerm("agencies.manage"), async (c) => {
  const b = await json(c, z.object({ name: z.string().trim().min(2).max(30).optional(), status: z.enum(["ACTIVE", "SUSPENDED", "CLOSED"]).optional() }));
  return c.json(await agencies.updateAgency(schemas.uuid.parse(c.req.param("agencyId")), b));
});

// Agency image: JPEG/PNG (multipart "file").
admin.post("/admin/agencies/:agencyId/image", requirePerm("agencies.manage"), async (c) => {
  const file = (await c.req.formData().catch(() => null))?.get("file");
  if (!(file instanceof File)) throw new AppError("FILE_REQUIRED", 400, "Choose a photo");
  return c.json(await agencies.setAgencyImage(schemas.uuid.parse(c.req.param("agencyId")), `/v1/uploads/${(await store(file, ["image"])).name}`));
});

// ---------- salaries and withdrawals ----------

const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month as YYYY-MM");
admin.get("/admin/salaries/:month", requirePerm("salaries.pay"), async (c) => c.json(await salaries.salarySheet(monthParam.parse(c.req.param("month")))));
admin.post("/admin/salaries/:month/pay", requirePerm("salaries.pay"), async (c) => c.json(await salaries.payMonth(c.get("user"), monthParam.parse(c.req.param("month")))));

admin.get("/admin/withdrawals", requirePerm("withdrawals.decide"), async (c) => {
  const status = z.enum(["PENDING", "PAID", "REJECTED"]).default("PENDING").parse(c.req.query("status"));
  return c.json({ withdrawals: await cash.listWithdrawals(status) });
});
admin.post("/admin/withdrawals/:id/decision", requirePerm("withdrawals.decide"), async (c) => {
  const b = await json(c, z.object({ paid: z.boolean(), note: z.string().trim().max(200).nullable().default(null) }));
  return c.json(await cash.decideWithdrawal(c.get("user"), schemas.uuid.parse(c.req.param("id")), b.paid, b.note || null));
});

// Create coins in a seller wallet.
admin.post("/admin/coin-sellers/:userId/mint", requirePerm("coins.mint"), async (c) => {
  const b = await json(c, z.object({ amount: schemas.coins, idempotencyKey: schemas.idempotencyKey }));
  rateLimit(`mint:${c.get("user").id}`, 60, 60_000);
  return c.json(await mint(c.get("user"), schemas.uuid.parse(c.req.param("userId")), b.amount, b.idempotencyKey));
});

// ---------- gift catalog ----------
// Multipart forms: the fields below as text, plus optional files "icon" (PNG/WebP) and "effect" (SVGA 2.x).

const giftFields = z.object({
  name: z.string().trim().min(1).max(24).optional(),
  coinPrice: z.coerce.number().int().min(1).max(10_000_000).optional(),
  maxQuantity: z.coerce.number().int().min(1).max(999).optional(),
  sortOrder: z.coerce.number().int().min(0).max(100_000).optional(),
  enabled: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  categoryId: z.coerce.number().int().positive().optional(),
});
async function giftForm(c: Context<Env>) {
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new AppError("VALIDATION_ERROR", 400, "Send the gift as a form");
  const text = Object.fromEntries(["name", "coinPrice", "maxQuantity", "sortOrder", "enabled", "categoryId"].flatMap((k) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() !== "" ? [[k, v]] : [];
  }));
  const file = (k: string) => {
    const v = form.get(k);
    return v instanceof File && v.size ? v : undefined;
  };
  return { fields: giftFields.parse(text), files: { icon: file("icon"), effect: file("effect") } };
}

admin.get("/admin/gifts", requirePerm("gifts.manage"), async (c) => c.json({ gifts: await giftAdmin.listAllGifts() }));

admin.post("/admin/gifts", requirePerm("gifts.manage"), async (c) => {
  const { fields, files } = await giftForm(c);
  const { name, coinPrice, maxQuantity = 99, sortOrder = 100, categoryId = 1 } = fields;
  if (!name || !coinPrice) throw new AppError("VALIDATION_ERROR", 400, "A gift needs a name and a price");
  return c.json(await giftAdmin.createGift(c.get("user"), { name, coinPrice, maxQuantity, sortOrder, categoryId }, files), 201);
});

admin.patch("/admin/gifts/:giftId", requirePerm("gifts.manage"), async (c) => {
  const { fields, files } = await giftForm(c);
  return c.json(await giftAdmin.updateGift(c.get("user"), z.string().min(1).max(64).parse(c.req.param("giftId")), fields, files));
});

// Gift box tabs: add, rename, reorder, hide (JSON).
const categoryFields = z.object({
  name: z.string().trim().min(1).max(20).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  enabled: z.boolean().optional(),
});

admin.get("/admin/gift-categories", requirePerm("gifts.manage"), async (c) => c.json({ categories: await giftAdmin.listAllCategories() }));

admin.post("/admin/gift-categories", requirePerm("gifts.manage"), async (c) => {
  const b = await json(c, categoryFields.required({ name: true }));
  return c.json(await giftAdmin.createCategory(b.name, b.sortOrder ?? 100), 201);
});

admin.patch("/admin/gift-categories/:id", requirePerm("gifts.manage"), async (c) => {
  const b = await json(c, categoryFields);
  return c.json(await giftAdmin.updateCategory(z.coerce.number().int().positive().parse(c.req.param("id")), b));
});
