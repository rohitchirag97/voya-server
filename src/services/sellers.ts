import { aliasedTable, and, desc, eq, gte, sql } from "drizzle-orm";
import { db, isUniqueViolation, type Tx } from "../db";
import { coinSellers, sellerLedger, users, walletAccounts, walletLedger, type User } from "../db/schema";
import { AppError, toSafeError } from "../lib/errors";
import { grantBadge, revokeBadge } from "./badges";
import { notifyCoins } from "./dmPush";
import { userSummary } from "./rooms";

// Seller wallets. Coins enter only through mint (staff); they leave to a user's main wallet (sale) or down to a sub seller.

const notSeller = () => new AppError("NOT_A_SELLER", 403, "You are not an approved coin seller");
const short = () => new AppError("INSUFFICIENT_SELLER_BALANCE", 409, "Not enough coins in the seller wallet");

// Runs a coin move once per (actor, key): a repeated key fails instead of moving coins twice.
async function once<T>(fn: (tx: Tx) => Promise<T>) {
  try {
    return await db.transaction(fn);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("DUPLICATE_REQUEST", 409, "This transfer was already sent");
    throw e;
  }
}

async function debit(tx: Tx, sellerId: string, amount: number) {
  const [row] = await tx
    .update(coinSellers)
    .set({ balance: sql`${coinSellers.balance} - ${amount}` })
    .where(and(eq(coinSellers.userId, sellerId), eq(coinSellers.status, "APPROVED"), gte(coinSellers.balance, amount)))
    .returning({ balance: coinSellers.balance });
  if (row) return row.balance;
  const [s] = await tx.select({ status: coinSellers.status }).from(coinSellers).where(eq(coinSellers.userId, sellerId));
  throw s?.status === "APPROVED" ? short() : notSeller();
}

const credit = (tx: Tx, sellerId: string, amount: number) =>
  tx
    .update(coinSellers)
    .set({ balance: sql`${coinSellers.balance} + ${amount}` })
    .where(eq(coinSellers.userId, sellerId))
    .returning({ balance: coinSellers.balance });

// Staff top-up of any approved seller's wallet (top or sub).
export const mint = (actor: User, sellerId: string, amount: number, key: string) =>
  once(async (tx) => {
    await tx.insert(sellerLedger).values({ sellerId, kind: "MINT", amount, actorId: actor.id, idempotencyKey: key });
    const [row] = await tx
      .update(coinSellers)
      .set({ balance: sql`${coinSellers.balance} + ${amount}` })
      .where(and(eq(coinSellers.userId, sellerId), eq(coinSellers.status, "APPROVED")))
      .returning({ balance: coinSellers.balance });
    if (!row) throw new AppError("NOT_A_SELLER", 404, "That user is not an approved coin seller");
    return { balance: row.balance };
  });

// Seller wallet -> any user's main wallet, the seller's own included.
export async function sell(seller: User, to: User, amount: number, key: string) {
  const { toBalance, txnId, ...result } = await once(async (tx) => {
    const [entry] = await tx
      .insert(sellerLedger)
      .values({ sellerId: seller.id, kind: "SALE", amount: -amount, counterpartyId: to.id, actorId: seller.id, idempotencyKey: key })
      .returning({ id: sellerLedger.id });
    const balance = await debit(tx, seller.id, amount);
    const [w] = await tx
      .update(walletAccounts)
      .set({ balance: sql`${walletAccounts.balance} + ${amount}`, version: sql`${walletAccounts.version} + 1` })
      .where(eq(walletAccounts.userId, to.id))
      .returning();
    if (!w) throw new AppError("USER_NOT_FOUND", 404, "That user has no wallet");
    const [received] = await tx
      .insert(walletLedger)
      .values({ userId: to.id, entryType: "SELLER_PURCHASE", amount, referenceType: "SELLER_LEDGER", referenceId: String(entry!.id) })
      .returning({ id: walletLedger.id });
    return { balance, toBalance: w.balance, txnId: `TXN${received!.id}`, to: { userId: to.id, displayName: to.displayName, publicId: to.publicId } };
  });
  notifyCoins(to.id, { kind: "SELLER", status: "SUCCESS", coins: amount, balance: toBalance, txnId }).catch(toSafeError);
  return result;
}

async function mySub(tx: Tx, parentId: string, subId: string) {
  const [s] = await tx
    .select()
    .from(coinSellers)
    .where(and(eq(coinSellers.userId, subId), eq(coinSellers.parentId, parentId), eq(coinSellers.status, "APPROVED")))
    .for("update");
  if (!s) throw new AppError("NOT_YOUR_SUB_SELLER", 404, "That user is not your sub seller");
  return s;
}

// Parent seller wallet -> sub seller wallet.
export const topUpSub = (parent: User, subId: string, amount: number, key: string) =>
  once(async (tx) => {
    await mySub(tx, parent.id, subId);
    await tx.insert(sellerLedger).values({ sellerId: parent.id, kind: "SUB_TOPUP", amount: -amount, counterpartyId: subId, actorId: parent.id, idempotencyKey: key });
    const balance = await debit(tx, parent.id, amount);
    await credit(tx, subId, amount);
    await tx.insert(sellerLedger).values({ sellerId: subId, kind: "SUB_TOPUP", amount, counterpartyId: parent.id, actorId: parent.id });
    return { balance };
  });

