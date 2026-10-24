import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { cosmetics, recharges, users } from "../db/schema";
import { io } from "../io";
import { AppError, toSafeError } from "../lib/errors";

// SVIP: tier from the ₹ recharged between the 1st and the last day of the current calendar month (India time).
// It runs out when the month ends; recharging in the new month earns it again. Perk minimums: see SVIP_PERKS.
export const SVIP_TIERS = [
  { tier: 1, rupees: 1_000 },
  { tier: 2, rupees: 5_000 },
  { tier: 3, rupees: 15_000 },
  { tier: 4, rupees: 30_000 },
  { tier: 5, rupees: 60_000 },
  { tier: 6, rupees: 1_20_000 },
  { tier: 7, rupees: 2_50_000 },
] as const;

export const SVIP_PERKS = {
  badge: 1, // SVIP badge next to the name everywhere
  frame: 1, // the tier's own avatar frame (cosmetics.min_svip)
  bubble: 1, // the tier's own chat bubble
  entrance: 2, // entrance animation + "SVIP2 X entered" notice, even when the room hides join notices
  invisibleVisits: 3, // opening a profile doesn't add you to its Visitors
  gifAvatar: 3, // animated GIF profile picture (hidden again if the tier lapses)
  antiKick: 5, // room owners/admins with a lower tier can't kick, mute or unseat you
} as const;

export const SVIP_PERK_TEXT: { key: keyof typeof SVIP_PERKS; title: string; detail: string }[] = [
  { key: "badge", title: "SVIP badge", detail: "Your SVIP tier shows next to your name everywhere" },
  { key: "frame", title: "SVIP frames", detail: "Wear your tier's exclusive avatar frame (and every lower tier's)" },
  { key: "bubble", title: "SVIP chat bubbles", detail: "Chat in your tier's exclusive bubble (and every lower tier's)" },
  { key: "entrance", title: "Grand entrance", detail: "An entrance animation and announcement in every room you enter" },
  { key: "invisibleVisits", title: "Invisible visits", detail: "Visit profiles without showing in their Visitors" },
  { key: "gifAvatar", title: "Animated profile picture", detail: "Use a GIF as your profile picture" },
  { key: "antiKick", title: "Kick protection", detail: "Owners and admins below your tier can't kick, mute or unseat you" },
];

export const tierFor = (rupees: number) => SVIP_TIERS.filter((t) => rupees >= t.rupees).at(-1)?.tier ?? 0;

const IST = sql.raw(`'Asia/Kolkata'`);
const monthStart = sql`(date_trunc('month', now() at time zone ${IST}) at time zone ${IST})`;
const tierValues = sql.raw(SVIP_TIERS.map((t) => `(${t.tier},${t.rupees})`).join(","));
const monthRupeesSql = sql`(select coalesce(sum(r.price_paise), 0) / 100 from ${recharges} r where r.user_id = ${users.id} and r.status = 'SUCCESS' and r.created_at >= ${monthStart})`;

// Tier as a column, for any query that selects from users.
// shortcut: one small sum per row; cache tiers in a column if lists of users get slow.
export const svipSql = sql<number>`(select coalesce(max(t.tier), 0) from (values ${tierValues}) t(tier, rupees) where t.rupees <= ${monthRupeesSql})`.mapWith(Number);

export async function svipOf(userId: string) {
  const [row] = await db.select({ svip: svipSql }).from(users).where(eq(users.id, userId));
  return row?.svip ?? 0;
}

export async function monthRupeesOf(userId: string) {
  const [row] = await db.select({ rupees: sql<number>`${monthRupeesSql}`.mapWith(Number) }).from(users).where(eq(users.id, userId));
  return row?.rupees ?? 0;
}

// Your SVIP page: tier, this month's progress, and when the month (and so the tier) ends.
export async function svipStatus(userId: string) {
  const [row] = await db
    .select({
      rupees: sql<number>`${monthRupeesSql}`.mapWith(Number),
      monthEnd: sql<string>`((date_trunc('month', now() at time zone ${IST}) + interval '1 month') at time zone ${IST})`,
    })
    .from(users)
    .where(eq(users.id, userId));
  const tier = tierFor(row!.rupees);
  const next = SVIP_TIERS.find((t) => t.tier > tier) ?? null;
  return {
    tier,
    thisMonthRupees: row!.rupees,
    validUntil: tier === 0 ? null : new Date(row!.monthEnd),
    next: next && { tier: next.tier, rupees: next.rupees, remaining: next.rupees - row!.rupees },
    tiers: SVIP_TIERS.map((t) => ({ ...t, perks: SVIP_PERK_TEXT.filter((p) => SVIP_PERKS[p.key] <= t.tier).map(({ title, detail }) => ({ title, detail })) })),
  };
}

// Kick protection: an SVIP at antiKick level or above can't be moderated by someone with a lower tier (staff excepted).
export async function assertNotSvipProtected(actorId: string, targetId: string) {
  const rows = await db.select({ id: users.id, svip: svipSql, staffRole: users.staffRole }).from(users).where(inArray(users.id, [actorId, targetId]));
  const actor = rows.find((r) => r.id === actorId);
  const target = rows.find((r) => r.id === targetId);
  if (!actor || !target || actor.staffRole) return;
  if (target.svip >= SVIP_PERKS.antiKick && target.svip > actor.svip)
    throw new AppError("SVIP_PROTECTED", 403, `SVIP${target.svip} members can't be moderated by lower tiers`);
}

// SVIP-only cosmetics: id → tier needed. Cached briefly; the catalog is small and rarely changes.
let minSvipCache: { at: number; map: Map<string, number> } | null = null;
export async function cosmeticMinSvip() {
  if (!minSvipCache || Date.now() - minSvipCache.at > 60_000) {
    const rows = await db.select({ id: cosmetics.id, minSvip: cosmetics.minSvip }).from(cosmetics);
    minSvipCache = { at: Date.now(), map: new Map(rows.map((r) => [r.id, r.minSvip])) };
  }
  return minSvipCache.map;
}
// An equipped item only shows while its owner still has the tier for it.
export const wearable = (id: string | null, svip: number, mins: Map<string, number>) => (id && (mins.get(id) ?? 0) <= svip ? id : null);

// Shown in every open room: SVIP tier-ups and level-ups from a recharge. Fire-and-forget: never affects the recharge.
export type Announcement = { kind: "SVIP_UP"; tier: number } | { kind: "LEVEL_UP"; level: number };
export function announceToAllRooms(user: { id: string; displayName: string | null; avatarUrl: string | null }, a: Announcement) {
  try {
    io.emit("app:announce", { ...a, userId: user.id, displayName: user.displayName ?? "Someone", avatarUrl: user.avatarUrl, at: new Date() });
  } catch (e) {
    toSafeError(e);
  }
}

// The user's equipped avatar frame id, only while it's enabled and they still have its SVIP tier (else null).
export const frameSql = sql<string | null>`(select c.id from ${cosmetics} c
  where c.id = ${users.avatarFrameId} and c.enabled and c.min_svip <= ${svipSql})`;

// A GIF profile picture only shows while its owner has the gifAvatar tier; otherwise it's hidden (initial shown instead).
const isGif = (url: string | null) => !!url && url.endsWith(".gif");
export const visibleAvatar = (url: string | null, svip: number) => (isGif(url) && svip < SVIP_PERKS.gifAvatar ? null : url);
export const avatarSql = sql<string | null>`(case when ${users.avatarUrl} like '%.gif' and ${svipSql} < ${SVIP_PERKS.gifAvatar} then null else ${users.avatarUrl} end)`;
