import { eq } from "drizzle-orm";
import { db } from "../db";
import { rooms, type User, type VideoState } from "../db/schema";
import { emitToRoom } from "../io";
import { AppError } from "../lib/errors";
import { assertRoomAdmin, getRoom, systemMessage } from "./rooms";

// Video mode for a room: a shared YouTube player under the seat row (like the Ludo board). The owner/admins switch it on,
// pick a video in the app's YouTube browser and pause/resume; everyone watches in sync. Phones work out the current position from `position`,
// `playing` and `at` (see VideoState), so the server sends nothing while a video simply plays.

// A YouTube video id (what the app's YouTube browser hands over when an admin picks a video).
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Its title, which also proves the video exists and is public (YouTube's oEmbed answers 401/404 otherwise).
async function videoTitle(id: string) {
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, {
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!res) throw new AppError("VIDEO_CHECK_FAILED", 503, "Couldn't reach YouTube. Try again");
  if (!res.ok) throw new AppError("VIDEO_NOT_FOUND", 400, "That video is private, removed or can't be played here");
  const body = (await res.json().catch(() => null)) as { title?: unknown } | null;
  return typeof body?.title === "string" ? body.title.slice(0, 200) : "YouTube video";
}

async function save(roomId: string, video: VideoState | null) {
  await db.update(rooms).set({ video }).where(eq(rooms.id, roomId));
  emitToRoom(roomId, "room:video", { roomId, video });
  return { video };
}

async function current(roomId: string) {
  const room = await getRoom(roomId);
  if (!room.video) throw new AppError("VIDEO_OFF", 409, "Video mode isn't on in this room");
  return room.video;
}

// Where the video is right now, in seconds.
const positionNow = (v: VideoState) => v.position + (v.playing ? Math.max(0, Date.now() - Date.parse(v.at)) / 1000 : 0);

export async function setMode(actor: User, roomId: string, on: boolean) {
  await assertRoomAdmin(roomId, actor.id);
  const room = await getRoom(roomId);
  if (room.kind === "LIVE") throw new AppError("VIDEO_NOT_IN_LIVE", 400, "Video mode is for audio rooms");
  if (!!room.video === on) return { video: room.video };
  if (on && room.ludo) throw new AppError("LUDO_ON", 409, "Turn off Ludo first");
  const result = await save(roomId, on ? { videoId: null, title: null, position: 0, playing: false, at: new Date().toISOString() } : null);
  await systemMessage(roomId, on ? `${actor.displayName} switched the room to Video mode` : `${actor.displayName} turned Video mode off`, { kind: "VIDEO", userId: actor.id });
  return result;
}

// Plays a YouTube video from the start, for everyone.
export async function play(actor: User, roomId: string, videoId: string) {
  await assertRoomAdmin(roomId, actor.id);
  await current(roomId);
  const title = await videoTitle(videoId);
  const result = await save(roomId, { videoId, title, position: 0, playing: true, at: new Date().toISOString() });
  await systemMessage(roomId, `${actor.displayName} is playing "${title}"`, { kind: "VIDEO", userId: actor.id });
  return result;
}

// Pause or resume where it is; `position` (seconds) jumps there instead.
export async function control(actor: User, roomId: string, playing: boolean, position?: number) {
  await assertRoomAdmin(roomId, actor.id);
  const v = await current(roomId);
  if (!v.videoId) throw new AppError("NO_VIDEO", 409, "Pick a video first");
  return save(roomId, { ...v, playing, position: position ?? positionNow(v), at: new Date().toISOString() });
}
