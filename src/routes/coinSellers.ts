import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db";
import { coinSellers, users } from "../db/schema";
import { json, requireAuth, schemas, type Env } from "../http";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate, findUserByRef } from "../services/auth";
import { createSub, removeSub, sell, sellerWallet, topUpSub } from "../services/sellers";
import { userSummary } from "../services/rooms";

export const coinSellerRoutes = new Hono<Env>();
coinSellerRoutes.use("/coin-sellers", requireAuth);
coinSellerRoutes.use("/coin-sellers/*", requireAuth);

// Approved sellers, longest-serving first.
coinSellerRoutes.get("/coin-sellers", async (c) => {
  const rows = await db
    .select({ ...userSummary, publicId: users.publicId, specialId: users.specialId, since: coinSellers.decidedAt })
    .from(coinSellers)
    .innerJoin(users, eq(users.id, coinSellers.userId))
    .where(eq(coinSellers.status, "APPROVED"))
    .orderBy(asc(coinSellers.decidedAt));
  return c.json({ sellers: rows });
});

// My application, if any (status null = never applied).
coinSellerRoutes.get("/coin-sellers/me", async (c) => {
  const [row] = await db
    .select({ status: coinSellers.status, appliedAt: coinSellers.appliedAt })
    .from(coinSellers)
    .where(eq(coinSellers.userId, c.get("user").id));
  return c.json(row ?? { status: null, appliedAt: null });
});

// One application per user; only a rejected one can be sent again.
coinSellerRoutes.post("/coin-sellers/apply", async (c) => {
  const user = c.get("user");
  assertCanParticipate(user);
  const b = await json(c, z.object({ message: z.string().trim().min(10, "Tell us a bit more (at least 10 characters)").max(500) }));
  rateLimit(`coinSellerApply:${user.id}`, 5, 60_000);
  const [row] = await db
    .insert(coinSellers)
    .values({ userId: user.id, message: b.message })
    .onConflictDoUpdate({
      target: coinSellers.userId,
      set: { status: "PENDING", message: b.message, appliedAt: new Date(), decidedAt: null },
      setWhere: sql`${coinSellers.status} = 'REJECTED'`,
    })
    .returning({ status: coinSellers.status, appliedAt: coinSellers.appliedAt });
  if (!row) throw new AppError("ALREADY_APPLIED", 409, "You have already applied");
  return c.json(row, 201);
});

// ---------- seller wallet (approved sellers only; each call re-checks) ----------

coinSellerRoutes.get("/coin-sellers/wallet", async (c) => c.json(await sellerWallet(c.get("user"))));

// Sell: seller wallet -> any user's main wallet (`to` = profile ID, special ID or name; your own works too).
coinSellerRoutes.post("/coin-sellers/wallet/sell", async (c) => {
  const b = await json(c, z.object({ to: z.string().trim().min(1).max(40), amount: schemas.coins, idempotencyKey: schemas.idempotencyKey }));
  rateLimit(`sellerMove:${c.get("user").id}`, 60, 60_000);
  return c.json(await sell(c.get("user"), await findUserByRef(b.to), b.amount, b.idempotencyKey));
});

coinSellerRoutes.post("/coin-sellers/sub-sellers", async (c) => {
  const b = await json(c, z.object({ user: z.string().trim().min(1).max(40) }));
  return c.json(await createSub(c.get("user"), await findUserByRef(b.user)), 201);
});

coinSellerRoutes.post("/coin-sellers/sub-sellers/:userId/topup", async (c) => {
  const subId = schemas.uuid.parse(c.req.param("userId"));
  const b = await json(c, z.object({ amount: schemas.coins, idempotencyKey: schemas.idempotencyKey }));
  rateLimit(`sellerMove:${c.get("user").id}`, 60, 60_000);
  return c.json(await topUpSub(c.get("user"), subId, b.amount, b.idempotencyKey));
});

coinSellerRoutes.delete("/coin-sellers/sub-sellers/:userId", async (c) => c.json(await removeSub(c.get("user"), schemas.uuid.parse(c.req.param("userId")))));
