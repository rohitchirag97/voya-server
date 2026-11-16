// Karaoke queue rules, pure: no database, no sockets, no clock (callers pass `now`). The service (services/karaoke.ts)
// owns storage and time; the singer's phone plays the backing track into their mic stream (Zego), so the server only
// decides whose turn it is and shows everyone the song and lyrics.
//
// Anyone in the room may queue; you need a seat only when your turn comes (the phone asks you to take one). A turn: the
// next entry becomes `current` (not started) and the singer has READY_MS to sit down and start, after which their phone
// says "started" and the deadline becomes the song's length plus slack for pauses. The turn ends when the phone says
// "done", the singer or a room admin skips, the singer leaves their seat mid-song, or a deadline passes.
//
// Room duets: a duet song can be queued with an open spot for a partner, who sings part B live from their own seat
// while the owner's phone plays the track and sings part A. Nobody joined by the start: the owner sings it all.

export type Person = { userId: string; displayName: string | null; avatarUrl: string | null };
export type Entry = Person & { id: string; songId: string; title: string; artist: string; cover: string | null; durationMs: number; duet: boolean; partner: Person | null };
export type KaraokeState = {
  v: number; // bumps on every change, so clients drop stale updates
  queue: Entry[]; // waiting, in order
  current: (Entry & { startedAt: string | null; deadline: string }) | null;
};

export const MAX_QUEUE = 30;
export const PER_PERSON = 2; // songs one person may have waiting
export const READY_MS = 45_000; // to take a seat (if needed), load the track and start
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

// A room admin moves a waiting song to the front: it plays next.
export function playNext(s: KaraokeState, entryId: string): KaraokeState {
  const e = s.queue.find((q) => q.id === entryId);
  if (!e) throw new RuleError("That song isn't waiting any more");
  if (s.queue[0]?.id === entryId) return s;
  return { ...s, v: s.v + 1, queue: [e, ...s.queue.filter((q) => q.id !== entryId)] };
}

// Mid-song seats: a singer who left their seat loses the turn; a duet partner who left is dropped (the singer carries
// on alone). Before the song starts there's READY_MS to sit down, and waiting songs never need a seat.
export function dropUnseated(s: KaraokeState, seated: Set<string>, now: number): KaraokeState {
  const c = s.current;
  if (!c?.startedAt) return s;
  if (!seated.has(c.userId)) return advance(s, now);
  if (c.partner && !seated.has(c.partner.userId)) return { ...s, v: s.v + 1, current: { ...c, partner: null } };
  return s;
}

// Take the open partner spot of a duet (waiting, or up now and not started yet).
export function joinDuet(s: KaraokeState, entryId: string, p: Person): KaraokeState {
  const e = s.queue.find((q) => q.id === entryId) ?? (s.current?.id === entryId ? s.current : null);
  if (!e) throw new RuleError("That song isn't in the queue any more");
  if (!e.duet) throw new RuleError("That song is a solo");
  if (e.userId === p.userId) throw new RuleError("You can't be your own duet partner");
  if (e.partner) throw new RuleError(e.partner.userId === p.userId ? "You've already joined" : "Someone already joined this duet");
  if (s.current?.id === entryId && s.current.startedAt) throw new RuleError("The song has already started");
  return withEntry(s, entryId, { partner: p });
}

// The partner steps out, or the owner (or an admin, `force`) takes them out: the spot opens again.
export function leaveDuet(s: KaraokeState, entryId: string, userId: string, force = false): KaraokeState {
  const e = s.queue.find((q) => q.id === entryId) ?? (s.current?.id === entryId ? s.current : null);
  if (!e?.partner) return s;
  if (e.partner.userId !== userId && e.userId !== userId && !force) throw new RuleError("Only the partner or the singer can do that");
  return withEntry(s, entryId, { partner: null });
}

function withEntry(s: KaraokeState, entryId: string, patch: Partial<Entry>): KaraokeState {
  return {
    v: s.v + 1,
    queue: s.queue.map((q) => (q.id === entryId ? { ...q, ...patch } : q)),
    current: s.current?.id === entryId ? { ...s.current, ...patch } : s.current,
  };
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

// Duet songs: lyric lines marked [A], [B] or [AB] (both sing) right after their time, e.g. "[00:12.50][A]text".
export const hasParts = (lyrics: string) => /\[(A|B)\]/.test(lyrics);
