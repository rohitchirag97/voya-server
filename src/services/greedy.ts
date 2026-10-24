import { randomInt } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { greedyBets, greedyRounds, users, walletAccounts, walletLedger, type User } from "../db/schema";
import { io, userChannel } from "../io";
import { AppError, toSafeError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate } from "./auth";
import { announceWin } from "./gameWins";

// The 8 things you can bet on. A winning item always pays its own multiplier; weight is how often it wins alone.
// Ids are stored in bets and results, so names/art can change freely but ids and odds must not.
export const ITEMS = [
  { id: 0, mult: 5, weight: 1945 },
  { id: 1, mult: 5, weight: 1945 },
  { id: 2, mult: 5, weight: 1945 },
  { id: 3, mult: 5, weight: 1945 },
  { id: 4, mult: 10, weight: 967 },
  { id: 5, mult: 15, weight: 640 },
  { id: 6, mult: 25, weight: 379 },
  { id: 7, mult: 45, weight: 205 },
] as const;

// What a round can land on: one item, or a special where a whole group wins at once. Stored in greedy_rounds.result_item.
// Fixed odds: for every item, (its own weight + its special's weight) / total × mult ≈ 98% back, so no item is a
// better bet than another. Specials hit about 1 round in 357. Never pick the result from what people bet.
export const OUTCOMES = [
  ...ITEMS.map((i) => ({ id: i.id, wins: [i.id] as number[], weight: i.weight, special: false })),
  { id: 8, wins: [0, 1, 2, 3], weight: 15, special: true }, // all ×5 items win
  { id: 9, wins: [4, 5, 6, 7], weight: 13, special: true }, // all big items win
];
const TOTAL_WEIGHT = OUTCOMES.reduce((s, o) => s + o.weight, 0);

// Each game is a skin over the same odds, with its own rounds, history and leaderboard. Names by item id, then the two specials.
export const GAMES = {
  jungle: {
    names: ["Rabbit", "Monkey", "Parrot", "Turtle", "Zebra", "Elephant", "Rhino", "Lion"],
    specials: [{ name: "Meadow", blurb: "All small animals win" }, { name: "Kingdom", blurb: "All big animals win" }],
  },
  galaxy: {
    names: ["Mercury", "Venus", "Earth", "Mars", "Neptune", "Uranus", "Jupiter", "Saturn"],
    specials: [{ name: "Inner Orbit", blurb: "All inner planets win" }, { name: "Giants", blurb: "All giant planets win" }],
  },
} as const;
export type Game = keyof typeof GAMES;
export const gameSchema = z.enum(["jungle", "galaxy"]).default("jungle");
export const channel = (game: Game) => `game:greedy:${game}`;
export const CHIPS = [10, 100, 1000, 10000] as const; // quick picks; any amount from 1 to MAX_ITEM_BET is allowed
// Per user, per animal, per round. ×45 of this must fit the int wallet columns.
export const MAX_ITEM_BET = 1_000_000;
export const BET_MS = Number(process.env.GREEDY_BET_MS ?? 30_000);
export const REVEAL_MS = 10_000; // spin animation + winners board before the next round
const WINNERS_SHOWN = 50;

export const betSchema = z.object({
  roundId: z.number().int().positive(),
  item: z.number().int().min(0).max(ITEMS.length - 1),
  amount: z.number().int().min(1).max(MAX_ITEM_BET),
});

export function draw() {
  let r = randomInt(TOTAL_WEIGHT);
  return OUTCOMES.find((o) => (r -= o.weight) < 0)!;
}

const balanceOf = async (userId: string) =>
  (await db.select({ b: walletAccounts.balance }).from(walletAccounts).where(eq(walletAccounts.userId, userId)))[0]?.b ?? 0;

export const historySchema = z.object({ before: z.number().int().positive().optional(), game: gameSchema });

