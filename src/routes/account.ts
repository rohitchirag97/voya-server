import { and, asc, count, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db, isUniqueViolation, pgCode } from "../db";
import { blocks, cosmetics, directMessages, follows, posts, profileLikes, profileVisits, reports, roomParticipants, rooms, users } from "../db/schema";
import { json, requireAuth, schemas, type Env } from "../http";
import { io, isOnline, userChannel } from "../io";
import { AppError } from "../lib/errors";
import { impersonatingBio, reservedName } from "../lib/impersonation";
import { ageOn, INTERESTS, MAX_COVERS, MAX_INTERESTS, MAX_PINNED_BADGES, MIN_AGE } from "../lib/profileOptions";
import { mediaExt, store } from "./posts";
import { levelInfo } from "../lib/levels";
import { rateLimit } from "../lib/rateLimit";
import { changePhone, linkGoogle, linkPhone, refresh, requestOtp, revokeSession, verifyCurrentPhone, verifyGoogle, verifyOtp } from "../services/auth";
import { activeBadges, badgeCatalog } from "../services/badges";
import { weeklyGiftStats } from "../services/gifts";
import { onBlock, relationshipsOf } from "../services/cp";
import { myFamily } from "../services/families";
import { pushDm } from "../services/dmPush";
import { userSummary } from "../services/rooms";
import { cosmeticMinSvip, SVIP_PERKS, svipOf, svipStatus, visibleAvatar, wearable } from "../services/svip";
import { nameError, normalizeName } from "../lib/displayName";

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, "E.164 phone number, e.g. +919876543210");
const publicUser = (u: typeof users.$inferSelect) => ({
  userId: u.id,
  publicId: u.publicId,
  specialId: u.specialId,
  displayName: u.displayName,
  avatarUrl: u.avatarUrl,
  bio: u.bio,
  gender: u.gender,
  birthday: u.birthday,
  hometown: u.hometown,
  interests: u.interests,
  coverUrls: u.coverUrls,
  status: u.status,
  staffRole: u.staffRole,
  level: levelInfo(u.xp),
});

export const account = new Hono<Env>();

account.post("/auth/otp/request", async (c) => c.json(await requestOtp((await json(c, z.object({ phone }))).phone)));

account.post("/auth/otp/verify", async (c) => {
  const b = await json(c, z.object({ phone, code: z.string().regex(/^\d{6}$/) }));
  const { user, ...tokens } = await verifyOtp(b.phone, b.code);
  return c.json({ user: publicUser(user), ...tokens });
});

account.post("/auth/google", async (c) => {
  const { user, ...tokens } = await verifyGoogle((await json(c, z.object({ idToken: z.string().min(1).max(4096) }))).idToken);
  return c.json({ user: publicUser(user), ...tokens });
});

account.post("/auth/refresh", async (c) => c.json(await refresh((await json(c, z.object({ refreshToken: z.string().min(1) }))).refreshToken)));

account.use("/auth/logout", requireAuth);
account.post("/auth/logout", async (c) => {
  await revokeSession(c.get("sessionId"));
  io.in(userChannel(c.get("user").id)).disconnectSockets();
  return c.json({ ok: true });
});

account.use("/me/*", requireAuth);
account.use("/me", requireAuth);
account.use("/users/*", requireAuth);
account.use("/reports", requireAuth);

account.get("/me", async (c) => {
  const u = c.get("user");
  // Sign-in methods are private: only you see your phone and whether Google is linked.
  return c.json({ ...publicUser(u), avatarUrl: visibleAvatar(u.avatarUrl, await svipOf(u.id)), phone: u.phone, googleLinked: !!u.googleSub });
});

account.post("/me/link/phone", async (c) => {
  const b = await json(c, z.object({ phone, code: z.string().regex(/^\d{6}$/) }));
  const u = await linkPhone(c.get("user").id, b.phone, b.code);
  return c.json({ phone: u.phone, googleLinked: !!u.googleSub });
});

account.post("/me/phone/verify-current", async (c) => {
  const b = await json(c, z.object({ code: z.string().regex(/^\d{6}$/) }));
  return c.json({ changeToken: await verifyCurrentPhone(c.get("user"), b.code) });
});

