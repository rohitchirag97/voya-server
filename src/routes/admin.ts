import { eq, ilike, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db";
import { coinSellers, staffRole, users, walletAccounts } from "../db/schema";
import { io, userChannel } from "../io";
import { json, requireAuth, requireStaff, schemas, type Env } from "../http";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { userSummary } from "../services/rooms";
import { decideCoinSeller, listSellers, mint } from "../services/sellers";
import { setSpecialId } from "../services/specialIds";

// Staff console API. OWNER and ADMIN get in; only the OWNER changes staff roles.
export const admin = new Hono<Env>();
admin.use("/admin/*", requireAuth, requireStaff("OWNER", "ADMIN"));

// Search by profile ID, special ID, or the start of a display name.
admin.get("/admin/users", async (c) => {
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

// OWNER only. role OWNER hands ownership over: the current owner becomes an ADMIN in the same transaction.
admin.post("/admin/users/:userId/staff-role", requireStaff("OWNER"), async (c) => {
  const owner = c.get("user");
  const targetId = schemas.uuid.parse(c.req.param("userId"));
  const { role } = await json(c, z.object({ role: z.enum(staffRole.enumValues).nullable() }));
  if (targetId === owner.id) throw new AppError("CANNOT_CHANGE_OWN_ROLE", 400, "Hand ownership to someone else instead");
  const updated = await db.transaction(async (tx) => {
    if (role === "OWNER") await tx.update(users).set({ staffRole: "ADMIN", updatedAt: new Date() }).where(eq(users.id, owner.id));
    const [u] = await tx.update(users).set({ staffRole: role, updatedAt: new Date() }).where(eq(users.id, targetId)).returning({ userId: users.id, staffRole: users.staffRole });
    if (!u) throw new AppError("USER_NOT_FOUND", 404);
    return u;
  });
  return c.json(updated);
});

// Ban for a while or for good, with a reason. An open app is told at once (it signs out and shows until when) and its
// live connections drop; every later request is refused with the same details (see assertNotBanned), so a phone
// that was offline finds out on its next request. Sessions are kept, so when the ban ends they're simply back.
// Staff can't be banned here (change their role first); nobody bans themselves.
const BAN_LENGTHS = { "24h": 86_400_000, "3d": 3 * 86_400_000, "7d": 7 * 86_400_000, "1m": 30 * 86_400_000, "1y": 365 * 86_400_000, life: null } as const;
admin.post("/admin/users/:userId/ban", async (c) => {
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

admin.post("/admin/users/:userId/unban", async (c) => {
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
admin.post("/admin/users/:userId/special-id", async (c) => {
  const { specialId } = await json(c, z.object({ specialId: z.string().trim().nullable() }));
  const u = await setSpecialId(schemas.uuid.parse(c.req.param("userId")), specialId || null);
  return c.json({ userId: u.id, specialId: u.specialId });
});

admin.get("/admin/coin-sellers", async (c) => {
  const status = z.enum(["PENDING", "APPROVED", "REJECTED"]).default("APPROVED").parse(c.req.query("status"));
  return c.json({ sellers: await listSellers(status) });
});

// Approve an application or appoint anyone directly (approve: true); revoke any seller (approve: false).
admin.post("/admin/coin-sellers/:userId/decision", async (c) => {
  const { approve } = await json(c, z.object({ approve: z.boolean() }));
  return c.json(await decideCoinSeller(schemas.uuid.parse(c.req.param("userId")), approve));
});

// Create coins in a seller wallet.
admin.post("/admin/coin-sellers/:userId/mint", async (c) => {
  const b = await json(c, z.object({ amount: schemas.coins, idempotencyKey: schemas.idempotencyKey }));
  rateLimit(`mint:${c.get("user").id}`, 60, 60_000);
  return c.json(await mint(c.get("user"), schemas.uuid.parse(c.req.param("userId")), b.amount, b.idempotencyKey));
});
