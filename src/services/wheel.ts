import { randomInt, randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { rooms, users, walletAccounts, walletLedger, type User } from "../db/schema";
import { emitToRoom, io } from "../io";
import { AppError, toSafeError } from "../lib/errors";
import { cancel as cancelRound, endsAt, FEES, finish, GAP_MS, idleState, join as joinRound, leave as leaveRound, LOBBY_MS, MAX_PLAYERS, MIN_PLAYERS, open, RuleError, SPIN_MS, start as startRound, winnerOf, type WheelState } from "../lib/wheel";
import { assertGamesOn } from "./flags";
import { assertMember, assertRoomAdmin, getRoom, systemMessage, userSummary } from "./rooms";

// Wheel mode for a room: an elimination wheel people pay into (see lib/wheel.ts). The coins move only here, and every
// move commits in one transaction with the room's wheel state, so a crash can't leave a fee taken but not recorded (or
// paid twice). The ledger rows: WHEEL_BET (a fee in), WHEEL_REFUND (a fee back), WHEEL_WIN (the payout), all with
// reference WHEEL_ROUND <round id>. The house cut is simply never paid out.
//
// shortcut: state lives in memory (written through to rooms.wheel) with one in-process clock, so this is only correct
// with one server instance; move the clock to a shared scheduler before scaling out.

export const channel = (roomId: string) => `wheel:${roomId}`;
export const feeSchema = z.object({ fee: z.number().int() });

const games = new Map<string, WheelState>();
const queues = new Map<string, Promise<unknown>>();
function serial<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(roomId) ?? Promise.resolve()).then(fn, fn);
  queues.set(roomId, run.catch(() => {}));
  return run;
}

const view = (roomId: string, s: WheelState | null) => ({ roomId, state: s, serverNow: new Date() });
type Move = { userId: string; amount: number; type: "BET" | "REFUND" | "WIN" };

async function load(roomId: string) {
  if (games.has(roomId)) return games.get(roomId)!;
  const room = await getRoom(roomId);
  if (room.wheel) games.set(roomId, room.wheel);
  return room.wheel;
}

// Moves the coins and saves the state in one transaction, then tells everyone. A fee needs the coins (else nothing
// happens and INSUFFICIENT_COINS is thrown).
async function commit(roomId: string, next: WheelState | null, moves: Move[] = []) {
  const roundId = next?.round?.id ?? games.get(roomId)?.round?.id ?? "none";
  const balances = new Map<string, number>();
  await db.transaction(async (tx) => {
    for (const m of moves) {
      const [w] = await tx
        .update(walletAccounts)
        .set({ balance: sql`${walletAccounts.balance} + ${m.amount}`, version: sql`${walletAccounts.version} + 1` })
        .where(and(eq(walletAccounts.userId, m.userId), m.amount < 0 ? sql`${walletAccounts.balance} >= ${-m.amount}` : undefined))
        .returning({ balance: walletAccounts.balance });
      if (!w) throw new AppError("INSUFFICIENT_COINS", 402, "Not enough coins");
      await tx.insert(walletLedger).values({ userId: m.userId, entryType: `WHEEL_${m.type}`, amount: m.amount, referenceType: "WHEEL_ROUND", referenceId: roundId });
      balances.set(m.userId, w.balance);
    }
    await tx.update(rooms).set({ wheel: next }).where(eq(rooms.id, roomId));
  });
  if (next) games.set(roomId, next);
  else games.delete(roomId);
  io.to(channel(roomId)).emit("wheel:state", view(roomId, next));
  return { state: next, balances };
}

const need = async (roomId: string) => {
  const s = await load(roomId);
  if (!s) throw new AppError("WHEEL_OFF", 409, "The wheel isn't on in this room");
  return s;
};

function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RuleError) throw new AppError("WHEEL_NOT_ALLOWED", 409, e.message);
    throw e;
  }
}

const refunds = (s: WheelState): Move[] => (s.round ? s.round.players.map((p) => ({ userId: p.userId, amount: s.round!.fee, type: "REFUND" as const })) : []);
const balanceOf = async (userId: string) => (await db.select({ b: walletAccounts.balance }).from(walletAccounts).where(eq(walletAccounts.userId, userId)))[0]?.b ?? 0;

// ---------- mode ----------

export async function setMode(actor: User, roomId: string, on: boolean) {
  await assertRoomAdmin(roomId, actor.id);
  if (on) await assertGamesOn();
  const room = await getRoom(roomId);
  if (room.kind === "LIVE") throw new AppError("WHEEL_NOT_IN_LIVE", 400, "The wheel is for audio rooms");
  for (const [k, label] of [["ludo", "Ludo"], ["pool", "8 Ball Pool"], ["draw", "Draw & Guess"], ["mafia", "Mafia"], ["chess", "Chess"], ["karaoke", "Karaoke"], ["video", "Video mode"]] as const) {
    if (on && room[k]) throw new AppError(`${k.toUpperCase()}_ON`, 409, `Turn off ${label} first`);
  }
  const changed = await serial(roomId, async () => {
    const cur = await load(roomId);
    if (!!cur === on) return false;
    if (on) await commit(roomId, idleState());
    else if (cur?.phase === "spinning") throw new AppError("WHEEL_SPINNING", 409, "Wait for the wheel to finish");
    else await commit(roomId, null, cur?.phase === "lobby" ? refunds(cur) : []); // an open round is refunded
    return true;
  });
  if (changed) {
    emitToRoom(roomId, "room:wheel", { roomId, on });
    await systemMessage(roomId, on ? `${actor.displayName} switched the room to Wheel. Join a round and be the last one standing!` : `${actor.displayName} turned the Wheel off`, { kind: "WHEEL", userId: actor.id });
  }
  return { on };
}

