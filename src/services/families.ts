import { and, asc, desc, eq, gte, ilike, ne, or, sql } from "drizzle-orm";
import { db, isUniqueViolation } from "../db";
import { blocks, directMessages, families, familyMembers, follows, giftTransactions, users, walletAccounts, walletLedger, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate } from "./auth";
import { pushDm } from "./dmPush";
import { userSummary } from "./rooms";

export const FAMILY_PRICE = 500; // coins to create a family; not refunded on disband

type Role = (typeof familyMembers.$inferSelect)["role"];
const inFamily = () => new AppError("ALREADY_IN_FAMILY", 409, "You are already in a family. Leave it first");

// Contribution = coins spent on gifts this India calendar month, counted only since joining this family.
const monthStart = sql`(date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;
const contribution = sql<number>`coalesce(sum(${giftTransactions.coinsDebited}), 0)::int`;
const giftsSinceJoining = and(eq(giftTransactions.senderId, familyMembers.userId), sql`${giftTransactions.createdAt} >= greatest(${familyMembers.joinedAt}, ${monthStart})`);

async function roleIn(familyId: string, userId: string): Promise<Role | null> {
  const [m] = await db.select({ role: familyMembers.role, familyId: familyMembers.familyId }).from(familyMembers).where(eq(familyMembers.userId, userId));
  return m?.familyId === familyId ? m.role : null;
}

const memberCount = sql<number>`(select count(*)::int from ${familyMembers} m where m.family_id = ${families.id})`;

export async function myFamily(userId: string) {
  const [row] = await db
    .select({ familyId: families.id, name: families.name, imageUrl: families.imageUrl, members: memberCount, role: familyMembers.role })
    .from(familyMembers)
    .innerJoin(families, eq(families.id, familyMembers.familyId))
    .where(eq(familyMembers.userId, userId));
  return { family: row ?? null, createPrice: FAMILY_PRICE };
}

// Pay once, become owner. The member row's primary key stops anyone already in a family.
export async function create(user: User, name: string) {
  assertCanParticipate(user);
  rateLimit(`familyCreate:${user.id}`, 5, 60_000);
  try {
    return await db.transaction(async (tx) => {
      const [wallet] = await tx
        .update(walletAccounts)
        .set({ balance: sql`${walletAccounts.balance} - ${FAMILY_PRICE}`, version: sql`${walletAccounts.version} + 1` })
        .where(and(eq(walletAccounts.userId, user.id), gte(walletAccounts.balance, FAMILY_PRICE)))
        .returning();
      if (!wallet) throw new AppError("INSUFFICIENT_COINS", 402);
      const [f] = await tx.insert(families).values({ name, ownerId: user.id }).returning();
      await tx.insert(familyMembers).values({ userId: user.id, familyId: f!.id, role: "OWNER" });
      await tx.insert(walletLedger).values({ userId: user.id, entryType: "FAMILY_CREATE", amount: -FAMILY_PRICE, referenceType: "FAMILY", referenceId: f!.id });
      return { familyId: f!.id, balance: wallet.balance };
    });
  } catch (e) {
    throw isUniqueViolation(e) ? inFamily() : e;
  }
}

// Biggest families first; `q` filters by name.
export function list(q?: string) {
  return db
    .select({ familyId: families.id, name: families.name, imageUrl: families.imageUrl, members: sql<number>`count(${familyMembers.userId})::int` })
    .from(families)
    .innerJoin(familyMembers, eq(familyMembers.familyId, families.id))
    .where(q ? ilike(families.name, `%${q.replace(/[\\%_]/g, "\\$&")}%`) : undefined)
    .groupBy(families.id)
    .orderBy(desc(sql`count(${familyMembers.userId})`), asc(families.createdAt))
    .limit(50);
}

// The family with its members, top monthly contributors first.
export async function detail(viewerId: string, familyId: string) {
  const [f] = await db.select().from(families).where(eq(families.id, familyId));
  if (!f) throw new AppError("FAMILY_NOT_FOUND", 404);
  const members = await db
    .select({ ...userSummary, publicId: users.publicId, role: familyMembers.role, joinedAt: familyMembers.joinedAt, contribution })
    .from(familyMembers)
    .innerJoin(users, eq(users.id, familyMembers.userId))
    .leftJoin(giftTransactions, giftsSinceJoining)
    .where(eq(familyMembers.familyId, familyId))
    .groupBy(familyMembers.userId, users.id)
    .orderBy(desc(contribution), asc(familyMembers.joinedAt));
  return {
    family: { familyId: f.id, name: f.name, imageUrl: f.imageUrl, ownerId: f.ownerId, createdAt: f.createdAt, monthTotal: members.reduce((s, m) => s + m.contribution, 0) },
    members,
    myRole: members.find((m) => m.userId === viewerId)?.role ?? null,
  };
}

export async function join(user: User, familyId: string) {
  assertCanParticipate(user);
  const [f] = await db.select({ id: families.id }).from(families).where(eq(families.id, familyId));
  if (!f) throw new AppError("FAMILY_NOT_FOUND", 404);
  try {
    await db.insert(familyMembers).values({ userId: user.id, familyId });
  } catch (e) {
    throw isUniqueViolation(e) ? inFamily() : e;
  }
}

// The owner can't leave; they disband instead.
export async function leave(user: User, familyId: string) {
  const [gone] = await db
    .delete(familyMembers)
    .where(and(eq(familyMembers.userId, user.id), eq(familyMembers.familyId, familyId), ne(familyMembers.role, "OWNER")))
    .returning();
  if (gone) return;
  throw (await roleIn(familyId, user.id)) === "OWNER" ? new AppError("OWNER_CANNOT_LEAVE", 409, "Disband the family instead") : new AppError("NOT_IN_FAMILY", 404);
}

export async function disband(user: User, familyId: string) {
  const [gone] = await db.delete(families).where(and(eq(families.id, familyId), eq(families.ownerId, user.id))).returning();
  if (!gone) throw new AppError("NOT_FAMILY_OWNER", 403, "Only the owner can do that");
}

export async function assertManager(user: User, familyId: string) {
  const mine = await roleIn(familyId, user.id);
  if (mine !== "OWNER" && mine !== "ADMIN") throw new AppError("NOT_FAMILY_ADMIN", 403, "Only the owner and admins can do that");
}

// Owner or admin; the route has already stored the upload.
export async function setImage(user: User, familyId: string, imageUrl: string) {
  await assertManager(user, familyId);
  await db.update(families).set({ imageUrl }).where(eq(families.id, familyId));
  return { imageUrl };
}

// Owner only: make a member an admin, or back to member.
export async function setRole(user: User, familyId: string, userId: string, role: "ADMIN" | "MEMBER") {
  if ((await roleIn(familyId, user.id)) !== "OWNER") throw new AppError("NOT_FAMILY_OWNER", 403, "Only the owner can do that");
  const [m] = await db
    .update(familyMembers)
    .set({ role })
    .where(and(eq(familyMembers.userId, userId), eq(familyMembers.familyId, familyId), ne(familyMembers.role, "OWNER")))
    .returning();
  if (!m) throw new AppError("NOT_IN_FAMILY", 404, "They are not in this family");
}

// Owner removes anyone else; admins remove plain members only.
export async function kick(user: User, familyId: string, userId: string) {
  const mine = await roleIn(familyId, user.id);
  if (mine !== "OWNER" && mine !== "ADMIN") throw new AppError("NOT_FAMILY_ADMIN", 403, "Only the owner and admins can do that");
  const [gone] = await db
    .delete(familyMembers)
    .where(and(eq(familyMembers.userId, userId), eq(familyMembers.familyId, familyId), mine === "OWNER" ? ne(familyMembers.role, "OWNER") : eq(familyMembers.role, "MEMBER")))
    .returning();
  if (!gone) throw new AppError("CANNOT_REMOVE", 403, "You can't remove this person");
}

// Owner or admin invites someone they follow, as a DM card. Joining is still the invitee's choice.
export async function invite(user: User, familyId: string, toUserId: string) {
  assertCanParticipate(user);
  rateLimit(`familyInvite:${user.id}`, 30, 60_000);
  const mine = await roleIn(familyId, user.id);
  if (mine !== "OWNER" && mine !== "ADMIN") throw new AppError("NOT_FAMILY_ADMIN", 403, "Only the owner and admins can invite");
  const [follow] = await db
    .select({ id: follows.followedId })
    .from(follows)
    .where(and(eq(follows.followerId, user.id), eq(follows.followedId, toUserId)));
  if (!follow) throw new AppError("NOT_FOLLOWING", 403, "You can only invite people you follow");
  const [blocked] = await db
    .select({ a: blocks.blockerId })
    .from(blocks)
    .where(or(and(eq(blocks.blockerId, user.id), eq(blocks.blockedId, toUserId)), and(eq(blocks.blockerId, toUserId), eq(blocks.blockedId, user.id))));
  if (blocked) throw new AppError("BLOCKED", 403, "You can't invite this person");
  const [theirs] = await db.select({ familyId: familyMembers.familyId }).from(familyMembers).where(eq(familyMembers.userId, toUserId));
  if (theirs) throw new AppError("ALREADY_IN_FAMILY", 409, theirs.familyId === familyId ? "They are already in your family" : "They are already in a family");
  const [f] = await db.select({ name: families.name }).from(families).where(eq(families.id, familyId));
  const [msg] = await db
    .insert(directMessages)
    .values({ senderId: user.id, recipientId: toUserId, body: `🏠 Join my family "${f!.name}"`, familyId })
    .returning();
  pushDm(msg!, user);
  return { invited: true };
}
