// Draw & Guess rules, pure: no database, no sockets, no clock (callers pass `now`). The service (services/draw.ts)
// owns time, storage and the strokes; guesses arrive as ordinary room chat (services/chat.ts asks `guess` first).
//
// Rules: 2-8 seated players take turns drawing, ROUNDS times each. The drawer sees the word, everyone else sees its
// letter count. A guess in chat that matches the word scores more the sooner it comes; the drawer scores for every
// right guess. The turn ends when every player has guessed or time runs out, then the word is shown for PAUSE_MS.
// shortcut: no letter hints and no word choice for the drawer; add them if turns often end with nobody guessing.

export type Person = { userId: string; displayName: string | null; avatarUrl: string | null };
export type DrawState = {
  v: number; // bumps on every change, so clients drop stale updates
  phase: "lobby" | "playing" | "finished";
  lobby: Person[];
  players: (Person & { score: number })[];
  turn: number; // turns played so far (the game is `turns` long)
  turns: number;
  drawer: number; // index into players
  word: string | null; // secret: never leaves the server except to the drawer (see publicView)
  used: string[]; // words already drawn this game
  guessed: string[]; // who got this turn's word, in order
  startsAt: string | null; // drawing and guessing open (after the pause showing the last word), ISO
  deadline: string | null; // the turn ends, ISO
  last: { word: string; drawerId: string } | null; // the word just finished, shown in the pause
};

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const ROUNDS = 2;
export const TURN_MS = Number(process.env.DRAW_TURN_MS ?? 80_000);
export const PAUSE_MS = 4_000;
export const MAX_POINTS = 100;
export const MIN_POINTS = 20;
export const DRAWER_POINTS = 25;

export const WORDS = [
  ...["apple", "banana", "cake", "pizza", "burger", "ice cream", "donut", "carrot", "egg", "cookie", "grapes", "watermelon", "mango", "corn", "bread", "cheese"],
  ...["cat", "dog", "fish", "bird", "lion", "tiger", "elephant", "monkey", "snake", "rabbit", "horse", "cow", "pig", "duck", "frog", "turtle", "spider", "butterfly", "shark", "whale"],
  ...["house", "tree", "flower", "sun", "moon", "star", "cloud", "rain", "rainbow", "mountain", "river", "island", "volcano", "beach", "fire", "snowman"],
  ...["car", "bus", "train", "plane", "boat", "bicycle", "rocket", "truck", "helicopter", "tractor", "ship"],
  ...["phone", "computer", "television", "camera", "guitar", "drum", "piano", "clock", "lamp", "chair", "table", "bed", "door", "window", "key", "umbrella"],
  ...["glasses", "hat", "shoe", "sock", "shirt", "crown", "ring", "bag", "book", "pencil", "scissors", "ladder", "candle", "balloon", "gift", "kite", "ball"],
  ...["football", "cricket", "trophy", "medal", "robot", "ghost", "dragon", "alien", "pirate", "king", "queen", "doctor", "teacher"],
  ...["heart", "smile", "eye", "nose", "hand", "foot", "tooth", "bone", "castle", "bridge", "tent", "lighthouse", "windmill", "tower"],
];

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
export const drawerOf = (s: DrawState) => (s.phase === "playing" ? s.players[s.drawer]! : null);
const iso = (ms: number) => new Date(ms).toISOString();

export const lobbyState = (v = 0): DrawState => ({ v: v + 1, phase: "lobby", lobby: [], players: [], turn: 0, turns: 0, drawer: 0, word: null, used: [], guessed: [], startsAt: null, deadline: null, last: null });

function pick(used: string[], rnd: () => number) {
  const left = WORDS.filter((w) => !used.includes(w));
  const pool = left.length ? left : WORDS;
  return pool[Math.floor(rnd() * pool.length)]!;
}

// Turn `turn` begins: a fresh word, nobody has guessed. The first turn of a game opens at once; later ones after PAUSE_MS.
function begin(s: DrawState, turn: number, drawer: number, now: number, rnd: () => number, pause: number): DrawState {
  const word = pick(s.used, rnd);
  return { ...s, v: s.v + 1, phase: "playing", turn, drawer, word, used: [...s.used, word], guessed: [], startsAt: iso(now + pause), deadline: iso(now + pause + TURN_MS) };
}

