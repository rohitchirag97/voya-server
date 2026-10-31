import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { db } from "../db";
import { badges, cosmetics, staffRoles, userCosmetics, users, type User } from "../db/schema";
import type { Env } from "../http";
import { AppError } from "../lib/errors";
import { OWNER_GOLD, OWNER_ROLE, PERMISSION_KEYS, type Permission } from "../lib/permissions";

// Staff roles (schema: staff_roles): what each staff member can do and how they look. One role per person; the owner's
// role is fixed and can do everything. Roles are read on every staff request, so they're cached briefly here and the
// cache is dropped whenever a role changes.

export type Role = typeof staffRoles.$inferSelect;
let cache: { at: number; map: Map<string, Role> } | null = null;
export async function roles() {
  if (!cache || Date.now() - cache.at > 30_000) {
    const rows = await db.select().from(staffRoles).orderBy(asc(staffRoles.sortOrder), asc(staffRoles.createdAt));
    cache = { at: Date.now(), map: new Map(rows.map((r) => [r.id, r])) };
  }
  return cache.map;
}
const dropCache = () => (cache = null);

export async function permissionsOf(user: Pick<User, "staffRole">): Promise<Permission[]> {
  if (!user.staffRole) return [];
  if (user.staffRole === OWNER_ROLE) return PERMISSION_KEYS;
  return ((await roles()).get(user.staffRole)?.permissions ?? []).filter((p): p is Permission => PERMISSION_KEYS.includes(p as Permission));
}
export const can = async (user: Pick<User, "staffRole">, perm: Permission) => (await permissionsOf(user)).includes(perm);

// After requireAuth: the user's role must have every one of these switches.
export const requirePerm = (...perms: Permission[]) =>
  createMiddleware<Env>(async (c, next) => {
    const mine = await permissionsOf(c.get("user"));
    if (!perms.every((p) => mine.includes(p))) throw new AppError("FORBIDDEN", 403, "Not allowed");
    await next();
  });
// After requireAuth: any staff role at all (the panel's own checks narrow it further).
export const requireAnyStaff = createMiddleware<Env>(async (c, next) => {
  if (!c.get("user").staffRole) throw new AppError("FORBIDDEN", 403, "Not allowed");
  await next();
});

// Everyone whose role has this switch (the owner included), e.g. who answers the SVIP support desk.
export async function staffWith(perm: Permission) {
  const ids = [OWNER_ROLE, ...[...(await roles()).values()].filter((r) => r.permissions.includes(perm)).map((r) => r.id)];
  return db.select({ id: users.id }).from(users).where(inArray(users.staffRole, ids));
}

// The app's list: each role's name, colour and whether it shows the tick (the owner's tick is always gold).
export async function publicRoles() {
  return [...(await roles()).values()].map((r) => ({ id: r.id, name: r.name, color: r.id === OWNER_ROLE ? OWNER_GOLD : r.color, showTag: r.showTag }));
}

// ---------- the role's look ----------

// Moving someone from one role to another: the old role's frame goes (and comes off if worn), the new role's frame is
// given and put on. A frame they also own some other way is never taken.
async function applyLook(userId: string, from: string | null, to: string | null) {
  const map = await roles();
  if (from) {
    const gone = await db.delete(userCosmetics).where(and(eq(userCosmetics.userId, userId), eq(userCosmetics.fromRole, from))).returning({ id: userCosmetics.cosmeticId });
    if (gone.length) await db.update(users).set({ avatarFrameId: null }).where(and(eq(users.id, userId), inArray(users.avatarFrameId, gone.map((g) => g.id))));
  }
  const frame = to ? map.get(to)?.frameId : null;
  if (frame) {
    await db.insert(userCosmetics).values({ userId, cosmeticId: frame, fromRole: to }).onConflictDoNothing();
    await db.update(users).set({ avatarFrameId: frame }).where(eq(users.id, userId));
  }
}

// ---------- managing roles ----------

const ROLE_COLOUR = /^#[0-9a-fA-F]{6}$/;
export type RoleInput = { name: string; color: string; permissions: string[]; showTag: boolean; badgeId: string | null; frameId: string | null };

// Nobody hands out switches they don't have themselves.
async function assertWithin(actor: User, perms: string[]) {
  const mine = await permissionsOf(actor);
  const extra = perms.filter((p) => !mine.includes(p as Permission));
  if (extra.length) throw new AppError("FORBIDDEN", 403, "You can only give access you have yourself");
}
async function checkInput(r: RoleInput) {
  if (!ROLE_COLOUR.test(r.color)) throw new AppError("VALIDATION_ERROR", 400, "Colour as #RRGGBB");
  if (r.color.toUpperCase() === OWNER_GOLD) throw new AppError("VALIDATION_ERROR", 400, "Gold is the owner's colour. Pick another.");
  if (r.permissions.some((p) => !PERMISSION_KEYS.includes(p as Permission))) throw new AppError("VALIDATION_ERROR", 400, "Unknown access switch");
  if (r.badgeId && !(await db.select({ id: badges.id }).from(badges).where(eq(badges.id, r.badgeId))).length) throw new AppError("BADGE_NOT_FOUND", 404, "That badge doesn't exist");
  if (r.frameId && !(await db.select({ id: cosmetics.id }).from(cosmetics).where(and(eq(cosmetics.id, r.frameId), eq(cosmetics.kind, "AVATAR_FRAME")))).length)
    throw new AppError("COSMETIC_NOT_FOUND", 404, "That frame doesn't exist");
}

