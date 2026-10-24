import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, isUniqueViolation } from "../db";
import { giftCatalog, giftTransactions, roomParticipants, rooms, roomSeats, users, walletAccounts, walletLedger, type User } from "../db/schema";
import { emitToRoom } from "../io";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate } from "./auth";
import { refreshCharisma, refreshPk, systemMessage, userSummary } from "./rooms";
import { refreshLivePk } from "./live";

export type GiftInput = { recipientUserId: string; giftId: string; quantity: number };
type GiftTx = typeof giftTransactions.$inferSelect;

export const listGifts = () =>
  db.select().from(giftCatalog).where(eq(giftCatalog.enabled, true)).orderBy(asc(giftCatalog.sortOrder));

export async function getBalance(userId: string) {
  const [w] = await db.select({ balance: walletAccounts.balance }).from(walletAccounts).where(eq(walletAccounts.userId, userId));
  return w?.balance ?? 0;
}

export async function ledger(userId: string, cursor: number | undefined, limit: number) {
  const rows = await db
    .select()
    .from(walletLedger)
    .where(and(eq(walletLedger.userId, userId), cursor ? lt(walletLedger.id, cursor) : undefined))
    .orderBy(desc(walletLedger.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { entries: page, nextCursor: rows.length > limit ? String(page.at(-1)!.id) : null };
}

const findPrior = async (senderId: string, key: string) =>
  (await db.select().from(giftTransactions).where(and(eq(giftTransactions.senderId, senderId), eq(giftTransactions.idempotencyKey, key))))[0];

async function replay(prior: GiftTx, roomId: string, input: GiftInput) {
  const same = prior.roomId === roomId && prior.recipientId === input.recipientUserId && prior.giftId === input.giftId && prior.quantity === input.quantity;
  if (!same) throw new AppError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key reused with a different request");
  return { transaction: prior, balance: await getBalance(prior.senderId), replayed: true };
}

const active = (roomId: string, userId: string) =>
  and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.userId, userId), isNull(roomParticipants.leftAt));

export type GiftAllInput = { giftId: string; quantity: number };

// Batch rows share the client key: "<key>#<recipientId>", so a retry finds the whole batch.
const findBatch = (senderId: string, key: string) =>
  db
    .select()
    .from(giftTransactions)
    .where(and(eq(giftTransactions.senderId, senderId), sql`starts_with(${giftTransactions.idempotencyKey}, ${key + "#"})`));

async function replayBatch(prior: GiftTx[], roomId: string, input: GiftAllInput) {
  const same = prior.every((t) => t.roomId === roomId && t.giftId === input.giftId && t.quantity === input.quantity);
  if (!same) throw new AppError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key reused with a different request");
  return { transactions: prior, balance: await getBalance(prior[0]!.senderId), replayed: true };
}

