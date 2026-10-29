import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db, isUniqueViolation, type Tx } from "../db";
import { agencyHosts, diamondAccounts, diamondLedger, hostMonths, walletAccounts, walletLedger, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate } from "./auth";
import { currentMonth } from "./hostMonth";

// A gift recipient earns 70% of the coins spent, as diamonds (rounded down per gift). The platform keeps the rest.
export const DIAMOND_SHARE_PERCENT = 70;
// Converting to coins: 2 diamonds = 1 coin, i.e. a diamond is worth ₹0.05, the same as in host salaries.
export const DIAMONDS_PER_COIN = 2;
export const diamondsFor = (coins: number) => Math.floor((coins * DIAMOND_SHARE_PERCENT) / 100);

// Diamonds come in two places: the account (anyone's, never lapses) and, for agency hosts, each month's salary pool
// (host_months; what isn't converted is settled by the salary). Both convert to coins; pools are used first.
const openPools = (userId: string) => and(eq(hostMonths.userId, userId), isNull(hostMonths.settledAt));

export async function diamondBalance(userId: string) {
  const [[a], [p]] = await Promise.all([
    db.select({ balance: diamondAccounts.balance }).from(diamondAccounts).where(eq(diamondAccounts.userId, userId)),
    db.select({ left: sql<number>`coalesce(sum(${hostMonths.earned} - ${hostMonths.converted}), 0)::int` }).from(hostMonths).where(openPools(userId)),
  ]);
  const pool = Number(p?.left ?? 0);
  return { balance: (a?.balance ?? 0) + pool, pool };
}

// Inside the gift transaction, after the sender's coin wallet is debited. A host's gift goes to this month's pool for
// their agency; anyone else's to their account. Lock order everywhere: coin wallets, then pools, then diamond accounts,
// recipients in user-id order, so crossing gifts can't deadlock.
export async function creditGifts(tx: Tx, gifts: { id: string; recipientId: string; coinsDebited: number }[]) {
  for (const g of [...gifts].sort((a, b) => (a.recipientId < b.recipientId ? -1 : a.recipientId > b.recipientId ? 1 : 0))) {
    const amount = diamondsFor(g.coinsDebited);
    if (amount <= 0) continue;
    const [host] = await tx
      .select({ agencyId: agencyHosts.agencyId })
      .from(agencyHosts)
      .where(and(eq(agencyHosts.userId, g.recipientId), sql`${agencyHosts.status} in ('ACTIVE', 'LEAVING')`));
    if (host) {
      await tx
        .insert(hostMonths)
        .values({ userId: g.recipientId, agencyId: host.agencyId, month: sql`${currentMonth}`, earned: amount })
        .onConflictDoUpdate({ target: [hostMonths.userId, hostMonths.agencyId, hostMonths.month], set: { earned: sql`${hostMonths.earned} + ${amount}` } });
    } else {
      await tx
        .insert(diamondAccounts)
        .values({ userId: g.recipientId, balance: amount })
        .onConflictDoUpdate({ target: diamondAccounts.userId, set: { balance: sql`${diamondAccounts.balance} + ${amount}` } });
    }
    await tx.insert(diamondLedger).values({ userId: g.recipientId, entryType: host ? "HOST_GIFT_RECEIVED" : "GIFT_RECEIVED", amount, referenceType: "GIFT", referenceId: g.id });
  }
}

// Diamonds -> coins in the main wallet. Only whole coins: an odd diamond stays. Salary pools are used first (oldest
// month first); what comes from a pool is taken off that month's salary at settlement.
export async function convertToCoins(user: User, requested: number, idempotencyKey: string) {
  assertCanParticipate(user);
  rateLimit(`diamondConvert:${user.id}`, 20, 60_000);
  const coins = Math.floor(requested / DIAMONDS_PER_COIN);
  if (coins < 1) throw new AppError("VALIDATION_ERROR", 400, `Convert at least ${DIAMONDS_PER_COIN} diamonds`);
  const diamonds = coins * DIAMONDS_PER_COIN;
  const short = () => new AppError("INSUFFICIENT_DIAMONDS", 409, "Not enough diamonds");
  try {
    const done = await db.transaction(async (tx) => {
      const [wallet] = await tx
        .update(walletAccounts)
        .set({ balance: sql`${walletAccounts.balance} + ${coins}`, version: sql`${walletAccounts.version} + 1` })
        .where(eq(walletAccounts.userId, user.id))
        .returning();
      if (!wallet) throw short();
      let left = diamonds;
      const pools = await tx.select().from(hostMonths).where(openPools(user.id)).orderBy(asc(hostMonths.month)).for("update");
      for (const p of pools) {
        const take = Math.min(left, p.earned - p.converted);
        if (take <= 0) continue;
        await tx
          .update(hostMonths)
          .set({ converted: sql`${hostMonths.converted} + ${take}` })
          .where(and(eq(hostMonths.userId, p.userId), eq(hostMonths.agencyId, p.agencyId), eq(hostMonths.month, p.month)));
        left -= take;
      }
      if (left > 0) {
        const [account] = await tx
          .update(diamondAccounts)
          .set({ balance: sql`${diamondAccounts.balance} - ${left}` })
          .where(and(eq(diamondAccounts.userId, user.id), gte(diamondAccounts.balance, left)))
          .returning();
        if (!account) throw short();
      }
      const [entry] = await tx
        .insert(diamondLedger)
        .values({ userId: user.id, entryType: "CONVERT_TO_COINS", amount: -diamonds, referenceType: "WALLET", referenceId: user.id, idempotencyKey })
        .returning();
      await tx.insert(walletLedger).values({ userId: user.id, entryType: "DIAMOND_CONVERT", amount: coins, referenceType: "DIAMOND_LEDGER", referenceId: String(entry!.id) });
      return { balance: wallet.balance, fromPool: diamonds - left };
    });
    return { diamonds: (await diamondBalance(user.id)).balance, ...done };
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("DUPLICATE_REQUEST", 409, "This conversion was already done");
    throw e;
  }
}

export const diamondHistory = (userId: string) =>
  db.select().from(diamondLedger).where(eq(diamondLedger.userId, userId)).orderBy(desc(diamondLedger.id)).limit(50);
