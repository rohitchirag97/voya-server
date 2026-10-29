import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, isUniqueViolation, type Tx } from "../db";
import { cashAccounts, cashLedger, payoutDetails, users, withdrawals, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { userSummary } from "./rooms";

// Withdrawable money in paise: host salaries from level 3 up and agency owner bonuses. Paid out by staff to a bank account.
export const MIN_WITHDRAWAL_PAISE = 500_00; // ₹500

export async function creditCash(tx: Tx, userId: string, paise: number, kind: string, referenceType: string, referenceId: string) {
  await tx
    .insert(cashAccounts)
    .values({ userId, balancePaise: paise })
    .onConflictDoUpdate({ target: cashAccounts.userId, set: { balancePaise: sql`${cashAccounts.balancePaise} + ${paise}` } });
  await tx.insert(cashLedger).values({ userId, kind, amountPaise: paise, referenceType, referenceId });
}

export async function cashOf(userId: string) {
  const [[a], [details], history, ledger] = await Promise.all([
    db.select({ balancePaise: cashAccounts.balancePaise }).from(cashAccounts).where(eq(cashAccounts.userId, userId)),
    db.select({ accountName: payoutDetails.accountName, accountNumber: payoutDetails.accountNumber, ifsc: payoutDetails.ifsc }).from(payoutDetails).where(eq(payoutDetails.userId, userId)),
    db.select().from(withdrawals).where(eq(withdrawals.userId, userId)).orderBy(desc(withdrawals.createdAt)).limit(20),
    db.select().from(cashLedger).where(eq(cashLedger.userId, userId)).orderBy(desc(cashLedger.id)).limit(30),
  ]);
  return { balancePaise: a?.balancePaise ?? 0, minPaise: MIN_WITHDRAWAL_PAISE, details: details ?? null, withdrawals: history, ledger };
}

export async function setDetails(user: User, d: { accountName: string; accountNumber: string; ifsc: string }) {
  await db
    .insert(payoutDetails)
    .values({ userId: user.id, ...d })
    .onConflictDoUpdate({ target: payoutDetails.userId, set: { ...d, updatedAt: new Date() } });
  return cashOf(user.id);
}

// The amount leaves the balance now; staff pay it to the bank details as they are at this moment.
export async function requestWithdrawal(user: User, amountPaise: number) {
  rateLimit(`withdraw:${user.id}`, 5, 60_000);
  if (amountPaise < MIN_WITHDRAWAL_PAISE) throw new AppError("BELOW_MINIMUM", 400, `The minimum withdrawal is ₹${MIN_WITHDRAWAL_PAISE / 100}`);
  try {
    await db.transaction(async (tx) => {
      const [d] = await tx.select().from(payoutDetails).where(eq(payoutDetails.userId, user.id));
      if (!d) throw new AppError("NO_PAYOUT_DETAILS", 400, "Add your bank details first");
      const [a] = await tx
        .update(cashAccounts)
        .set({ balancePaise: sql`${cashAccounts.balancePaise} - ${amountPaise}` })
        .where(and(eq(cashAccounts.userId, user.id), gte(cashAccounts.balancePaise, amountPaise)))
        .returning();
      if (!a) throw new AppError("INSUFFICIENT_CASH", 409, "That's more than your balance");
      const [w] = await tx
        .insert(withdrawals)
        .values({ userId: user.id, amountPaise, accountName: d.accountName, accountNumber: d.accountNumber, ifsc: d.ifsc })
        .returning();
      await tx.insert(cashLedger).values({ userId: user.id, kind: "WITHDRAWAL", amountPaise: -amountPaise, referenceType: "WITHDRAWAL", referenceId: w!.id });
    });
  } catch (e) {
    throw isUniqueViolation(e) ? new AppError("WITHDRAWAL_OPEN", 409, "You already have a withdrawal waiting to be paid") : e;
  }
  return cashOf(user.id);
}

// ---------- staff ----------

export const listWithdrawals = (status: "PENDING" | "PAID" | "REJECTED") =>
  db
    .select({ id: withdrawals.id, amountPaise: withdrawals.amountPaise, accountName: withdrawals.accountName, accountNumber: withdrawals.accountNumber, ifsc: withdrawals.ifsc, status: withdrawals.status, note: withdrawals.note, createdAt: withdrawals.createdAt, decidedAt: withdrawals.decidedAt, user: { ...userSummary, publicId: users.publicId } })
    .from(withdrawals)
    .innerJoin(users, eq(users.id, withdrawals.userId))
    .where(eq(withdrawals.status, status))
    .orderBy(status === "PENDING" ? withdrawals.createdAt : desc(withdrawals.decidedAt))
    .limit(200);

// Mark paid (after sending the money) or reject (the amount goes back to their balance). Each request is decided once.
export async function decideWithdrawal(staff: User, id: string, paid: boolean, note: string | null) {
  return db.transaction(async (tx) => {
    const [w] = await tx.select().from(withdrawals).where(eq(withdrawals.id, id)).for("update");
    if (!w) throw new AppError("WITHDRAWAL_NOT_FOUND", 404);
    if (w.status !== "PENDING") throw new AppError("ALREADY_DECIDED", 409, "This withdrawal was already decided");
    const [done] = await tx
      .update(withdrawals)
      .set({ status: paid ? "PAID" : "REJECTED", note, decidedAt: new Date(), decidedBy: staff.id })
      .where(eq(withdrawals.id, id))
      .returning();
    if (!paid) await creditCash(tx, w.userId, w.amountPaise, "WITHDRAWAL_RETURNED", "WITHDRAWAL", w.id);
    return done!;
  });
}
