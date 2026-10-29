import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { rocketBets, rocketRounds, users, walletAccounts, walletLedger, type User } from "../db/schema";
import { io, userChannel } from "../io";
import { AppError, toSafeError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate } from "./auth";
import { announceWin } from "./gameWins";

// Crash game. The multiplier grows as e^(K·seconds) from 1.00x: 2x at ~9.9s, 10x at ~33s, 100x at ~66s.
// Multipliers are integers in hundredths (245 = 2.45x) so money math never touches floats beyond one floor().
export const K = 0.07;
export const BET_MS = Number(process.env.ROCKET_BET_MS ?? 8_000);
export const PAUSE_MS = 4_000; // after a crash, before the next round opens
export const MAX_BET = 1_000_000; // × the 50x cap must fit the int wallet columns
// The rocket never flies past 50x: a round that would go higher explodes at exactly 50.00x, and anyone still in loses.
// Targets below the cap keep the fixed 98% return; about 2% of rounds reach the cap.
export const CAP100 = 5_000;
export const RTP = 0.98;
export const CHIPS = [100, 1000, 10000, 100000] as const;
export const CHANNEL = "game:rocket";
export const clock = { now: () => Date.now() }; // tests move time; everything below reads the clock through this

// Fixed odds, decided before any bet. A cash-out at target T (hundredths) pays only if crash100 > T, and
// P(crash100 > T) = P(floor(98/u) ≥ T) = 98/T, so every target returns exactly 98% on average; 2% of rounds crash
// at 1.00x. (The +1 is what makes "> T" exact on the hundredths grid.) Never choose the crash point from what people bet.
export function drawCrash100() {
  const u = randomInt(1, 2 ** 32 + 1) / 2 ** 32; // uniform in (0, 1]
  return Math.min(CAP100, Math.max(100, Math.floor((RTP * 100) / u) + 1));
}
export const mult100At = (ms: number) => Math.floor(100 * Math.exp((K * Math.max(0, ms)) / 1000));
export const crashMs = (crash100: number) => (Math.log(crash100 / 100) / K) * 1000;
const commit = (salt: string, crash100: number) => createHash("sha256").update(`${salt}:${crash100}`).digest("hex");

// Two independent bet panels per player (slot 0 and 1), e.g. one on a safe auto cash-out and one riding higher.
const slot = z.number().int().min(0).max(1).default(0);
export const betSchema = z.object({
  roundId: z.number().int().positive(),
  slot,
  amount: z.number().int().min(1).max(MAX_BET),
  auto100: z.number().int().min(101).max(CAP100 - 1).nullish(), // auto cash-out target, below the cap so it can fire, e.g. 200 = 2.00x; the latest bet's value wins
});
export const cashOutSchema = z.object({ roundId: z.number().int().positive(), slot });
export const historySchema = z.object({ before: z.number().int().positive().optional() });

const balanceOf = async (userId: string) =>
  (await db.select({ b: walletAccounts.balance }).from(walletAccounts).where(eq(walletAccounts.userId, userId)))[0]?.b ?? 0;
const userCard = async (userId: string) =>
  (await db.select({ userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, userId)))[0];
const phaseOf = (r: { launchAt: Date; crashedAt: Date | null }) => (r.crashedAt ? "crashed" : clock.now() < r.launchAt.getTime() ? "betting" : "flying");

// The crash point and salt stay server-side until the round has crashed; only the hash is public before that.
const publicRound = (r: typeof rocketRounds.$inferSelect) => ({
  roundId: r.id,
  number: r.number,
  launchAt: r.launchAt,
  hash: r.hash,
  phase: phaseOf(r),
  ...(r.crashedAt ? { crash100: r.crash100, salt: r.salt } : {}),
});

async function roundPlayers(roundId: number) {
  return db
    .select({ userId: rocketBets.userId, slot: rocketBets.slot, displayName: users.displayName, avatarUrl: users.avatarUrl, amount: rocketBets.amount, cashed100: rocketBets.cashed100, payout: rocketBets.payout })
    .from(rocketBets)
    .innerJoin(users, eq(users.id, rocketBets.userId))
    .where(eq(rocketBets.roundId, roundId))
    .orderBy(desc(rocketBets.amount))
    .limit(50);
}

