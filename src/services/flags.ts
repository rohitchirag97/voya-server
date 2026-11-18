import { eq } from "drizzle-orm";
import { db } from "../db";
import { featureFlags } from "../db/schema";
import { io } from "../io";
import { AppError } from "../lib/errors";
import { levelOf } from "../lib/levels";
import type { User } from "../db/schema";

// Feature switches (admin panel > Feature switches). Off until someone turns them on: a key with no row is off.
// "games": one switch for every coin game (Greedy Jungle and Galaxy, Rocket, Lucky Slots, Roulette).
export const GAMES = "games";

// shortcut: cached per process (cleared on every change made here), so with several server instances a switch takes
// up to CACHE_MS to reach the others; move to a shared cache or pub/sub before scaling out.
const CACHE_MS = 30_000;
let cache: { at: number; games: boolean } | null = null;

export async function gamesOn() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.games;
  const [row] = await db.select({ enabled: featureFlags.enabled }).from(featureFlags).where(eq(featureFlags.key, GAMES));
  cache = { at: Date.now(), games: !!row?.enabled };
  return cache.games;
}

export async function assertGamesOn() {
  if (!(await gamesOn())) throw new AppError("GAMES_OFF", 403, "Games aren't available right now");
}

// The coin games (anything you bet coins on) open at this level; the app shows them locked below it.
export const MIN_GAME_LEVEL = 5;
export async function assertCanPlay(user: Pick<User, "xp">) {
  await assertGamesOn();
  if (levelOf(user.xp) < MIN_GAME_LEVEL) throw new AppError("GAME_LEVEL", 403, `Upgrade to Level ${MIN_GAME_LEVEL} to unlock games`);
}

export async function setGamesOn(enabled: boolean, by: string) {
  await db
    .insert(featureFlags)
    .values({ key: GAMES, enabled, updatedBy: by })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled, updatedBy: by, updatedAt: new Date() } });
  cache = null;
  io.emit("app:games", { enabled }); // open apps show or hide the games right away
  return { games: enabled };
}