export const startGame = (s: DrawState, people: Person[], now: number, rnd = Math.random): DrawState =>
  begin({ ...s, used: [], last: null, turns: people.length * ROUNDS, players: people.map((p) => ({ ...p, score: 0 })) }, 0, 0, now, rnd, 0);

// The current turn is over (all guessed, time up, drawer gone): show its word, then the next drawer, or the end.
export function endTurn(s: DrawState, now: number, rnd = Math.random): DrawState {
  if (s.phase !== "playing") return s;
  const last = { word: s.word!, drawerId: drawerOf(s)!.userId };
  const done = s.turn + 1 >= s.turns;
  if (done) return { ...s, v: s.v + 1, phase: "finished", word: null, guessed: [], startsAt: null, deadline: null, last };
  return begin({ ...s, last }, s.turn + 1, (s.drawer + 1) % s.players.length, now, rnd, PAUSE_MS);
}

// A chat message during a game. "hit": a first right guess (scored; the chat shows that they guessed, not the word).
// "spoiler": the drawer, or someone who already knows the word, typing it (the message is refused). "none": ordinary chat.
export function guess(s: DrawState, userId: string, text: string, now: number, rnd = Math.random): { state: DrawState; result: "hit" | "spoiler" | "none" } {
  const none = { state: s, result: "none" as const };
  if (s.phase !== "playing" || !s.word || !s.startsAt || Date.parse(s.startsAt) > now) return none;
  const said = norm(text);
  const word = norm(s.word);
  const knows = drawerOf(s)!.userId === userId || s.guessed.includes(userId);
  if (knows) return said.includes(word) ? { state: s, result: "spoiler" } : none;
  if (said !== word) return none;
  const player = s.players.some((p) => p.userId === userId);
  // Listeners may guess too (so the word never shows in chat), but only players score.
  if (!player) return { state: s, result: "hit" };
  const left = Math.max(0, Date.parse(s.deadline!) - now) / TURN_MS;
  const points = Math.max(MIN_POINTS, Math.round(MAX_POINTS * left));
  const drawer = drawerOf(s)!.userId;
  const players = s.players.map((p) => (p.userId === userId ? { ...p, score: p.score + points } : p.userId === drawer ? { ...p, score: p.score + DRAWER_POINTS } : p));
  const n = { ...s, v: s.v + 1, players, guessed: [...s.guessed, userId] };
  return { state: n.guessed.length >= n.players.length - 1 ? endTurn(n, now, rnd) : n, result: "hit" };
}

// A player leaves mid-game: off the scoreboard. Under MIN_PLAYERS left ends the game; the drawer leaving ends the turn.
export function removePlayer(s: DrawState, userId: string, now: number, rnd = Math.random): DrawState {
  const i = s.players.findIndex((p) => p.userId === userId);
  if (s.phase !== "playing" || i < 0) return s;
  const wasDrawer = drawerOf(s)!.userId === userId;
  const players = s.players.filter((p) => p.userId !== userId);
  if (players.length < MIN_PLAYERS) return { ...s, v: s.v + 1, phase: "finished", players, word: null, guessed: [], startsAt: null, deadline: null, last: s.word ? { word: s.word, drawerId: drawerOf(s)!.userId } : s.last };
  // Keep the same person drawing: everyone after the leaver moves down one place.
  const drawer = i < s.drawer ? s.drawer - 1 : s.drawer;
  const next = { ...s, v: s.v + 1, players, drawer, guessed: s.guessed.filter((g) => g !== userId) };
  // The drawer left: the person after them (now at their index) draws next, so endTurn starts from the one before.
  if (wasDrawer) return endTurn({ ...next, drawer: (i - 1 + players.length) % players.length }, now, rnd);
  return next.guessed.length >= players.length - 1 ? endTurn(next, now, rnd) : next;
}

// What everyone sees: the word as its letter count ("_ _ _ _   _ _"), never the word itself.
export const publicView = (s: DrawState | null) =>
  s && { ...s, word: undefined, used: undefined, hint: s.word ? s.word.replace(/[^ ]/g, "_").split("").join(" ") : null };
