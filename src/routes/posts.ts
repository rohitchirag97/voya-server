import { and, desc, eq, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db";
import { postComments, postLikes, posts, users } from "../db/schema";
import { json, requireAuth, schemas, type Env } from "../http";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { assertCanParticipate } from "../services/auth";
import { userSummary } from "../services/rooms";

export const postRoutes = new Hono<Env>();
postRoutes.use("/posts", requireAuth);
postRoutes.use("/posts/*", requireAuth);
postRoutes.use("/users/:userId/posts", requireAuth);

// shortcut: media files live on this server's disk; move to object storage (S3/R2) + CDN before running more than one instance.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024; // ~60s of phone video after on-device compression
const MAX_GIF_BYTES = 2 * 1024 * 1024; // animated profile pictures stay light: they play everywhere a face shows
const FILE_NAME = /^[0-9a-f-]{36}\.(jpg|png|gif|mp4|mov)$/;
const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime" };

// Only real JPEG/PNG/MP4/MOV bytes are stored, whatever the client claims.
export function mediaExt(head: Uint8Array) {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
  if (/^GIF8[79]a$/.test(String.fromCharCode(...head.slice(0, 6)))) return "gif";
  // ISO media files carry "ftyp" at byte 4; QuickTime brand "qt  " means .mov.
  if (String.fromCharCode(...head.slice(4, 8)) === "ftyp") return String.fromCharCode(...head.slice(8, 12)) === "qt  " ? "mov" : "mp4";
  return null;
}

// Saves an uploaded photo/video under uploadsDir after sniffing its real type; also used for room covers.
// "gif" is its own kind: only allowed where asked for (SVIP3+ profile pictures).
export async function store(file: File, allowed: ("image" | "video" | "gif")[]) {
  const ext = mediaExt(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  const isVideo = ext === "mp4" || ext === "mov";
  if (!ext || !allowed.includes(isVideo ? "video" : ext === "gif" ? "gif" : "image")) throw new AppError("BAD_MEDIA", 400, allowed.includes("video") ? "Only photos (JPEG/PNG) or videos (MP4)" : "Only JPEG or PNG images");
  if (ext === "gif" && file.size > MAX_GIF_BYTES) throw new AppError("MEDIA_TOO_LARGE", 413, "GIF is too large (max 2 MB)");
  if (file.size > (isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) throw new AppError("MEDIA_TOO_LARGE", 413, isVideo ? "Video is too large (max 60 MB)" : "Photo is too large (max 10 MB)");
  const name = `${randomUUID()}.${ext}`;
  await mkdir(config.uploadsDir, { recursive: true });
  await Bun.write(join(config.uploadsDir, name), file);
  return { name, isVideo };
}

const likes = sql<number>`(select count(*) from ${postLikes} where ${postLikes.postId} = ${posts.id})`.mapWith(Number);
const comments = sql<number>`(select count(*) from ${postComments} where ${postComments.postId} = ${posts.id})`.mapWith(Number);
const likedBy = (me: string) => sql<boolean>`exists(select 1 from ${postLikes} where ${postLikes.postId} = ${posts.id} and ${postLikes.userId} = ${me})`;
const url = (name: string | null) => (name ? `/v1/uploads/${name}` : null);

// Newest first; cursor is the last post's createdAt (ISO).
async function listPosts(me: string, authorId: string | undefined, cursor: string | undefined, limit: number) {
  const before = cursor ? new Date(cursor) : null;
  if (before && Number.isNaN(before.getTime())) throw new AppError("BAD_CURSOR", 400);
  const rows = await db
    .select({
      postId: posts.id,
      kind: posts.kind,
      image: posts.image,
      video: posts.video,
      width: posts.width,
      height: posts.height,
      caption: posts.caption,
      createdAt: posts.createdAt,
      author: userSummary,
      likes,
      comments,
      likedByMe: likedBy(me),
    })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.userId))
    .where(and(authorId ? eq(posts.userId, authorId) : undefined, before ? lt(posts.createdAt, before) : undefined))
    .orderBy(desc(posts.createdAt))
    .limit(limit + 1);
  // imageUrl = the photo, or a video's poster frame.
  const page = rows.slice(0, limit).map(({ image, video, ...p }) => ({ ...p, imageUrl: url(image), videoUrl: url(video) }));
  return { posts: page, nextCursor: rows.length > limit ? page.at(-1)!.createdAt.toISOString() : null };
}

postRoutes.get("/posts", async (c) => {
  const q = schemas.page.parse(c.req.query());
  return c.json(await listPosts(c.get("user").id, undefined, q.cursor, q.limit));
});

postRoutes.get("/users/:userId/posts", async (c) => {
  const q = schemas.page.parse(c.req.query());
  return c.json(await listPosts(c.get("user").id, schemas.uuid.parse(c.req.param("userId")), q.cursor, q.limit));
});

// Multipart: caption, plus file (photo or video) with width/height; a video also sends thumb (its poster frame).
// No file = a text post, which needs a caption.
const dims = z.coerce.number().int().min(1).max(20_000);
postRoutes.post("/posts", async (c) => {
  const user = c.get("user");
  assertCanParticipate(user);
  rateLimit(`post:${user.id}`, 10, 60_000);
  const form = await c.req.formData().catch(() => null);
  if (!form) throw new AppError("BAD_UPLOAD", 400, "Send the post as multipart form data");
  const caption = z.string().trim().max(2000).parse(form.get("caption") ?? "");
  const file = form.get("file");

  if (!(file instanceof File)) {
    if (!caption) throw new AppError("EMPTY_POST", 400, "Write something or add a photo or video");
    const [p] = await db.insert(posts).values({ userId: user.id, kind: "TEXT", caption }).returning();
    return c.json({ postId: p!.id }, 201);
  }

  const width = dims.parse(form.get("width"));
  const height = dims.parse(form.get("height"));
  const media = await store(file, ["image", "video"]);
  let poster: string | null = null;
  if (media.isVideo) {
    const thumb = form.get("thumb");
    if (!(thumb instanceof File)) {
      await unlink(join(config.uploadsDir, media.name)).catch(() => {});
      throw new AppError("THUMB_REQUIRED", 400, "Video posts need a poster frame");
    }
    poster = (await store(thumb, ["image"])).name;
  }
  const [p] = await db
    .insert(posts)
    .values(
      media.isVideo
        ? { userId: user.id, kind: "VIDEO", video: media.name, image: poster, width, height, caption }
        : { userId: user.id, kind: "IMAGE", image: media.name, width, height, caption },
    )
    .returning();
  return c.json({ postId: p!.id }, 201);
});

postRoutes.delete("/posts/:postId", async (c) => {
  const id = schemas.uuid.parse(c.req.param("postId"));
  const [p] = await db.delete(posts).where(and(eq(posts.id, id), eq(posts.userId, c.get("user").id))).returning();
  if (!p) throw new AppError("POST_NOT_FOUND", 404);
  for (const name of [p.image, p.video]) if (name) await unlink(join(config.uploadsDir, name)).catch(() => {});
  return c.json({ ok: true });
});

const setLike = async (postId: string, userId: string, on: boolean) => {
  const [p] = await db.select({ id: posts.id }).from(posts).where(eq(posts.id, postId));
  if (!p) throw new AppError("POST_NOT_FOUND", 404);
  if (on) await db.insert(postLikes).values({ postId, userId }).onConflictDoNothing();
  else await db.delete(postLikes).where(and(eq(postLikes.postId, postId), eq(postLikes.userId, userId)));
  const [r] = await db.select({ likes }).from(posts).where(eq(posts.id, postId));
  return { likes: r!.likes, likedByMe: on };
};
postRoutes.post("/posts/:postId/like", async (c) => c.json(await setLike(schemas.uuid.parse(c.req.param("postId")), c.get("user").id, true)));
postRoutes.delete("/posts/:postId/like", async (c) => c.json(await setLike(schemas.uuid.parse(c.req.param("postId")), c.get("user").id, false)));

// Public: file names are random UUIDs, and the image/video players can't easily send auth headers.
// Supports Range requests so videos start playing before they finish downloading.
postRoutes.get("/uploads/:name", async (c) => {
  const name = c.req.param("name");
  if (!FILE_NAME.test(name)) throw new AppError("NOT_FOUND", 404);
  const f = Bun.file(join(config.uploadsDir, name));
  if (!(await f.exists())) throw new AppError("NOT_FOUND", 404);
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[name.split(".").pop()!]!,
    "cache-control": "public, max-age=31536000, immutable",
    "accept-ranges": "bytes",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (range && (range[1] || range[2])) {
    const size = f.size;
    // "bytes=a-b", "bytes=a-" or the last n bytes "bytes=-n".
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    return new Response(f.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(f, { headers });
});

// ---------- comments ----------

const commentCols = { id: postComments.id, body: postComments.body, createdAt: postComments.createdAt, user: userSummary };
const postExists = async (postId: string) => {
  const [p] = await db.select({ userId: posts.userId }).from(posts).where(eq(posts.id, postId));
  if (!p) throw new AppError("POST_NOT_FOUND", 404);
  return p;
};

// Newest first; cursor = the oldest comment id already loaded.
postRoutes.get("/posts/:postId/comments", async (c) => {
  const postId = schemas.uuid.parse(c.req.param("postId"));
  const q = schemas.numericPage.parse(c.req.query());
  await postExists(postId);
  const rows = await db
    .select(commentCols)
    .from(postComments)
    .innerJoin(users, eq(users.id, postComments.userId))
    .where(and(eq(postComments.postId, postId), q.cursor ? lt(postComments.id, q.cursor) : undefined))
    .orderBy(desc(postComments.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return c.json({ comments: page, nextCursor: rows.length > q.limit ? String(page.at(-1)!.id) : null });
});

postRoutes.post("/posts/:postId/comments", async (c) => {
  const user = c.get("user");
  assertCanParticipate(user);
  const postId = schemas.uuid.parse(c.req.param("postId"));
  const b = await json(c, z.object({ body: z.string().trim().min(1, "Write a comment").max(500) }));
  rateLimit(`comment:${user.id}`, 20, 60_000);
  await postExists(postId);
  const [row] = await db.insert(postComments).values({ postId, userId: user.id, body: b.body }).returning();
  const [full] = await db.select(commentCols).from(postComments).innerJoin(users, eq(users.id, postComments.userId)).where(eq(postComments.id, row!.id));
  return c.json(full, 201);
});

// The commenter can delete their comment; the post owner can delete any comment on their post.
postRoutes.delete("/posts/:postId/comments/:commentId", async (c) => {
  const me = c.get("user").id;
  const postId = schemas.uuid.parse(c.req.param("postId"));
  const commentId = z.coerce.number().int().positive().parse(c.req.param("commentId"));
  const post = await postExists(postId);
  const [cm] = await db.select({ userId: postComments.userId }).from(postComments).where(and(eq(postComments.id, commentId), eq(postComments.postId, postId)));
  if (!cm) throw new AppError("COMMENT_NOT_FOUND", 404);
  if (cm.userId !== me && post.userId !== me) throw new AppError("FORBIDDEN", 403, "You can only delete your own comments");
  await db.delete(postComments).where(eq(postComments.id, commentId));
  return c.json({ ok: true });
});