// Only top sellers appoint sub sellers; the user must not already be an approved seller.
export async function createSub(parent: User, sub: User) {
  if (sub.id === parent.id) throw new AppError("INVALID_SUB_SELLER", 400, "You can't be your own sub seller");
  const [p] = await db.select().from(coinSellers).where(and(eq(coinSellers.userId, parent.id), eq(coinSellers.status, "APPROVED")));
  if (!p) throw notSeller();
  if (p.parentId) throw new AppError("SUB_CANNOT_APPOINT", 403, "Sub sellers can't appoint sellers");
  const values = { status: "APPROVED" as const, message: "Appointed sub seller", parentId: parent.id, decidedAt: new Date() };
  const [row] = await db
    .insert(coinSellers)
    .values({ userId: sub.id, ...values })
    .onConflictDoUpdate({ target: coinSellers.userId, set: values, setWhere: sql`${coinSellers.status} <> 'APPROVED'` })
    .returning();
  if (!row) throw new AppError("ALREADY_SELLER", 409, "That user is already a coin seller");
  await grantBadge(sub.id, "sub_seller", null);
  return row;
}

// Removing a sub seller sends whatever is left in their wallet back to the parent.
export async function removeSub(parent: User, subId: string) {
  const result = await db.transaction(async (tx) => {
    const s = await mySub(tx, parent.id, subId);
    await tx.update(coinSellers).set({ status: "REJECTED", balance: 0, decidedAt: new Date() }).where(eq(coinSellers.userId, subId));
    const [p] = await credit(tx, parent.id, s.balance);
    if (s.balance > 0) {
      await tx.insert(sellerLedger).values([
        { sellerId: subId, kind: "SUB_RETURN", amount: -s.balance, counterpartyId: parent.id, actorId: parent.id },
        { sellerId: parent.id, kind: "SUB_RETURN", amount: s.balance, counterpartyId: subId, actorId: parent.id },
      ]);
    }
    return { returned: s.balance, balance: p!.balance };
  });
  await revokeBadge(subId, "sub_seller");
  return result;
}

const counterparty = aliasedTable(users, "counterparty");
const parentUser = aliasedTable(users, "parent");

// Everything the seller page shows.
export async function sellerWallet(user: User) {
  const [me] = await db.select().from(coinSellers).where(and(eq(coinSellers.userId, user.id), eq(coinSellers.status, "APPROVED")));
  if (!me) throw notSeller();
  const [parent] = me.parentId
    ? await db.select({ userId: users.id, displayName: users.displayName, publicId: users.publicId }).from(users).where(eq(users.id, me.parentId))
    : [];
  const subSellers = me.parentId
    ? []
    : await db
        .select({ ...userSummary, publicId: users.publicId, balance: coinSellers.balance, since: coinSellers.decidedAt })
        .from(coinSellers)
        .innerJoin(users, eq(users.id, coinSellers.userId))
        .where(and(eq(coinSellers.parentId, user.id), eq(coinSellers.status, "APPROVED")))
        .orderBy(coinSellers.decidedAt);
  const history = await db
    .select({
      id: sellerLedger.id,
      kind: sellerLedger.kind,
      amount: sellerLedger.amount,
      createdAt: sellerLedger.createdAt,
      counterparty: { userId: counterparty.id, displayName: counterparty.displayName, publicId: counterparty.publicId },
    })
    .from(sellerLedger)
    .leftJoin(counterparty, eq(counterparty.id, sellerLedger.counterpartyId))
    .where(eq(sellerLedger.sellerId, user.id))
    .orderBy(desc(sellerLedger.id))
    .limit(50);
  return { balance: me.balance, isSub: !!me.parentId, parent: parent ?? null, subSellers, history };
}

// Staff: approve (or directly appoint) a top seller, or revoke any seller. A revoked wallet keeps its balance, frozen.
export async function decideCoinSeller(userId: string, approve: boolean) {
  const now = new Date();
  const [row] = approve
    ? await db
        .insert(coinSellers)
        .values({ userId, status: "APPROVED", message: "Appointed by staff", decidedAt: now })
        .onConflictDoUpdate({ target: coinSellers.userId, set: { status: "APPROVED", parentId: null, decidedAt: now } })
        .returning()
    : await db.update(coinSellers).set({ status: "REJECTED", decidedAt: now }).where(eq(coinSellers.userId, userId)).returning();
  if (!row) throw new AppError("NO_APPLICATION", 404, "This user has not applied");
  await revokeBadge(userId, "sub_seller");
  if (approve) await grantBadge(userId, "coin_seller", null);
  else await revokeBadge(userId, "coin_seller");
  return row;
}

// Staff list: applications or sellers, with wallets and who appointed each sub seller. Top sellers first.
export const listSellers = (status: "PENDING" | "APPROVED" | "REJECTED") =>
  db
    .select({
      ...userSummary,
      publicId: users.publicId,
      status: coinSellers.status,
      message: coinSellers.message,
      appliedAt: coinSellers.appliedAt,
      balance: coinSellers.balance,
      parent: { userId: parentUser.id, displayName: parentUser.displayName },
    })
    .from(coinSellers)
    .innerJoin(users, eq(users.id, coinSellers.userId))
    .leftJoin(parentUser, eq(parentUser.id, coinSellers.parentId))
    .where(eq(coinSellers.status, status))
    .orderBy(sql`${coinSellers.parentId} is not null`, desc(coinSellers.appliedAt));
