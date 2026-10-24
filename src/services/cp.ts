import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, type Tx } from "../db";
import { blocks, cpPairs, cpProposals, directMessages, users, walletAccounts, walletLedger, type User } from "../db/schema";
import { io, userChannel } from "../io";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate } from "./auth";
import { userSummary } from "./rooms";
import { announceToAllRooms } from "./svip";

export type CpType = (typeof cpProposals.$inferSelect)["type"];
export const CP_TYPES = {
  LOVE: { max: 1, price: 520, gift: "Ring" },
  BESTIE: { max: 4, price: 199, gift: "Bracelet" },
  SIBLING: { max: 7, price: 99, gift: "Charm" },
} as const satisfies Record<CpType, { max: number; price: number; gift: string }>;
export const SIBLING_LABELS = ["BROTHER", "SISTER"] as const;
export const PROPOSAL_TTL_MS = 48 * 3600_000;
export const LOVE_COOLDOWN_MS = 7 * 24 * 3600_000; // after a Love CP ends, before either person can start a new one

type Proposal = typeof cpProposals.$inferSelect;
const pairOf = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];
const involves = (id: string) => or(eq(cpPairs.userA, id), eq(cpPairs.userB, id));
const what = (p: { type: CpType; label: string | null }) =>
  p.type === "LOVE" ? "Love CP" : p.type === "BESTIE" ? "Best friend" : p.label === "SISTER" ? "Sister" : "Brother";

// Same-pair and per-type limits for both people. Callers hold both users' row locks, so counts can't race.
async function assertCanPair(tx: Tx, a: string, b: string, type: CpType) {
  const [x, y] = pairOf(a, b);
  const [existing] = await tx
    .select({ type: cpPairs.type })
    .from(cpPairs)
    .where(and(eq(cpPairs.userA, x), eq(cpPairs.userB, y), isNull(cpPairs.endedAt)));
  if (existing) throw new AppError("CP_ALREADY_PAIRED", 409, "You two already have a CP");
  for (const id of [a, b]) {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(cpPairs)
      .where(and(involves(id), eq(cpPairs.type, type), isNull(cpPairs.endedAt)));
    if (row!.n >= CP_TYPES[type].max) {
      const slot = type === "LOVE" ? "Love CP" : type === "BESTIE" ? "Best friend" : "Brother/Sister";
      throw new AppError("CP_LIMIT", 409, `${id === a ? "You have" : "They have"} no free ${slot} slot`);
    }
    if (type === "LOVE") {
      const [recent] = await tx
        .select({ id: cpPairs.id })
        .from(cpPairs)
        .where(and(involves(id), eq(cpPairs.type, "LOVE"), gte(cpPairs.endedAt, new Date(Date.now() - LOVE_COOLDOWN_MS))));
      if (recent) throw new AppError("CP_COOLDOWN", 409, `${id === a ? "You" : "They"} ended a Love CP less than 7 days ago`);
    }
  }
}

const lockUsers = (tx: Tx, a: string, b: string) => tx.select({ id: users.id }).from(users).where(inArray(users.id, [a, b])).orderBy(asc(users.id)).for("update");

async function refund(tx: Tx, p: Proposal) {
  await tx
    .update(walletAccounts)
    .set({ balance: sql`${walletAccounts.balance} + ${p.price}`, version: sql`${walletAccounts.version} + 1` })
    .where(eq(walletAccounts.userId, p.fromId));
  await tx.insert(walletLedger).values({ userId: p.fromId, entryType: "CP_REFUND", amount: p.price, referenceType: "CP_PROPOSAL", referenceId: p.id });
}

const notify = (p: Proposal) => io.to(userChannel(p.fromId)).to(userChannel(p.toId)).emit("cp:update", { proposalId: p.id, status: p.status });