// Past results of one game, newest first, a page at a time: pass the last roundId you have as `before` for the next page.
export async function history(before?: number, limit = 50, game: Game = "jungle") {
  const rows = await db
    .select({ roundId: greedyRounds.id, number: greedyRounds.number, item: greedyRounds.resultItem, at: greedyRounds.settledAt })
    .from(greedyRounds)
    .where(and(eq(greedyRounds.game, game), isNotNull(greedyRounds.settledAt), before ? lt(greedyRounds.id, before) : undefined))
    .orderBy(desc(greedyRounds.id))
    .limit(limit + 1);
  return { rounds: rows.slice(0, limit), more: rows.length > limit };
}

// Everything the game screen needs on open or reconnect, named for the given game.
export async function getState(userId: string, game: Game = "jungle") {
  const skin = GAMES[game];
  const [round] = await db
    .select()
    .from(greedyRounds)
    .where(and(eq(greedyRounds.game, game), isNull(greedyRounds.settledAt)))
    .orderBy(desc(greedyRounds.id))
    .limit(1);
  const myBets = round
    ? await db
        .select({ item: greedyBets.item, amount: greedyBets.amount })
        .from(greedyBets)
        .where(and(eq(greedyBets.roundId, round.id), eq(greedyBets.userId, userId)))
    : [];
  return {
    game,
    items: ITEMS.map(({ id, mult }) => ({ id, mult, name: skin.names[id] })),
    outcomes: OUTCOMES.map(({ weight, ...o }) =>
      o.special ? { ...o, ...skin.specials[o.id - ITEMS.length]! } : { ...o, name: skin.names[o.id] },
    ),
    chips: CHIPS,
    maxBet: MAX_ITEM_BET,
    me: userId,
    round: round ? { roundId: round.id, number: round.number, betEndsAt: round.betEndsAt } : null,
    serverNow: new Date(),
    myBets,
    balance: await balanceOf(userId),
    history: (await history(undefined, 20, game)).rounds,
  };
}

// The day runs midnight to midnight in India; nothing is deleted, "today" is just the rounds started since 12 AM.
const DAY_TZ = "Asia/Kolkata";
const LEADERBOARD_SIZE = 100;

// Everyone who bet today in this game, ranked by what they won today. A round counts on the day it started.
export async function todayLeaderboard(userId: string, game: Game = "jungle") {
  // Built from constants only, so safe to inline: each animal's multiplier, and "this bet won" for every outcome.
  const mults = sql.raw(`(array[${ITEMS.map((i) => i.mult).join(",")}])`);
  const betWon = sql.raw(OUTCOMES.map((o) => `(r.result_item = ${o.id} and b.item in (${o.wins.join(",")}))`).join(" or "));
  const dayStart = sql`(date_trunc('day', now() at time zone ${DAY_TZ}) at time zone ${DAY_TZ})`;
  const { rows } = await db.execute<{ userId: string; displayName: string | null; avatarUrl: string | null; won: number; bet: number; rank: number }>(sql`
    with totals as (
      select b.user_id,
        sum(b.amount)::float8 as bet,
        coalesce(sum(b.amount::bigint * ${mults}[b.item + 1]) filter (where ${betWon}), 0)::float8 as won
      from ${greedyBets} b join ${greedyRounds} r on r.id = b.round_id
      where r.game = ${game} and r.created_at >= ${dayStart}
      group by b.user_id
    ), ranked as (select *, rank() over (order by won desc)::int as rank from totals)
    select ranked.user_id as "userId", u.display_name as "displayName", u.avatar_url as "avatarUrl", ranked.won, ranked.bet, ranked.rank
    from ranked join ${users} u on u.id = ranked.user_id
    where ranked.rank <= ${LEADERBOARD_SIZE} or ranked.user_id = ${userId}
    order by ranked.rank, ranked.user_id`);
  const [{ resetsAt, players }] = (
    await db.execute<{ resetsAt: Date; players: number }>(sql`
      select (${dayStart} + interval '1 day') as "resetsAt",
        (select count(distinct b.user_id)::int from ${greedyBets} b join ${greedyRounds} r on r.id = b.round_id where r.game = ${game} and r.created_at >= ${dayStart}) as players`)
  ).rows as [{ resetsAt: Date; players: number }];
  const top = rows.filter((r) => r.rank <= LEADERBOARD_SIZE).slice(0, LEADERBOARD_SIZE);
  return { players, resetsAt, rows: top, me: rows.find((r) => r.userId === userId) ?? null };
}

