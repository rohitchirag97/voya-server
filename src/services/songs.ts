import { and, asc, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "../db";
import { songs, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { lrcTimes } from "../lib/karaoke";
import { store, storeAudio } from "../routes/posts";

// The karaoke song library: staff upload songs in the admin panel, everyone in a Karaoke room searches and queues them.
const file = (name: string | null) => (name ? `/v1/uploads/${name}` : null);
export const songLength = (s: { durationMs: number | null; lyrics: string }) => s.durationMs ?? (lrcTimes(s.lyrics).at(-1) ?? 0) + 15_000;
const card = (s: typeof songs.$inferSelect) => ({ songId: s.id, title: s.title, artist: s.artist, cover: file(s.cover), durationMs: songLength(s), hasOriginal: !!s.original });

// Search by title or artist; no query = the most sung.
export async function search(q: string) {
  const like = q ? or(ilike(songs.title, `%${q}%`), ilike(songs.artist, `%${q}%`)) : undefined;
  const rows = await db.select().from(songs).where(and(eq(songs.enabled, true), like)).orderBy(desc(songs.plays), asc(songs.title)).limit(50);
  return { songs: rows.map(card) };
}

export async function getSong(songId: string) {
  const [s] = await db.select().from(songs).where(eq(songs.id, songId));
  if (!s || !s.enabled) throw new AppError("SONG_NOT_FOUND", 404, "That song isn't available");
  return s;
}

// What a phone needs to sing or follow along: the files and the lyrics.
export async function songDetail(songId: string) {
  const s = await getSong(songId);
  return { ...card(s), track: file(s.track)!, original: file(s.original), lyrics: s.lyrics };
}

// ---------- admin ----------

export type SongFields = { title?: string; artist?: string; durationMs?: number | null; enabled?: boolean; lyrics?: string };
export type SongFiles = { track?: File; original?: File; cover?: File };

function checkLyrics(lyrics: string) {
  if (lrcTimes(lyrics).length < 2) throw new AppError("BAD_LYRICS", 400, "Lyrics must be an LRC file with timed lines like [00:12.50]");
}

export async function listAll() {
  const rows = await db.select().from(songs).orderBy(desc(songs.createdAt));
  return { songs: rows.map((s) => ({ ...card(s), enabled: s.enabled, plays: s.plays, givenDurationMs: s.durationMs, track: file(s.track), original: file(s.original), lyrics: s.lyrics, createdAt: s.createdAt })) };
}

export async function createSong(_actor: User, f: SongFields & { title: string; lyrics: string }, files: SongFiles) {
  if (!files.track) throw new AppError("VALIDATION_ERROR", 400, "A song needs its backing track");
  checkLyrics(f.lyrics);
  const [s] = await db
    .insert(songs)
    .values({
      title: f.title,
      artist: f.artist ?? "",
      lyrics: f.lyrics,
      durationMs: f.durationMs ?? null,
      enabled: f.enabled ?? true,
      track: await storeAudio(files.track),
      original: files.original ? await storeAudio(files.original) : null,
      cover: files.cover ? (await store(files.cover, ["image"])).name : null,
    })
    .returning();
  return card(s!);
}

export async function updateSong(_actor: User, songId: string, f: SongFields, files: SongFiles) {
  if (f.lyrics !== undefined) checkLyrics(f.lyrics);
  const patch: Partial<typeof songs.$inferInsert> = { ...f };
  if (files.track) patch.track = await storeAudio(files.track);
  if (files.original) patch.original = await storeAudio(files.original);
  if (files.cover) patch.cover = (await store(files.cover, ["image"])).name;
  const [s] = await db.update(songs).set(patch).where(eq(songs.id, songId)).returning();
  if (!s) throw new AppError("SONG_NOT_FOUND", 404);
  return card(s);
}
