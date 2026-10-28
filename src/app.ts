import { Server as Engine } from "@socket.io/bun-engine";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { requestId } from "hono/request-id";
import type { Env } from "./http";
import { io } from "./io";
import { toSafeError } from "./lib/errors";
import { account } from "./routes/account";
import { admin } from "./routes/admin";
import { dm } from "./routes/dm";
import { coinSellerRoutes } from "./routes/coinSellers";
import { links } from "./routes/links";
import { cpRoutes } from "./routes/cp";
import { familyRoutes } from "./routes/families";
import { postRoutes } from "./routes/posts";
import { roomRoutes } from "./routes/rooms";
import "./socket";

export const app = new Hono<Env>();

app.use(requestId());
app.use(async (c, next) => {
  const t = performance.now();
  await next();
  // Never log bodies or tokens.
  console.log(JSON.stringify({ level: "info", reqId: c.get("requestId"), method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - t) }));
});

app.onError((e, c) => {
  const { status, code, message, data } = toSafeError(e);
  return c.json({ error: { code, message, ...(data && { data }), requestId: c.get("requestId") } }, status);
});

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Not found", requestId: c.get("requestId") } }, 404));

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", links); // shareable room links (/r/:roomId) and the install page (/download)
// HTML5 mini-games, opened in a WebView over the room. The socket client comes from the installed socket.io, so versions always match.
app.get("/games/socket.io.min.js", () => new Response(Bun.file(`${import.meta.dir}/../node_modules/socket.io/client-dist/socket.io.min.js`)));
app.use("/games/*", serveStatic({ root: `${import.meta.dir}/../public` }));
app.route("/v1", account);
app.route("/v1", admin); // before roomRoutes, whose "*" auth would run a second time
app.route("/v1", postRoutes); // before roomRoutes, whose "*" auth would cover the public /uploads too
app.route("/v1", roomRoutes);
app.route("/v1", dm);
app.route("/v1", coinSellerRoutes);
app.route("/v1", cpRoutes);
app.route("/v1", familyRoutes);

// Heartbeat every 10s, dead after 8s more without a reply: a phone that silently lost its connection is noticed in
// ~18s (the defaults took up to 45s), so its seat is freed sooner.
const engine = new Engine({ path: "/socket.io/", pingInterval: 10_000, pingTimeout: 8_000 });
io.bind(engine);

export function serve(port: number) {
  const { websocket } = engine.handler();
  return Bun.serve({
    port,
    idleTimeout: 30, // must exceed the engine's 10s pingInterval
    websocket,
    fetch(req, server) {
      if (new URL(req.url).pathname === "/socket.io/") return engine.handleRequest(req, server);
      return app.fetch(req, server);
    },
  });
}