account.post("/me/phone/change", async (c) => {
  const b = await json(c, z.object({ changeToken: z.string().min(1).max(1024), phone, code: z.string().regex(/^\d{6}$/) }));
  const u = await changePhone(c.get("user").id, b.changeToken, b.phone, b.code);
  return c.json({ phone: u.phone, googleLinked: !!u.googleSub });
});

account.post("/me/link/google", async (c) => {
  const b = await json(c, z.object({ idToken: z.string().min(1).max(4096) }));
  const u = await linkGoogle(c.get("user").id, b.idToken);
  return c.json({ phone: u.phone, googleLinked: !!u.googleSub });
});
account.get("/me/svip", async (c) => c.json(await svipStatus(c.get("user").id)));
account.get("/profile-options", (c) => c.json({ interests: INTERESTS, maxInterests: MAX_INTERESTS, maxPinnedBadges: MAX_PINNED_BADGES, minAge: MIN_AGE, maxCovers: MAX_COVERS }));

// Profile picture and cover photos: JPEG/PNG uploads (multipart "file"), stored like post photos.
// `gif`: "allow" accepts an animated GIF; "svip3" refuses it with the SVIP3 perk message (profile picture below SVIP3); "no" = JPEG/PNG only.
const uploadedImage = async (c: { req: { formData: () => Promise<FormData> } }, gif: "allow" | "svip3" | "no" = "no") => {
  const file = (await c.req.formData().catch(() => null))?.get("file");
  if (!(file instanceof File)) throw new AppError("FILE_REQUIRED", 400, "Choose a photo");
  const isGif = mediaExt(new Uint8Array(await file.slice(0, 16).arrayBuffer())) === "gif";
  if (isGif && gif === "svip3") throw new AppError("SVIP_REQUIRED", 403, `Animated profile pictures are an SVIP${SVIP_PERKS.gifAvatar} perk`);
  return `/v1/uploads/${(await store(file, gif === "allow" ? ["image", "gif"] : ["image"])).name}`;
};
const setMe = async (id: string, patch: Partial<typeof users.$inferInsert>) =>
  publicUser((await db.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, id)).returning())[0]!);

account.post("/me/avatar", async (c) => {
  const me = c.get("user");
  const gif = (await svipOf(me.id)) >= SVIP_PERKS.gifAvatar ? "allow" : "svip3";
  return c.json(await setMe(me.id, { avatarUrl: await uploadedImage(c, gif) }));
});
account.delete("/me/avatar", async (c) => c.json(await setMe(c.get("user").id, { avatarUrl: null })));

// Adds a cover photo at the end (max MAX_COVERS).
account.post("/me/covers", async (c) => {
  const me = c.get("user");
  rateLimit(`cover:${me.id}`, 20, 3600_000);
  if (me.coverUrls.length >= MAX_COVERS) throw new AppError("COVERS_FULL", 409, `You can have up to ${MAX_COVERS} cover photos`);
  const url = await uploadedImage(c);
  // Appended in SQL so two uploads at once both land (and the cap still holds).
  const [u] = await db
    .update(users)
    .set({ coverUrls: sql`array_append(${users.coverUrls}, ${url})`, updatedAt: new Date() })
    .where(and(eq(users.id, me.id), sql`cardinality(${users.coverUrls}) < ${MAX_COVERS}`))
    .returning();
  if (!u) throw new AppError("COVERS_FULL", 409, `You can have up to ${MAX_COVERS} cover photos`);
  return c.json(publicUser(u));
});
// Reorder or remove cover photos: send the ones to keep, in order (only your existing photos).
account.put("/me/covers", async (c) => {
  const { coverUrls } = await json(c, z.object({ coverUrls: z.array(z.string().max(200)).max(MAX_COVERS) }));
  const me = c.get("user");
  const keep = [...new Set(coverUrls)];
  if (keep.some((u) => !me.coverUrls.includes(u))) throw new AppError("COVER_NOT_FOUND", 400, "Unknown cover photo");
  return c.json(await setMe(me.id, { coverUrls: keep }));
});

