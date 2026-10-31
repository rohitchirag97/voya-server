import { Server as Engine } from "@socket.io/bun-engine";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { requestId } from "hono/request-id";
import { join } from "node:path";
import { GIFT_FILES_DIR } from "./services/giftAdmin";
import { EVENT_FILES_DIR } from "./services/events";
import { eventRoutes } from "./routes/events";
import { noticeRoutes } from "./routes/notices";
import { itemRoutes } from "./routes/items";
import { svipRoutes } from "./routes/svip";
import { ITEM_FILES_DIR } from "./services/items";
import type { Env } from "./http";
import { io } from "./io";
import { toSafeError } from "./lib/errors";
import { levelTable } from "./lib/salaryLevels";
import { MIN_WITHDRAWAL_PAISE } from "./services/cash";
import { DIAMOND_SHARE_PERCENT } from "./services/diamonds";
import { PAISE_PER_COIN } from "./services/recharge";
import { account } from "./routes/account";
import { admin } from "./routes/admin";
import { dm } from "./routes/dm";
import { coinSellerRoutes } from "./routes/coinSellers";
import { links } from "./routes/links";
import { cpRoutes } from "./routes/cp";
import { familyRoutes } from "./routes/families";
import { agencyRoutes } from "./routes/agencies";
import { postRoutes } from "./routes/posts";
import { roomRoutes } from "./routes/rooms";
import { support } from "./routes/support";
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
// Public (no login): the host salary policy for the website's /salary page. Registered before the /v1 routers, whose
// auth middleware would otherwise cover it.
app.get("/v1/salary-policy", (c) =>
  c.json({ ...levelTable(), diamondSharePercent: DIAMOND_SHARE_PERCENT, rupeesPerCoin: PAISE_PER_COIN / 100, minWithdrawalRupees: MIN_WITHDRAWAL_PAISE / 100 }),
);
app.route("/", links); // shareable room links (/r/:roomId) and the install page (/download)
// HTML5 mini-games, opened in a WebView over the room. The socket client comes from the installed socket.io, so versions always match.
app.get("/games/socket.io.min.js", () => new Response(Bun.file(`${import.meta.dir}/../node_modules/socket.io/client-dist/socket.io.min.js`)));
// Files added in the admin panel: gift icons and animations (services/giftAdmin.ts), event banners and headers
// (services/events.ts), prize items (services/items.ts). Each upload has a fresh name: cached forever.
const UPLOAD_NAME = /^[0-9a-f-]{36}\.(png|jpg|webp|svga)$/;
app.get("/games/:dir{gifts|events|items}/:name", async (c) => {
  const name = c.req.param("name");
  const dir = { gifts: GIFT_FILES_DIR, events: EVENT_FILES_DIR, items: ITEM_FILES_DIR }[c.req.param("dir") as "gifts" | "events" | "items"];
  const f = Bun.file(join(dir(), name));
  if (!UPLOAD_NAME.test(name) || !(await f.exists())) return c.notFound();
  const type = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", svga: "application/octet-stream" }[name.split(".").pop()!]!;
  return new Response(f, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" } });
});
app.use(
  "/games/*",
  serveStatic({
    root: `${import.meta.dir}/../public`,
    // Effects and gift icons are big and rarely change: phones keep them for a week, so a gift sent again (or in the
    // next session) plays at once. Pages and scripts stay uncached so updates show straight away.
    onFound: (path, c) => {
      if (/\.(svga|png)$/.test(path)) c.header("Cache-Control", "public, max-age=604800");
    },
  }),
);
app.route("/v1", account);
app.route("/v1", eventRoutes); // before roomRoutes, whose "*" auth would run a second time
app.route("/v1", noticeRoutes);
app.route("/v1", itemRoutes);
app.route("/v1", svipRoutes);
app.route("/v1", admin); // before roomRoutes, whose "*" auth would run a second time
app.route("/v1", postRoutes); // before roomRoutes, whose "*" auth would cover the public /uploads too
app.route("/v1", roomRoutes);
app.route("/v1", dm);
app.route("/v1", support);
app.route("/v1", coinSellerRoutes);
app.route("/v1", cpRoutes);
app.route("/v1", familyRoutes);
app.route("/v1", agencyRoutes);

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