export async function placeBet(user: User, input: z.infer<typeof betSchema>) {
  assertCanParticipate(user);
  rateLimit(`greedy:${user.id}`, 30, 10_000);
  // shortcut: no idempotency key, so the client must never auto-retry a bet; add one if a retry path is ever built.
  return db.transaction(async (tx) => {
    // Lock order: round -> wallet. Settlement takes the round FOR UPDATE, so it waits for in-flight bets,
    // and a bet that waited re-checks settled_at and is refused.
    const [round] = await tx
      .select({ id: greedyRounds.id })
      .from(greedyRounds)
      .where(and(eq(greedyRounds.id, input.roundId), isNull(greedyRounds.settledAt), gt(greedyRounds.betEndsAt, sql`now()`)))
      .for("share");
    if (!round) throw new AppError("BETTING_CLOSED", 409, "Betting is closed for this round");

    const [wallet] = await tx
      .update(walletAccounts)
      .set({ balance: sql`${walletAccounts.balance} - ${input.amount}`, version: sql`${walletAccounts.version} + 1` })
      .where(and(eq(walletAccounts.userId, user.id), gte(walletAccounts.balance, input.amount)))
      .returning();
    if (!wallet) throw new AppError("INSUFFICIENT_COINS", 402);

    const [bet] = await tx
      .insert(greedyBets)
      .values({ roundId: round.id, userId: user.id, item: input.item, amount: input.amount })
      .onConflictDoUpdate({ target: [greedyBets.roundId, greedyBets.userId, greedyBets.item], set: { amount: sql`${greedyBets.amount} + ${input.amount}` } })
      .returning();
    if (bet!.amount > MAX_ITEM_BET) throw new AppError("BET_LIMIT", 409, `Max ${MAX_ITEM_BET.toLocaleString("en-IN")} coins per pick each round`); // rolls back the debit
    await tx
      .insert(walletLedger)
      .values({ userId: user.id, entryType: "GREEDY_BET", amount: -input.amount, referenceType: "GREEDY_ROUND", referenceId: String(round.id) });
    return { roundId: round.id, item: bet!.item, itemTotal: bet!.amount, balance: wallet.balance };
  });
}

export async function openRound(game: Game = "jungle") {
  // Round numbers count per game. Only this game's loop inserts its rounds, so max + 1 cannot race (the unique index would catch it if it did).
  const number = sql<number>`(select coalesce(max(${greedyRounds.number}), 0) + 1 from ${greedyRounds} where ${greedyRounds.game} = ${game})`;
  const [round] = await db.insert(greedyRounds).values({ game, number, betEndsAt: new Date(Date.now() + BET_MS) }).returning();
  io.to(channel(game)).emit("greedy:round", { roundId: round!.id, number: round!.number, betEndsAt: round!.betEndsAt, serverNow: new Date() });
  return round!;
}