export async function propose(user: User, input: { toUserId: string; type: CpType; label?: (typeof SIBLING_LABELS)[number] }) {
  assertCanParticipate(user);
  if (input.toUserId === user.id) throw new AppError("CANNOT_TARGET_SELF", 400);
  if ((input.type === "SIBLING") !== !!input.label) throw new AppError("VALIDATION_ERROR", 400, "Choose Brother or Sister for a sibling CP, and only then");
  rateLimit(`cp:${user.id}`, 10, 60_000);
  const [them] = await db.select().from(users).where(eq(users.id, input.toUserId));
  if (!them || them.status !== "ACTIVE") throw new AppError("USER_NOT_FOUND", 404);
  const [blocked] = await db
    .select({ a: blocks.blockerId })
    .from(blocks)
    .where(or(and(eq(blocks.blockerId, user.id), eq(blocks.blockedId, them.id)), and(eq(blocks.blockerId, them.id), eq(blocks.blockedId, user.id))));
  if (blocked) throw new AppError("BLOCKED", 403, "You can't send a CP request to this person");

  const { price } = CP_TYPES[input.type];
  const label = input.label ?? null;
  const result = await db.transaction(async (tx) => {
    await lockUsers(tx, user.id, them.id);
    const [pending] = await tx
      .select({ id: cpProposals.id })
      .from(cpProposals)
      .where(and(eq(cpProposals.status, "PENDING"), or(and(eq(cpProposals.fromId, user.id), eq(cpProposals.toId, them.id)), and(eq(cpProposals.fromId, them.id), eq(cpProposals.toId, user.id)))));
    if (pending) throw new AppError("CP_PENDING", 409, "There's already a CP request between you two");
    await assertCanPair(tx, user.id, them.id, input.type);

    const [wallet] = await tx
      .update(walletAccounts)
      .set({ balance: sql`${walletAccounts.balance} - ${price}`, version: sql`${walletAccounts.version} + 1` })
      .where(and(eq(walletAccounts.userId, user.id), gte(walletAccounts.balance, price)))
      .returning();
    if (!wallet) throw new AppError("INSUFFICIENT_COINS", 402);
    const [p] = await tx
      .insert(cpProposals)
      .values({ fromId: user.id, toId: them.id, type: input.type, label, price, expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS) })
      .returning();
    await tx.insert(walletLedger).values({ userId: user.id, entryType: "CP_PROPOSAL", amount: -price, referenceType: "CP_PROPOSAL", referenceId: p!.id });
    const body = `${CP_EMOJI[input.type]} ${user.displayName ?? "Someone"} wants you as their ${what(p!)}`;
    const [msg] = await tx.insert(directMessages).values({ senderId: user.id, recipientId: them.id, body, cpProposalId: p!.id }).returning();
    return { proposal: p!, msg: msg!, balance: wallet.balance };
  });
  io.to(userChannel(them.id)).to(userChannel(user.id)).emit("dm:new", { ...result.msg, cp: cardOf(result.proposal) });
  return { proposal: cardOf(result.proposal), balance: result.balance };
}

export const CP_EMOJI: Record<CpType, string> = { LOVE: "💍", BESTIE: "🤝", SIBLING: "👫" };
export const cardOf = (p: Proposal) => ({ id: p.id, fromId: p.fromId, toId: p.toId, type: p.type, label: p.label, price: p.price, status: p.status, expiresAt: p.expiresAt });

// The recipient accepts or declines. Accepting re-checks the limits: slots may have filled since it was sent.
export async function respond(user: User, proposalId: string, accept: boolean) {
  const out = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(cpProposals).where(eq(cpProposals.id, proposalId)).for("update");
    if (!p || p.toId !== user.id) throw new AppError("CP_NOT_FOUND", 404);
    if (p.status !== "PENDING") throw new AppError("CP_NOT_PENDING", 409, "This request is no longer open");
    if (p.expiresAt < new Date()) {
      const [done] = await tx.update(cpProposals).set({ status: "EXPIRED", respondedAt: new Date() }).where(eq(cpProposals.id, p.id)).returning();
      await refund(tx, p);
      return { p: done!, expired: true };
    }
    if (!accept) {
      const [done] = await tx.update(cpProposals).set({ status: "DECLINED", respondedAt: new Date() }).where(eq(cpProposals.id, p.id)).returning();
      await refund(tx, p);
      return { p: done! };
    }
    assertCanParticipate(user);
    await lockUsers(tx, p.fromId, p.toId);
    await assertCanPair(tx, p.fromId, p.toId, p.type);
    const [a, b] = pairOf(p.fromId, p.toId);
    await tx.insert(cpPairs).values({ userA: a, userB: b, type: p.type, label: p.label, proposalId: p.id });
    const [done] = await tx.update(cpProposals).set({ status: "ACCEPTED", respondedAt: new Date() }).where(eq(cpProposals.id, p.id)).returning();
    return { p: done! };
  });
  notify(out.p);
  if (out.expired) throw new AppError("CP_EXPIRED", 409, "This request expired");
  if (out.p.status === "ACCEPTED" && out.p.type === "LOVE") {
    const [from] = await db.select().from(users).where(eq(users.id, out.p.fromId));
    if (from) announceToAllRooms(from, { kind: "CP_LOVE", partnerId: user.id, partnerName: user.displayName ?? "someone" });
  }
  return cardOf(out.p);
}

