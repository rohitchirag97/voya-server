import { Hono } from "hono";
import { requireAuth, type Env } from "../http";
import { claimTask, myTasks } from "../services/tasks";

// Daily and weekly tasks (lib/tasks.ts): mine and my room's, and claiming their rewards.
export const taskRoutes = new Hono<Env>();
taskRoutes.use("/tasks", requireAuth);
taskRoutes.use("/tasks/*", requireAuth);

taskRoutes.get("/tasks", async (c) => c.json(await myTasks(c.get("user"))));
taskRoutes.post("/tasks/:id/claim", async (c) => c.json(await claimTask(c.get("user"), c.req.param("id"))));