// Badge wall: which of your badges show at the top of your profile, in order.
account.put("/me/pinned-badges", async (c) => {
  const { badgeIds } = await json(c, z.object({ badgeIds: z.array(z.string().max(64)).max(MAX_PINNED_BADGES) }));
  const me = c.get("user").id;
  const owned = new Set((await activeBadges(me)).map((b) => b.id));
  const pinned = [...new Set(badgeIds)];
  if (pinned.some((id) => !owned.has(id))) throw new AppError("BADGE_NOT_OWNED", 400, "You can only pin badges you have");
  await db.update(users).set({ pinnedBadges: pinned, updatedAt: new Date() }).where(eq(users.id, me));
  return c.json({ pinnedBadges: pinned });
});

account.patch("/me/profile", async (c) => {
  const b = await json(
    c,
    z.object({
      displayName: z
        .string()
        .max(200)
        .transform(normalizeName)
        .superRefine((n, ctx) => {
          const e = nameError(n);
          if (e) ctx.addIssue({ code: "custom", message: e });
        })
        .optional(),
      bio: z.string().max(160).nullable().optional(),
      gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable().optional(),
      birthday: z.iso
        .date()
        .refine((d) => ageOn(d) >= MIN_AGE && ageOn(d) <= 100, `You must be at least ${MIN_AGE}`)
        .nullable()
        .optional(),
      hometown: z.string().trim().max(40).nullable().optional(),
      interests: z.array(z.enum(INTERESTS)).max(MAX_INTERESTS).optional(),
    }),
  );
  if (b.hometown === "") b.hometown = null;
  if (b.interests) b.interests = [...new Set(b.interests)];
  // Staff may use these words; everyone else is stopped from posing as staff.
  if (!c.get("user").staffRole) {
    if (b.displayName && reservedName(b.displayName)) throw new AppError("RESERVED_NAME", 400, "That name is reserved for official VoyaLive staff");
    if (b.bio && impersonatingBio(b.bio)) throw new AppError("IMPERSONATION", 400, "Your bio can't claim to be official VoyaLive staff");
  }
  try {
    const [u] = await db.update(users).set({ ...b, updatedAt: new Date() }).where(eq(users.id, c.get("user").id)).returning();
    return c.json(publicUser(u!));
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("DISPLAY_NAME_TAKEN", 409);
    throw e;
  }
});

const target = async (c: { req: { param: (k: "userId") => string } }, selfId: string) => {
  const id = schemas.uuid.parse(c.req.param("userId"));
  if (id === selfId) throw new AppError("CANNOT_TARGET_SELF", 400);
  return id;
};
const fkGuard = (e: unknown) => {
  if (pgCode(e) === "23503") throw new AppError("USER_NOT_FOUND", 404);
  throw e;
};

// Equipped decorations with their artwork, for rendering a profile.
async function decorationsOf(u: typeof users.$inferSelect) {
  const ids = [u.avatarFrameId, u.cardDecorId, u.chatBubbleId].filter((x): x is string => !!x);
  const rows = ids.length
    ? await db
        .select({ id: cosmetics.id, name: cosmetics.name, svg: cosmetics.svg, style: cosmetics.style, enabled: cosmetics.enabled })
        .from(cosmetics)
        .where(inArray(cosmetics.id, ids))
    : [];
  const svip = await svipOf(u.id);
  const mins = await cosmeticMinSvip();
  // SVIP items show only while the owner still has the tier.
  const pick = (id: string | null) => {
    const r = rows.find((x) => x.id === wearable(id, svip, mins) && x.enabled);
    return r ? { id: r.id, name: r.name, svg: r.svg, style: r.style } : null;
  };
  return { avatarFrame: pick(u.avatarFrameId), cardDecor: pick(u.cardDecorId), chatBubble: pick(u.chatBubbleId) };
}