// Past crash points, newest first, a page at a time (pass the last roundId as `before`). Salt included so anyone can verify.
export async function history(before?: number, limit = 50) {
  const rows = await db
    .select({ roundId: rocketRounds.id, number: rocketRounds.number, crash100: rocketRounds.crash100, salt: rocketRounds.salt, hash: rocketRounds.hash, at: rocketRounds.crashedAt })
    .from(rocketRounds)
    .where(and(isNotNull(rocketRounds.crashedAt), before ? lt(rocketRounds.id, before) : undefined))
    .orderBy(desc(rocketRounds.id))
    .limit(limit + 1);
  return { rounds: rows.slice(0, limit), more: rows.length > limit };
}

// Everything the screen needs on open or reconnect.
export async function getState(userId: string) {
  const [round] = await db.select().from(rocketRounds).orderBy(desc(rocketRounds.id)).limit(1);
  const players = round ? await roundPlayers(round.id) : [];
  const totals = round
    ? (await db.select({ n: sql<number>`count(distinct ${rocketBets.userId})::int`, sum: sql<number>`coalesce(sum(${rocketBets.amount}), 0)::float8` }).from(rocketBets).where(eq(rocketBets.roundId, round.id)))[0]!
    : { n: 0, sum: 0 };
  const mine = round ? await db.select().from(rocketBets).where(and(eq(rocketBets.roundId, round.id), eq(rocketBets.userId, userId))) : [];
  return {
    me: userId,
    k: K,
    chips: CHIPS,
    maxBet: MAX_BET,
    cap100: CAP100,
    serverNow: new Date(clock.now()),
    round: round ? publicRound(round) : null,
    myBets: mine.map((b) => ({ slot: b.slot, amount: b.amount, auto100: b.auto100, cashed100: b.cashed100, payout: b.payout })),
    players,
    playerCount: totals.n,
    totalBet: totals.sum,
    balance: await balanceOf(userId),
    history: (await history(undefined, 20)).rounds.map(({ roundId, number, crash100 }) => ({ roundId, number, crash100 })),
  };
}

export async function placeBet(user: User, input: z.infer<typeof betSchema>) {
  assertCanParticipate(user);
  rateLimit(`rocket:${user.id}`, 40, 10_000);
  // shortcut: no idempotency key, and repeat bets add up, so the client must never auto-retry a bet.
  const result = await db.transaction(async (tx) => {
      // Lock order: round -> wallet. Settlement takes the round FOR UPDATE, so it waits for in-flight bets.
      const [round] = await tx.select().from(rocketRounds).where(and(eq(rocketRounds.id, input.roundId), isNull(rocketRounds.crashedAt))).for("share");
      if (!round || clock.now() >= round.launchAt.getTime()) throw new AppError("BETTING_CLOSED", 409, "Betting is closed for this round");
      const [wallet] = await tx
        .update(walletAccounts)
        .set({ balance: sql`${walletAccounts.balance} - ${input.amount}`, version: sql`${walletAccounts.version} + 1` })
        .where(and(eq(walletAccounts.userId, user.id), sql`${walletAccounts.balance} >= ${input.amount}`))
        .returning();
      if (!wallet) throw new AppError("INSUFFICIENT_COINS", 402);
      // Repeat bets on a panel add to its stake; the newest auto target applies to the whole stake.
      const [bet] = await tx
        .insert(rocketBets)
        .values({ roundId: round.id, userId: user.id, slot: input.slot, amount: input.amount, auto100: input.auto100 ?? null })
        .onConflictDoUpdate({
          target: [rocketBets.roundId, rocketBets.userId, rocketBets.slot],
          set: { amount: sql`${rocketBets.amount} + ${input.amount}`, auto100: input.auto100 ?? null },
        })
        .returning();
      if (bet!.amount > MAX_BET) throw new AppError("BET_LIMIT", 409, `Max ${MAX_BET.toLocaleString("en-IN")} coins per bet panel each round`); // rolls back
      await tx.insert(walletLedger).values({ userId: user.id, entryType: "ROCKET_BET", amount: -input.amount, referenceType: "ROCKET_ROUND", referenceId: String(round.id) });
      return { roundId: round.id, slot: input.slot, added: input.amount, amount: bet!.amount, auto100: bet!.auto100, balance: wallet.balance };
    });
  io.to(CHANNEL).emit("rocket:bet", { roundId: result.roundId, slot: result.slot, ...(await userCard(user.id)), added: result.added, amount: result.amount });
  return result;
}

