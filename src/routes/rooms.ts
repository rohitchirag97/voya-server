import { Hono } from "hono";
import { z } from "zod";
import { json, requireAuth, schemas, type Env } from "../http";
import * as chat from "../services/chat";
import * as gifts from "../services/gifts";
import * as recharge from "../services/recharge";
import * as live from "../services/live";
import * as ludo from "../services/ludo";
import * as video from "../services/video";
import * as rooms from "../services/rooms";
import { AppError } from "../lib/errors";
import { store } from "./posts";

export const roomRoutes = new Hono<Env>();
roomRoutes.use("*", requireAuth);

const roomId = (c: { req: { param: (k: "roomId") => string } }) => schemas.uuid.parse(c.req.param("roomId"));
const query = <T extends z.ZodType>(c: { req: { query: () => Record<string, string> } }, s: T) => s.parse(c.req.query());

roomRoutes.get("/rooms", async (c) => {
  const q = query(c, schemas.page);
  const category = z.string().trim().max(30).optional().parse(c.req.query("category")) || undefined;
  return c.json(await rooms.listRooms(q.cursor, q.limit, "AUDIO", category));
});
// Home "Friends": rooms and live streams where people you follow are right now.
roomRoutes.get("/me/following/active", async (c) => c.json({ items: await rooms.friendsActivity(c.get("user").id) }));

roomRoutes.post("/rooms", async (c) => {
  const { visibility, ...input } = await json(c, schemas.createRoom);
  return c.json(await rooms.createRoom(c.get("user"), input), 201);
});

roomRoutes.get("/rooms/:roomId", async (c) => c.json(await rooms.getSnapshot(roomId(c))));
roomRoutes.get("/me/room", async (c) => c.json({ room: await rooms.getMyRoom(c.get("user")) }));
// Locked rooms need { password } (4 digits); no body is fine otherwise.
const joinBody = z.object({ password: z.string().regex(/^\d{4}$/).optional() });
roomRoutes.post("/rooms/:roomId/join", async (c) => {
  const { password } = joinBody.parse(await c.req.json().catch(() => ({})));
  return c.json(await rooms.joinRoom(c.get("user"), roomId(c), password));
});
roomRoutes.post("/rooms/:roomId/leave", async (c) => c.json(await rooms.leaveRoom(c.get("user"), roomId(c))));
roomRoutes.post("/rooms/:roomId/chat/clear", async (c) => c.json(await chat.clearChat(c.get("user"), roomId(c))));
roomRoutes.post("/rooms/:roomId/invite", async (c) => {
  const { userIds } = await json(c, z.object({ userIds: z.array(schemas.uuid).min(1).max(50) }));
  return c.json(await rooms.inviteFriends(c.get("user"), roomId(c), userIds));
});

roomRoutes.post("/rooms/:roomId/seat-count", async (c) => {
  const { seatCount } = await json(c, schemas.createRoom.pick({ seatCount: true }));
  return c.json(await rooms.setSeatCount(c.get("user"), roomId(c), seatCount));
});

// Room settings: any subset of these fields. Owner and admins only.
const settingsSchema = z
  .object({
    title: z.string().trim().min(1).max(60),
    background: z.enum(rooms.ROOM_BACKGROUNDS),
    showEntry: z.boolean(),
    giftAnimations: z.boolean(),
    privacy: z.enum(["PUBLIC", "LOCKED", "PRIVATE"]),
    password: z.string().regex(/^\d{4}$/, "Password must be 4 digits"),
  })
  .partial();
roomRoutes.patch("/rooms/:roomId/settings", async (c) => c.json(await rooms.updateSettings(c.get("user"), roomId(c), await json(c, settingsSchema))));

// Room image: a JPEG/PNG upload (multipart "file"), stored like post photos and served from /v1/uploads.
roomRoutes.post("/rooms/:roomId/cover", async (c) => {
  const id = roomId(c);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new AppError("FILE_REQUIRED", 400, "Choose a photo");
  const { name } = await store(file, ["image"]);
  return c.json(await rooms.updateSettings(c.get("user"), id, { coverUrl: `/v1/uploads/${name}` }));
});

// Custom room background: a JPEG/PNG (multipart "file"). Owner and admins only; picking a preset afterwards replaces it.
roomRoutes.post("/rooms/:roomId/background", async (c) => {
  const id = roomId(c);
  await rooms.assertRoomAdmin(id, c.get("user").id); // before storing anything
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new AppError("FILE_REQUIRED", 400, "Choose a photo");
  const { name } = await store(file, ["image"]);
  return c.json(await rooms.updateSettings(c.get("user"), id, { backgroundUrl: `/v1/uploads/${name}` }));
});

// Charisma counter on (from zero) / off. Owner and admins only.
roomRoutes.post("/rooms/:roomId/charisma", async (c) => {
  const { on } = await json(c, z.object({ on: z.boolean() }));
  return c.json(await rooms.setCharisma(c.get("user"), roomId(c), on));
});

