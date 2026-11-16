// Chess for a room, pure: no database, no sockets, no clock (callers pass `now`). The moves themselves are checked by
// chess.js (every rule: castling, en passant, promotion, check, mate, stalemate, repetition, 50 moves, bare kings);
// this file adds players, the chess clocks, resigning and draw offers. The game is replayed from its move list, so
// repetition is detected over the whole game.
import { Chess } from "chess.js";

export type Person = { userId: string; displayName: string | null; avatarUrl: string | null };
export type Color = "w" | "b";
export type Reason = "CHECKMATE" | "RESIGN" | "TIMEOUT" | "LEFT" | "STALEMATE" | "REPETITION" | "FIFTY_MOVES" | "MATERIAL" | "AGREED";
export type ChessState = {
  v: number; // bumps on every change, so clients drop stale updates
  phase: "lobby" | "playing" | "finished";
  lobby: Person[]; // joined, waiting for the start (2 play)
  players: (Person & { color: Color })[]; // white first
  moves: string[]; // the game so far, in SAN ("e4", "Nf3", "O-O", "e8=Q#")
  fen: string; // the position now
  last: { from: string; to: string; san: string } | null;
  clock: Record<Color, number>; // ms left for each side, as of turnAt
  turnAt: string | null; // when the side to move started thinking (ISO)
  drawOffer: string | null; // userId of the player offering a draw
  winner: string | null; // userId; null with a draw reason
  reason: Reason | null;
};

export const PLAYERS = 2;
export const CLOCK_MS = Number(process.env.CHESS_CLOCK_MS ?? 600_000); // 10 minutes each
export const START_FEN = new Chess().fen();
const iso = (ms: number) => new Date(ms).toISOString();

export class RuleError extends Error {}

export const lobbyState = (v = 0): ChessState => ({ v: v + 1, phase: "lobby", lobby: [], players: [], moves: [], fen: START_FEN, last: null, clock: { w: CLOCK_MS, b: CLOCK_MS }, turnAt: null, drawOffer: null, winner: null, reason: null });

// The first to join plays white unless shuffled by `rnd`.
export function startGame(s: ChessState, people: Person[], now: number, rnd = Math.random): ChessState {
  const [a, b] = rnd() < 0.5 ? [people[0]!, people[1]!] : [people[1]!, people[0]!];
  return { ...lobbyState(s.v), phase: "playing", players: [{ ...a, color: "w" }, { ...b, color: "b" }], turnAt: iso(now) };
}

const replay = (moves: string[]) => {
  const g = new Chess();
  for (const m of moves) g.move(m);
  return g;
};
const turnOf = (s: ChessState): Color => (s.moves.length % 2 === 0 ? "w" : "b");
export const colorOf = (s: ChessState, userId: string) => s.players.find((p) => p.userId === userId)?.color ?? null;
const playerOf = (s: ChessState, c: Color) => s.players.find((p) => p.color === c)!;

// Time left for the side to move, at `now`.
export const timeLeft = (s: ChessState, now: number) => s.clock[turnOf(s)] - (s.turnAt ? now - Date.parse(s.turnAt) : 0);

const end = (s: ChessState, winner: string | null, reason: Reason): ChessState => ({ ...s, v: s.v + 1, phase: "finished", winner, reason, turnAt: null, drawOffer: null });

export function move(s: ChessState, userId: string, m: { from: string; to: string; promotion?: string }, now: number): ChessState {
  if (s.phase !== "playing") throw new RuleError("No game is running");
  const side = turnOf(s);
  if (colorOf(s, userId) !== side) throw new RuleError("It's not your turn");
  const left = timeLeft(s, now);
  if (left <= 0) return end(s, playerOf(s, side === "w" ? "b" : "w").userId, "TIMEOUT");
  const g = replay(s.moves);
  let done;
  try {
    done = g.move({ from: m.from, to: m.to, promotion: m.promotion ?? "q" });
  } catch {
    throw new RuleError("That move isn't allowed");
  }
  const n: ChessState = {
    ...s,
    v: s.v + 1,
    moves: [...s.moves, done.san],
    fen: g.fen(),
    last: { from: done.from, to: done.to, san: done.san },
    clock: { ...s.clock, [side]: left },
    turnAt: iso(now),
    drawOffer: null, // moving declines an offer
  };
  if (g.isCheckmate()) return end(n, userId, "CHECKMATE");
  if (g.isStalemate()) return end(n, null, "STALEMATE");
  if (g.isInsufficientMaterial()) return end(n, null, "MATERIAL");
  if (g.isThreefoldRepetition()) return end(n, null, "REPETITION");
  if (g.isDrawByFiftyMoves()) return end(n, null, "FIFTY_MOVES");
  return n;
}

// Resign (or leave the game): the other player wins.
export function resign(s: ChessState, userId: string, reason: "RESIGN" | "LEFT" = "RESIGN"): ChessState {
  if (s.phase !== "playing" || !colorOf(s, userId)) return s;
  return end(s, s.players.find((p) => p.userId !== userId)!.userId, reason);
}

// Offer a draw; the other player accepting it (offering back) ends the game drawn.
export function offerDraw(s: ChessState, userId: string): ChessState {
  if (s.phase !== "playing" || !colorOf(s, userId)) throw new RuleError("You're not playing");
  if (s.drawOffer && s.drawOffer !== userId) return end(s, null, "AGREED");
  return s.drawOffer === userId ? s : { ...s, v: s.v + 1, drawOffer: userId };
}

// The side to move ran out of time: they lose.
export function timeout(s: ChessState, now: number): ChessState {
  if (s.phase !== "playing" || timeLeft(s, now) > 0) return s;
  const side = turnOf(s);
  return end({ ...s, clock: { ...s.clock, [side]: 0 } }, playerOf(s, side === "w" ? "b" : "w").userId, "TIMEOUT");
}
