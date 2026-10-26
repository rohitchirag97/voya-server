import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { join } from "node:path";
import { config } from "../config";
import { db } from "../db";
import { rooms, users } from "../db/schema";
import { schemas } from "../http";

// Shareable links (public, no login). /r/<roomId>: a tiny page with a preview card (WhatsApp, Instagram) that opens the
// room in the app, or sends people without the app to install it. /download: the install page.
// shortcut: no domain/HTTPS yet, so Android can't verify App Links; the page launches the app with an intent:// URL
// instead (one browser hop). With a domain, add assetlinks.json + an autoVerify intent filter to skip the browser.
export const links = new Hono();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const PACKAGE = "com.partylive";
const APK_FILE = "voyalive.apk"; // kept in the uploads volume (survives redeploys); replaced when a new build ships

// Where people without the app go: the Play Store page once APP_STORE_URL is set, else our download page.
const installUrl = (origin: string) => config.appStoreUrl || `${origin}/download`;

const page = (title: string, head: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;
    background: radial-gradient(circle at 30% 10%, #3b1e7a, #0a0716 70%); color: #fff; }
  .card { width: min(92vw, 380px); text-align: center; padding: 28px 22px; border-radius: 24px; background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.14); }
  .cover { width: 112px; height: 112px; border-radius: 24px; object-fit: cover; background: linear-gradient(135deg, #ff3d8b, #8b5cf6); }
  h1 { font-size: 22px; margin: 16px 0 6px; } p { color: #a59cc9; margin: 0 0 20px; line-height: 1.4; }
  a.btn { display: block; padding: 14px; border-radius: 999px; font-weight: 800; text-decoration: none; color: #fff; margin-top: 10px;
    background: linear-gradient(90deg, #ff3d8b, #8b5cf6); }
  a.ghost { background: transparent; border: 1px solid rgba(255,255,255,0.25); }
  .brand { margin-top: 18px; font-size: 12px; color: #a59cc9; letter-spacing: 1px; }
</style></head><body><div class="card">${body}<div class="brand">VOYALIVE</div></div></body></html>`;

links.get("/r/:roomId", async (c) => {
  const origin = new URL(c.req.url).origin;
  const parsed = schemas.uuid.safeParse(c.req.param("roomId"));
  const [room] = parsed.success
    ? await db
        .select({ id: rooms.id, title: rooms.title, coverUrl: rooms.coverUrl, kind: rooms.kind, privacy: rooms.privacy, host: users.displayName })
        .from(rooms)
        .innerJoin(users, eq(users.id, rooms.hostUserId))
        .where(eq(rooms.id, parsed.data))
    : [];
  const install = installUrl(origin);
  if (!room || room.privacy === "PRIVATE") {
    return c.html(page("VoyaLive", "", `<h1>Room not found</h1><p>It may have closed or be private.</p><a class="btn" href="${esc(install)}">Get VoyaLive</a>`), 404);
  }
  const title = `${room.title} · VoyaLive`;
  const what = room.kind === "LIVE" ? `${room.host ?? "Someone"} is live on VoyaLive` : `Join ${room.host ?? "us"} in this room on VoyaLive`;
  const cover = room.coverUrl ? (room.coverUrl.startsWith("/") ? origin + room.coverUrl : room.coverUrl) : "";
  // Chrome on Android opens the app if it's installed, else goes to the fallback (install page).
  const intent = `intent://room/${room.id}#Intent;scheme=voyalive;package=${PACKAGE};S.browser_fallback_url=${encodeURIComponent(install)};end`;
  const head = `
<meta property="og:title" content="${esc(room.title)}">
<meta property="og:description" content="${esc(what)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(`${origin}/r/${room.id}`)}">
${cover ? `<meta property="og:image" content="${esc(cover)}">` : ""}`;
  const body = `${cover ? `<img class="cover" src="${esc(cover)}" alt="">` : `<div class="cover"></div>`}
<h1>${esc(room.title)}</h1><p>${esc(what)}</p>
<a class="btn" href="${esc(intent)}">Open in VoyaLive</a>
<a class="btn ghost" href="${esc(install)}">Don't have the app? Get it</a>
<script>if (/Android/i.test(navigator.userAgent)) location.href = ${JSON.stringify(intent)};</script>`;
  return c.html(page(title, head, body));
});

links.get("/download", (c) =>
  c.html(
    page(
      "Get VoyaLive",
      `<meta property="og:title" content="Get VoyaLive"><meta property="og:description" content="Voice rooms, live streams and friends.">`,
      `<div class="cover"></div><h1>VoyaLive</h1><p>Voice rooms, live streams, games and friends.</p>
<a class="btn" href="/download/${APK_FILE}">Install for Android</a>
<p style="margin-top:14px;font-size:12px">After downloading, open the file and allow installing from this source if your phone asks.</p>`,
    ),
  ),
);

links.get(`/download/${APK_FILE}`, async (c) => {
  const f = Bun.file(join(config.uploadsDir, APK_FILE));
  if (!(await f.exists())) return c.text("The download isn't available yet.", 404);
  return new Response(f, {
    headers: { "content-type": "application/vnd.android.package-archive", "content-disposition": `attachment; filename="${APK_FILE}"`, "cache-control": "no-cache" },
  });
});
