import { and, desc, eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { posts, songs, users, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { hasParts } from "../lib/karaoke";
import { generateToken04, roomPrivilege } from "../lib/zegoToken";
import { storeAudio } from "../routes/posts";
import { userSummary } from "./rooms";
import { getSong } from "./songs";

// Karaoke covers: a recording made in the app's studio (your voice over a song's backing track, mixed on the phone)
// posted to the feed. Duets are covers of one part (A or B) of a song whose lyrics mark parts: someone posts their part
// as an open duet, someone else sings the other part over that recording, and the result is one post with both voices.

export type Part = "A" | "B";

// The studio records through ZEGO like a room, so it logs in to a private room of your own, never played by anyone.
const STUDIO_TTL_S = 3600;
export function studioCredentials(userId: string) {
  const zegoRoomId = `studio-${userId}`;
  return {
    appId: config.zegoAppId,
    zegoRoomId,
    zegoUserId: userId,
    token: generateToken04(config.zegoAppId, userId, config.zegoServerSecret, STUDIO_TTL_S, roomPrivilege(zegoRoomId, true)),
    tokenExpiresInSeconds: STUDIO_TTL_S,
    streamId: `studio-${userId}`,
  };
}

export type CoverInput = { songId: string; caption: string; file: File; part?: Part; duetOpen: boolean; duetOf?: string };

export async function createCover(user: User, c: CoverInput) {
  const song = await getSong(c.songId);
  let part: Part | null = c.part ?? null;
  if (c.duetOf) {
    // Joining someone's open duet: you sang the other part over their recording.
    const [open] = await db.select().from(posts).where(eq(posts.id, c.duetOf));
    if (!open || open.kind !== "COVER" || !open.duetOpen) throw new AppError("DUET_NOT_OPEN", 409, "That duet isn't open any more");
    if (open.songId !== song.id) throw new AppError("DUET_WRONG_SONG", 400, "Sing the same song as the duet");
    if (open.userId === user.id) throw new AppError("DUET_OWN", 409, "You can't join your own duet");
    part = open.part === "A" ? "B" : "A";
  } else if (c.duetOpen) {
    if (!hasParts(song.lyrics)) throw new AppError("NOT_A_DUET", 400, "This song has no duet parts");
    if (!part) throw new AppError("PART_REQUIRED", 400, "Pick part A or B");
  } else part = null; // a solo cover sings everything
  const audio = await storeAudio(c.file);
  const [p] = await db
    .insert(posts)
    .values({ userId: user.id, kind: "COVER", caption: c.caption, audio, songId: song.id, part, duetOpen: !c.duetOf && c.duetOpen, duetOf: c.duetOf ?? null })
    .returning();
  return { postId: p!.id };
}

// Open duets to join: one song's, or everyone's, newest first.
export async function openDuets(songId: string | undefined, me: string) {
  const rows = await db
    .select({ postId: posts.id, part: posts.part, songId: posts.songId, audio: posts.audio, caption: posts.caption, createdAt: posts.createdAt, author: userSummary, title: songs.title, artist: songs.artist, cover: songs.cover })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.userId))
    .innerJoin(songs, eq(songs.id, posts.songId))
    .where(and(eq(posts.duetOpen, true), eq(songs.enabled, true), songId ? eq(posts.songId, songId) : undefined))
    .orderBy(desc(posts.createdAt))
    .limit(50);
  return { duets: rows.filter((r) => r.author.userId !== me).map(({ audio, cover, ...r }) => ({ ...r, cover: cover ? `/v1/uploads/${cover}` : null, audioUrl: `/v1/uploads/${audio}` })) };
}
