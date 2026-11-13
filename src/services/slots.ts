import { randomInt } from "node:crypto";
import { z } from "zod";
import { type User } from "../db/schema";
import { rateLimit } from "../lib/rateLimit";
import { drawReels, MAX_MULT, multiplier, PAYS, rtp, SYMBOLS, TWO_CHERRIES } from "../lib/slots";
import { assertCanParticipate } from "./auth";
import { announceWin } from "./gameWins";
import { balanceOf, settlePlay } from "./instantGame";

// Slot machine: each spin is played alone, start to finish, in one transaction (rules in lib/slots.ts).
// Ledger rows SLOT_BET / SLOT_WIN reference the spin id (services/instantGame.ts).
export const CHIPS = [100, 1000, 10000, 100000] as const;
export const MAX_BET = 100_000; // × the 500x top prize must fit the int wallet columns
export const spinSchema = z.object({ amount: z.number().int().min(1).max(MAX_BET) });

export async function getState(userId: string) {
  return { chips: CHIPS, maxBet: MAX_BET, symbols: SYMBOLS, pays: PAYS, twoCherries: TWO_CHERRIES, maxMult: MAX_MULT, rtp: rtp(), balance: await balanceOf(userId) };
}

export async function spin(user: User, input: z.infer<typeof spinSchema>) {
  assertCanParticipate(user);
  rateLimit(`slot:${user.id}`, 20, 10_000);
  // shortcut: no idempotency key, so the client must never auto-retry a spin.
  const reels = drawReels(randomInt);
  const mult = multiplier(reels);
  const payout = input.amount * mult;
  const { playId, balance } = await settlePlay(user.id, "SLOT", input.amount, payout);
  if (payout) announceWin(user.id, "slot", payout);
  return { spinId: playId, reels, multiplier: mult, payout, balance };
}