// Every role with how many people hold it.
export async function listRoles() {
  const counts = await db.select({ role: users.staffRole, n: sql<number>`count(*)::int` }).from(users).where(isNotNull(users.staffRole)).groupBy(users.staffRole);
  return [...(await roles()).values()].map((r) => ({ ...r, fixed: r.id === OWNER_ROLE, members: counts.find((c) => c.role === r.id)?.n ?? 0 }));
}

export async function createRole(actor: User, r: RoleInput) {
  await checkInput(r);
  await assertWithin(actor, r.permissions);
  const [row] = await db.insert(staffRoles).values({ id: `R${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`, ...r }).returning();
  dropCache();
  return row!;
}

// A changed frame moves for everyone in the role. The owner's role and your own role can't be edited.
export async function updateRole(actor: User, id: string, r: RoleInput) {
  if (id === OWNER_ROLE) throw new AppError("FORBIDDEN", 403, "The owner's role can't be changed");
  if (id === actor.staffRole && actor.staffRole !== OWNER_ROLE) throw new AppError("FORBIDDEN", 403, "You can't edit your own role");
  const old = (await roles()).get(id);
  if (!old) throw new AppError("NOT_FOUND", 404, "No such role");
  await checkInput(r);
  await assertWithin(actor, [...r.permissions, ...old.permissions]); // nor edit a role that has more than you
  await db.update(staffRoles).set(r).where(eq(staffRoles.id, id));
  dropCache();
  if (old.frameId !== r.frameId) {
    const members = await db.select({ id: users.id }).from(users).where(eq(users.staffRole, id));
    for (const m of members) {
      await applyLook(m.id, id, null); // the old frame goes
      await applyLook(m.id, null, id); // the new one comes
    }
  }
}

// Deleting a role: everyone in it goes back to a regular user (its frame goes with it).
export async function deleteRole(actor: User, id: string) {
  if (id === OWNER_ROLE) throw new AppError("FORBIDDEN", 403, "The owner's role can't be deleted");
  if (id === actor.staffRole) throw new AppError("FORBIDDEN", 403, "You can't delete your own role");
  const old = (await roles()).get(id);
  if (!old) throw new AppError("NOT_FOUND", 404, "No such role");
  await assertWithin(actor, old.permissions);
  const members = await db.update(users).set({ staffRole: null, updatedAt: new Date() }).where(eq(users.staffRole, id)).returning({ id: users.id });
  for (const m of members) await applyLook(m.id, id, null);
  await db.delete(staffRoles).where(eq(staffRoles.id, id));
  dropCache();
  return { members: members.length };
}

// Give someone a role, change it, or remove it (null). You can't change your own role or the owner's, and can only
// give roles within your own access. Making someone the owner hands ownership over: the old owner becomes an Admin.
export async function assignRole(actor: User, targetId: string, roleId: string | null) {
  if (targetId === actor.id) throw new AppError("CANNOT_CHANGE_OWN_ROLE", 400, "You can't change your own role");
  const [target] = await db.select({ staffRole: users.staffRole }).from(users).where(eq(users.id, targetId));
  if (!target) throw new AppError("USER_NOT_FOUND", 404);
  if (target.staffRole === OWNER_ROLE) throw new AppError("FORBIDDEN", 403, "The owner's role can't be changed here");
  if (roleId === OWNER_ROLE) {
    if (actor.staffRole !== OWNER_ROLE) throw new AppError("FORBIDDEN", 403, "Only the owner can hand over ownership");
  } else if (roleId) {
    const role = (await roles()).get(roleId);
    if (!role) throw new AppError("NOT_FOUND", 404, "No such role");
    await assertWithin(actor, role.permissions);
  }
  if (target.staffRole) await assertWithin(actor, (await roles()).get(target.staffRole)?.permissions ?? []); // nor demote someone above you
  await db.transaction(async (tx) => {
    if (roleId === OWNER_ROLE) await tx.update(users).set({ staffRole: "ADMIN", updatedAt: new Date() }).where(eq(users.id, actor.id));
    await tx.update(users).set({ staffRole: roleId, updatedAt: new Date() }).where(eq(users.id, targetId));
  });
  await applyLook(targetId, target.staffRole, roleId);
  if (roleId === OWNER_ROLE) await applyLook(actor.id, OWNER_ROLE, "ADMIN");
  return { userId: targetId, staffRole: roleId };
}

// Role badges: each user's role badge (shown automatically, before their own badges).
export async function roleBadgeIds(userIds: string[]) {
  if (!userIds.length) return new Map<string, string>();
  const map = await roles();
  const rows = await db.select({ id: users.id, role: users.staffRole }).from(users).where(and(inArray(users.id, userIds), isNotNull(users.staffRole)));
  return new Map(rows.flatMap((r) => (r.role && map.get(r.role)?.badgeId ? [[r.id, map.get(r.role)!.badgeId!] as const] : [])));
}
