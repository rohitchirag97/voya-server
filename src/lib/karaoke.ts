// Karaoke queue rules, pure: no database, no sockets, no clock (callers pass `now`). The service (services/karaoke.ts)
// owns storage and time; the singer's phone plays the backing track into their mic stream (Zego), so the server only
// decides whose turn it is and shows everyone the song and lyrics.
//
// A turn: the next entry becomes `current` (not started); the singer's phone loads the track and says "started", which
// sets the turn's deadline (the song's length plus slack for pauses). The turn ends when the phone says "done", the
// singer or a room admin skips, the singer leaves their seat, or a deadline passes (never started, or ran far over).

export type Entry = { id: string; userId: string; displayName: string | null; avatarUrl: string | null; songId: string; title: string; artist: string; cover: string | null; durationMs: number };
export type KaraokeState = {
  v: number; // bumps on every change, so clients drop stale updates
  queue: Entry[]; // waiting, in order
  current: (Entry & { startedAt: string | null; deadline: string }) | null;
};

export const MAX_QUEUE = 30;
export const PER_PERSON = 2; // songs one person may have waiting
export const READY_MS = 30_000; // to load the track and start
export const SLACK_MS = 120_000; // pauses and slow starts on top of the song's length

const iso = (ms: number) => new Date(ms).toISOString();

export const emptyState = (v = 0): KaraokeState => ({ v: v + 1, queue: [], current: null });

export class RuleError extends Error {}

// The next singer's turn (or nobody's).
function advance(s: KaraokeState, now: number): KaraokeState {
  const [next, ...queue] = s.queue;
  return { v: s.v + 1, queue, current: next ? { ...next, startedAt: null, deadline: iso(now + READY_MS) } : null };
}

export function add(s: KaraokeState, e: Entry, now: number): KaraokeState {
  if (s.queue.length >= MAX_QUEUE) throw new RuleError("The queue is full");
  if (s.queue.filter((q) => q.userId === e.userId).length >= PER_PERSON) throw new RuleError(`You can queue up to ${PER_PERSON} songs`);
  const n = { ...s, v: s.v + 1, queue: [...s.queue, e] };
  return n.current ? n : advance(n, now);
}

// The singer's phone has the track playing.
export function started(s: KaraokeState, userId: string, entryId: string, now: number): KaraokeState {
  const c = s.current;
  if (!c || c.id !== entryId || c.userId !== userId) throw new RuleError("It's not your turn");
  if (c.startedAt) return s;
  return { ...s, v: s.v + 1, current: { ...c, startedAt: iso(now), deadline: iso(now + c.durationMs + SLACK_MS) } };
}

// The song ended on the singer's phone, or they (or an admin: `force`) skipped it.
export function finish(s: KaraokeState, userId: string, entryId: string, now: number, force = false): KaraokeState {
  const c = s.current;
  if (!c || c.id !== entryId) return s; // already moved on: a late "done" is harmless
  if (c.userId !== userId && !force) throw new RuleError("Only the singer or a room admin can skip");
  return advance(s, now);
}

// Take a waiting song out: your own, or anyone's with `force` (admins).
export function remove(s: KaraokeState, userId: string, entryId: string, force = false): KaraokeState {
  const e = s.queue.find((q) => q.id === entryId);
  if (!e) return s;
  if (e.userId !== userId && !force) throw new RuleError("You can only remove your own songs");
  return { ...s, v: s.v + 1, queue: s.queue.filter((q) => q.id !== entryId) };
}

// Everyone who left their seat loses their waiting songs; a singer who left loses the turn.
export function dropUnseated(s: KaraokeState, seated: Set<string>, now: number): KaraokeState {
  const queue = s.queue.filter((q) => seated.has(q.userId));
  const n = queue.length === s.queue.length ? s : { ...s, v: s.v + 1, queue };
  return n.current && !seated.has(n.current.userId) ? advance(n, now) : n;
}

export const expired = (s: KaraokeState, now: number) => !!s.current && Date.parse(s.current.deadline) <= now;
export const timeout = (s: KaraokeState, now: number) => (expired(s, now) ? advance(s, now) : s);

// LRC lyrics: the time of each line "[mm:ss.xx]" (several per line allowed). Used to check uploads and to guess a
// song's length when the admin doesn't give one.
const TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
export function lrcTimes(lrc: string): number[] {
  const out: number[] = [];
  for (const m of lrc.matchAll(TAG)) out.push(Number(m[1]) * 60_000 + Number(m[2]) * 1000 + (m[3] ? Number(m[3].padEnd(3, "0")) : 0));
  return out.sort((a, b) => a - b);
}
