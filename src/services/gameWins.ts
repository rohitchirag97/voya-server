import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { roomParticipants, users } from "../db/schema";
import { io } from "../io";
import { toSafeError } from "../lib/errors";
import { systemMessage } from "./rooms";

// Wins worth telling people about. A "win" is one payout: a Greedy round's payout, or one Rocket cash-out.
export const ROOM_NOTICE_MIN = 300; // posted in the chat of the room the winner is in, with a button to open that game
export const BIG_WIN_MIN = 10_000; // banner in every room, wherever the winner was

export type GameKey = "jungle" | "galaxy" | "rocket";
export const GAME_TITLES: Record<GameKey, string> = { jungle: "Greedy Jungle", galaxy: "Greedy Galaxy", rocket: "Rocket" };

// Fire-and-forget from the game code: a notice failing must never affect the payout that already happened.
export function announceWin(userId: string, game: GameKey, amount: number) {
  if (amount < ROOM_NOTICE_MIN) return;
  announce(userId, game, amount).catch(toSafeError);
}

async function announce(userId: string, game: GameKey, amount: number) {
  const [u] = await db.select({ displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, userId));
  const name = u?.displayName ?? "Someone";
  // Rooms the winner is in right now (normally one).
  const inRooms = await db
    .select({ roomId: roomParticipants.roomId })
    .from(roomParticipants)
    .where(and(eq(roomParticipants.userId, userId), isNull(roomParticipants.leftAt)));
  for (const { roomId } of inRooms) {
    await systemMessage(roomId, `${name} won ${amount.toLocaleString("en-IN")} coins in ${GAME_TITLES[game]}`, { kind: "GAME_WIN", userId, game, amount });
  }
  // Every connected app shows it in whatever room it has open; each game has its own banner design, so no title needed.
  if (amount >= BIG_WIN_MIN) io.emit("game:bigwin", { userId, displayName: name, avatarUrl: u?.avatarUrl ?? null, game, amount, at: new Date() });
}