account.use("/badges", requireAuth);
account.get("/badges", async (c) => c.json(await badgeCatalog()));
account.use("/cosmetics", requireAuth);
account.get("/cosmetics", async (c) =>
  c.json(
    await db
      .select({ id: cosmetics.id, kind: cosmetics.kind, name: cosmetics.name, svg: cosmetics.svg, style: cosmetics.style, minSvip: cosmetics.minSvip })
      .from(cosmetics)
      .where(eq(cosmetics.enabled, true))
      .orderBy(asc(cosmetics.kind), asc(cosmetics.sortOrder)),
  ),
);

// Equip or remove (null) your frame / card decoration / bubble. Every enabled item is free; SVIP items need the tier.
account.patch("/me/cosmetics", async (c) => {
  const slot = z.string().max(64).nullable().optional();
  const b = await json(c, z.object({ avatarFrameId: slot, cardDecorId: slot, chatBubbleId: slot }));
  let svip: number | undefined;
  const check = async (id: string | null | undefined, kind: "AVATAR_FRAME" | "CARD_DECOR" | "CHAT_BUBBLE") => {
    if (!id) return;
    const [row] = await db.select().from(cosmetics).where(and(eq(cosmetics.id, id), eq(cosmetics.enabled, true)));
    if (row?.kind !== kind) throw new AppError("COSMETIC_NOT_FOUND", 404);
    if (row.minSvip > (svip ??= await svipOf(c.get("user").id))) throw new AppError("SVIP_REQUIRED", 403, `Needs SVIP${row.minSvip}`);
  };
  await check(b.avatarFrameId, "AVATAR_FRAME");
  await check(b.cardDecorId, "CARD_DECOR");
  await check(b.chatBubbleId, "CHAT_BUBBLE");
  const [u] = await db.update(users).set({ ...b, updatedAt: new Date() }).where(eq(users.id, c.get("user").id)).returning();
  return c.json({ ...publicUser(u!), ...(await decorationsOf(u!)) });
});

// Find people by their 10-digit ID or their special ID, letters in any case (registered before /users/:userId).
account.get("/users/search", async (c) => {
  const q = z.object({ q: z.string().trim().regex(/^[A-Za-z0-9]{3,10}$/, "Enter an ID") }).parse(c.req.query()).q;
  rateLimit(`search:${c.get("user").id}`, 30, 60_000);
  const rows = await db
    .select({ ...userSummary, publicId: users.publicId, specialId: users.specialId })
    .from(users)
    .where(or(/^\d{10}$/.test(q) ? eq(users.publicId, Number(q)) : undefined, eq(users.specialId, q.toUpperCase())));
  return c.json({ users: rows });
});

account.get("/users/:userId", async (c) => {
  const id = schemas.uuid.parse(c.req.param("userId"));
  const me = c.get("user").id;
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) throw new AppError("USER_NOT_FOUND", 404);
  // Someone else opening this profile counts as a visit (one row per visitor, bumped each time); SVIP3+ visit invisibly.
  if (id !== me && (await svipOf(me)) < SVIP_PERKS.invisibleVisits)
    await db
      .insert(profileVisits)
      .values({ visitorId: me, visitedId: id })
      .onConflictDoUpdate({ target: [profileVisits.visitorId, profileVisits.visitedId], set: { visits: sql`${profileVisits.visits} + 1`, lastVisitedAt: new Date() } });
  return c.json(await profileOf(u, me));
});

// Profiles of several people at once (a room prefetches everyone so cards open instantly). Not a visit.
// shortcut: ~10 queries per person, capped at 50 ids; switch to grouped queries if rooms get big.
account.post("/users/cards", async (c) => {
  const { ids } = await json(c, z.object({ ids: z.array(schemas.uuid).min(1).max(50) }));
  const me = c.get("user").id;
  rateLimit(`cards:${me}`, 30, 60_000);
  const rows = await db.select().from(users).where(inArray(users.id, [...new Set(ids)]));
  return c.json({ profiles: await Promise.all(rows.map((u) => profileOf(u, me))) });
});

