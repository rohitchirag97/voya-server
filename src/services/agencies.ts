import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { db, isUniqueViolation } from "../db";
import { agencies, agencyHosts, directMessages, giftTransactions, recharges, users, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate } from "./auth";
import { grantBadge, revokeBadge } from "./badges";
import { AGENCY_SHARE } from "../lib/salaryLevels";
import { pushDm } from "./dmPush";
import { monthForAgency, monthForHost } from "./hostMonth";
import { userSummary } from "./rooms";

// A host who asked to leave goes when the owner approves, or by themselves once their account has been quiet this long:
// no app use, no gifts sent or received, no recharges.
export const INACTIVE_MONTHS = 3;
const BADGE = "agency_owner";

type Agency = typeof agencies.$inferSelect;
const publicAgency = (a: Agency) => ({ agencyId: a.id, code: a.code, name: a.name, imageUrl: a.imageUrl, status: a.status });
const busy = () => new AppError("ALREADY_IN_AGENCY", 409, "Already in an agency or has a pending request");

// Release LEAVING hosts who have been inactive for INACTIVE_MONTHS. Run before anything reads memberships.
export function expireLeaves() {
  const cutoff = sql`now() - ${`${INACTIVE_MONTHS} months`}::interval`;
  return db.delete(agencyHosts).where(
    and(
      eq(agencyHosts.status, "LEAVING"),
      lt(agencyHosts.leaveRequestedAt, cutoff),
      sql`not exists (select 1 from ${users} u where u.id = ${agencyHosts.userId} and u.last_seen_at >= ${cutoff})`,
      sql`not exists (select 1 from ${giftTransactions} g where g.sender_id = ${agencyHosts.userId} and g.created_at >= ${cutoff})`,
      sql`not exists (select 1 from ${giftTransactions} g where g.recipient_id = ${agencyHosts.userId} and g.created_at >= ${cutoff})`,
      sql`not exists (select 1 from ${recharges} r where r.user_id = ${agencyHosts.userId} and r.created_at >= ${cutoff})`,
    ),
  );
}

const openAgencyOf = async (ownerId: string) =>
  (await db.select().from(agencies).where(and(eq(agencies.ownerId, ownerId), ne(agencies.status, "CLOSED"))))[0];

async function ownedActive(owner: User) {
  const a = await openAgencyOf(owner.id);
  if (!a) throw new AppError("NOT_AGENCY_OWNER", 403, "You don't run an agency");
  if (a.status !== "ACTIVE") throw new AppError("AGENCY_SUSPENDED", 409, "Your agency is suspended. Contact VoyaLive support.");
  return a;
}

// ---------- staff ----------

export async function createAgency(owner: User, name: string) {
  const [host] = await db.select({ status: agencyHosts.status }).from(agencyHosts).where(eq(agencyHosts.userId, owner.id));
  if (host?.status === "ACTIVE" || host?.status === "LEAVING") throw new AppError("OWNER_IS_HOST", 409, "They're a host in an agency. They must leave it first.");
  try {
    const a = await db.transaction(async (tx) => {
      if (host) await tx.delete(agencyHosts).where(eq(agencyHosts.userId, owner.id)); // a pending application or invite lapses
      return (await tx.insert(agencies).values({ name, ownerId: owner.id }).returning())[0]!;
    });
    await grantBadge(owner.id, BADGE, null);
    return publicAgency(a);
  } catch (e) {
    throw isUniqueViolation(e) ? new AppError("ALREADY_OWNER", 409, "They already run an agency") : e;
  }
}

export async function listAgencies() {
  await expireLeaves();
  const hosts = sql<number>`(select count(*)::int from ${agencyHosts} h where h.agency_id = ${agencies.id} and h.status in ('ACTIVE', 'LEAVING'))`;
  return db
    .select({ agencyId: agencies.id, code: agencies.code, name: agencies.name, imageUrl: agencies.imageUrl, status: agencies.status, createdAt: agencies.createdAt, hosts, owner: { ...userSummary, publicId: users.publicId } })
    .from(agencies)
    .innerJoin(users, eq(users.id, agencies.ownerId))
    .orderBy(asc(agencies.status), asc(agencies.code));
}

