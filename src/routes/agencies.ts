import { Hono } from "hono";
import { z } from "zod";
import { json, requireAuth, schemas, type Env } from "../http";
import { levelTable } from "../lib/salaryLevels";
import * as agencies from "../services/agencies";
import { findUserByRef } from "../services/auth";

// Agencies in the app: hosts apply / accept invites / ask to leave; the owner invites and approves.
export const agencyRoutes = new Hono<Env>();
agencyRoutes.use("/agencies/*", requireAuth);

const userId = (c: { req: { param: (k: "userId") => string } }) => schemas.uuid.parse(c.req.param("userId"));

// The salary level table and mic rules, so the app never hardcodes them.
agencyRoutes.get("/agencies/levels", (c) => c.json(levelTable()));
agencyRoutes.get("/agencies/me",async (c) => c.json(await agencies.myAgency(c.get("user").id)));
agencyRoutes.get("/agencies/code/:code", async (c) => c.json(await agencies.byCode(z.coerce.number().int().min(1).max(2_000_000_000).parse(c.req.param("code")))));
agencyRoutes.post("/agencies/:agencyId/apply", async (c) => c.json(await agencies.apply(c.get("user"), schemas.uuid.parse(c.req.param("agencyId")))));
agencyRoutes.post("/agencies/me/cancel", async (c) => c.json(await agencies.cancelRequest(c.get("user"))));
agencyRoutes.post("/agencies/me/accept", async (c) => c.json(await agencies.acceptInvite(c.get("user"))));
agencyRoutes.post("/agencies/me/leave", async (c) => c.json(await agencies.requestLeave(c.get("user"))));

// The agency I own.
agencyRoutes.get("/agencies/owned", async (c) => c.json(await agencies.ownerView(c.get("user"))));
agencyRoutes.post("/agencies/owned/invite", async (c) => {
  const b = await json(c, z.object({ user: z.string().trim().min(1).max(40) }));
  return c.json(await agencies.invite(c.get("user"), await findUserByRef(b.user)));
});
agencyRoutes.post("/agencies/owned/people/:userId/approve", async (c) => c.json(await agencies.approve(c.get("user"), userId(c))));
agencyRoutes.delete("/agencies/owned/people/:userId", async (c) => c.json(await agencies.removePerson(c.get("user"), userId(c))));