// One gift to everyone seated right now (sender included if seated), charged as one atomic debit.
export async function sendGiftToAllSeated(sender: User, roomId: string, input: GiftAllInput, idempotencyKey: string | undefined) {
  if (!idempotencyKey || idempotencyKey.length > 64) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
  const prior = await findBatch(sender.id, idempotencyKey);
  if (prior.length) return replayBatch(prior, roomId, input);

  assertCanParticipate(sender);
  rateLimit(`gift:${sender.id}`, 20, 10_000);

  let result;
  try {
    result = await db.transaction(async (tx) => {
      // Same lock order as single gifts: the room share lock freezes the seat list until commit.
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for("share");
      if (room?.status !== "LIVE") throw new AppError("ROOM_NOT_LIVE", 409);
      const [s] = await tx.select({ id: roomParticipants.id }).from(roomParticipants).where(active(roomId, sender.id));
      if (!s) throw new AppError("SENDER_NOT_IN_ROOM", 403);
      const seated = await tx
        .select({ userId: roomSeats.occupantUserId, seatIndex: roomSeats.seatIndex })
        .from(roomSeats)
        .where(and(eq(roomSeats.roomId, roomId), isNotNull(roomSeats.occupantUserId)))
        .orderBy(asc(roomSeats.seatIndex));
      if (!seated.length) throw new AppError("NO_ONE_SEATED", 409, "Nobody is on stage");

      const [gift] = await tx.select().from(giftCatalog).where(eq(giftCatalog.id, input.giftId));
      if (!gift?.enabled) throw new AppError("GIFT_DISABLED", 400);
      if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > gift.maxQuantity) throw new AppError("INVALID_QUANTITY", 400);
      const each = gift.coinPrice * input.quantity;
      const total = each * seated.length;

      const [wallet] = await tx
        .update(walletAccounts)
        .set({ balance: sql`${walletAccounts.balance} - ${total}`, version: sql`${walletAccounts.version} + 1` })
        .where(and(eq(walletAccounts.userId, sender.id), gte(walletAccounts.balance, total)))
        .returning();
      if (!wallet) throw new AppError("INSUFFICIENT_COINS", 402);

      const txs = await tx
        .insert(giftTransactions)
        .values(
          seated.map((r) => ({
            senderId: sender.id,
            recipientId: r.userId!,
            giftId: gift.id,
            roomId,
            recipientSeatIndex: r.seatIndex,
            quantity: input.quantity,
            coinsDebited: each,
            idempotencyKey: `${idempotencyKey}#${r.userId}`,
          })),
        )
        .returning();
      // One ledger row per transaction so the ledger still sums to the balance.
      await tx
        .insert(walletLedger)
        .values(txs.map((t) => ({ userId: sender.id, entryType: "GIFT_DEBIT", amount: -each, referenceType: "GIFT", referenceId: t.id })));
      return { transactions: txs, balance: wallet.balance, gift };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const winner = await findBatch(sender.id, idempotencyKey);
      if (winner.length) return replayBatch(winner, roomId, input);
    }
    throw e;
  }

  const n = result.transactions.length;
  emitToRoom(roomId, "room:gift:received", {
    transactionId: result.transactions[0]!.id,
    roomId,
    sender: { userId: sender.id, displayName: sender.displayName, avatarUrl: sender.avatarUrl },
    recipient: { userId: null, displayName: `everyone on stage (${n})` },
    recipients: result.transactions.map((t) => ({ userId: t.recipientId, seatIndex: t.recipientSeatIndex })),
    seatIndex: null,
    gift: { id: result.gift.id, name: result.gift.name, assetUrl: result.gift.assetUrl, svg: result.gift.svg, animation: result.gift.animation },
    quantity: input.quantity,
    at: result.transactions[0]!.createdAt,
  });
  await systemMessage(roomId, `${sender.displayName} sent ${input.quantity}x ${result.gift.name} to everyone on stage (${n})`, {
    kind: "GIFT_ALL",
    userId: sender.id,
  });
  await refreshCharisma(roomId).catch(() => {}); // a stale counter must never fail the gift
  await refreshPk(roomId).catch(() => {});
  await refreshLivePk(roomId).catch(() => {});
  return { transactions: result.transactions, balance: result.balance, replayed: false };
}