export async function watch(user: User, roomId: string) {
  await assertMember(roomId, user.id);
  const admin = await assertRoomAdmin(roomId, user.id).then(() => true, () => false);
  return { ...view(roomId, await load(roomId)), me: { userId: user.id, admin }, balance: await balanceOf(user.id), fees: FEES, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, spinMs: SPIN_MS, gapMs: GAP_MS };
}

// ---------- a round ----------

export async function openRound(actor: User, roomId: string, fee: number) {
  await assertRoomAdmin(roomId, actor.id);
  await assertGamesOn();
  const s = await serial(roomId, async () => {
    const cur = await need(roomId);
    return (await commit(roomId, rule(() => open(cur, randomUUID(), fee, Date.now())))).state;
  });
  await systemMessage(roomId, `🎡 A wheel round is open: ${fee.toLocaleString("en-IN")} coins to join, 2-10 players. Last one standing takes the pot!`, { kind: "WHEEL", userId: actor.id });
  return s;
}

export async function join(user: User, roomId: string) {
  await assertMember(roomId, user.id);
  await assertGamesOn();
  const [me] = await db.select({ userId: userSummary.userId, displayName: userSummary.displayName, avatarUrl: userSummary.avatarUrl }).from(users).where(eq(users.id, user.id));
  return serial(roomId, async () => {
    const s = await need(roomId);
    const n = rule(() => joinRound(s, me!));
    const r = await commit(roomId, n, [{ userId: user.id, amount: -n.round!.fee, type: "BET" }]);
    return { balance: r.balances.get(user.id) };
  });
}

export async function leave(user: User, roomId: string) {
  return serial(roomId, async () => {
    const s = await need(roomId);
    const n = rule(() => leaveRound(s, user.id));
    const r = await commit(roomId, n, [{ userId: user.id, amount: s.round!.fee, type: "REFUND" }]);
    return { balance: r.balances.get(user.id) };
  });
}

export async function spin(actor: User, roomId: string) {
  await assertRoomAdmin(roomId, actor.id);
  const s = await serial(roomId, async () => {
    const cur = await need(roomId);
    return (await commit(roomId, rule(() => startRound(cur, Date.now(), randomInt)))).state;
  });
  const r = s!.round!;
  await systemMessage(roomId, `🎡 The wheel is spinning! ${r.players.length} players, ${r.payout.toLocaleString("en-IN")} coins to the last one standing.`, { kind: "WHEEL", userId: actor.id });
  return s;
}

export async function cancel(actor: User, roomId: string) {
  await assertRoomAdmin(roomId, actor.id);
  return serial(roomId, async () => {
    const s = await need(roomId);
    return (await commit(roomId, rule(() => cancelRound(s)), refunds(s))).state;
  });
}

// ---------- the clock ----------

// The last spin ended: pay the winner. A round left unspun too long: cancel and refund it.
const settle = (roomId: string, now: number) =>
  serial(roomId, async () => {
    const s = games.get(roomId);
    const r = s?.round;
    if (!s || !r) return;
    if (s.phase === "spinning" && !r.paid && endsAt(r) <= now) {
      const winner = winnerOf(r)!;
      await commit(roomId, finish(s), [{ userId: winner, amount: r.payout, type: "WIN" }]);
      const name = r.players.find((p) => p.userId === winner)?.displayName ?? "Someone";
      await systemMessage(roomId, `🏆 ${name} won the wheel and takes ${r.payout.toLocaleString("en-IN")} coins!`, { kind: "WHEEL", userId: winner });
    } else if (s.phase === "lobby" && Date.parse(r.openedAt) + LOBBY_MS <= now) {
      await commit(roomId, cancelRound(s), refunds(s));
      await systemMessage(roomId, "🎡 The wheel round wasn't spun in time, so it was cancelled and everyone got their coins back.", { kind: "WHEEL", userId: null });
    }
  });

export async function tick(now = Date.now()) {
  for (const [roomId, s] of games) {
    const r = s.round;
    if (r && ((s.phase === "spinning" && !r.paid && endsAt(r) <= now) || (s.phase === "lobby" && Date.parse(r.openedAt) + LOBBY_MS <= now))) await settle(roomId, now).catch(toSafeError);
  }
}

// On boot: every room in Wheel mode. A round that finished spinning while the server was down is paid on the first tick.
export async function runWheelLoop() {
  for (const r of await db.select({ id: rooms.id, wheel: rooms.wheel }).from(rooms).where(isNotNull(rooms.wheel))) games.set(r.id, r.wheel!);
  setInterval(() => tick().catch(toSafeError), 500);
}