// Ludo mode on (opens a lobby) / off (ends any game). Owner and admins only.
roomRoutes.post("/rooms/:roomId/ludo", async (c) => {
  const { on } = await json(c, z.object({ on: z.boolean() }));
  return c.json(await ludo.setMode(c.get("user"), roomId(c), on));
});

// Video mode on / off, the video everyone watches (a YouTube id), and pause/resume/jump. Owner and admins only.
roomRoutes.post("/rooms/:roomId/video", async (c) => {
  const { on } = await json(c, z.object({ on: z.boolean() }));
  return c.json(await video.setMode(c.get("user"), roomId(c), on));
});
roomRoutes.put("/rooms/:roomId/video", async (c) => {
  const { videoId } = await json(c, z.object({ videoId: z.string().regex(video.VIDEO_ID) }));
  return c.json(await video.play(c.get("user"), roomId(c), videoId));
});
roomRoutes.post("/rooms/:roomId/video/playback", async (c) => {
  const b = await json(c, z.object({ playing: z.boolean(), position: z.number().min(0).max(86_400).optional() }));
  return c.json(await video.control(c.get("user"), roomId(c), b.playing, b.position));
});

// PK 1v1 between two seated people (owner and admins); DELETE cancels it.
roomRoutes.post("/rooms/:roomId/pk", async (c) => {
  const b = await json(c, z.object({ a: schemas.uuid, b: schemas.uuid, minutes: z.union([z.literal(3), z.literal(5), z.literal(10), z.literal(15)]) })); // rooms.PK_MINUTES
  return c.json(await rooms.startPk(c.get("user"), roomId(c), b.a, b.b, b.minutes));
});
roomRoutes.delete("/rooms/:roomId/pk", async (c) => c.json(await rooms.stopPk(c.get("user"), roomId(c))));

// Top gifters in this room, this week or this month (room members).
roomRoutes.get("/rooms/:roomId/top-gifters", async (c) => {
  const id = roomId(c);
  const { period } = z.object({ period: z.enum(["week", "month"]).default("week") }).parse(c.req.query());
  await rooms.assertMember(id, c.get("user").id);
  return c.json(await gifts.topGifters(id, period));
});

// Weekly rank among all rooms and the heart level (room members).
roomRoutes.get("/rooms/:roomId/stats", async (c) => {
  const id = roomId(c);
  await rooms.assertMember(id, c.get("user").id);
  return c.json(await rooms.roomStats(id));
});

roomRoutes.post("/rooms/:roomId/zego-token", async (c) => {
  const id = roomId(c);
  await rooms.assertMember(id, c.get("user").id);
  return c.json(await rooms.zegoCredentials(id, c.get("user").id));
});

roomRoutes.post("/rooms/:roomId/seats/:seatIndex/claim", async (c) =>
  c.json(await rooms.claimSeat(c.get("user"), roomId(c), schemas.seatIndex.parse(c.req.param("seatIndex")))),
);
roomRoutes.post("/rooms/:roomId/seats/:seatIndex/release", async (c) =>
  c.json(await rooms.releaseSeat(c.get("user"), roomId(c), schemas.seatIndex.parse(c.req.param("seatIndex")))),
);

const seatIdx = (c: { req: { param: (k: "seatIndex") => string } }) => schemas.seatIndex.parse(c.req.param("seatIndex"));

roomRoutes.post("/rooms/:roomId/seats/:seatIndex/lock", async (c) => {
  const { locked } = await json(c, z.object({ locked: z.boolean() }));
  return c.json(await rooms.setSeatLocked(c.get("user"), roomId(c), seatIdx(c), locked));
});
roomRoutes.post("/rooms/:roomId/seats/:seatIndex/invite", async (c) => {
  const { userId } = await json(c, z.object({ userId: z.uuid() }));
  return c.json(await rooms.inviteToSeat(c.get("user"), roomId(c), seatIdx(c), userId));
});
roomRoutes.post("/rooms/:roomId/seats/:seatIndex/accept-invite", async (c) =>
  c.json(await rooms.claimSeat(c.get("user"), roomId(c), seatIdx(c), { invited: true })),
);
roomRoutes.post("/rooms/:roomId/invite/decline", async (c) => c.json(await rooms.declineInvite(c.get("user"), roomId(c))));

const targetId = (c: { req: { param: (k: "userId") => string } }) => schemas.uuid.parse(c.req.param("userId"));

roomRoutes.post("/rooms/:roomId/admins/:userId", async (c) => c.json(await rooms.setAdmin(c.get("user"), roomId(c), targetId(c), true)));
roomRoutes.delete("/rooms/:roomId/admins/:userId", async (c) => c.json(await rooms.setAdmin(c.get("user"), roomId(c), targetId(c), false)));
roomRoutes.get("/rooms/:roomId/kicked", async (c) => c.json(await rooms.listKicked(c.get("user"), roomId(c))));
roomRoutes.delete("/rooms/:roomId/kicked/:userId", async (c) => c.json(await rooms.unkick(c.get("user"), roomId(c), targetId(c))));

