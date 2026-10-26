import { and, eq, sql } from "drizzle-orm";
import { config } from "../config";
import { db, isUniqueViolation } from "../db";
import { recharges, users, walletAccounts, walletLedger, type User } from "../db/schema";
import { AppError, toSafeError } from "../lib/errors";
import { levelInfo, levelOf } from "../lib/levels";
import { rateLimit } from "../lib/rateLimit";
import { notifyCoins } from "./dmPush";
import { announceToAllRooms, monthRupeesOf, tierFor } from "./svip";

// Coin packages (price in paise). Each ₹1 paid also earns 1 level point (XP).
export const PACKAGES = [
  { id: "coins_60", coins: 60, pricePaise: 9_900 },
  { id: "coins_300", coins: 300, pricePaise: 44_900 },
  { id: "coins_980", coins: 980, pricePaise: 1_39_900 },
  { id: "coins_2000", coins: 2000, pricePaise: 2_79_900 },
  { id: "coins_5000", coins: 5000, pricePaise: 6_49_900 },
] as const;

const balanceOf = async (userId: string) =>
  (await db.select({ b: walletAccounts.balance }).from(walletAccounts).where(eq(walletAccounts.userId, userId)))[0]?.b ?? 0;

async function replay(userId: string, key: string, packageId: string) {
  const [prior] = await db.select().from(recharges).where(and(eq(recharges.userId, userId), eq(recharges.idempotencyKey, key)));
  if (!prior) return null;
  if (prior.packageId !== packageId) throw new AppError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key reused with a different request");
  const [u] = await db.select({ xp: users.xp }).from(users).where(eq(users.id, userId));
  return { recharge: prior, balance: await balanceOf(userId), level: levelInfo(u!.xp), leveledUp: false, replayed: true };
}

// shortcut: test purchases only (provider "DEV", no money moves). Before launch, verify a real
// Google Play / payment-provider receipt here instead, and keep this path off in production.
export async function recharge(user: User, packageId: string, key: string | undefined) {
  if (config.env === "production") throw new AppError("PAYMENTS_NOT_CONFIGURED", 503, "Recharge isn't available yet");
  if (!key || key.length > 128) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
  const pkg = PACKAGES.find((p) => p.id === packageId);
  if (!pkg) throw new AppError("INVALID_PACKAGE", 400);
  const prior = await replay(user.id, key, packageId);
  if (prior) return prior;
  rateLimit(`recharge:${user.id}`, 10, 60_000);

  try {
    const result = await db.transaction(async (tx) => {
      const [r] = await tx
        .insert(recharges)
        .values({ userId: user.id, packageId: pkg.id, coins: pkg.coins, pricePaise: pkg.pricePaise, provider: "DEV", idempotencyKey: key })
        .returning();
      const [w] = await tx
        .update(walletAccounts)
        .set({ balance: sql`${walletAccounts.balance} + ${pkg.coins}`, version: sql`${walletAccounts.version} + 1` })
        .where(eq(walletAccounts.userId, user.id))
        .returning();
      const [entry] = await tx
        .insert(walletLedger)
        .values({ userId: user.id, entryType: "RECHARGE", amount: pkg.coins, referenceType: "RECHARGE", referenceId: r!.id })
        .returning({ id: walletLedger.id });
      const earned = Math.floor(pkg.pricePaise / 100);
      const [u] = await tx
        .update(users)
        .set({ xp: sql`${users.xp} + ${earned}` })
        .where(eq(users.id, user.id))
        .returning({ xp: users.xp });
      const level = levelInfo(u!.xp);
      return { recharge: r!, balance: w!.balance, level, leveledUp: level.level > levelOf(u!.xp - earned), replayed: false, txnId: `TXN${entry!.id}` };
    });
    announceRecharge(user, Math.floor(pkg.pricePaise / 100), result.level.level, result.leveledUp).catch(toSafeError);
    const paidRupees = Math.floor(pkg.pricePaise / 100);
    notifyCoins(user.id, { kind: "RECHARGE", status: "SUCCESS", coins: pkg.coins, balance: result.balance, txnId: result.txnId, paidRupees }).catch(toSafeError);
    return result;
  } catch (e) {
    // Same key sent twice at once: the loser returns the winner's result.
    if (isUniqueViolation(e)) {
      const won = await replay(user.id, key, packageId);
      if (won) return won;
    }
    throw e;
  }
}

// Tell every open room about a level-up and an SVIP tier-up this recharge caused.
async function announceRecharge(user: User, rupees: number, level: number, leveledUp: boolean) {
  if (leveledUp) announceToAllRooms(user, { kind: "LEVEL_UP", level });
  const month = await monthRupeesOf(user.id);
  const tier = tierFor(month);
  if (tier > tierFor(month - rupees)) announceToAllRooms(user, { kind: "SVIP_UP", tier });
}