// Draws the result and pays every winner in one transaction; a second call on the same round is a no-op.
// forcedOutcome is for tests only.
export async function settleRound(roundId: number, forcedOutcome?: number) {
  return db.transaction(async (tx) => {
    const [round] = await tx.select().from(greedyRounds).where(eq(greedyRounds.id, roundId)).for("update");
    if (!round || round.settledAt) return null;
    const outcome = forcedOutcome === undefined ? draw() : OUTCOMES[forcedOutcome]!;
    const bets = await tx
      .select({ userId: greedyBets.userId, item: greedyBets.item, amount: greedyBets.amount })
      .from(greedyBets)
      .where(and(eq(greedyBets.roundId, roundId), inArray(greedyBets.item, outcome.wins)))
      .orderBy(asc(greedyBets.userId)); // fixed wallet lock order

    // A special can pay one player on several animals; they get one credit for the total.
    const payouts = new Map<string, number>();
    for (const b of bets) payouts.set(b.userId, (payouts.get(b.userId) ?? 0) + b.amount * ITEMS[b.item]!.mult);

    const winners: { userId: string; payout: number; balance: number }[] = [];
    for (const [userId, payout] of payouts) {
      const [w] = await tx
        .update(walletAccounts)
        .set({ balance: sql`${walletAccounts.balance} + ${payout}`, version: sql`${walletAccounts.version} + 1` })
        .where(eq(walletAccounts.userId, userId))
        .returning({ balance: walletAccounts.balance });
      await tx.insert(walletLedger).values({ userId, entryType: "GREEDY_WIN", amount: payout, referenceType: "GREEDY_ROUND", referenceId: String(roundId) });
      winners.push({ userId, payout, balance: w!.balance });
    }
    await tx.update(greedyRounds).set({ resultItem: outcome.id, settledAt: sql`now()` }).where(eq(greedyRounds.id, roundId));
    return { roundId, number: round.number, game: round.game as Game, item: outcome.id, wins: outcome.wins, winners };
  });
}

export async function settleAndAnnounce(roundId: number, forcedOutcome?: number) {
  const result = await settleRound(roundId, forcedOutcome);
  if (!result) return;
  const top = result.winners.toSorted((a, b) => b.payout - a.payout).slice(0, WINNERS_SHOWN);
  const names = top.length
    ? await db.select({ userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(inArray(users.id, top.map((w) => w.userId)))
    : [];
  // Personal wins first, so the screen knows "you won" by the time the spin lands.
  for (const w of result.winners) {
    io.to(userChannel(w.userId)).emit("greedy:win", { roundId, payout: w.payout, balance: w.balance });
    announceWin(w.userId, result.game, w.payout);
  }
  io.to(channel(result.game)).emit("greedy:result", {
    roundId,
    number: result.number, // per-game round number shown to players
    item: result.item, // outcome id: an item 0–7, or 8 / 9 for the two specials
    wins: result.wins, // the items that paid
    nextAt: new Date(Date.now() + REVEAL_MS),
    // Biggest wins first; the list is capped, the totals are not.
    winners: top.map((w) => ({ ...names.find((n) => n.userId === w.userId), userId: w.userId, payout: w.payout })),
    winnerCount: result.winners.length,
    totalPayout: result.winners.reduce((s, w) => s + w.payout, 0),
  });
}

// shortcut: the loops run in this process, so only one server instance may run them; elect a leader (or a DB advisory lock) before scaling out.
export async function runGreedyLoop() {
  // Rounds a crash left open (any game) are settled now; their bets are honored.
  for (const r of await db.select({ id: greedyRounds.id }).from(greedyRounds).where(isNull(greedyRounds.settledAt))) {
    await settleAndAnnounce(r.id).catch(toSafeError);
  }
  await Promise.all((Object.keys(GAMES) as Game[]).map(runGame));
}

// One endless round loop per game; the games run side by side, independently.
async function runGame(game: Game) {
  for (;;) {
    try {
      // A round whose settle failed (crash, DB hiccup) would otherwise hold its bets until a restart: finish it first.
      const stale = await db
        .select({ id: greedyRounds.id })
        .from(greedyRounds)
        .where(and(eq(greedyRounds.game, game), isNull(greedyRounds.settledAt), lt(greedyRounds.betEndsAt, sql`now()`)));
      for (const r of stale) await settleAndAnnounce(r.id);
      const round = await openRound(game);
      await Bun.sleep(Math.max(0, round.betEndsAt.getTime() - Date.now()));
      await settleAndAnnounce(round.id);
      await Bun.sleep(REVEAL_MS);
    } catch (e) {
      toSafeError(e); // logs; keep the game alive
      await Bun.sleep(5_000);
    }
  }
}