async function profileOf(u: typeof users.$inferSelect, me: string) {
  const id = u.id;
  const isMe = id === me;
  const svip = await svipOf(id);
  const [[followers], [following], [mine], [theirs], [postCount], [likeCount], [liked], [visitorCount], [friendCount]] = await Promise.all([
    db.select({ n: count() }).from(follows).where(eq(follows.followedId, id)),
    db.select({ n: count() }).from(follows).where(eq(follows.followerId, id)),
    db.select({ n: count() }).from(follows).where(and(eq(follows.followerId, me), eq(follows.followedId, id))),
    db.select({ n: count() }).from(follows).where(and(eq(follows.followerId, id), eq(follows.followedId, me))),
    db.select({ n: count() }).from(posts).where(eq(posts.userId, id)),
    db.select({ n: count() }).from(profileLikes).where(eq(profileLikes.likedId, id)),
    db.select({ n: count() }).from(profileLikes).where(and(eq(profileLikes.likerId, me), eq(profileLikes.likedId, id))),
    db.select({ n: count() }).from(profileVisits).where(eq(profileVisits.visitedId, id)),
    // Friends = mutual follows.
    db
      .execute<{ n: number }>(sql`select count(*)::int as n from ${follows} a join ${follows} b on b.follower_id = a.followed_id and b.followed_id = a.follower_id where a.follower_id = ${id}`)
      .then((r) => r.rows),
  ]);
  return {
    ...publicUser(u),
    avatarUrl: visibleAvatar(u.avatarUrl, svip), // a GIF only while they have SVIP3+
    followers: followers!.n,
    following: following!.n,
    friends: friendCount!.n,
    posts: postCount!.n,
    likes: likeCount!.n,
    likedByMe: liked!.n > 0,
    isFollowing: mine!.n > 0,
    followsMe: theirs!.n > 0, // drives "Follow back"
    ...(await decorationsOf(u)),
    ...(await badgesWithWall(u)),
    svip,
    inRoom: await currentRoom(u.id), // the live room they're in right now, so visitors can join them
    online: isOnline(u.id), // app open right now
    lastSeenAt: u.lastSeenAt, // when they were last around (shown when not online)
    week: await weeklyGiftStats(u.id), // gift contribution / charisma since Monday
    relationships: await relationshipsOf(u.id), // active CPs (Love, Best friends, Brother/Sister)
    family: (await myFamily(u.id)).family, // { familyId, name, role } or null
    isMe,
    visitors: isMe ? visitorCount!.n : undefined, // private: only the owner sees visitor numbers
  };
}

// People lists, newest first. Cursor = the last row's timestamp (ISO). isFollowing = do I follow them.
const pageQuery = z.object({ cursor: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(50).default(30) });
const iFollow = (me: string) => sql<boolean>`exists(select 1 from ${follows} f2 where f2.follower_id = ${me} and f2.followed_id = ${users.id})`;
const personCols = (me: string) => ({ ...userSummary, publicId: users.publicId, specialId: users.specialId, isFollowing: iFollow(me) });
const page = <T extends { at: Date }>(rows: T[], limit: number) => ({
  people: rows.slice(0, limit),
  nextCursor: rows.length > limit ? rows[limit - 1]!.at.toISOString() : null,
});

account.get("/users/:userId/followers", async (c) => {
  const id = schemas.uuid.parse(c.req.param("userId"));
  const q = pageQuery.parse(c.req.query());
  const rows = await db
    .select({ ...personCols(c.get("user").id), at: follows.createdAt })
    .from(follows)
    .innerJoin(users, eq(users.id, follows.followerId))
    .where(and(eq(follows.followedId, id), q.cursor ? lt(follows.createdAt, new Date(q.cursor)) : undefined))
    .orderBy(desc(follows.createdAt))
    .limit(q.limit + 1);
  return c.json(page(rows, q.limit));
});

account.get("/users/:userId/following", async (c) => {
  const id = schemas.uuid.parse(c.req.param("userId"));
  const q = pageQuery.parse(c.req.query());
  const rows = await db
    .select({ ...personCols(c.get("user").id), at: follows.createdAt })
    .from(follows)
    .innerJoin(users, eq(users.id, follows.followedId))
    .where(and(eq(follows.followerId, id), q.cursor ? lt(follows.createdAt, new Date(q.cursor)) : undefined))
    .orderBy(desc(follows.createdAt))
    .limit(q.limit + 1);
  return c.json(page(rows, q.limit));
});