roomRoutes.post("/rooms/:roomId/participants/:userId/unseat", async (c) => c.json(await rooms.removeFromSeat(c.get("user"), roomId(c), targetId(c))));

roomRoutes.post("/rooms/:roomId/participants/:userId/remove", async (c) =>
  c.json(await rooms.removeParticipant(c.get("user"), roomId(c), schemas.uuid.parse(c.req.param("userId")))),
);
roomRoutes.post("/rooms/:roomId/participants/:userId/mute", async (c) => {
  const { muted } = await json(c, z.object({ muted: z.boolean().default(true) }));
  return c.json(await rooms.setMicMuted(c.get("user"), roomId(c), schemas.uuid.parse(c.req.param("userId")), muted));
});

roomRoutes.get("/rooms/:roomId/messages", async (c) => {
  const q = query(c, schemas.numericPage);
  return c.json(await chat.history(c.get("user"), roomId(c), q.cursor, q.limit));
});
roomRoutes.post("/rooms/:roomId/messages", async (c) => c.json(await chat.sendChat(c.get("user"), roomId(c), await json(c, schemas.chat)), 201));

roomRoutes.get("/rooms/:roomId/gifts/eligible-recipients", async (c) => c.json(await rooms.eligibleRecipients(c.get("user"), roomId(c))));
roomRoutes.post("/rooms/:roomId/gifts/all-seated", async (c) =>
  c.json(await gifts.sendGiftToAllSeated(c.get("user"), roomId(c), await json(c, schemas.giftAll), c.req.header("Idempotency-Key"))),
);
roomRoutes.post("/rooms/:roomId/gifts", async (c) =>
  c.json(await gifts.sendGift(c.get("user"), roomId(c), await json(c, schemas.gift), c.req.header("Idempotency-Key"))),
);

roomRoutes.get("/gifts", async (c) => c.json(await gifts.listGifts()));
roomRoutes.get("/wallet", async (c) => c.json({ balance: await gifts.getBalance(c.get("user").id) }));
roomRoutes.get("/wallet/packages", (c) => c.json(recharge.PACKAGES));
roomRoutes.post("/wallet/recharge", async (c) => {
  const { packageId } = await json(c, z.object({ packageId: z.string().min(1).max(64) }));
  return c.json(await recharge.recharge(c.get("user"), packageId, c.req.header("Idempotency-Key")));
});
roomRoutes.get("/wallet/transactions", async (c) => {
  const q = query(c, schemas.numericPage);
  return c.json(await gifts.ledger(c.get("user").id, q.cursor, q.limit));
});

// ---------- live streams ----------
roomRoutes.get("/lives", async (c) => {
  const q = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(c.req.query());
  return c.json(await live.listLives(q.cursor, q.limit));
});
roomRoutes.get("/me/live", async (c) => c.json({ room: await rooms.getMyRoom(c.get("user"), "LIVE") }));
roomRoutes.post("/lives", async (c) => {
  const { title } = await json(c, z.object({ title: z.string().trim().min(1).max(60) }));
  return c.json(await live.startLive(c.get("user"), title), 201);
});
roomRoutes.post("/lives/:roomId/end", async (c) => c.json(await live.endLive(c.get("user"), roomId(c))));

// Live PK: the running battle for a live room; invite another live host; the invited host accepts or declines; either ends it.
roomRoutes.get("/lives/:roomId/pk", async (c) => {
  const id = roomId(c);
  await rooms.assertMember(id, c.get("user").id);
  return c.json({ pk: await live.livePkFor(id) });
});
roomRoutes.post("/lives/:roomId/pk", async (c) => {
  const b = await json(c, z.object({ targetRoomId: schemas.uuid, minutes: z.union([z.literal(3), z.literal(5), z.literal(10)]) })); // live.LIVE_PK_MINUTES
  return c.json(await live.invitePk(c.get("user"), roomId(c), b.targetRoomId, b.minutes));
});
const pkId = (c: { req: { param: (k: "pkId") => string } }) => schemas.uuid.parse(c.req.param("pkId"));
roomRoutes.post("/live-pks/:pkId/accept", async (c) => c.json(await live.acceptPk(c.get("user"), pkId(c))));
roomRoutes.post("/live-pks/:pkId/decline", async (c) => c.json(await live.declinePk(c.get("user"), pkId(c))));
roomRoutes.delete("/live-pks/:pkId", async (c) => c.json(await live.cancelPk(c.get("user"), pkId(c))));
// Live streams: your seat's camera off (audio only) / on.
roomRoutes.post("/rooms/:roomId/camera", async (c) => {
  const { off } = await json(c, z.object({ off: z.boolean() }));
  return c.json(await rooms.setCameraOff(c.get("user"), roomId(c), off));
});
// Staff: pin a room to the top of the list (up to 4, the official room included) or unpin it.
roomRoutes.post("/rooms/:roomId/pin", async (c) => {
  const { pinned } = await json(c, z.object({ pinned: z.boolean() }));
  return c.json(await rooms.setPinned(c.get("user"), roomId(c), pinned));
});
