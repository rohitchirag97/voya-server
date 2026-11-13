import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { walletAccounts, walletLedger } from "../db/schema";
import { AppError } from "../lib/errors";

// Settles one play of a single-player game (slots, roulette) in one transaction: takes the stake, pays the win.
// The wallet ledger is the record: a <GAME>_BET row and, when it pays, a <GAME>_WIN row, both referencing the play id.
export async function settlePlay(userId: string, game: "SLOT" | "ROULETTE", stake: number, payout: number) {
  const playId = randomUUID();
  const balance = await db.transaction(async (tx) => {
    const [wallet] = await tx
      .update(walletAccounts)
      .set({ balance: sql`${walletAccounts.balance} - ${stake} + ${payout}`, version: sql`${walletAccounts.version} + 1` })
      .where(and(eq(walletAccounts.userId, userId), sql`${walletAccounts.balance} >= ${stake}`))
      .returning({ balance: walletAccounts.balance });
    if (!wallet) throw new AppError("INSUFFICIENT_COINS", 402);
    await tx.insert(walletLedger).values({ userId, entryType: `${game}_BET`, amount: -stake, referenceType: `${game}_SPIN`, referenceId: playId });
    if (payout) await tx.insert(walletLedger).values({ userId, entryType: `${game}_WIN`, amount: payout, referenceType: `${game}_SPIN`, referenceId: playId });
    return wallet.balance;
  });
  return { playId, balance };
}

export const balanceOf = async (userId: string) =>
  (await db.select({ b: walletAccounts.balance }).from(walletAccounts).where(eq(walletAccounts.userId, userId)))[0]?.b ?? 0;