export async function sendGift(sender: User, roomId: string, input: GiftInput, idempotencyKey: string | undefined) {
  if (!idempotencyKey || idempotencyKey.length > 128) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", 400);
  const prior = await findPrior(sender.id, idempotencyKey);
  if (prior) return replay(prior, roomId, input);

  assertCanParticipate(sender);
  rateLimit(`gift:${sender.id}`, 20, 10_000);
  // Self-gifting is allowed (product decision): you can gift yourself while seated.

  let result;
  try {
    result = await db.transaction(async (tx) => {
      // Lock order everywhere: room -> seat -> wallet. FOR SHARE blocks seat changes until we commit,
      // so the recipient cannot leave their seat between the check and the debit.
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for("share");
      if (room?.status !== "LIVE") throw new AppError("ROOM_NOT_LIVE", 409);
      const [s] = await tx.select({ id: roomParticipants.id }).from(roomParticipants).where(active(roomId, sender.id));
      if (!s) throw new AppError("SENDER_NOT_IN_ROOM", 403);
      const [r] = await tx.select({ id: roomParticipants.id }).from(roomParticipants).where(active(roomId, input.recipientUserId));
      if (!r) throw new AppError("RECIPIENT_NOT_IN_ROOM", 409);
      const [seat] = await tx
        .select({ seatIndex: roomSeats.seatIndex })
        .from(roomSeats)
        .where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.occupantUserId, input.recipientUserId)));
      if (!seat) throw new AppError("RECIPIENT_NOT_SEATED", 409);

      const [gift] = await tx.select().from(giftCatalog).where(eq(giftCatalog.id, input.giftId));
      if (!gift?.enabled) throw new AppError("GIFT_DISABLED", 400);
      if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > gift.maxQuantity) throw new AppError("INVALID_QUANTITY", 400);
      const cost = gift.coinPrice * input.quantity;

      const [wallet] = await tx
        .update(walletAccounts)
        .set({ balance: sql`${walletAccounts.balance} - ${cost}`, version: sql`${walletAccounts.version} + 1` })
        .where(and(eq(walletAccounts.userId, sender.id), gte(walletAccounts.balance, cost)))
        .returning();
      if (!wallet) throw new AppError("INSUFFICIENT_COINS", 402);

      const [g] = await tx
        .insert(giftTransactions)
        .values({
          senderId: sender.id,
          recipientId: input.recipientUserId,
          giftId: gift.id,
          roomId,
          recipientSeatIndex: seat.seatIndex,
          quantity: input.quantity,
          coinsDebited: cost,
          idempotencyKey,
        })
        .returning();
      // P0: coins are a sink; creator earnings (recipient credit) come with monetization.
      await tx.insert(walletLedger).values({ userId: sender.id, entryType: "GIFT_DEBIT", amount: -cost, referenceType: "GIFT", referenceId: g!.id });
      return { transaction: g!, balance: wallet.balance, gift };
    });
  } catch (e) {
    // Two concurrent requests with one key: the loser rolls back and returns the winner's result.
    if (isUniqueViolation(e)) {
      const winner = await findPrior(sender.id, idempotencyKey);
      if (winner) return replay(winner, roomId, input);
    }
    throw e;
  }

  const [recipient] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, input.recipientUserId));
  const t = result.transaction;
  emitToRoom(roomId, "room:gift:received", {
    transactionId: t.id,
    roomId,
    sender: { userId: sender.id, displayName: sender.displayName, avatarUrl: sender.avatarUrl },
    recipient: { userId: t.recipientId, displayName: recipient?.displayName },
    seatIndex: t.recipientSeatIndex,
    gift: { id: result.gift.id, name: result.gift.name, assetUrl: result.gift.assetUrl, svg: result.gift.svg, animation: result.gift.animation },
    quantity: t.quantity,
    at: t.createdAt,
  });
  await systemMessage(roomId, `${sender.displayName} sent ${t.quantity}x ${result.gift.name} to ${recipient?.displayName}`, {
    kind: "GIFT",
    transactionId: t.id,
  });
  await refreshCharisma(roomId).catch(() => {}); // a stale counter must never fail the gift
  await refreshPk(roomId).catch(() => {});
  await refreshLivePk(roomId).catch(() => {});
  return { transaction: t, balance: result.balance, replayed: false };
}

// This week's gift totals for a profile card (Monday 00:00 to Sunday 23:59, India time; resets every Monday).
// contribution = coins spent on gifts sent; charisma = coins' worth of gifts received.
const IST = sql.raw(`'Asia/Kolkata'`);
const weekStart = sql`(date_trunc('week', now() at time zone ${IST}) at time zone ${IST})`;
export async function weeklyGiftStats(userId: string) {
  const sum = (col: typeof giftTransactions.senderId | typeof giftTransactions.recipientId) =>
    sql<number>`(select coalesce(sum(${giftTransactions.coinsDebited}), 0) from ${giftTransactions}
      where ${col} = ${userId} and ${giftTransactions.status} = 'SETTLED' and ${giftTransactions.createdAt} >= ${weekStart})`.mapWith(Number);
  const { rows } = await db.execute<{ contribution: string; charisma: string; ends_at: Date }>(sql`select
    ${sum(giftTransactions.senderId)} as contribution,
    ${sum(giftTransactions.recipientId)} as charisma,
    ((date_trunc('week', now() at time zone ${IST}) + interval '1 week') at time zone ${IST}) as ends_at`);
  const r = rows[0]!;
  return { contribution: Number(r.contribution), charisma: Number(r.charisma), endsAt: new Date(r.ends_at) };
}

// A room's top gifters: who sent the most gift coins in this room this week (from Monday) or this month (from the 1st), India time.
export async function topGifters(roomId: string, period: "week" | "month", limit = 20) {
  const since = sql`(date_trunc(${period}, now() at time zone ${IST}) at time zone ${IST})`;
  const coins = sql<number>`sum(${giftTransactions.coinsDebited})`.mapWith(Number);
  return db
    .select({ ...userSummary, coins })
    .from(giftTransactions)
    .innerJoin(users, eq(users.id, giftTransactions.senderId))
    .where(and(eq(giftTransactions.roomId, roomId), eq(giftTransactions.status, "SETTLED"), gte(giftTransactions.createdAt, since)))
    .groupBy(users.id)
    .orderBy(desc(coins))
    .limit(limit);
}
