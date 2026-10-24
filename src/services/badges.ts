import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { badges, userBadges } from "../db/schema";
import { AppError } from "../lib/errors";

// Badges a user currently holds: enabled and not expired, in display order.
export const activeBadges = (userId: string) =>
  db
    .select({ id: badges.id, name: badges.name, description: badges.description, svg: badges.svg, expiresAt: userBadges.expiresAt })
    .from(userBadges)
    .innerJoin(badges, eq(badges.id, userBadges.badgeId))
    .where(and(eq(userBadges.userId, userId), eq(badges.enabled, true), or(isNull(userBadges.expiresAt), gt(userBadges.expiresAt, new Date()))))
    .orderBy(asc(badges.sortOrder));

export const badgeCatalog = () =>
  db.select({ id: badges.id, name: badges.name, svg: badges.svg }).from(badges).where(eq(badges.enabled, true)).orderBy(asc(badges.sortOrder));

// userId -> active badge ids (display order, at most `max` each) for many users in one query.
export async function activeBadgeIds(userIds: string[], max = 3) {
  const out = new Map<string, string[]>();
  if (!userIds.length) return out;
  const rows = await db
    .select({ userId: userBadges.userId, badgeId: badges.id })
    .from(userBadges)
    .innerJoin(badges, eq(badges.id, userBadges.badgeId))
    .where(and(inArray(userBadges.userId, userIds), eq(badges.enabled, true), or(isNull(userBadges.expiresAt), gt(userBadges.expiresAt, new Date()))))
    .orderBy(asc(badges.sortOrder));
  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    if (list.length < max) list.push(r.badgeId);
    out.set(r.userId, list);
  }
  return out;
}

// Give a badge for `days` days (null = forever). Granting again resets the expiry from now.
export async function grantBadge(userId: string, badgeId: string, days: number | null) {
  const [b] = await db.select({ id: badges.id }).from(badges).where(eq(badges.id, badgeId));
  if (!b) throw new AppError("BADGE_NOT_FOUND", 404);
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000);
  const [row] = await db
    .insert(userBadges)
    .values({ userId, badgeId, expiresAt })
    .onConflictDoUpdate({ target: [userBadges.userId, userBadges.badgeId], set: { expiresAt, grantedAt: new Date() } })
    .returning();
  return row!;
}

export const revokeBadge = (userId: string, badgeId: string) =>
  db.delete(userBadges).where(and(eq(userBadges.userId, userId), eq(userBadges.badgeId, badgeId)));