// Only your own visitors: most recent visit first, with how many times they came.
// Online now / last seen, for a list of people (inbox rows, chat header).
account.post("/users/presence", async (c) => {
  const { ids } = await json(c, z.object({ ids: z.array(schemas.uuid).min(1).max(100) }));
  const rows = await db.select({ userId: users.id, lastSeenAt: users.lastSeenAt }).from(users).where(inArray(users.id, [...new Set(ids)]));
  return c.json({ presence: rows.map((r) => ({ ...r, online: isOnline(r.userId) })) });
});

// My friends (we follow each other), for inviting them to a room.
account.get("/me/friends", async (c) => {
  const me = c.get("user").id;
  const friends = await db
    .select(userSummary)
    .from(users)
    .where(
      sql`${users.id} in (select a.followed_id from ${follows} a join ${follows} b on b.follower_id = a.followed_id and b.followed_id = a.follower_id where a.follower_id = ${me})`,
    )
    .orderBy(asc(users.displayName))
    .limit(500);
  // Online first (they can get an invite banner right now), then by name.
  return c.json({ friends: friends.map((f) => ({ ...f, online: isOnline(f.userId) })).sort((a, b) => Number(b.online) - Number(a.online)) });
});

// Who liked my profile, newest first, with when. Only the owner sees it.
account.get("/me/likes", async (c) => {
  const me = c.get("user").id;
  const q = pageQuery.parse(c.req.query());
  const rows = await db
    .select({ ...personCols(me), at: profileLikes.createdAt })
    .from(profileLikes)
    .innerJoin(users, eq(users.id, profileLikes.likerId))
    .where(and(eq(profileLikes.likedId, me), q.cursor ? lt(profileLikes.createdAt, new Date(q.cursor)) : undefined))
    .orderBy(desc(profileLikes.createdAt))
    .limit(q.limit + 1);
  return c.json(page(rows, q.limit));
});

account.get("/me/visitors", async (c) => {
  const me = c.get("user").id;
  const q = pageQuery.parse(c.req.query());
  const rows = await db
    .select({ ...personCols(me), at: profileVisits.lastVisitedAt, visits: profileVisits.visits })
    .from(profileVisits)
    .innerJoin(users, eq(users.id, profileVisits.visitorId))
    .where(and(eq(profileVisits.visitedId, me), q.cursor ? lt(profileVisits.lastVisitedAt, new Date(q.cursor)) : undefined))
    .orderBy(desc(profileVisits.lastVisitedAt))
    .limit(q.limit + 1);
  return c.json(page(rows, q.limit));
});

account.post("/users/:userId/follow", async (c) => {
  const user = c.get("user");
  const followedId = await target(c, user.id);
  const added = await db.insert(follows).values({ followerId: user.id, followedId }).onConflictDoNothing().returning().catch(fkGuard);
  if (added.length) {
    // Live heads-up to the person followed (only reaches them while they have the app connected).
    const [back] = await db
      .select({ n: count() })
      .from(follows)
      .where(and(eq(follows.followerId, followedId), eq(follows.followedId, user.id)));
    io.to(userChannel(followedId)).emit("user:followed", {
      user: { userId: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl },
      youFollowThem: back!.n > 0,
    });
  }
  return c.json({ following: true });
});

// Like someone's profile (heart on the profile page). Idempotent both ways; returns the new count.
const likesOf = async (id: string) => (await db.select({ n: count() }).from(profileLikes).where(eq(profileLikes.likedId, id)))[0]!.n;
account.post("/users/:userId/like", async (c) => {
  const user = c.get("user");
  const me = user.id;
  const likedId = await target(c, me);
  rateLimit(`profileLike:${me}`, 30, 60_000);
  const added = await db.insert(profileLikes).values({ likerId: me, likedId }).onConflictDoNothing().returning().catch(fkGuard);
  if (added.length) await tellLiked(user, likedId).catch(() => {}); // a heads-up never fails the like
  return c.json({ likes: await likesOf(likedId), likedByMe: true });
});

