import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, desc, eq, gt, isNull, lte, ne, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { cpPairs, eventPayouts, events, users, walletAccounts, walletLedger, type EventConfig, type EventCounting, type EventReward, type RewardItem, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { grantItem, itemLabels } from "./items";
import { userSummary } from "./rooms";

// Events (schema: events). Counting is live from what the server already records, only inside the event's window:
// gift coins (sent, received, per room), coins from recharges, game winnings, CP points; narrowed by optional filters
// (which gifts, who takes part). Prizes are any mix of items, handed out when staff approve after the end.

export const EVENT_FILES_DIR = () => join(config.uploadsDir, "events");
const IST = "Asia/Kolkata";
type Event = typeof events.$inferSelect;
type Board = EventConfig["boards"][number];
type Task = EventConfig["tasks"][number];

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

// ---------- stored settings ----------

// Older events stored "only this event's gifts" as a flag and prizes as coins + one badge: read them as blocks and items.
type Stored = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const asReward = (r: Stored | undefined): EventReward =>
  Array.isArray(r?.items)
    ? { items: r.items }
    : { items: [...(r?.coins ? [{ type: "COINS" as const, amount: r.coins }] : []), ...(r?.badgeId ? [{ type: "BADGE" as const, id: r.badgeId, days: r.badgeDays ?? null }] : [])] };
const asCounting = (x: Stored): EventCounting => ({
  metric: x.metric,
  game: x.game ?? "ALL",
  filters: x.filters ?? (x.eventGiftsOnly ? [{ type: "EVENT_GIFTS" }] : []),
});
export const normConfig = (c: Stored): EventConfig => ({
  page: c.page,
  boards: (c.boards ?? []).map((b: Stored) => ({
    ...asCounting(b),
    id: b.id,
    title: b.title,
    size: b.size,
    rewards: (b.rewards ?? []).map((r: Stored) => ({ from: r.from, to: r.to, ...(r.min !== undefined && { min: r.min }), ...asReward(r) })),
  })),
  tasks: (c.tasks ?? []).map((t: Stored) => ({ ...asCounting(t), id: t.id, title: t.title, target: t.target, daily: t.daily, reward: asReward(t.reward) })),
});
const load = (e: Event): Event => ({ ...e, config: normConfig(e.config) });

// ---------- counting ----------

const ISTQ = sql.raw(`'${IST}'`);
const GREEDY_SKIN = { GREEDY_JUNGLE: "jungle", GREEDY_GALAXY: "galaxy" } as const;

// "Who takes part" filters, on the column holding the person being counted.
function peopleFilters(c: EventCounting, col: string) {
  const who = sql.raw(col);
  return sql.join(
    c.filters.map((f) =>
      f.type === "HOSTS_ONLY"
        ? sql` and ${who} in (select user_id from agency_hosts where status in ('ACTIVE', 'LEAVING'))`
        : f.type === "JOINED_AFTER"
          ? sql` and ${who} in (select id from users where created_at >= (${f.date}::date::timestamp at time zone ${ISTQ}))`
          : f.type === "MIN_LEVEL"
            ? sql` and ${who} in (select u.id from users u where (select coalesce(max(l.level), 0) from level_thresholds l where l.xp_required <= u.xp) >= ${f.level})`
            : sql``,
    ),
  );
}
// "Which gifts" filters.
function giftFilters(e: Event, c: EventCounting) {
  return sql.join(
    c.filters.map((f) =>
      f.type === "EVENT_GIFTS" && e.giftCategoryId
        ? sql` and g.gift_id in (select id from gift_catalog where category_id = ${e.giftCategoryId})`
        : f.type === "GIFT_CATEGORIES" && f.ids.length
          ? sql` and g.gift_id in (select id from gift_catalog where category_id in ${f.ids})`
          : sql``,
    ),
  );
}

// Totals per key within [startsAt, min(now, endsAt)), biggest first. The key is a user, a room (ROOM_GIFTS) or a CP
// pair (CP_POINTS). `byDay`: also split by India-time day. `userId`: only rows that are (or include) this user.
async function totals(e: Event, c: EventCounting, opts: { limit?: number; userId?: string; byDay?: boolean } = {}) {
  const to = new Date(Math.min(Date.now(), e.endsAt.getTime()));
  const day = (col: string) => (opts.byDay ? sql.raw(`, (${col} at time zone '${IST}')::date::text`) : sql`, ''`);
  const limit = opts.limit ? sql`limit ${opts.limit}` : sql``;
  const mine = (col: string) => (opts.userId ? sql` and ${sql.raw(col)} = ${opts.userId}` : sql``);
  let q;
  switch (c.metric) {
    case "RECHARGE":
      q = sql`select r.user_id::text as key ${day("r.created_at")} as day, sum(r.coins)::float8 as value from recharges r
        where r.status = 'SUCCESS' and r.created_at >= ${e.startsAt} and r.created_at < ${to}${peopleFilters(c, "r.user_id")}${mine("r.user_id")}
        group by 1, 2 order by value desc ${limit}`;
      break;
    case "GAME_WINS": {
      const games =
        c.game === "ROCKET"
          ? sql`l.entry_type = 'ROCKET_WIN'`
          : c.game === "GREEDY_JUNGLE" || c.game === "GREEDY_GALAXY"
            ? sql`l.entry_type = 'GREEDY_WIN' and l.reference_id in (select id::text from greedy_rounds where game = ${GREEDY_SKIN[c.game]})`
            : sql`l.entry_type in ('GREEDY_WIN', 'ROCKET_WIN')`;
      q = sql`select l.user_id::text as key ${day("l.created_at")} as day, sum(l.amount)::float8 as value from wallet_ledger l
        where ${games} and l.created_at >= ${e.startsAt} and l.created_at < ${to}${peopleFilters(c, "l.user_id")}${mine("l.user_id")}
        group by 1, 2 order by value desc ${limit}`;
      break;
    }
    case "CP_POINTS": {
      // CP points are kept per day: whole India-time days from the start's day to the end's.
      const pairs = opts.userId ? sql` and d.pair_id in (select id from cp_pairs where user_a = ${opts.userId} or user_b = ${opts.userId})` : sql``;
      q = sql`select d.pair_id::text as key ${opts.byDay ? sql`, d.day::text` : sql`, ''`} as day, sum(d.points)::float8 as value from cp_points_daily d
        where d.day >= (${e.startsAt}::timestamptz at time zone ${ISTQ})::date and d.day <= ((${to}::timestamptz - interval '1 millisecond') at time zone ${ISTQ})::date${pairs}
        group by 1, 2 order by value desc ${limit}`;
      break;
    }
    default: {
      const who = c.metric === "GIFTS_SENT" ? "g.sender_id" : c.metric === "GIFTS_RECEIVED" ? "g.recipient_id" : "g.room_id";
      const person = c.metric !== "ROOM_GIFTS";
      q = sql`select ${sql.raw(who)}::text as key ${day("g.created_at")} as day, sum(g.coins_debited)::float8 as value from gift_transactions g
        where g.created_at >= ${e.startsAt} and g.created_at < ${to}${giftFilters(e, c)}${person ? peopleFilters(c, who) : sql``}${person ? mine(who) : sql``}
        group by 1, 2 order by value desc ${limit}`;
    }
  }
  const { rows } = await db.execute<{ key: string; day: string; value: number }>(q);
  return rows.map((r) => ({ key: r.key, day: r.day, value: Number(r.value) }));
}

// CP pairs' two partners, by pair id.
async function pairsOf(ids: string[]) {
  if (!ids.length) return new Map<string, { a: string; b: string }>();
  const rows = await db.select({ id: cpPairs.id, a: cpPairs.userA, b: cpPairs.userB }).from(cpPairs).where(sql`${cpPairs.id} in ${ids}`);
  return new Map(rows.map((r) => [r.id, { a: r.a, b: r.b }]));
}

// Names and pictures for ranked users, titles and owners for ranked rooms, both partners for ranked CP pairs.
async function labels(metric: EventCounting["metric"], keys: string[]): Promise<Map<string, Record<string, unknown>>> {
  if (!keys.length) return new Map();
  if (metric === "ROOM_GIFTS") {
    const { rows } = await db.execute<{ id: string; title: string; owner_id: string; owner_name: string | null; cover_url: string | null }>(sql`
      select r.id, r.title, r.host_user_id as owner_id, u.display_name as owner_name, r.cover_url from rooms r join users u on u.id = r.host_user_id where r.id in ${keys}`);
    return new Map(rows.map((r) => [r.id, { roomId: r.id, title: r.title, owner: r.owner_name, ownerId: r.owner_id, coverUrl: r.cover_url }]));
  }
  if (metric === "CP_POINTS") {
    const pairs = await pairsOf(keys);
    const people = await labels("GIFTS_SENT", [...new Set([...pairs.values()].flatMap((p) => [p.a, p.b]))]);
    return new Map([...pairs].map(([id, p]) => [id, { pairId: id, a: people.get(p.a) ?? null, b: people.get(p.b) ?? null }]));
  }
  const people = await db.select(userSummary).from(users).where(sql`${users.id} in ${keys}`);
  return new Map(people.map((p) => [p.userId, p as Record<string, unknown>]));
}

async function board(e: Event, b: Board, me?: string) {
  const rows = await totals(e, b, { limit: b.size });
  const names = await labels(b.metric, rows.map((r) => r.key));
  let mine: { rank: number | null; value: number } | null = null;
  if (me && b.metric !== "ROOM_GIFTS") {
    const [own] = await totals(e, b, { userId: me }); // my row (my best pair for CP)
    const at = own ? rows.findIndex((r) => r.key === own.key) : -1;
    mine = { rank: at >= 0 ? at + 1 : null, value: own?.value ?? 0 };
  }
  return {
    id: b.id,
    title: b.title,
    metric: b.metric,
    unit: b.metric === "CP_POINTS" ? "points" : "coins",
    rewards: b.rewards,
    rows: rows.map((r, i) => ({ rank: i + 1, value: r.value, ...(names.get(r.key) ?? { key: r.key }) })),
    mine,
  };
}

// Today's date in India time, as YYYY-MM-DD.
const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

async function taskProgress(e: Event, t: Task, me: string) {
  const rows = await totals(e, t, { userId: me, byDay: t.daily });
  const value = t.daily ? (rows.find((r) => r.day === todayIst())?.value ?? 0) : (rows[0]?.value ?? 0);
  const paid = e.paidOutAt !== null;
  return { id: t.id, title: t.title, unit: "coins", target: t.target, daily: t.daily, reward: t.reward, value, done: value >= t.target, paid };
}

// Names and pictures of every badge and item an event's prizes mention.
function rewardLabels(c: EventConfig) {
  const all = [...c.boards.flatMap((b) => b.rewards.flatMap((r) => r.items)), ...c.tasks.flatMap((t) => t.reward.items)];
  return itemLabels({
    badges: [...new Set(all.flatMap((i) => (i.type === "BADGE" ? [i.id] : [])))],
    items: [...new Set(all.flatMap((i) => (i.type === "ITEM" ? [i.id] : [])))],
  });
}

// ---------- for the app ----------

// Live events for the banner carousels, in order (several can run at once).
export const liveEvents = () =>
  db
    .select({ id: events.id, title: events.title, bannerUrl: events.bannerUrl, bannerHome: events.bannerHome, bannerRoom: events.bannerRoom, homeTab: events.homeTab, endsAt: events.endsAt, color: sql<string>`${events.config}->'page'->>'color'` })
    .from(events)
    .where(and(eq(events.published, true), lte(events.startsAt, sql`now()`), gt(events.endsAt, sql`now()`)))
    .orderBy(asc(events.sortOrder), desc(events.startsAt));

// One event's page: its look, leaderboards (with my place), my task progress, and what its prize items look like.
// Drafts: staff only.
export async function eventPage(id: string, me: User) {
  const [row] = await db.select().from(events).where(eq(events.id, id));
  if (!row || (!row.published && !me.staffRole)) throw new AppError("NOT_FOUND", 404, "No such event");
  const e = load(row);
  return {
    id: e.id,
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    phase: phase(e),
    page: e.config.page,
    boards: await Promise.all(e.config.boards.map((b) => board(e, b, me.id))),
    tasks: await Promise.all(e.config.tasks.map((t) => taskProgress(e, t, me.id))),
    labels: await rewardLabels(e.config),
    rewardsPaid: e.paidOutAt !== null,
  };
}

// ---------- payouts ----------

type Prize = { userId: string; source: string; reward: EventReward; why: string };

// Who earns what: each board's ranks inside a prize range that reached its minimum (both partners for a CP pair), and
// everyone who reached a task's target (per day if daily).
export async function winners(e: Event): Promise<Prize[]> {
  const out: Prize[] = [];
  for (const b of e.config.boards) {
    if (b.metric === "ROOM_GIFTS" || !b.rewards.length) continue; // room boards are for show: no single person to pay
    const last = Math.max(...b.rewards.map((r) => r.to));
    const rows = await totals(e, b, { limit: last });
    const pairs = b.metric === "CP_POINTS" ? await pairsOf(rows.map((r) => r.key)) : null;
    rows.forEach((r, i) => {
      const rank = i + 1;
      const prize = b.rewards.find((x) => x.from <= rank && rank <= x.to);
      if (!prize || r.value <= 0 || r.value < (prize.min ?? 0)) return;
      const pair = pairs?.get(r.key);
      for (const userId of pairs ? (pair ? [pair.a, pair.b] : []) : [r.key])
        out.push({ userId, source: `board:${b.id}:${rank}`, reward: { items: prize.items }, why: `${b.title}: rank ${rank}` });
    });
  }
  for (const t of e.config.tasks) {
    const rows = await totals(e, t, { byDay: t.daily });
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
    labels: await rewardLabels(e.config),
    prizes: prizes.map((p) => ({ ...p, user: names.get(p.userId) ?? null, paid: done.has(`${p.userId}|${p.source}`) })),
  };
}

const coinsOf = (items: RewardItem[]) => items.reduce((n, i) => n + (i.type === "COINS" ? i.amount : 0), 0);

// Staff approve after the event ends: every prize not yet paid is paid now. Coins go to the wallet in one transaction
// with the payout records; then each other item is granted (a missing item is reported, never undoes the coins).
export async function approvePayouts(actor: User, id: string) {
  const e = await getEvent(id);
  if (phase(e) !== "ended") throw new AppError("EVENT_NOT_ENDED", 409, "Rewards can be approved once the event has ended");
  const prizes = await winners(e);
  const paid = await db.transaction(async (tx) => {
    const fresh: (Prize & { payoutId: number })[] = [];
    for (const p of prizes) {
      const [row] = await tx
        .insert(eventPayouts)
        .values({ eventId: id, userId: p.userId, source: p.source, reward: p.reward, approvedBy: actor.id })
        .onConflictDoNothing()
        .returning({ id: eventPayouts.id });
      if (!row) continue; // paid before
      fresh.push({ ...p, payoutId: row.id });
      const coins = coinsOf(p.reward.items);
      if (coins > 0) {
        await tx.insert(walletAccounts).values({ userId: p.userId, balance: 0 }).onConflictDoNothing();
        await tx
          .update(walletAccounts)
          .set({ balance: sql`${walletAccounts.balance} + ${coins}`, version: sql`${walletAccounts.version} + 1` })
          .where(eq(walletAccounts.userId, p.userId));
        await tx.insert(walletLedger).values({ userId: p.userId, entryType: "EVENT_REWARD", amount: coins, referenceType: "EVENT_PAYOUT", referenceId: String(row.id) });
      }
    }
    await tx.update(events).set({ paidOutAt: new Date() }).where(eq(events.id, id));
    return fresh;
  });
  const failed: string[] = [];
  for (const p of paid)
    for (const item of p.reward.items)
      if (item.type !== "COINS") await grantItem(p.userId, item, `event:${id}:${p.payoutId}`).catch(() => failed.push(`${p.why} (${item.type.toLowerCase()})`));
  return { paid: paid.length, failures: failed };
}

// ---------- repeating ----------

// The next period of a weekly or monthly event: it starts when this one ends and lasts a week, or to the same time next
// month (India time).
export function nextWindow(e: Pick<Event, "endsAt" | "repeat">) {
  const startsAt = e.endsAt;
  if (e.repeat === "WEEKLY") return { startsAt, endsAt: new Date(startsAt.getTime() + 7 * 86_400_000) };
  const ist = new Date(startsAt.getTime() + 5.5 * 3_600_000);
  ist.setUTCMonth(ist.getUTCMonth() + 1);
  return { startsAt, endsAt: new Date(ist.getTime() - 5.5 * 3_600_000) };
}

// Every minute: each ended weekly/monthly event opens its next period (same banner, page, boards, tasks and prizes;
// counting starts fresh). The ended one waits for reward approval as usual. Switch Repeat off to stop after a period.
export async function repeatEvents() {
  const due = await db
    .select()
    .from(events)
    .where(and(eq(events.published, true), ne(events.repeat, "NONE"), isNull(events.repeatedInto), lte(events.endsAt, sql`now()`)));
  for (const e of due)
    await db.transaction(async (tx) => {
      // Claim it first, so two servers never open the same next period.
      const [claimed] = await tx.update(events).set({ repeatedInto: e.id }).where(and(eq(events.id, e.id), isNull(events.repeatedInto))).returning({ id: events.id });
      if (!claimed) return;
      const { id: _id, createdAt: _c, paidOutAt: _p, repeatedInto: _r, ...copy } = e;
      const [next] = await tx.insert(events).values({ ...copy, ...nextWindow(e), config: normConfig(e.config) }).returning({ id: events.id });
      await tx.update(events).set({ repeatedInto: next!.id }).where(eq(events.id, e.id));
    });
}

export const runEventLoop = (ms = 60_000) =>
  setInterval(() => repeatEvents().catch((err) => console.error(JSON.stringify({ level: "error", msg: "event-repeat-failed", err: String(err) }))), ms);

// ---------- admin ----------

export async function getEvent(id: string) {
  const [e] = await db.select().from(events).where(eq(events.id, id));
  if (!e) throw new AppError("NOT_FOUND", 404, "No such event");
  return load(e);
}

export const listAllEvents = async () =>
  (await db.select().from(events).orderBy(desc(events.startsAt))).map((e) => ({ ...load(e), phase: phase(e) }));

// New boards/tasks get short ids; existing ones keep theirs (payouts refer to them).
export const withIds = (c: EventConfig): EventConfig => ({
  ...c,
  boards: c.boards.map((b) => ({ ...b, id: b.id || randomUUID().slice(0, 8) })),
  tasks: c.tasks.map((t) => ({ ...t, id: t.id || randomUUID().slice(0, 8) })),
});