// Rename, suspend, reactivate or close. The badge shows only while the agency is active; closing lets every host go.
export async function updateAgency(agencyId: string, patch: { name?: string; status?: Agency["status"] }) {
  const [cur] = await db.select().from(agencies).where(eq(agencies.id, agencyId));
  if (!cur) throw new AppError("AGENCY_NOT_FOUND", 404);
  if (cur.status === "CLOSED") throw new AppError("AGENCY_CLOSED", 409, "This agency is closed");
  const a = await db.transaction(async (tx) => {
    if (patch.status === "CLOSED") await tx.delete(agencyHosts).where(eq(agencyHosts.agencyId, agencyId));
    return (await tx.update(agencies).set(patch).where(eq(agencies.id, agencyId)).returning())[0]!;
  });
  if (a.status === "ACTIVE") await grantBadge(a.ownerId, BADGE, null);
  else await revokeBadge(a.ownerId, BADGE);
  return publicAgency(a);
}

export async function setAgencyImage(agencyId: string, imageUrl: string) {
  const [a] = await db.update(agencies).set({ imageUrl }).where(and(eq(agencies.id, agencyId), ne(agencies.status, "CLOSED"))).returning();
  if (!a) throw new AppError("AGENCY_NOT_FOUND", 404);
  return publicAgency(a);
}

// ---------- hosts ----------

// What the app shows on the Agency screen: the agency I run, and/or my place in one.
export async function myAgency(userId: string) {
  await expireLeaves();
  const owned = await openAgencyOf(userId);
  const [m] = await db.select().from(agencyHosts).innerJoin(agencies, eq(agencies.id, agencyHosts.agencyId)).where(eq(agencyHosts.userId, userId));
  return {
    owned: owned ? publicAgency(owned) : null,
    membership: m
      ? { ...publicAgency(m.agencies), hostStatus: m.agency_hosts.status, requestedAt: m.agency_hosts.requestedAt, joinedAt: m.agency_hosts.joinedAt, leaveRequestedAt: m.agency_hosts.leaveRequestedAt }
      : null,
    month: m?.agency_hosts.joinedAt ? await monthForHost(userId, m.agencies.id) : null, // my diamonds, mic time and level this month
    inactiveMonths: INACTIVE_MONTHS,
  };
}

// Look an agency up by the code people share, to apply.
export async function byCode(code: number) {
  const [row] = await db
    .select({ agency: agencies, owner: { ...userSummary, publicId: users.publicId } })
    .from(agencies)
    .innerJoin(users, eq(users.id, agencies.ownerId))
    .where(and(eq(agencies.code, code), eq(agencies.status, "ACTIVE")));
  if (!row) throw new AppError("AGENCY_NOT_FOUND", 404, "No agency with that ID");
  return { ...publicAgency(row.agency), owner: row.owner };
}

async function assertNotOwner(userId: string) {
  if (await openAgencyOf(userId)) throw new AppError("IS_AGENCY_OWNER", 409, "Agency owners can't be hosts");
}

export async function apply(user: User, agencyId: string) {
  assertCanParticipate(user);
  rateLimit(`agencyApply:${user.id}`, 10, 60_000);
  const [a] = await db.select().from(agencies).where(eq(agencies.id, agencyId));
  if (a?.status !== "ACTIVE") throw new AppError("AGENCY_NOT_FOUND", 404, "No agency with that ID");
  await assertNotOwner(user.id);
  try {
    await db.insert(agencyHosts).values({ userId: user.id, agencyId, status: "APPLIED" });
  } catch (e) {
    throw isUniqueViolation(e) ? busy() : e;
  }
  return myAgency(user.id);
}

// Withdraw my application, or decline an invite.
export async function cancelRequest(user: User) {
  const [gone] = await db.delete(agencyHosts).where(and(eq(agencyHosts.userId, user.id), inArray(agencyHosts.status, ["APPLIED", "INVITED"]))).returning();
  if (!gone) throw new AppError("NO_REQUEST", 404, "No open application or invite");
  return myAgency(user.id);
}

export async function acceptInvite(user: User) {
  assertCanParticipate(user);
  const [row] = await db
    .update(agencyHosts)
    .set({ status: "ACTIVE", joinedAt: new Date() })
    .where(and(eq(agencyHosts.userId, user.id), eq(agencyHosts.status, "INVITED"), sql`exists (select 1 from ${agencies} a where a.id = ${agencyHosts.agencyId} and a.status = 'ACTIVE')`))
    .returning();
  if (!row) throw new AppError("NO_INVITE", 404, "No invite to accept, or the agency is suspended");
  return myAgency(user.id);
}