// A new like lands in the liked person's inbox as a message from the liker (so it shows, counts as unread and
// notifies like any message). Not across a block, and at most once a day per pair, so unlike/like can't spam.
const LIKED_BODY = "❤️ liked your profile";
async function tellLiked(user: { id: string; displayName: string | null; avatarUrl: string | null }, likedId: string) {
  const [blocked] = await db
    .select({ a: blocks.blockerId })
    .from(blocks)
    .where(or(and(eq(blocks.blockerId, user.id), eq(blocks.blockedId, likedId)), and(eq(blocks.blockerId, likedId), eq(blocks.blockedId, user.id))));
  if (blocked) return;
  // Once a day per pair. shortcut: kept in memory (messages are deleted once delivered, so they can't be checked);
  // a server restart allows one more.
  try {
    rateLimit(`likeMsg:${user.id}:${likedId}`, 1, 86_400_000);
  } catch {
    return;
  }
  const [msg] = await db.insert(directMessages).values({ senderId: user.id, recipientId: likedId, body: LIKED_BODY }).returning();
  pushDm(msg!, user);
}
account.delete("/users/:userId/like", async (c) => {
  const me = c.get("user").id;
  const likedId = await target(c, me);
  await db.delete(profileLikes).where(and(eq(profileLikes.likerId, me), eq(profileLikes.likedId, likedId)));
  return c.json({ likes: await likesOf(likedId), likedByMe: false });
});

account.delete("/users/:userId/follow", async (c) => {
  const me = c.get("user").id;
  await db.delete(follows).where(and(eq(follows.followerId, me), eq(follows.followedId, await target(c, me))));
  return c.json({ following: false });
});

account.post("/users/:userId/block", async (c) => {
  const me = c.get("user").id;
  const them = await target(c, me);
  await db.insert(blocks).values({ blockerId: me, blockedId: them }).onConflictDoNothing().catch(fkGuard);
  await onBlock(me, them);
  return c.json({ blocked: true });
});

account.delete("/users/:userId/block", async (c) => {
  const me = c.get("user").id;
  await db.delete(blocks).where(and(eq(blocks.blockerId, me), eq(blocks.blockedId, await target(c, me))));
  return c.json({ blocked: false });
});

account.post("/reports", async (c) => {
  const me = c.get("user").id;
  rateLimit(`report:${me}`, 10, 3600_000);
  const b = await json(
    c,
    z.object({
      targetType: z.enum(["USER", "ROOM", "MESSAGE", "PROFILE"]),
      targetId: z.string().min(1).max(64),
      reason: z.string().min(1).max(64),
      details: z.string().max(1000).optional(),
      // Reported inbox messages, from the reporter's phone (chats aren't kept on the server; only these are).
      evidence: z
        .array(z.object({ senderId: z.string().max(64), body: z.string().max(1000), imageUrl: z.string().max(300).nullish(), createdAt: z.string().max(40) }))
        .max(50)
        .optional(),
    }),
  );
  const [r] = await db.insert(reports).values({ reporterId: me, ...b }).returning({ id: reports.id });
  return c.json({ reportId: r!.id }, 201);
});

// The live room someone is in right now (null if none). Joining it still goes through the normal checks (kicked, ended…).
async function currentRoom(userId: string) {
  const [r] = await db
    .select({ roomId: rooms.id, title: rooms.title, coverUrl: rooms.coverUrl, listeners: rooms.listenerCount, privacy: rooms.privacy, kind: rooms.kind })
    .from(roomParticipants)
    .innerJoin(rooms, eq(rooms.id, roomParticipants.roomId))
    // Private rooms never show on profiles.
    .where(and(eq(roomParticipants.userId, userId), isNull(roomParticipants.leftAt), eq(rooms.status, "LIVE"), ne(rooms.privacy, "PRIVATE")))
    .limit(1);
  return r ?? null;
}

// All the person's current badges, plus the pinned ones still owned (expired ones fall off the wall).
async function badgesWithWall(u: typeof users.$inferSelect) {
  const badges = await activeBadges(u.id);
  const owned = new Set(badges.map((b) => b.id));
  return { badges, pinnedBadges: u.pinnedBadges.filter((id) => owned.has(id)) };
}
