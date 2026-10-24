import { Hono } from "hono";
import { z } from "zod";
import { json, requireAuth, schemas, type Env } from "../http";
import { cancel, CP_TYPES, endPair, propose, PROPOSAL_TTL_MS, respond, SIBLING_LABELS } from "../services/cp";

export const cpRoutes = new Hono<Env>();
cpRoutes.use("/cp/*", requireAuth);

// Types, slot limits and prices, so the app never hardcodes them.
cpRoutes.get("/cp/options", (c) => c.json({ types: CP_TYPES, siblingLabels: SIBLING_LABELS, proposalTtlMs: PROPOSAL_TTL_MS }));

cpRoutes.post("/cp/proposals", async (c) => {
  const b = await json(c, z.object({ toUserId: schemas.uuid, type: z.enum(["LOVE", "BESTIE", "SIBLING"]), label: z.enum(SIBLING_LABELS).optional() }));
  return c.json(await propose(c.get("user"), b), 201);
});

const id = (c: { req: { param: (k: "id") => string } }) => schemas.uuid.parse(c.req.param("id"));
cpRoutes.post("/cp/proposals/:id/accept", async (c) => c.json(await respond(c.get("user"), id(c), true)));
cpRoutes.post("/cp/proposals/:id/decline", async (c) => c.json(await respond(c.get("user"), id(c), false)));
cpRoutes.post("/cp/proposals/:id/cancel", async (c) => c.json(await cancel(c.get("user"), id(c))));
cpRoutes.delete("/cp/pairs/:id", async (c) => {
  await endPair(c.get("user"), id(c));
  return c.json({ ended: true });
});
