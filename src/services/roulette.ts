import { randomInt } from "node:crypto";
import { z } from "zod";
import { type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { isKey, settle } from "../lib/roulette";
import { assertCanParticipate } from "./auth";
import { announceWin } from "./gameWins";
import { balanceOf, settlePlay } from "./instantGame";

// Roulette (European, one zero): each spin is played alone and settled at once (rules in lib/roulette.ts).
// Ledger rows ROULETTE_BET (all chips on the table) / ROULETTE_WIN reference the spin id (services/instantGame.ts).
export const CHIPS = [100, 1000, 10000, 100000] as const;
export const MAX_TOTAL = 500_000; // per spin; × 36 for a straight-up win must fit the int wallet columns
export const spinSchema = z.object({
  bets: z
    .array(z.object({ key: z.string().refine(isKey, "Unknown bet"), amount: z.number().int().min(1).max(MAX_TOTAL) }))
    .min(1)
    .max(60),
});

export async function getState(userId: string) {
  return { chips: CHIPS, maxTotal: MAX_TOTAL, balance: await balanceOf(userId) };
}

export async function spin(user: User, input: z.infer<typeof spinSchema>) {
  assertCanParticipate(user);
  rateLimit(`roulette:${user.id}`, 20, 10_000);
  const stake = input.bets.reduce((s, b) => s + b.amount, 0);
  if (stake > MAX_TOTAL) throw new AppError("BET_LIMIT", 409, `Max ${MAX_TOTAL.toLocaleString("en-IN")} coins on the table per spin`);
  // shortcut: no idempotency key, so the client must never auto-retry a spin.
  const number = randomInt(37);
  const { payout, keys } = settle(input.bets, number);
  const { playId, balance } = await settlePlay(user.id, "ROULETTE", stake, payout);
  if (payout) announceWin(user.id, "roulette", payout);
  return { spinId: playId, number, stake, payout, won: keys, balance };
}
