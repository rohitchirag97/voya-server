import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { eventPayouts, events, users, walletAccounts, walletLedger, type EventConfig, type EventMetric, type EventReward, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { grantBadge } from "./badges";
import { userSummary } from "./rooms";

// Events (schema: events). Counting is live from what the server already records: gift coins (sent, received, per room)
// and recharge rupees, only inside the event's window, and optionally only the event's own gift category.

export const EVENT_FILES_DIR = () => join(config.uploadsDir, "events");
const IST = "Asia/Kolkata";
type Event = typeof events.$inferSelect;

export const isLive = (e: Event, now = new Date()) => e.published && e.startsAt <= now && now < e.endsAt;
const phase = (e: Event, now = new Date()) => (!e.published ? "draft" : now < e.startsAt ? "upcoming" : now < e.endsAt ? "live" : "ended");

// Images for banners and page headers: PNG/JPEG/WebP up to 2 MB, saved with fresh names (served at /games/events/<name>).
export async function saveEventImage(file: File) {
  if (file.size > 2 * 1024 * 1024) throw new AppError("MEDIA_TOO_LARGE", 413, "Image is too large (max 2 MB)");
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ext =
    b[0] === 0x89 && b[1] === 0x50 ? "png" : b[0] === 0xff && b[1] === 0xd8 ? "jpg" : String.fromCharCode(...b.slice(8, 12)) === "WEBP" ? "webp" : null;
  if (!ext) throw new AppError("BAD_MEDIA", 400, "Image must be PNG, JPEG or WebP");
  const name = `${randomUUID()}.${ext}`;
  await mkdir(EVENT_FILES_DIR(), { recursive: true });
  await Bun.write(join(EVENT_FILES_DIR(), name), file);
  return `games/events/${name}`;
}

// ---------- counting ----------

// Totals per user (or per room for ROOM_GIFTS) within [from, to), biggest first. `day`: also split by India-time day.
async function totals(e: Event, metric: EventMetric, eventGiftsOnly: boolean, opts: { limit?: number; userId?: string; byDay?: boolean } = {}) {
  const to = new Date(Math.min(Date.now(), e.endsAt.getTime()));
  const onlyCategory = eventGiftsOnly && e.giftCategoryId ? sql`and g.gift_id in (select id from gift_catalog where category_id = ${e.giftCategoryId})` : sql``;
  const day = (col: string) => (opts.byDay ? sql.raw(`, (${col} at time zone '${IST}')::date::text`) : sql`, ''`);
  const who = metric === "GIFTS_SENT" ? "g.sender_id" : metric === "GIFTS_RECEIVED" ? "g.recipient_id" : metric === "ROOM_GIFTS" ? "g.room_id" : "r.user_id";
  const mine = opts.userId ? sql`and ${sql.raw(who)} = ${opts.userId}` : sql``;
  const limit = opts.limit ? sql`limit ${opts.limit}` : sql``;
  const q =
    metric === "RECHARGE"
      ? sql`select r.user_id::text as key ${day("r.created_at")} as day, (sum(r.price_paise) / 100)::float8 as value from recharges r
          where r.status = 'SUCCESS' and r.created_at >= ${e.startsAt} and r.created_at < ${to} ${mine} group by 1, 2 order by value desc ${limit}`
      : sql`select ${sql.raw(who)}::text as key ${day("g.created_at")} as day, sum(g.coins_debited)::float8 as value from gift_transactions g
          where g.created_at >= ${e.startsAt} and g.created_at < ${to} ${onlyCategory} ${mine} group by 1, 2 order by value desc ${limit}`;
  const { rows } = await db.execute<{ key: string; day: string; value: number }>(q);
  return rows.map((r) => ({ key: r.key, day: r.day, value: Number(r.value) }));
}

// Names and pictures for ranked users, or titles and owners for ranked rooms.
async function labels(metric: EventMetric, keys: string[]) {
  if (!keys.length) return new Map<string, Record<string, unknown>>();
  if (metric === "ROOM_GIFTS") {
    const { rows } = await db.execute<{ id: string; title: string; owner_id: string; owner_name: string | null; cover_url: string | null }>(sql`
      select r.id, r.title, r.host_user_id as owner_id, u.display_name as owner_name, r.cover_url from rooms r join users u on u.id = r.host_user_id where r.id in ${keys}`);
    return new Map(rows.map((r) => [r.id, { roomId: r.id, title: r.title, owner: r.owner_name, ownerId: r.owner_id, coverUrl: r.cover_url }]));
  }
  const people = await db.select(userSummary).from(users).where(sql`${users.id} in ${keys}`);
  return new Map(people.map((p) => [p.userId, p as Record<string, unknown>]));
}

async function board(e: Event, b: EventConfig["boards"][number], me?: string) {
  const rows = await totals(e, b.metric, b.eventGiftsOnly, { limit: b.size });
  const names = await labels(b.metric, rows.map((r) => r.key));
  let mine: { rank: number | null; value: number } | null = null;
  if (me && b.metric !== "ROOM_GIFTS") {
    const at = rows.findIndex((r) => r.key === me);
    if (at >= 0) mine = { rank: at + 1, value: rows[at]!.value };
    else {
      const [own] = await totals(e, b.metric, b.eventGiftsOnly, { userId: me });
      mine = { rank: null, value: own?.value ?? 0 }; // outside the ranks shown
    }
  }
  return {
    id: b.id,
    title: b.title,
    metric: b.metric,
    unit: b.metric === "RECHARGE" ? "rupees" : "coins",
    rewards: b.rewards,
    rows: rows.map((r, i) => ({ rank: i + 1, value: r.value, ...(names.get(r.key) ?? { key: r.key }) })),
    mine,
  };
}

// Today's date in India time, as YYYY-MM-DD.
const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

async function taskProgress(e: Event, t: EventConfig["tasks"][number], me: string) {
  const rows = await totals(e, t.metric, t.eventGiftsOnly, { userId: me, byDay: t.daily });
  const value = t.daily ? (rows.find((r) => r.day === todayIst())?.value ?? 0) : (rows[0]?.value ?? 0);
  const paid = e.paidOutAt !== null;
  return { id: t.id, title: t.title, unit: t.metric === "RECHARGE" ? "rupees" : "coins", target: t.target, daily: t.daily, reward: t.reward, value, done: value >= t.target, paid };
}

// ---------- for the app ----------

// Live events for the banner carousels, in order (several can run at once).
export const liveEvents = () =>
  db
    .select({ id: events.id, title: events.title, bannerUrl: events.bannerUrl, bannerHome: events.bannerHome, bannerRoom: events.bannerRoom, endsAt: events.endsAt })
    .from(events)
    .where(and(eq(events.published, true), lte(events.startsAt, sql`now()`), gt(events.endsAt, sql`now()`)))
    .orderBy(asc(events.sortOrder), desc(events.startsAt));

// One event's page: its look, leaderboards (with my place) and my task progress. Drafts: staff only.
export async function eventPage(id: string, me: User) {
  const [e] = await db.select().from(events).where(eq(events.id, id));
  if (!e || (!e.published && !me.staffRole)) throw new AppError("NOT_FOUND", 404, "No such event");
  return {
    id: e.id,
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    phase: phase(e),
    page: e.config.page,
    boards: await Promise.all(e.config.boards.map((b) => board(e, b, me.id))),
    tasks: await Promise.all(e.config.tasks.map((t) => taskProgress(e, t, me.id))),
    rewardsPaid: e.paidOutAt !== null,
  };
}

// ---------- payouts ----------

type Prize = { userId: string; source: string; reward: EventReward; why: string };

// Who earns what: each board's ranks inside a reward range, and everyone who reached a task's target (per day if daily).
export async function winners(e: Event): Promise<Prize[]> {
  const out: Prize[] = [];
  for (const b of e.config.boards) {
    if (b.metric === "ROOM_GIFTS" || !b.rewards.length) continue; // room boards are for show: no single person to pay
    const last = Math.max(...b.rewards.map((r) => r.to));
    const rows = await totals(e, b.metric, b.eventGiftsOnly, { limit: last });
    rows.forEach((r, i) => {
      const rank = i + 1;
      const reward = b.rewards.find((x) => x.from <= rank && rank <= x.to);
      if (reward && r.value > 0) out.push({ userId: r.key, source: `board:${b.id}:${rank}`, reward: { coins: reward.coins, badgeId: reward.badgeId, badgeDays: reward.badgeDays }, why: `${b.title}: rank ${rank}` });
    });
  }
  for (const t of e.config.tasks) {
    const rows = await totals(e, t.metric, t.eventGiftsOnly, { byDay: t.daily });
    for (const r of rows)
      if (r.value >= t.target) out.push({ userId: r.key, source: t.daily ? `task:${t.id}:${r.day}` : `task:${t.id}`, reward: t.reward, why: t.daily ? `${t.title} (${r.day})` : t.title });
  }
  return out;
}

export async function payoutPreview(id: string) {
  const e = await getEvent(id);
  const prizes = await winners(e);
  const names = await labels("GIFTS_SENT", [...new Set(prizes.map((p) => p.userId))]);
  const paid = await db.select({ userId: eventPayouts.userId, source: eventPayouts.source }).from(eventPayouts).where(eq(eventPayouts.eventId, id));
  const done = new Set(paid.map((p) => `${p.userId}|${p.source}`));
  return {
    phase: phase(e),
    paidOutAt: e.paidOutAt,
    prizes: prizes.map((p) => ({ ...p, user: names.get(p.userId) ?? null, paid: done.has(`${p.userId}|${p.source}`) })),
  };
}

// Staff approve after the event ends: every prize not yet paid is paid now (coins to the wallet, badges granted).
export async function approvePayouts(actor: User, id: string) {
  const e = await getEvent(id);
  if (phase(e) !== "ended") throw new AppError("EVENT_NOT_ENDED", 409, "Rewards can be approved once the event has ended");
  const prizes = await winners(e);
  const paid = await db.transaction(async (tx) => {
    const fresh: Prize[] = [];
    for (const p of prizes) {
      const [row] = await tx
        .insert(eventPayouts)
        .values({ eventId: id, userId: p.userId, source: p.source, reward: p.reward, approvedBy: actor.id })
        .onConflictDoNothing()
        .returning({ id: eventPayouts.id });
      if (!row) continue; // paid before
      fresh.push(p);
      if (p.reward.coins && p.reward.coins > 0) {
        await tx.insert(walletAccounts).values({ userId: p.userId, balance: 0 }).onConflictDoNothing();
        await tx
          .update(walletAccounts)
          .set({ balance: sql`${walletAccounts.balance} + ${p.reward.coins}`, version: sql`${walletAccounts.version} + 1` })
          .where(eq(walletAccounts.userId, p.userId));
        await tx.insert(walletLedger).values({ userId: p.userId, entryType: "EVENT_REWARD", amount: p.reward.coins, referenceType: "EVENT_PAYOUT", referenceId: String(row.id) });
      }
    }
    await tx.update(events).set({ paidOutAt: new Date() }).where(eq(events.id, id));
    return fresh;
  });
  // Badges after the money is safely recorded; a missing badge is reported, never undoes the coins.
  const failed: string[] = [];
  for (const p of paid) if (p.reward.badgeId) await grantBadge(p.userId, p.reward.badgeId, p.reward.badgeDays ?? null).catch(() => failed.push(p.why));
  return { paid: paid.length, badgeFailures: failed };
}

// ---------- admin ----------

export async function getEvent(id: string) {
  const [e] = await db.select().from(events).where(eq(events.id, id));
  if (!e) throw new AppError("NOT_FOUND", 404, "No such event");
  return e;
}

export const listAllEvents = async () =>
  (await db.select().from(events).orderBy(desc(events.startsAt))).map((e) => ({ ...e, phase: phase(e) }));

// New boards/tasks get short ids; existing ones keep theirs (payouts refer to them).
export const withIds = (c: EventConfig): EventConfig => ({
  ...c,
  boards: c.boards.map((b) => ({ ...b, id: b.id || randomUUID().slice(0, 8) })),
  tasks: c.tasks.map((t) => ({ ...t, id: t.id || randomUUID().slice(0, 8) })),
});