// Cash out now, at the server's multiplier for this instant. Too late (at or past the crash point) is refused.
export async function cashOut(user: User, input: z.infer<typeof cashOutSchema>) {
  const now = clock.now();
  const result = await db.transaction(async (tx) => {
    const [round] = await tx.select().from(rocketRounds).where(eq(rocketRounds.id, input.roundId)).for("share");
    if (!round) throw new AppError("NOT_FOUND", 404);
    const elapsed = now - round.launchAt.getTime();
    if (elapsed < 0) throw new AppError("NOT_LAUNCHED", 409, "The rocket hasn't launched yet");
    let m = mult100At(elapsed);
    if (round.crashedAt || m >= round.crash100) throw new AppError("CRASHED", 409, "Too late, the rocket crashed");
    const [bet] = await tx
      .select()
      .from(rocketBets)
      .where(and(eq(rocketBets.roundId, round.id), eq(rocketBets.userId, user.id), eq(rocketBets.slot, input.slot), isNull(rocketBets.cashed100)))
      .for("update");
    if (!bet) throw new AppError("NO_ACTIVE_BET", 409, "No bet to cash out");
    if (bet.auto100 && bet.auto100 <= m) m = bet.auto100; // auto cash-out already fired on the way up; pay at its target
    const payout = Math.floor((bet.amount * m) / 100);
    await tx.update(rocketBets).set({ cashed100: m, payout }).where(and(eq(rocketBets.roundId, round.id), eq(rocketBets.userId, user.id), eq(rocketBets.slot, input.slot)));
    const [w] = await tx
      .update(walletAccounts)
      .set({ balance: sql`${walletAccounts.balance} + ${payout}`, version: sql`${walletAccounts.version} + 1` })
      .where(eq(walletAccounts.userId, user.id))
      .returning({ balance: walletAccounts.balance });
    await tx.insert(walletLedger).values({ userId: user.id, entryType: "ROCKET_WIN", amount: payout, referenceType: "ROCKET_ROUND", referenceId: String(round.id) });
    return { roundId: round.id, slot: input.slot, multiplier100: m, payout, balance: w!.balance };
  });
  io.to(CHANNEL).emit("rocket:cashout", { roundId: result.roundId, slot: result.slot, ...(await userCard(user.id)), multiplier100: result.multiplier100, payout: result.payout });
  announceWin(user.id, "rocket", result.payout);
  return result;
}

// `forcedCrash100` is for tests only.
export async function openRound(forcedCrash100?: number) {
  const crash100 = forcedCrash100 ?? drawCrash100();
  const salt = randomBytes(16).toString("hex");
  // Only the rocket loop inserts rounds, so max + 1 cannot race (the unique index would catch it if it did).
  const number = sql<number>`(select coalesce(max(${rocketRounds.number}), 0) + 1 from ${rocketRounds})`;
  const [round] = await db
    .insert(rocketRounds)
    .values({ number, crash100, salt, hash: commit(salt, crash100), launchAt: new Date(clock.now() + BET_MS) })
    .returning();
  io.to(CHANNEL).emit("rocket:round", { ...publicRound(round!), serverNow: new Date(clock.now()) });
  return round!;
}

// Ends the flight: auto cash-outs below the crash point are paid at their target, everyone else still in loses.
// A second call on the same round is a no-op.
export async function crashRound(roundId: number) {
  return db.transaction(async (tx) => {
    const [round] = await tx.select().from(rocketRounds).where(eq(rocketRounds.id, roundId)).for("update");
    if (!round || round.crashedAt) return null;
    const autos = await tx
      .select()
      .from(rocketBets)
      .where(and(eq(rocketBets.roundId, roundId), isNull(rocketBets.cashed100), sql`${rocketBets.auto100} < ${round.crash100}`))
      .orderBy(asc(rocketBets.userId), asc(rocketBets.slot)); // fixed wallet lock order
    const winners: { userId: string; slot: number; multiplier100: number; payout: number; balance: number }[] = [];
    for (const b of autos) {
      const payout = Math.floor((b.amount * b.auto100!) / 100);
      await tx.update(rocketBets).set({ cashed100: b.auto100, payout }).where(and(eq(rocketBets.roundId, roundId), eq(rocketBets.userId, b.userId), eq(rocketBets.slot, b.slot)));
      const [w] = await tx
        .update(walletAccounts)
        .set({ balance: sql`${walletAccounts.balance} + ${payout}`, version: sql`${walletAccounts.version} + 1` })
        .where(eq(walletAccounts.userId, b.userId))
        .returning({ balance: walletAccounts.balance });
      await tx.insert(walletLedger).values({ userId: b.userId, entryType: "ROCKET_WIN", amount: payout, referenceType: "ROCKET_ROUND", referenceId: String(roundId) });
      winners.push({ userId: b.userId, slot: b.slot, multiplier100: b.auto100!, payout, balance: w!.balance });
    }
    const [crashed] = await tx.update(rocketRounds).set({ crashedAt: new Date(clock.now()) }).where(eq(rocketRounds.id, roundId)).returning();
    return { round: crashed!, winners };
  });
}

