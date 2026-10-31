import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { User } from "./db/schema";
import { AppError } from "./lib/errors";
import { authenticate } from "./services/auth";

export type Env = { Variables: { user: User; sessionId: string; requestId: string } };

export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const { user, sessionId } = await authenticate(c.req.header("Authorization")?.replace(/^Bearer /, ""));
  c.set("user", user);
  c.set("sessionId", sessionId);
  await next();
});

export const json = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> =>
  schema.parse(await c.req.json().catch(() => ({})));

// Shared by REST and Socket.IO so both transports validate identically.
export const schemas = {
  page: z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
  numericPage: z.object({ cursor: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(50).default(30) }),
  createRoom: z.object({
    title: z.string().trim().min(1).max(60),
    category: z.string().trim().max(30).optional(),
    coverUrl: z.url().max(500).optional(),
    // shortcut: PRIVATE rooms need invite links (ROOM-019), not built yet; only PUBLIC is accepted.
    visibility: z.literal("PUBLIC").default("PUBLIC"),
    seatCount: z.literal([8, 10, 12, 16, 20]),
  }),
  chat: z.object({
    body: z.string().max(500),
    mentions: z.array(z.object({ userId: z.uuid(), handle: z.string().optional() })).max(10).default([]),
    clientMessageId: z.string().min(1).max(64),
  }),
  gift: z.object({ recipientUserId: z.uuid(), giftId: z.string().min(1).max(64), quantity: z.number().int().min(1).max(9999) }),
  giftAll: z.object({ giftId: z.string().min(1).max(64), quantity: z.number().int().min(1).max(9999) }),
  seatIndex: z.coerce.number().int().min(0).max(19),
  uuid: z.uuid(),
  coins: z.number().int().min(1).max(10_000_000),
  // Sent by the client once per intended transfer, so a retried or double-submitted request moves coins once.
  idempotencyKey: z.string().min(8).max(64),
};
