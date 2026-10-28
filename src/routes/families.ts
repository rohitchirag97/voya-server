import { Hono } from "hono";
import { z } from "zod";
import { json, requireAuth, schemas, type Env } from "../http";
import * as families from "../services/families";

export const familyRoutes = new Hono<Env>();
familyRoutes.use("/families", requireAuth);
familyRoutes.use("/families/*", requireAuth);

const id = (c: { req: { param: (k: "id") => string } }) => schemas.uuid.parse(c.req.param("id"));
const member = (c: { req: { param: (k: "userId") => string } }) => schemas.uuid.parse(c.req.param("userId"));

// My family (null if none) and the price to create one, so the app never hardcodes it.
familyRoutes.get("/families/me", async (c) => c.json(await families.myFamily(c.get("user").id)));

familyRoutes.get("/families", async (c) => {
  const { q } = z.object({ q: z.string().trim().max(20).optional() }).parse(c.req.query());
  return c.json({ families: await families.list(q || undefined) });
});

familyRoutes.post("/families", async (c) => {
  const b = await json(c, z.object({ name: z.string().trim().min(2, "At least 2 characters").max(20) }));
  return c.json(await families.create(c.get("user"), b.name), 201);
});

familyRoutes.get("/families/:id", async (c) => c.json(await families.detail(c.get("user").id, id(c))));
familyRoutes.delete("/families/:id", async (c) => (await families.disband(c.get("user"), id(c)), c.json({ disbanded: true })));
familyRoutes.post("/families/:id/join", async (c) => (await families.join(c.get("user"), id(c)), c.json({ joined: true })));
familyRoutes.post("/families/:id/leave", async (c) => (await families.leave(c.get("user"), id(c)), c.json({ left: true })));

familyRoutes.post("/families/:id/invite", async (c) => {
  const b = await json(c, z.object({ userId: schemas.uuid }));
  return c.json(await families.invite(c.get("user"), id(c), b.userId));
});

familyRoutes.post("/families/:id/members/:userId/role", async (c) => {
  const b = await json(c, z.object({ role: z.enum(["ADMIN", "MEMBER"]) }));
  await families.setRole(c.get("user"), id(c), member(c), b.role);
  return c.json({ role: b.role });
});
familyRoutes.delete("/families/:id/members/:userId", async (c) => (await families.kick(c.get("user"), id(c), member(c)), c.json({ removed: true })));