export async function cancel(user: User, proposalId: string) {
  const p = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(cpProposals).where(eq(cpProposals.id, proposalId)).for("update");
    if (!p || p.fromId !== user.id) throw new AppError("CP_NOT_FOUND", 404);
    if (p.status !== "PENDING") throw new AppError("CP_NOT_PENDING", 409, "This request is no longer open");
    const [done] = await tx.update(cpProposals).set({ status: "CANCELLED", respondedAt: new Date() }).where(eq(cpProposals.id, p.id)).returning();
    await refund(tx, p);
    return done!;
  });
  notify(p);
  return cardOf(p);
}

// Refunds requests nobody answered in time. Run every minute; each row is claimed atomically so overlapping runs are safe.
export async function expireProposals() {
  const due = await db
    .select({ id: cpProposals.id })
    .from(cpProposals)
    .where(and(eq(cpProposals.status, "PENDING"), lt(cpProposals.expiresAt, new Date())))
    .limit(500);
  for (const { id } of due) {
    const p = await db.transaction(async (tx) => {
      const [p] = await tx
        .update(cpProposals)
        .set({ status: "EXPIRED", respondedAt: new Date() })
        .where(and(eq(cpProposals.id, id), eq(cpProposals.status, "PENDING")))
        .returning();
      if (p) await refund(tx, p);
      return p;
    });
    if (p) notify(p);
  }
  return due.length;
}

export function runCpExpiryLoop(ms = 60_000) {
  return setInterval(() => expireProposals().catch((e) => console.error(JSON.stringify({ level: "error", msg: "cp-expiry-failed", err: String(e) }))), ms);
}

// Either person can end it, any time. A Love CP ending starts both people's 7-day cooldown.
export async function endPair(user: User, pairId: string) {
  const [p] = await db
    .update(cpPairs)
    .set({ endedAt: new Date(), endedBy: user.id })
    .where(and(eq(cpPairs.id, pairId), involves(user.id), isNull(cpPairs.endedAt)))
    .returning();
  if (!p) throw new AppError("CP_NOT_FOUND", 404);
  io.to(userChannel(p.userA)).to(userChannel(p.userB)).emit("cp:ended", { pairId: p.id });
}

// Blocking someone ends your CP with them and cancels (and refunds) open requests either way.
export async function onBlock(a: string, b: string) {
  const [x, y] = pairOf(a, b);
  await db
    .update(cpPairs)
    .set({ endedAt: new Date(), endedBy: a })
    .where(and(eq(cpPairs.userA, x), eq(cpPairs.userB, y), isNull(cpPairs.endedAt)));
  const open = await db
    .select({ id: cpProposals.id })
    .from(cpProposals)
    .where(and(eq(cpProposals.status, "PENDING"), or(and(eq(cpProposals.fromId, a), eq(cpProposals.toId, b)), and(eq(cpProposals.fromId, b), eq(cpProposals.toId, a)))));
  for (const { id } of open) {
    await db.transaction(async (tx) => {
      const [p] = await tx
        .update(cpProposals)
        .set({ status: "CANCELLED", respondedAt: new Date() })
        .where(and(eq(cpProposals.id, id), eq(cpProposals.status, "PENDING")))
        .returning();
      if (p) await refund(tx, p);
    });
  }
}

// Active relationships for a profile, oldest first, with the other person.
export async function relationshipsOf(userId: string) {
  const partner = sql`case when ${cpPairs.userA} = ${userId} then ${cpPairs.userB} else ${cpPairs.userA} end`;
  return db
    .select({ pairId: cpPairs.id, type: cpPairs.type, label: cpPairs.label, since: cpPairs.createdAt, user: userSummary })
    .from(cpPairs)
    .innerJoin(users, eq(users.id, partner))
    .where(and(involves(userId), isNull(cpPairs.endedAt)))
    .orderBy(asc(cpPairs.createdAt));
}

// Cards for DM messages that carry a proposal.
export async function cardsFor(ids: string[]) {
  if (!ids.length) return new Map<string, ReturnType<typeof cardOf>>();
  const rows = await db.select().from(cpProposals).where(inArray(cpProposals.id, ids)).orderBy(desc(cpProposals.createdAt));
  return new Map(rows.map((p) => [p.id, cardOf(p)]));
}