export async function requestLeave(user: User) {
  const [row] = await db
    .update(agencyHosts)
    .set({ status: "LEAVING", leaveRequestedAt: new Date() })
    .where(and(eq(agencyHosts.userId, user.id), eq(agencyHosts.status, "ACTIVE")))
    .returning();
  if (!row) throw new AppError("NOT_A_HOST", 404, "You're not a host in an agency");
  return myAgency(user.id);
}

// ---------- owner ----------

// My agency with everyone in or waiting to get in.
export async function ownerView(owner: User) {
  await expireLeaves();
  const a = await openAgencyOf(owner.id);
  if (!a) throw new AppError("NOT_AGENCY_OWNER", 403, "You don't run an agency");
  const rows = await db
    .select({ ...userSummary, publicId: users.publicId, hostStatus: agencyHosts.status, requestedAt: agencyHosts.requestedAt, joinedAt: agencyHosts.joinedAt, leaveRequestedAt: agencyHosts.leaveRequestedAt })
    .from(agencyHosts)
    .innerJoin(users, eq(users.id, agencyHosts.userId))
    .where(eq(agencyHosts.agencyId, a.id))
    .orderBy(asc(agencyHosts.requestedAt));
  // Hosts carry this month's figures; best month first. Totals are what the owner can expect so far.
  const month = await monthForAgency(a.id);
  const people = rows.map((r) => ({ ...r, month: month.get(r.userId) ?? null })).sort((x, y) => (y.month?.diamonds ?? -1) - (x.month?.diamonds ?? -1));
  const hosts = [...month.values()];
  const totals = {
    diamonds: hosts.reduce((s, h) => s + h.diamonds, 0),
    salaries: hosts.reduce((s, h) => s + h.salary, 0),
    agencyBonus: Math.round(hosts.reduce((s, h) => s + h.salary, 0) * AGENCY_SHARE * 100) / 100,
  };
  return { agency: publicAgency(a), people, totals, inactiveMonths: INACTIVE_MONTHS };
}

export async function invite(owner: User, target: User) {
  assertCanParticipate(owner);
  rateLimit(`agencyInvite:${owner.id}`, 30, 60_000);
  const a = await ownedActive(owner);
  if (target.id === owner.id) throw new AppError("CANNOT_TARGET_SELF", 400, "You can't invite yourself");
  if (target.status !== "ACTIVE") throw new AppError("USER_NOT_FOUND", 404);
  await assertNotOwner(target.id);
  try {
    await db.insert(agencyHosts).values({ userId: target.id, agencyId: a.id, status: "INVITED" });
  } catch (e) {
    throw isUniqueViolation(e) ? busy() : e;
  }
  const [msg] = await db
    .insert(directMessages)
    .values({ senderId: owner.id, recipientId: target.id, body: `🏢 ${owner.displayName ?? "An agency owner"} invited you to host for "${a.name}"`, agencyId: a.id })
    .returning();
  pushDm(msg!, owner);
  return ownerView(owner);
}

// Approve an application (they join), or a leave request (they go now).
export async function approve(owner: User, userId: string) {
  const a = await ownedActive(owner);
  const [row] = await db.select().from(agencyHosts).where(and(eq(agencyHosts.userId, userId), eq(agencyHosts.agencyId, a.id)));
  if (row?.status === "APPLIED") await db.update(agencyHosts).set({ status: "ACTIVE", joinedAt: new Date() }).where(eq(agencyHosts.userId, userId));
  else if (row?.status === "LEAVING") await db.delete(agencyHosts).where(eq(agencyHosts.userId, userId));
  else throw new AppError("NO_REQUEST", 404, "Nothing to approve for this person");
  return ownerView(owner);
}

// Turn down an application, take back an invite, or remove a host.
export async function removePerson(owner: User, userId: string) {
  const a = await openAgencyOf(owner.id);
  if (!a) throw new AppError("NOT_AGENCY_OWNER", 403, "You don't run an agency");
  const [gone] = await db.delete(agencyHosts).where(and(eq(agencyHosts.userId, userId), eq(agencyHosts.agencyId, a.id))).returning();
  if (!gone) throw new AppError("NOT_IN_AGENCY", 404, "They're not in your agency");
  return ownerView(owner);
}
