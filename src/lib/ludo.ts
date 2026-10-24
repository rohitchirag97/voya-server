// Ludo rules, pure: no database, no sockets, no clock. The service (services/ludo.ts) owns time, dice and storage.
//
// Board: a 52-square loop shared by everyone, then a private 5-square home column per colour, then home.
// A token's position is counted from its own colour's start square:
//   -1 = in base, 0..50 = on the loop (0 = its start square), 51..55 = home column, 56 = home.
// Classic rules (as most players know them from Ludo King):
//   - a 6 brings a token out of base onto its start square
//   - exact roll needed to reach home
//   - landing on an opponent on an unsafe loop square sends every opponent token there back to base
//   - starts and star squares are safe; tokens never block each other
//   - a 6, a capture or reaching home earns another roll; a third 6 in a row loses the turn
//   - the first player with all 4 tokens home wins and the game ends

export const COLORS = ["red", "green", "yellow", "blue"] as const;
export const LOOP = 52;
export const LAST_LOOP = 50; // last loop square before turning into the home column
export const HOME = 56;
export const TOKENS = 4;
// Global loop squares where nobody can be captured: each colour's start square and the four stars.
export const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export type Player = {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  color: number; // index into COLORS; also fixes the start square (color * 13)
  tokens: number[]; // TOKENS positions, see above
  auto: boolean; // left the seat mid-game: the server plays every turn from then on
};

export type LastAction =
  | { kind: "roll"; userId: string; dice: number; auto: boolean }
  | { kind: "pass"; userId: string; dice: number; reason: "NO_MOVE" | "THREE_SIXES"; auto: boolean }
  | { kind: "move"; userId: string; dice: number; token: number; from: number; to: number; captured: { userId: string; token: number; from: number }[]; auto: boolean };

export type LudoState = {
  v: number; // bumps on every change, so clients drop stale updates
  phase: "lobby" | "playing" | "finished";
  lobby: { userId: string; displayName: string | null; avatarUrl: string | null }[]; // joined, waiting for the start
  players: Player[]; // in turn order; empty in the lobby
  turn: number; // index into players
  step: "roll" | "move";
  dice: number | null; // the roll waiting to be used (step "move")
  sixes: number; // 6s rolled in a row this turn
  legal: number[]; // tokens that can move with `dice`
  deadline: string | null; // when the server takes over this step (ISO)
  last: LastAction | null;
  winner: string | null; // userId
};

export const lobbyState = (v = 0): LudoState => ({ v, phase: "lobby", lobby: [], players: [], turn: 0, step: "roll", dice: null, sixes: 0, legal: [], deadline: null, last: null, winner: null });

// 2 players sit opposite each other; 3 and 4 fill the board in order.
export const colorsFor = (n: number) => (n === 2 ? [0, 2] : [0, 1, 2, 3].slice(0, n));

export function startGame(state: LudoState, people: LudoState["lobby"]): LudoState {
  const colors = colorsFor(people.length);
  return {
    ...state,
    v: state.v + 1,
    phase: "playing",
    players: people.map((p, i) => ({ ...p, color: colors[i]!, tokens: Array(TOKENS).fill(-1), auto: false })),
    turn: 0,
    step: "roll",
    dice: null,
    sixes: 0,
    legal: [],
    last: null,
    winner: null,
  };
}

// Where a loop position sits on the shared loop, or null off the loop (base, home column, home).
export const globalSquare = (color: number, pos: number) => (pos >= 0 && pos <= LAST_LOOP ? (color * 13 + pos) % LOOP : null);

export function target(pos: number, dice: number) {
  if (pos === -1) return dice === 6 ? 0 : null;
  if (pos === HOME) return null;
  return pos + dice <= HOME ? pos + dice : null;
}

export const legalTokens = (p: Player, dice: number) => p.tokens.flatMap((pos, i) => (target(pos, dice) === null ? [] : [i]));

// Opponent tokens a move would capture.
function capturesAt(state: LudoState, mover: Player, to: number) {
  const sq = globalSquare(mover.color, to);
  if (sq === null || SAFE.has(sq)) return [];
  return state.players.flatMap((o) => (o === mover ? [] : o.tokens.flatMap((pos, token) => (globalSquare(o.color, pos) === sq ? [{ userId: o.userId, token, from: pos }] : []))));
}

const nextTurn = (state: LudoState) => (state.turn + 1) % state.players.length;

// Step "roll": apply a die value. Passes the turn when there's nothing to move or on a third 6.
export function roll(state: LudoState, dice: number, auto = false): LudoState {
  const p = state.players[state.turn]!;
  const sixes = dice === 6 ? state.sixes + 1 : 0;
  if (sixes === 3) return { ...state, v: state.v + 1, turn: nextTurn(state), step: "roll", dice: null, sixes: 0, legal: [], last: { kind: "pass", userId: p.userId, dice, reason: "THREE_SIXES", auto } };
  const legal = legalTokens(p, dice);
  if (!legal.length) return { ...state, v: state.v + 1, turn: nextTurn(state), step: "roll", dice: null, sixes: 0, legal: [], last: { kind: "pass", userId: p.userId, dice, reason: "NO_MOVE", auto } };
  return { ...state, v: state.v + 1, step: "move", dice, sixes, legal, last: { kind: "roll", userId: p.userId, dice, auto } };
}

// Step "move": move one of the legal tokens by the rolled dice.
export function move(state: LudoState, token: number, auto = false): LudoState {
  if (state.step !== "move" || state.dice === null || !state.legal.includes(token)) throw new Error("illegal move");
  const dice = state.dice;
  const mover = state.players[state.turn]!;
  const from = mover.tokens[token]!;
  const to = target(from, dice)!;
  const captured = capturesAt(state, mover, to);
  const players = state.players.map((p) => {
    if (p === mover) return { ...p, tokens: p.tokens.map((t, i) => (i === token ? to : t)) };
    const lost = captured.filter((c) => c.userId === p.userId).map((c) => c.token);
    return lost.length ? { ...p, tokens: p.tokens.map((t, i) => (lost.includes(i) ? -1 : t)) } : p;
  });
  const last: LastAction = { kind: "move", userId: mover.userId, dice, token, from, to, captured, auto };
  const won = players[state.turn]!.tokens.every((t) => t === HOME);
  if (won) return { ...state, v: state.v + 1, players, phase: "finished", step: "roll", dice: null, sixes: 0, legal: [], deadline: null, last, winner: mover.userId };
  const again = dice === 6 || captured.length > 0 || to === HOME;
  return { ...state, v: state.v + 1, players, turn: again ? state.turn : nextTurn(state), step: "roll", dice: null, sixes: again ? state.sixes : 0, legal: [], last };
}

// What the server plays for an absent or timed-out player: capture > reach home > leave base > land safe > furthest along.
export function autoToken(state: LudoState) {
  const p = state.players[state.turn]!;
  const dice = state.dice!;
  const score = (i: number) => {
    const from = p.tokens[i]!;
    const to = target(from, dice)!;
    const sq = globalSquare(p.color, to);
    if (capturesAt(state, p, to).length) return 5000;
    if (to === HOME) return 4000;
    if (from === -1) return 3000;
    if (sq !== null && SAFE.has(sq)) return 2000 + to;
    return 1000 + to;
  };
  return [...state.legal].sort((a, b) => score(b) - score(a))[0]!;
}
