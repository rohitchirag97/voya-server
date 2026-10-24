import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db";
import { coinSellers, users } from "../db/schema";
import { json, requireAuth, type Env } from "../http";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate } from "../services/auth";
import { grantBadge, revokeBadge } from "../services/badges";
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

// Staff decision (CLI for now, admin console later). Approval also gives the Coin Seller badge; rejection removes it.
export async function decideCoinSeller(userId: string, approve: boolean) {
  const [row] = await db
    .update(coinSellers)
    .set({ status: approve ? "APPROVED" : "REJECTED", decidedAt: new Date() })
    .where(eq(coinSellers.userId, userId))
    .returning();
  if (!row) throw new AppError("NO_APPLICATION", 404, "This user has not applied");
  if (approve) await grantBadge(userId, "coin_seller", null);
  else await revokeBadge(userId, "coin_seller");
  return row;
}