export async function crashAndAnnounce(roundId: number) {
  const result = await crashRound(roundId);
  if (!result) return null;
  for (const w of result.winners) {
    io.to(userChannel(w.userId)).emit("rocket:win", { roundId, slot: w.slot, multiplier100: w.multiplier100, payout: w.payout, balance: w.balance });
    announceWin(w.userId, "rocket", w.payout);
    io.to(CHANNEL).emit("rocket:cashout", { roundId, slot: w.slot, ...(await userCard(w.userId)), multiplier100: w.multiplier100, payout: w.payout, auto: true });
  }
  io.to(CHANNEL).emit("rocket:crash", { ...publicRound(result.round), nextAt: new Date(clock.now() + PAUSE_MS) });
  return result;
}

// The day runs midnight to midnight in India; a round counts on the day it started.
const DAY_TZ = "Asia/Kolkata";
const LEADERBOARD_SIZE = 100;
export async function todayLeaderboard(userId: string) {
  const dayStart = sql`(date_trunc('day', now() at time zone ${DAY_TZ}) at time zone ${DAY_TZ})`;
  const { rows } = await db.execute<{ userId: string; displayName: string | null; avatarUrl: string | null; won: number; rank: number }>(sql`
    with totals as (
      select b.user_id, coalesce(sum(b.payout), 0)::float8 as won
      from ${rocketBets} b join ${rocketRounds} r on r.id = b.round_id
      where r.created_at >= ${dayStart}
      group by b.user_id
    ), ranked as (select *, rank() over (order by won desc)::int as rank from totals)
    select ranked.user_id as "userId", u.display_name as "displayName", u.avatar_url as "avatarUrl", ranked.won, ranked.rank
    from ranked join ${users} u on u.id = ranked.user_id
    where ranked.rank <= ${LEADERBOARD_SIZE} or ranked.user_id = ${userId}
    order by ranked.rank, ranked.user_id`);
  const [{ resetsAt, players }] = (
    await db.execute<{ resetsAt: Date; players: number }>(sql`
      select (${dayStart} + interval '1 day') as "resetsAt",
        (select count(distinct b.user_id)::int from ${rocketBets} b join ${rocketRounds} r on r.id = b.round_id where r.created_at >= ${dayStart}) as players`)
  ).rows as [{ resetsAt: Date; players: number }];
  return { players, resetsAt, rows: rows.filter((r) => r.rank <= LEADERBOARD_SIZE).slice(0, LEADERBOARD_SIZE), me: rows.find((r) => r.userId === userId) ?? null };
}

// shortcut: the loop runs in this process, so only one server instance may run it; elect a leader before scaling out.
// Each pass finishes the open round if there is one (e.g. after a restart, so its bets still fly and settle), else opens a new one.
export async function runRocketLoop() {
  for (;;) {
    try {
      const [open] = await db.select().from(rocketRounds).where(isNull(rocketRounds.crashedAt)).orderBy(asc(rocketRounds.id)).limit(1);
      const round = open ?? (await openRound());
      const launchIn = round.launchAt.getTime() - clock.now();
      if (launchIn > 0) {
        await Bun.sleep(launchIn);
        io.to(CHANNEL).emit("rocket:launch", { roundId: round.id, launchAt: round.launchAt, serverNow: new Date(clock.now()) });
      }
      await Bun.sleep(Math.max(0, round.launchAt.getTime() + crashMs(round.crash100) - clock.now()));
      await crashAndAnnounce(round.id);
      await Bun.sleep(PAUSE_MS);
    } catch (e) {
      toSafeError(e); // logs; keep the game alive
      await Bun.sleep(5_000);
    }
  }
}
