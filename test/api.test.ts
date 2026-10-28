import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createDecipheriv, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { io as connect, type Socket } from "socket.io-client";
import { serve } from "../src/app";
import { config } from "../src/config";
import { db } from "../src/db";
import { migrateAndSeed } from "../src/db/migrate";
import { SEAT_LAYOUTS, seatPositions } from "../src/lib/layout";
import { resetRateLimits } from "../src/lib/rateLimit";
import { generateToken04 } from "../src/lib/zegoToken";
import { grantBadge } from "../src/services/badges";
import { setSpecialId } from "../src/services/specialIds";
import { decideCoinSeller } from "../src/services/sellers";
import { levelInfo, levelOf, loadLevels, maxLevel, xpToReach } from "../src/lib/levels";
import { tierFor } from "../src/services/svip";
import * as ludo from "../src/services/ludo";
import * as chat from "../src/services/chat";

let base = "";
let server: ReturnType<typeof serve>;
const sockets: Socket[] = [];

beforeAll(async () => {
  await migrateAndSeed();
  await db.execute(sql`truncate users, user_badges, user_sessions, otp_codes, rooms, room_participants, room_seats, chat_messages,
    wallet_accounts, wallet_ledger, seller_ledger, gift_transactions, follows, blocks, reports, posts, post_likes, direct_messages, coin_sellers, profile_likes, profile_visits, post_comments, greedy_bets, greedy_rounds, rocket_bets, rocket_rounds cascade`);
  server = serve(0);
  base = `http://localhost:${server.port}`;
});
beforeEach(() => resetRateLimits());
afterAll(() => {
  sockets.forEach((s) => s.close());
  server.stop(true);
});

async function api(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + "/v1" + path, {
    method,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

// Every listed room (or live stream), across all pages, in list order.
async function everyRoom(path: "/rooms" | "/lives", token: string) {
  const out: any[] = [];
  let cursor: string | null = null;
  do {
    const page: any = (await api("GET", `${path}?limit=50${cursor ? `&cursor=${cursor}` : ""}`, token)).body;
    out.push(...page.rooms);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

let n = 0;
async function signup(name: string) {
  const phone = `+9198${String(Date.now() % 1e6).padStart(6, "0")}${String(n++).padStart(2, "0")}`;
  const { body: otp } = await api("POST", "/auth/otp/request", undefined, { phone });
  const { body } = await api("POST", "/auth/otp/verify", undefined, { phone, code: otp.devCode });
  const handle = `${name}_${n}`;
  expect((await api("PATCH", "/me/profile", body.accessToken, { displayName: handle })).status).toBe(200);
  return { token: body.accessToken as string, id: body.user.userId as string, handle };
}

async function liveRoom(seatCount = 8) {
  const host = await signup("host");
  const created = await api("POST", "/rooms", host.token, { title: "Evening Chai", seatCount });
  expect(created.status).toBe(201);
  const roomId = created.body.room.roomId as string;
  return { host, roomId };
}

async function joined(roomId: string, name: string) {
  const u = await signup(name);
  expect((await api("POST", `/rooms/${roomId}/join`, u.token)).status).toBe(200);
  return u;
}

function socketFor(token: string) {
  const s = connect(base, { auth: { token }, transports: ["websocket"] });
  sockets.push(s);
  return s;
}
const emit = (s: Socket, ev: string, p: unknown) => s.emitWithAck(ev, p);
const nextEvent = (s: Socket, ev: string) => new Promise<any>((r) => s.once(ev, r));

// Stands in for Google's tokeninfo endpoint (answering with `claims`) while fn runs; every other request goes through.
async function withGoogle(claims: Record<string, unknown>, fn: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  const clientId = config.googleClientId;
  config.googleClientId = "test-client.apps.googleusercontent.com";
  Object.assign(claims, { aud: claims.aud ?? config.googleClientId, iss: "https://accounts.google.com", email_verified: "true" });
  globalThis.fetch = (async (url: any, init?: any) =>
    String(url).startsWith("https://oauth2.googleapis.com/tokeninfo") ? Response.json(claims) : realFetch(url, init)) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    config.googleClientId = clientId;
  }
}

describe("google sign-in", () => {
  test("a verified Google token signs in the same user each time; a token for another app is rejected", async () => {
    const claims: Record<string, unknown> = { sub: `g${Date.now()}` };
    await withGoogle(claims, async () => {
      const first = await api("POST", "/auth/google", undefined, { idToken: "tok" });
      expect(first.status).toBe(200);
      expect(first.body.accessToken).toBeString();
      const again = await api("POST", "/auth/google", undefined, { idToken: "tok" });
      expect(again.body.user.userId).toBe(first.body.user.userId);

      claims.aud = "someone-elses-app";
      expect((await api("POST", "/auth/google", undefined, { idToken: "tok" })).status).toBe(401);
    });
  });

  test("linking: a phone user adds Google and a Google user adds a phone; an identity can't be taken twice", async () => {
    const phoneUser = await signup("linkp");
    await withGoogle({ sub: `gl${Date.now()}` }, async () => {
      const linked = await api("POST", "/me/link/google", phoneUser.token, { idToken: "tok" });
      expect(linked.status).toBe(200);
      expect(linked.body.googleLinked).toBe(true);
      // Google now signs in to the same account.
      expect((await api("POST", "/auth/google", undefined, { idToken: "tok" })).body.user.userId).toBe(phoneUser.id);
      // A second account can't claim the same Google account, and the first can't link another one.
      const other = await signup("linko");
      expect((await api("POST", "/me/link/google", other.token, { idToken: "tok" })).status).toBe(409);
      expect((await api("POST", "/me/link/google", phoneUser.token, { idToken: "tok" })).status).toBe(409);
    });

    await withGoogle({ sub: `gp${Date.now()}` }, async () => {
      const g = (await api("POST", "/auth/google", undefined, { idToken: "tok" })).body;
      const me = await api("GET", "/me", g.accessToken);
      expect(me.body.phone).toBeNull();
      const phone = `+9197${String(Date.now() % 1e8).padStart(8, "0")}`;
      const { body: otp } = await api("POST", "/auth/otp/request", undefined, { phone });
      expect((await api("POST", "/me/link/phone", g.accessToken, { phone, code: "000000" === otp.devCode ? "111111" : "000000" })).status).toBe(401);
      expect((await api("POST", "/me/link/phone", g.accessToken, { phone, code: otp.devCode })).body.phone).toBe(phone);
      // The phone now signs in to the Google account.
      const { body: otp2 } = await api("POST", "/auth/otp/request", undefined, { phone });
      expect((await api("POST", "/auth/otp/verify", undefined, { phone, code: otp2.devCode })).body.user.userId).toBe(g.user.userId);
    });
  });
});

describe("change phone", () => {
  test("needs a code from the current number, then one from the new number", async () => {
    const u = await signup("chg");
    const oldPhone = (await api("GET", "/me", u.token)).body.phone as string;
    const newPhone = `+9196${String(Date.now() % 1e8).padStart(8, "0")}`;
    const code = async (phone: string) => (await api("POST", "/auth/otp/request", undefined, { phone })).body.devCode as string;

    // A made-up pass, or a wrong code for the current number, gets nowhere.
    expect((await api("POST", "/me/phone/change", u.token, { changeToken: u.token, phone: newPhone, code: await code(newPhone) })).status).toBe(401);
    await code(oldPhone);
    expect((await api("POST", "/me/phone/verify-current", u.token, { code: "000000" })).status).toBe(401);

    const { body: pass } = await api("POST", "/me/phone/verify-current", u.token, { code: await code(oldPhone) });
    expect(pass.changeToken).toBeString();
    // The pass is not an access token.
    expect((await api("GET", "/me", pass.changeToken)).status).toBe(401);
    // Another user can't use it.
    const other = await signup("chgo");
    expect((await api("POST", "/me/phone/change", other.token, { changeToken: pass.changeToken, phone: newPhone, code: await code(newPhone) })).status).toBe(401);

    const changed = await api("POST", "/me/phone/change", u.token, { changeToken: pass.changeToken, phone: newPhone, code: await code(newPhone) });
    expect(changed.body.phone).toBe(newPhone);
    // The new number signs in to the account; the old one no longer does.
    expect((await api("POST", "/auth/otp/verify", undefined, { phone: newPhone, code: await code(newPhone) })).body.user.userId).toBe(u.id);
    expect((await api("POST", "/auth/otp/verify", undefined, { phone: oldPhone, code: await code(oldPhone) })).body.user.userId).not.toBe(u.id);
    // The pass was for the old number, so it can't be reused.
    const third = `+9195${String(Date.now() % 1e8).padStart(8, "0")}`;
    expect((await api("POST", "/me/phone/change", u.token, { changeToken: pass.changeToken, phone: third, code: await code(third) })).status).toBe(401);
  });
});

describe("profiles", () => {
  test("public profile with follow counts", async () => {
    const a = await signup("profa");
    const b = await signup("profb");
    const view = async () => (await api("GET", `/users/${b.id}`, a.token)).body;
    expect(await view()).toMatchObject({ userId: b.id, displayName: b.handle, followers: 0, isFollowing: false, followsMe: false, isMe: false });

    // b hears about the new follower live, with a "follow back" hint.
    const sb = socketFor(b.token);
    await new Promise<void>((r) => sb.once("connect", () => r()));
    const heard = nextEvent(sb, "user:followed");
    await api("POST", `/users/${b.id}/follow`, a.token);
    expect(await heard).toEqual({ user: expect.objectContaining({ userId: a.id }), youFollowThem: false });
    expect(await view()).toMatchObject({ followers: 1, isFollowing: true });
    expect((await api("GET", `/users/${a.id}`, b.token)).body).toMatchObject({ followsMe: true, isFollowing: false });

    // Following back tells a it's mutual.
    const sa = socketFor(a.token);
    await new Promise<void>((r) => sa.once("connect", () => r()));
    const back = nextEvent(sa, "user:followed");
    await api("POST", `/users/${a.id}/follow`, b.token);
    expect((await back).youFollowThem).toBe(true);
    expect((await api("GET", `/users/${a.id}`, a.token)).body).toMatchObject({ following: 1, isMe: true });
    expect((await api("GET", `/users/00000000-0000-4000-8000-000000000000`, a.token)).body.error.code).toBe("USER_NOT_FOUND");
  });
});

describe("display names", () => {
  test("decorative names are allowed; invisible, layout-breaking and mention-breaking ones are not", async () => {
    const a = await signup("fancy");
    const ok = async (displayName: string, saved = displayName) =>
      expect((await api("PATCH", "/me/profile", a.token, { displayName })).body.displayName).toBe(saved);
    await ok(`꧁༺ 𝓡𝓪𝓳 ${n} ༻꧂`);
    await ok(`★彡 ᴘʀɪʏᴀ 彡★ ${n}`);
    await ok(`  राज   ${n} 👑 `, `राज ${n} 👑`); // trimmed, spaces collapsed
    for (const displayName of ["\u3164\u3164\u3164", "ab\u202Ecd", "ab\u200Bcd", "@raj_x","zalgo\u0302\u0303\u0304\u0305\u0306\u0307", "ab", "x".repeat(31), "   "])
      expect((await api("PATCH", "/me/profile", a.token, { displayName })).body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("staff and impersonation", () => {
  test("reserved names and fake-official bios are blocked for regular users, allowed for staff", async () => {
    const a = await signup("imp");
    for (const displayName of ["Admin", "voyalive_help", "Adm1n_raj", "0fficial", "supp0rt", "5taff.x", "offlcial", "𝓐𝓭𝓶𝓲𝓷", "ᴀᴅᴍɪɴ", "Ⓢⓣⓐⓕⓕ", "аdmin", "voya", "Riya_Voya", "𝓥𝓸𝔂𝓪 girl", "ᴠᴏʏᴀ", "V0ya", "νoya", "ＶＯＹＡ"])
      expect((await api("PATCH", "/me/profile", a.token, { displayName })).body.error.code).toBe("RESERVED_NAME");
    for (const bio of ["Official VoyaLive account", "✅ verified seller", "VoyaLive Support Team", "staff here"])
      expect((await api("PATCH", "/me/profile", a.token, { bio })).body.error.code).toBe("IMPERSONATION");
    expect((await api("PATCH", "/me/profile", a.token, { bio: "Contact for Coins Purchase : +91 7069021206" })).status).toBe(200);
    expect((await api("PATCH", "/me/profile", a.token, { bio: "Room admin of Chai Adda" })).status).toBe(200);

    const b = await signup("viewer");
    expect((await api("GET", `/users/${a.id}`, b.token)).body.staffRole).toBeNull();
    await db.execute(sql`update users set staff_role = 'ADMIN' where id = ${a.id}`);
    expect((await api("GET", `/users/${a.id}`, b.token)).body.staffRole).toBe("ADMIN");
    expect((await api("PATCH", "/me/profile", a.token, { displayName: `VoyaLive_Admin_${n}` })).status).toBe(200);
    // the API can't grant the role
    expect((await api("PATCH", "/me/profile", b.token, { staffRole: "ADMIN" } as any)).status).toBe(200);
    expect((await api("GET", `/users/${b.id}`, a.token)).body.staffRole).toBeNull();
  });
});

describe("svip", () => {
  // Recharge of ₹rupees at a point relative to the start of this month (India time).
  const paid = (userId: string, rupees: number, when: "this" | "last" | "older") =>
    db.execute(sql`insert into recharges (user_id, package_id, coins, price_paise, provider, idempotency_key, created_at)
      values (${userId}, 'test', 1, ${rupees * 100}, 'DEV', ${crypto.randomUUID()},
        (date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')
          + ${when === "this" ? sql`interval '1 minute'` : when === "last" ? sql`interval '-1 day'` : sql`interval '-40 days'`})`);

  test("only recharges from the 1st to the last day of the current month count, and the tier ends with the month", async () => {
    expect([999, 1000, 4999, 5000, 2_50_000, 9_99_999].map(tierFor)).toEqual([0, 1, 1, 2, 7, 7]);
    const a = await signup("sva");
    expect((await api("GET", "/me/svip", a.token)).body).toMatchObject({ tier: 0, validUntil: null, next: { tier: 1, remaining: 1000 } });

    await paid(a.id, 2_50_000, "last"); // last month, however big, doesn't count
    await paid(a.id, 50_000, "older");
    expect((await api("GET", "/me/svip", a.token)).body).toMatchObject({ tier: 0, thisMonthRupees: 0 });
    await paid(a.id, 3_000, "this");
    expect((await api("GET", "/me/svip", a.token)).body).toMatchObject({ tier: 1, thisMonthRupees: 3_000, next: { tier: 2, remaining: 2_000 } });
    await paid(a.id, 27_000, "this"); // ₹30,000 this month → SVIP4
    const up = (await api("GET", "/me/svip", a.token)).body;
    expect(up.tier).toBe(4);
    // Active until the 1st of next month, 00:00 India time.
    const end = new Date(up.validUntil);
    expect(end.getTime()).toBeGreaterThan(Date.now());
    expect(new Date(end.getTime() + 5.5 * 3600_000).toISOString().slice(8, 16)).toBe("01T00:00");
    expect(up.tiers).toHaveLength(7);
    expect(up.tiers[4].perks.map((p: any) => p.title)).toEqual(expect.arrayContaining(["Kick protection", "SVIP frames", "Grand entrance"]));

    // The tier travels with profiles and user summaries.
    const b = await signup("svb");
    expect((await api("GET", `/users/${a.id}`, b.token)).body.svip).toBe(4);
    expect((await api("GET", `/users/${a.id}/followers`, b.token)).status).toBe(200);
  });

  test("tier-only frames and bubbles: locked below the tier, hidden again when the tier lapses", async () => {
    const a = await signup("svcos");
    const b = await signup("svcosb");
    const items = (await api("GET", "/cosmetics", a.token)).body;
    expect(items.filter((x: any) => x.minSvip > 0).map((x: any) => x.id)).toEqual(
      expect.arrayContaining(["svip1_frame", "svip7_frame", "svip1_bubble", "svip7_bubble"]),
    );
    expect((await api("PATCH", "/me/cosmetics", a.token, { avatarFrameId: "svip3_frame" })).body.error.code).toBe("SVIP_REQUIRED");
    await paid(a.id, 15_000, "this");
    expect((await api("PATCH", "/me/cosmetics", a.token, { avatarFrameId: "svip3_frame", chatBubbleId: "svip2_bubble" })).status).toBe(200);
    expect((await api("PATCH", "/me/cosmetics", a.token, { avatarFrameId: "svip4_frame" })).body.error.code).toBe("SVIP_REQUIRED");
    expect((await api("GET", `/users/${a.id}`, b.token)).body.avatarFrame.id).toBe("svip3_frame");
    // The month rolls over (simulated by moving the recharge to last month): the frame stops showing.
    await db.execute(sql`update recharges set created_at = created_at - interval '40 days' where user_id = ${a.id}`);
    const lapsed = (await api("GET", `/users/${a.id}`, b.token)).body;
    expect(lapsed).toMatchObject({ svip: 0, avatarFrame: null, chatBubble: null });
  });

  test("a recharge announces level-ups and SVIP tier-ups to every room", async () => {
    const u = await signup("svann");
    const listener = await signup("svlisten");
    const s = socketFor(listener.token);
    await new Promise<void>((r) => s.once("connect", () => r()));
    const got: any[] = [];
    s.on("app:announce", (a) => got.push(a));
    await paid(u.id, 600, "this"); // ₹600 so far; the ₹449 package crosses ₹1,000 → SVIP1
    expect((await api("POST", "/wallet/recharge", u.token, { packageId: "coins_300" }, { "Idempotency-Key": crypto.randomUUID() })).status).toBe(200);
    await Bun.sleep(300);
    expect(got).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "SVIP_UP", tier: 1, userId: u.id, displayName: u.handle }),
        expect.objectContaining({ kind: "RECHARGE", leveledUp: true, userId: u.id }),
      ]),
    );
    got.length = 0;
    expect((await api("POST", "/wallet/recharge", u.token, { packageId: "coins_60" }, { "Idempotency-Key": crypto.randomUUID() })).status).toBe(200);
    await Bun.sleep(300);
    expect(got.filter((a) => a.kind === "SVIP_UP")).toEqual([]); // still SVIP1: no repeat
    expect(got).toEqual([expect.objectContaining({ kind: "RECHARGE", userId: u.id })]); // every recharge is announced
  });

  test("SVIP3+ visit invisibly; SVIP5+ can't be moderated by lower tiers; SVIP2+ entrances are announced", async () => {
    const owner = await signup("svo");
    const seen = await signup("svseen");
    const ghost = await signup("svghost");
    await paid(ghost.id, 15_000, "this");
    await api("GET", `/users/${owner.id}`, seen.token);
    await api("GET", `/users/${owner.id}`, ghost.token);
    expect((await api("GET", `/users/${owner.id}`, owner.token)).body.visitors).toBe(1);

    const { host, roomId } = await liveRoom();
    expect((await api("PATCH", `/rooms/${roomId}/settings`, host.token, { showEntry: false })).status).toBe(200);
    const vip = await signup("svvip");
    await paid(vip.id, 60_000, "this");
    expect((await api("POST", `/rooms/${roomId}/join`, vip.token)).status).toBe(200);
    await joined(roomId, "svplain");
    const notices = (await api("GET", `/rooms/${roomId}/messages?limit=50`, host.token)).body.messages.filter((m: any) => m.payload?.kind === "JOIN");
    expect(notices.map((m: any) => m.body)).toEqual([`SVIP5 ${vip.handle} entered the room`]);

    expect((await api("POST", `/rooms/${roomId}/participants/${vip.id}/mute`, host.token, { muted: true })).body.error.code).toBe("SVIP_PROTECTED");
    expect((await api("POST", `/rooms/${roomId}/participants/${vip.id}/remove`, host.token)).body.error.code).toBe("SVIP_PROTECTED");
    await paid(host.id, 1_20_000, "this"); // a higher tier owner can
    expect((await api("POST", `/rooms/${roomId}/participants/${vip.id}/remove`, host.token)).status).toBe(200);
  });
});

describe("room notices and layout", () => {
  test("no 'left' notice; admin changes are told only to that user", async () => {
    const { host, roomId } = await liveRoom();
    const a = await joined(roomId, "ntca");
    const b = await joined(roomId, "ntcb");
    const sa = socketFor(a.token);
    await emit(sa, "room:join", { roomId });
    const told = nextEvent(sa, "room:admin:changed");
    await api("POST", `/rooms/${roomId}/admins/${a.id}`, host.token);
    expect(await told).toMatchObject({ roomId, admin: true, by: host.handle });
    await api("POST", `/rooms/${roomId}/leave`, b.token);

    const bodies = (await api("GET", `/rooms/${roomId}/messages?limit=50`, host.token)).body.messages.map((m: any) => m.body);
    expect(bodies.some((t: string) => / left$/.test(t))).toBe(false);
    expect(bodies.some((t: string) => /admin/.test(t))).toBe(false);
  });

  test("owner changes seat count; people on removed seats move or step down", async () => {
    const { host, roomId } = await liveRoom(10);
    const users = await Promise.all(["lay1", "lay2", "lay3"].map((n) => joined(roomId, n)));
    const [u1, u2] = users as [Awaited<ReturnType<typeof joined>>, Awaited<ReturnType<typeof joined>>];
    await api("POST", `/rooms/${roomId}/seats/9/claim`, u1.token);
    await api("POST", `/rooms/${roomId}/participants/${u1.id}/mute`, u1.token, { muted: true });
    const setCount = (who: { token: string }, seatCount: unknown) => api("POST", `/rooms/${roomId}/seat-count`, who.token, { seatCount });

    expect((await setCount(u1, 8)).body.error.code).toBe("NOT_ROOM_ADMIN");
    // Admins can change it too (and back).
    await api("POST", `/rooms/${roomId}/admins/${u1.id}`, host.token);
    expect((await setCount(u1, 12)).body.seatCount).toBe(12);
    expect((await setCount(u1, 10)).body.seatCount).toBe(10);
    await api("DELETE", `/rooms/${roomId}/admins/${u1.id}`, host.token);
    expect((await setCount(host, 9)).status).toBe(400);

    // Shrink 10 → 8: the person on seat 9 moves to the first free seat, keeping stream and mute.
    const streamId = (await api("GET", `/rooms/${roomId}`, host.token)).body.seats[9].streamId;
    const shrink = await setCount(host, 8);
    expect(shrink.body).toMatchObject({ seatCount: 8, rowLayout: [4, 4], unseated: [] });
    let snap = (await api("GET", `/rooms/${roomId}`, host.token)).body;
    expect(snap.seats).toHaveLength(8);
    expect(snap.rowLayout).toEqual([4, 4]);
    expect(snap.seats[1]).toMatchObject({ rowIndex: 0, columnIndex: 1, streamId, micMuted: true });
    expect(snap.seats[1].occupant.userId).toBe(u1.id);

    // Grow 8 → 20: new empty seats, positions follow the 5+5+5+5 layout.
    await setCount(host, 20);
    snap = (await api("GET", `/rooms/${roomId}`, host.token)).body;
    expect(snap.seats).toHaveLength(20);
    expect(snap.seats[5]).toMatchObject({ rowIndex: 1, columnIndex: 0 });
    expect(snap.seats[1].occupant.userId).toBe(u1.id);

    // Shrink 20 → 8 when every remaining seat is full: overflow goes back to the audience.
    for (let i = 2; i < 8; i++) {
      const extra = await joined(roomId, `fill${i}`);
      await api("POST", `/rooms/${roomId}/seats/${i}/claim`, extra.token);
    }
    await api("POST", `/rooms/${roomId}/seats/15/claim`, u2.token);
    const su2 = socketFor(u2.token);
    await emit(su2, "room:join", { roomId });
    const stepped = nextEvent(su2, "room:unseated");
    expect((await setCount(host, 8)).body.unseated).toEqual([u2.id]);
    expect((await stepped).reason).toBe("LAYOUT_CHANGED");
    snap = (await api("GET", `/rooms/${roomId}`, host.token)).body;
    expect(snap.seats.some((x: any) => x.occupant?.userId === u2.id)).toBe(false);
    expect(snap.participants.some((p: any) => p.userId === u2.id)).toBe(true); // still in the room
  });
});

describe("decorations", () => {
  test("list, equip, show on profile, validate kind, unequip", async () => {
    const a = await signup("deca");
    const b = await signup("decb");
    expect((await api("GET", "/cosmetics")).status).toBe(401);
    const items = (await api("GET", "/cosmetics", a.token)).body;
    expect(items.map((x: any) => [x.id, x.kind])).toEqual(
      expect.arrayContaining([
        ["frame_golden_halo", "AVATAR_FRAME"],
        ["card_aurora", "CARD_DECOR"],
      ]),
    );
    expect(items[0].svg).toStartWith("<svg");

    // Wrong slot or unknown id is refused.
    expect((await api("PATCH", "/me/cosmetics", a.token, { avatarFrameId: "card_aurora" })).body.error.code).toBe("COSMETIC_NOT_FOUND");
    expect((await api("PATCH", "/me/cosmetics", a.token, { cardDecorId: "nope" })).body.error.code).toBe("COSMETIC_NOT_FOUND");

    const eq = await api("PATCH", "/me/cosmetics", a.token, { avatarFrameId: "frame_golden_halo", cardDecorId: "card_aurora" });
    expect(eq.body.avatarFrame.id).toBe("frame_golden_halo");
    const seen = (await api("GET", `/users/${a.id}`, b.token)).body;
    expect(seen.avatarFrame).toMatchObject({ id: "frame_golden_halo", name: "Golden Halo" });
    expect(seen.cardDecor.svg).toContain("<svg");

    await api("PATCH", "/me/cosmetics", a.token, { avatarFrameId: null });
    const after = (await api("GET", `/users/${a.id}`, b.token)).body;
    expect(after.avatarFrame).toBeNull();
    expect(after.cardDecor.id).toBe("card_aurora"); // untouched
  });
});

describe("levels and recharge", () => {
  test("thresholds: rupee anchors, every level costs at least the previous, max 50", () => {
    // New users start at level 0; any XP unlocks Lv 1.
    expect([0, 1, 99, 100, 299, 300, 599, 600].map(levelOf)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
    expect(levelInfo(0)).toEqual({ level: 0, xp: 0, levelXp: 0, levelXpNeeded: 1, nextLevelAt: 1 });
    // The agreed anchors (1 XP per ₹1).
    expect([10, 20, 30, 40, 50].map(xpToReach)).toEqual([12_000, 48_000, 250_000, 587_000, 1_200_000]);
    expect([11_999, 12_000, 1_199_999, 1_200_000, 9_999_999].map(levelOf)).toEqual([9, 10, 49, 50, 50]);
    expect(maxLevel()).toBe(50);
    const steps = Array.from({ length: 49 }, (_, i) => xpToReach(i + 2) - xpToReach(i + 1));
    expect(steps.every((d, i) => i === 0 || d >= steps[i - 1]!)).toBe(true);
    expect(levelInfo(150)).toEqual({ level: 2, xp: 150, levelXp: 50, levelXpNeeded: 200, nextLevelAt: 300 });
    expect(levelInfo(1_500_000)).toMatchObject({ level: 50, nextLevelAt: null });
  });

  test("editing the thresholds table changes levels without a release", async () => {
    await db.execute(sql`update level_thresholds set xp_required = 50 where level = 2`);
    await loadLevels();
    expect(levelOf(60)).toBe(2);
    await db.execute(sql`update level_thresholds set xp_required = 100 where level = 2`);
    await loadLevels();
    expect(levelOf(60)).toBe(1);
  });

  test("recharge credits coins and level points; idempotent; levels up", async () => {
    const u = await signup("rich");
    const me = async () => (await api("GET", "/me", u.token)).body;
    expect((await me()).level).toMatchObject({ level: 0, xp: 0 });
    const packages = (await api("GET", "/wallet/packages", u.token)).body;
    expect(packages[0]).toMatchObject({ id: "coins_60", coins: 60 });

    const buy = (packageId: string, key: string) => api("POST", "/wallet/recharge", u.token, { packageId }, { "Idempotency-Key": key });
    const before = (await api("GET", "/wallet", u.token)).body.balance;
    // ₹99 for 60 coins → 99 XP: level 0 → Lv 1 (Lv 2 needs 100).
    const r1 = await buy("coins_60", "r1");
    expect(r1.body).toMatchObject({ balance: before + 60, leveledUp: true, level: { level: 1, xp: 99 } });
    // Retry: no second credit.
    expect((await buy("coins_60", "r1")).body.replayed).toBe(true);
    await Bun.sleep(100);
    // One inbox notice from the Recharge Notification account (support staff), none for the replay.
    const notices = (await api("GET", "/dm/pending", u.token)).body.messages;
    expect(notices).toEqual([
      expect.objectContaining({
        notice: { kind: "RECHARGE", status: "SUCCESS", coins: 60, balance: before + 60, txnId: expect.stringMatching(/^TXN\d+$/), paidRupees: 99 },
        sender: expect.objectContaining({ displayName: "Recharge Notification", staffRole: "SUPPORT" }),
      }),
    ]);
    expect((await api("GET", "/wallet", u.token)).body.balance).toBe(before + 60);
    expect((await buy("coins_300", "r1")).body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await buy("nope", "r9")).body.error.code).toBe("INVALID_PACKAGE");

    // ₹99 + ₹449 = 548 XP → Lv 3 (needs 300; Lv 4 needs 600).
    const r2 = await buy("coins_300", "r2");
    expect(r2.body).toMatchObject({ leveledUp: true, level: { level: 3, xp: 548, levelXp: 248, levelXpNeeded: 300 } });
    expect((await me()).level.level).toBe(3);

    // Spending coins never lowers the level; the ledger still matches the balance.
    const ledger = (await api("GET", "/wallet/transactions?limit=50", u.token)).body.entries;
    expect(ledger.filter((e: any) => e.entryType === "RECHARGE").map((e: any) => e.amount).sort()).toEqual([300, 60]);
    expect(ledger.reduce((s: number, e: any) => s + e.amount, 0)).toBe((await api("GET", "/wallet", u.token)).body.balance);
  });
});

describe("badges", () => {
  test("active badges show on profiles; expired ones disappear; re-granting extends", async () => {
    const a = await signup("bdga");
    const b = await signup("bdgb");
    const shown = async () => (await api("GET", `/users/${a.id}`, b.token)).body.badges;
    expect(await shown()).toEqual([]);

    await grantBadge(a.id, "top_gifter", 7);
    await grantBadge(a.id, "vip", null); // forever
    let list = await shown();
    expect(list.map((x: any) => x.id)).toEqual(["vip", "top_gifter"]); // display order
    expect(list[0].expiresAt).toBeNull();
    expect(list[1].svg).toStartWith("<svg");
    expect(new Date(list[1].expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    // Expired → hidden. Granting again brings it back with a fresh expiry.
    await db.execute(sql`update user_badges set expires_at = now() - interval '1 minute' where badge_id = 'top_gifter'`);
    expect((await shown()).map((x: any) => x.id)).toEqual(["vip"]);
    await grantBadge(a.id, "top_gifter", 30);
    list = await shown();
    expect(list.map((x: any) => x.id)).toEqual(["vip", "top_gifter"]);
    expect(new Date(list[1].expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    await expect(grantBadge(a.id, "nope", 1)).rejects.toThrow();
  });
});

describe("chat bubbles and chat badges", () => {
  test("messages carry the sender's badge ids and bubble; catalogs serve the artwork", async () => {
    const { host, roomId } = await liveRoom();
    const fan = await joined(roomId, "bubblefan");
    await grantBadge(fan.id, "vip", 30);
    await grantBadge(fan.id, "party_star", 30);

    expect((await api("PATCH", "/me/cosmetics", fan.token, { chatBubbleId: "card_aurora" })).body.error.code).toBe("COSMETIC_NOT_FOUND");
    const eq = await api("PATCH", "/me/cosmetics", fan.token, { chatBubbleId: "bubble_galaxy_crown" });
    expect(eq.body.chatBubble).toMatchObject({ id: "bubble_galaxy_crown", style: { border: "#FFC94D" } });

    const sent = await api("POST", `/rooms/${roomId}/messages`, fan.token, { body: "hello party", mentions: [], clientMessageId: "b1" });
    expect(sent.body.sender).toMatchObject({ bubbleId: "bubble_galaxy_crown", badges: ["vip", "party_star"] });
    const hist = (await api("GET", `/rooms/${roomId}/messages`, host.token)).body.messages;
    expect(hist.find((m: any) => m.body === "hello party").sender).toMatchObject({ bubbleId: "bubble_galaxy_crown", badges: ["vip", "party_star"] });

    const cosmetics = (await api("GET", "/cosmetics", host.token)).body;
    expect(cosmetics.find((c: any) => c.id === "bubble_galaxy_crown")).toMatchObject({ kind: "CHAT_BUBBLE", style: { gradient: ["#4C1D95", "#BE185D"] } });
    const badgeList = (await api("GET", "/badges", host.token)).body;
    expect(badgeList.map((b: any) => b.id)).toEqual(expect.arrayContaining(["vip", "party_star"]));
  });
});

describe("direct messages", () => {
  test("friends only, live delivery, history, retries, blocks", async () => {
    const a = await signup("dma");
    const b = await signup("dmb");
    const send = (from: { token: string }, to: { id: string }, body: string, clientMessageId: string) =>
      api("POST", `/dm/${to.id}`, from.token, { body, clientMessageId });

    // One-way follow isn't enough.
    await api("POST", `/users/${b.id}/follow`, a.token);
    expect((await send(a, b, "hi", "m1")).body.error.code).toBe("NOT_FRIENDS");
    await api("POST", `/users/${a.id}/follow`, b.token);

    const sb = socketFor(b.token);
    await new Promise<void>((r) => sb.once("connect", () => r()));
    const live = nextEvent(sb, "dm:new");
    const first = await send(a, b, "hi friend", "m1");
    expect(first.status).toBe(201);
    expect((await live).body).toBe("hi friend");
    // Same clientMessageId is a retry, not a second message.
    expect((await send(a, b, "hi friend", "m1")).body.id).toBe(first.body.id);
    await send(b, a, "hey!", "m2");

    const hist = (await api("GET", `/dm/${a.id}`, b.token)).body.messages;
    expect(hist.map((m: any) => m.body)).toEqual(["hey!", "hi friend"]);

    // Inbox: one row per person, showing the latest message.
    const inbox = (await api("GET", "/dm", a.token)).body.conversations;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ user: { userId: b.id, displayName: b.handle }, lastMessage: { body: "hey!" } });
    expect((await api("GET", "/dm")).status).toBe(401);

    await api("POST", `/users/${a.id}/block`, b.token);
    expect((await send(a, b, "still there?", "m3")).body.error.code).toBe("BLOCKED");
  });

  test("friends can send photos; strangers and non-images can't", async () => {
    const [a, b, c] = [await signup("dmpa"), await signup("dmpb"), await signup("dmpc")];
    await api("POST", `/users/${b.id}/follow`, a.token);
    await api("POST", `/users/${a.id}/follow`, b.token);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);
    const sendPhoto = async (from: { token: string }, to: { id: string }, clientMessageId: string, bytes: Uint8Array = png) => {
      const form = new FormData();
      form.append("file", new File([bytes], "p.png", { type: "image/png" }));
      form.append("clientMessageId", clientMessageId);
      const res = await fetch(`${base}/v1/dm/${to.id}/image`, { method: "POST", headers: { authorization: `Bearer ${from.token}` }, body: form });
      return { status: res.status, body: (await res.json()) as any };
    };

    const sent = await sendPhoto(a, b, "p1");
    const { id, imageUrl } = sent.body; // read before toMatchObject: Bun swaps matched values in place
    expect(sent.status).toBe(201);
    expect(sent.body.body).toBe("📷 Photo");
    expect(imageUrl).toMatch(/^\/v1\/uploads\/.+\.png$/);
    expect((await sendPhoto(a, b, "p1")).body.id).toBe(id); // a retry, not a second photo
    expect((await fetch(base + imageUrl)).status).toBe(200);
    expect((await api("GET", `/dm/${a.id}`, b.token)).body.messages[0]).toMatchObject({ id, imageUrl });

    // Unread: b opened the chat above (the history check), so only messages after that are unread.
    const unread = async (u: { token: string }) => (await api("GET", "/dm/unread", u.token)).body.count;
    await api("POST", `/dm/${b.id}`, a.token, { body: "and another", clientMessageId: "u1" });
    await api("POST", `/dm/${b.id}`, a.token, { body: "and one more", clientMessageId: "u1b" });
    expect(await unread(b)).toBe(2);
    expect((await api("GET", "/dm", b.token)).body.conversations[0].unread).toBe(2);
    expect(await unread(a)).toBe(0); // your own messages are never unread
    await api("GET", `/dm/${a.id}`, b.token);
    expect(await unread(b)).toBe(0);
    await api("POST", `/dm/${b.id}`, a.token, { body: "while you're here", clientMessageId: "u2" });
    expect(await unread(b)).toBe(1);
    await api("POST", `/dm/${a.id}/read`, b.token);
    expect(await unread(b)).toBe(0);

    expect((await sendPhoto(a, c, "p2")).body.error.code).toBe("NOT_FRIENDS");
    expect((await sendPhoto(a, b, "p3", new TextEncoder().encode("not an image at all"))).body.error.code).toBe("BAD_MEDIA");
  });
});

describe("seat layouts", () => {
  test("exact row layouts, row-major indexes", () => {
    expect(SEAT_LAYOUTS).toEqual({ 4: [4], 8: [4, 4], 10: [5, 5], 12: [4, 4, 4], 16: [4, 4, 4, 4], 20: [5, 5, 5, 5] });
    const p = seatPositions(10);
    expect(p).toHaveLength(10);
    expect(p[0]).toEqual({ seatIndex: 0, rowIndex: 0, columnIndex: 0 });
    expect(p[5]).toEqual({ seatIndex: 5, rowIndex: 1, columnIndex: 0 });
    expect(seatPositions(20).at(-1)).toEqual({ seatIndex: 19, rowIndex: 3, columnIndex: 4 });
  });
});

describe("zego token04", () => {
  test("decrypts to the expected claims", () => {
    const t = generateToken04(42, "u1", config.zegoServerSecret, 60, "p");
    const buf = Buffer.from(t.slice(2), "base64");
    const nLen = buf.readUInt16BE(8);
    const nonce = buf.subarray(10, 10 + nLen);
    const encLen = buf.readUInt16BE(10 + nLen);
    const enc = buf.subarray(12 + nLen, 12 + nLen + encLen);
    expect(nLen).toBe(12);
    expect(buf.length).toBe(12 + nLen + encLen + 1);
    expect(buf.at(-1)).toBe(1); // GCM mode byte
    const d = createDecipheriv("aes-256-gcm", config.zegoServerSecret, nonce);
    d.setAuthTag(enc.subarray(-16));
    const info = JSON.parse(Buffer.concat([d.update(enc.subarray(0, -16)), d.final()]).toString());
    expect(t.startsWith("04")).toBe(true);
    expect(info).toMatchObject({ app_id: 42, user_id: "u1", payload: "p" });
    expect(info.expire - info.ctime).toBe(60);
  });
});

describe("rooms", () => {
  test("accepts only 8/10/12/16/20 seats", async () => {
    for (const seatCount of [8, 10, 12, 16, 20]) {
      const h = await signup("cap");
      const r = await api("POST", "/rooms", h.token, { title: "t", seatCount });
      expect(r.status).toBe(201);
      expect(r.body.room.seats).toHaveLength(seatCount);
      expect(r.body.room.rowLayout).toEqual(SEAT_LAYOUTS[seatCount as 8]);
      expect(r.body.room.seats[0].occupant.userId).toBe(h.id);
      expect(r.body.zego.token).toStartWith("04");
    }
    const h = await signup("bad");
    for (const seatCount of [0, 9, 15, 21, "8"]) {
      expect((await api("POST", "/rooms", h.token, { title: "t", seatCount })).status).toBe(400);
    }
  });

  test("requires a display name and auth", async () => {
    expect((await api("GET", "/rooms")).status).toBe(401);
  });

  test("host seat reserved, one seat per user, concurrent claim has one winner", async () => {
    const { roomId } = await liveRoom(8);
    const a = await joined(roomId, "a");
    const b = await joined(roomId, "b");

    expect((await api("POST", `/rooms/${roomId}/seats/0/claim`, a.token)).body.error.code).toBe("HOST_SEAT_RESERVED");
    expect((await api("POST", `/rooms/${roomId}/seats/8/claim`, a.token)).body.error.code).toBe("INVALID_SEAT");

    const [ra, rb] = await Promise.all([
      api("POST", `/rooms/${roomId}/seats/3/claim`, a.token),
      api("POST", `/rooms/${roomId}/seats/3/claim`, b.token),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const winner = ra.status === 200 ? a : b;
    const loser = winner === a ? b : a;
    const streamId = (await api("GET", `/rooms/${roomId}`, winner.token)).body.seats[3].streamId;
    expect(streamId).toBeString();

    // Claiming another seat while seated moves you: one seat, same stream, mute carried over.
    await api("POST", `/rooms/${roomId}/participants/${winner.id}/mute`, winner.token, { muted: true });
    expect((await api("POST", `/rooms/${roomId}/seats/4/claim`, winner.token)).status).toBe(200);
    const snap = await api("GET", `/rooms/${roomId}`, winner.token);
    expect(snap.body.seats.filter((s: any) => s.occupant?.userId === winner.id)).toHaveLength(1);
    expect(snap.body.seats[3].occupant).toBeNull();
    expect(snap.body.seats[4]).toMatchObject({ streamId, micMuted: true });

    // A failed move keeps your current seat.
    await api("POST", `/rooms/${roomId}/seats/5/claim`, loser.token);
    expect((await api("POST", `/rooms/${roomId}/seats/5/claim`, winner.token)).body.error.code).toBe("SEAT_TAKEN");
    expect((await api("GET", `/rooms/${roomId}`, winner.token)).body.seats[4].occupant.userId).toBe(winner.id);

    expect((await api("POST", `/rooms/${roomId}/seats/4/release`, winner.token)).body.released).toBe(true);
    expect((await api("POST", `/rooms/${roomId}/seats/4/release`, winner.token)).body.released).toBe(false);
  });

  test("moderator mute locks the mic; remove-from-seat follows owner/admin rules", async () => {
    const { host, roomId } = await liveRoom(8);
    const adm = await joined(roomId, "mutadm");
    const adm2 = await joined(roomId, "mutadmtwo");
    const l = await joined(roomId, "mutlis");
    await api("POST", `/rooms/${roomId}/admins/${adm.id}`, host.token);
    await api("POST", `/rooms/${roomId}/admins/${adm2.id}`, host.token);
    await api("POST", `/rooms/${roomId}/seats/1/claim`, adm.token);
    await api("POST", `/rooms/${roomId}/seats/2/claim`, adm2.token);
    await api("POST", `/rooms/${roomId}/seats/3/claim`, l.token);
    const mute = (actor: { token: string }, target: { id: string }, muted: boolean) =>
      api("POST", `/rooms/${roomId}/participants/${target.id}/mute`, actor.token, { muted });
    const seat = async (i: number) => (await api("GET", `/rooms/${roomId}`, host.token)).body.seats[i];

    // Self mute/unmute works normally and only touches the self switch.
    expect((await mute(l, l, true)).body).toEqual({ micMuted: true, modMuted: false });
    expect((await mute(l, l, false)).body).toEqual({ micMuted: false, modMuted: false });

    // Admin mute is a separate switch: it doesn't touch the self mute.
    expect((await mute(adm, l, true)).body).toEqual({ micMuted: false, modMuted: true });
    // While admin-muted, the user can still flip their own switch either way.
    expect((await mute(l, l, true)).body).toEqual({ micMuted: true, modMuted: true });
    // Moving seats keeps both switches.
    await api("POST", `/rooms/${roomId}/seats/4/claim`, l.token);
    expect(await seat(4)).toMatchObject({ micMuted: true, modMuted: true });
    // Lifting the admin mute leaves them self-muted: no surprise open mic.
    expect((await mute(adm, l, false)).body).toEqual({ micMuted: true, modMuted: false });
    expect((await mute(l, l, false)).body).toEqual({ micMuted: false, modMuted: false });
    // Self-unmuting under an admin mute flips only the self switch; the admin mute still holds.
    await mute(adm, l, true);
    expect((await mute(l, l, false)).body).toEqual({ micMuted: false, modMuted: true });
    // Leaving the stage clears both.
    await mute(l, l, true);
    await api("POST", `/rooms/${roomId}/seats/4/release`, l.token);
    await api("POST", `/rooms/${roomId}/seats/4/claim`, l.token);
    expect(await seat(4)).toMatchObject({ micMuted: false, modMuted: false });

    // Admins can't mute or unseat the owner or other admins; the owner can mute and unseat admins.
    expect((await mute(adm, adm2, true)).body.error.code).toBe("CANNOT_TARGET_ADMIN");
    expect((await mute(adm, host, true)).body.error.code).toBe("CANNOT_TARGET_OWNER");
    expect((await mute(host, adm2, true)).body.modMuted).toBe(true);
    expect((await mute(adm2, adm2, false)).body).toEqual({ micMuted: false, modMuted: true });
    const unseat = (actor: { token: string }, target: { id: string }) =>
      api("POST", `/rooms/${roomId}/participants/${target.id}/unseat`, actor.token);
    expect((await unseat(adm, adm2)).body.error.code).toBe("CANNOT_TARGET_ADMIN");
    expect((await unseat(adm, host)).body.error.code).toBe("CANNOT_TARGET_OWNER");
    expect((await unseat(l, adm)).body.error.code).toBe("NOT_ROOM_ADMIN");

    const sl = socketFor(l.token);
    await emit(sl, "room:join", { roomId });
    const told = nextEvent(sl, "room:unseated");
    expect((await unseat(adm, l)).body.seatIndex).toBe(4);
    expect((await told).seatIndex).toBe(4);
    expect((await unseat(host, adm2)).body.unseated).toBe(true);
    expect((await seat(2)).occupant).toBeNull();
    // Unseated users stay in the room as listeners.
    const snap = (await api("GET", `/rooms/${roomId}`, host.token)).body;
    expect(snap.participants.map((p: any) => p.userId)).toEqual(expect.arrayContaining([l.id, adm2.id]));
    expect((await unseat(adm, l)).body.error.code).toBe("NOT_SEATED");
  });

  test("owner can leave or move seats; only owner and admins sit on seat 0", async () => {
    const { host, roomId } = await liveRoom(8);
    const adm = await joined(roomId, "seatadm");
    const l = await joined(roomId, "seatlis");
    const seats = async () => (await api("GET", `/rooms/${roomId}`, host.token)).body.seats;

    // Owner moves off seat 0 and back, then leaves the stage; the room stays live.
    expect((await api("POST", `/rooms/${roomId}/seats/6/claim`, host.token)).status).toBe(200);
    expect((await seats())[0].occupant).toBeNull();
    expect((await api("POST", `/rooms/${roomId}/seats/0/claim`, l.token)).body.error.code).toBe("HOST_SEAT_RESERVED");
    expect((await api("POST", `/rooms/${roomId}/seats/6/release`, host.token)).body.released).toBe(true);
    const snap = (await api("GET", `/rooms/${roomId}`, host.token)).body;
    expect(snap.status).toBe("LIVE");
    expect(snap.participants.find((p: any) => p.userId === host.id).role).toBe("HOST");

    // Admins can take the owner seat; nobody (owner included) takes a locked seat without an invite.
    await api("POST", `/rooms/${roomId}/admins/${adm.id}`, host.token);
    expect((await api("POST", `/rooms/${roomId}/seats/0/claim`, adm.token)).status).toBe(200);
    await api("POST", `/rooms/${roomId}/seats/2/lock`, host.token, { locked: true });
    expect((await api("POST", `/rooms/${roomId}/seats/2/claim`, l.token)).body.error.code).toBe("SEAT_LOCKED");
    expect((await api("POST", `/rooms/${roomId}/seats/2/claim`, host.token)).body.error.code).toBe("SEAT_LOCKED");
    await api("POST", `/rooms/${roomId}/seats/2/lock`, host.token, { locked: false });
    expect((await api("POST", `/rooms/${roomId}/seats/2/claim`, host.token)).status).toBe(200);
    expect((await api("POST", `/rooms/${roomId}/seats/0/claim`, host.token)).body.error.code).toBe("SEAT_TAKEN");
    const now = await seats();
    expect(now[0].occupant.userId).toBe(adm.id);
    expect(now[2].occupant.userId).toBe(host.id);
  });

  test("kicked users land on the kicked-out list and can rejoin once taken off it", async () => {
    const { host, roomId } = await liveRoom();
    const a = await joined(roomId, "kick");
    await api("POST", `/rooms/${roomId}/seats/1/claim`, a.token);
    expect((await api("POST", `/rooms/${roomId}/participants/${host.id}/remove`, a.token)).body.error.code).toBe("NOT_ROOM_ADMIN");
    expect((await api("POST", `/rooms/${roomId}/participants/${a.id}/remove`, host.token)).status).toBe(200);
    expect((await api("POST", `/rooms/${roomId}/join`, a.token)).body.error.code).toBe("REMOVED_FROM_ROOM");

    const list = await api("GET", `/rooms/${roomId}/kicked`, host.token);
    expect(list.body.map((u: any) => u.userId)).toEqual([a.id]);
    expect((await api("GET", `/rooms/${roomId}/kicked`, a.token)).body.error.code).toBe("NOT_ROOM_ADMIN");

    expect((await api("DELETE", `/rooms/${roomId}/kicked/${a.id}`, host.token)).body.unkicked).toBe(true);
    expect((await api("GET", `/rooms/${roomId}/kicked`, host.token)).body).toEqual([]);
    expect((await api("POST", `/rooms/${roomId}/join`, a.token)).status).toBe(200);
  });

  test("owner makes admins; admins moderate everyone except the owner and other admins", async () => {
    const { host, roomId } = await liveRoom();
    const adm = await joined(roomId, "adm");
    const adm2 = await joined(roomId, "admtwo");
    const l = await joined(roomId, "lis");

    expect((await api("POST", `/rooms/${roomId}/admins/${l.id}`, adm.token)).body.error.code).toBe("NOT_HOST");
    const sl = socketFor(l.token);
    await emit(sl, "room:join", { roomId });
    const state = nextEvent(sl, "room:state");
    expect((await api("POST", `/rooms/${roomId}/admins/${adm.id}`, host.token)).body.admin).toBe(true);
    expect((await state).admins).toEqual([adm.id]);
    await api("POST", `/rooms/${roomId}/admins/${adm2.id}`, host.token);
    expect((await api("GET", `/rooms/${roomId}`, l.token)).body.admins.sort()).toEqual([adm.id, adm2.id].sort());
    // Only the owner grants admin, even to admins.
    expect((await api("POST", `/rooms/${roomId}/admins/${l.id}`, adm.token)).body.error.code).toBe("NOT_HOST");

    // Admin powers: lock seats, invite, mute and kick listeners.
    expect((await api("POST", `/rooms/${roomId}/seats/5/lock`, adm.token, { locked: true })).body.locked).toBe(true);
    expect((await api("POST", `/rooms/${roomId}/seats/5/invite`, adm.token, { userId: l.id })).body.invited).toBe(true);
    await api("POST", `/rooms/${roomId}/seats/5/accept-invite`, l.token);
    expect((await api("POST", `/rooms/${roomId}/participants/${l.id}/mute`, adm.token, { muted: true })).body.modMuted).toBe(true);
    // ...but not against the owner or another admin.
    expect((await api("POST", `/rooms/${roomId}/participants/${host.id}/mute`, adm.token, { muted: true })).body.error.code).toBe("CANNOT_TARGET_OWNER");
    expect((await api("POST", `/rooms/${roomId}/participants/${adm2.id}/remove`, adm.token)).body.error.code).toBe("CANNOT_TARGET_ADMIN");

    expect((await api("POST", `/rooms/${roomId}/participants/${l.id}/remove`, adm.token)).body.removed).toBe(true);
    expect((await api("GET", `/rooms/${roomId}/kicked`, adm.token)).body.map((u: any) => u.userId)).toEqual([l.id]);

    // Admin survives leave/rejoin; revoking drops the powers; kicking an admin removes the role.
    await api("POST", `/rooms/${roomId}/leave`, adm.token);
    await api("POST", `/rooms/${roomId}/join`, adm.token);
    expect((await api("GET", `/rooms/${roomId}`, adm.token)).body.admins).toContain(adm.id);
    await api("DELETE", `/rooms/${roomId}/admins/${adm.id}`, host.token);
    expect((await api("POST", `/rooms/${roomId}/seats/6/lock`, adm.token, { locked: true })).body.error.code).toBe("NOT_ROOM_ADMIN");
    await api("POST", `/rooms/${roomId}/participants/${adm2.id}/remove`, host.token);
    expect((await api("GET", `/rooms/${roomId}`, host.token)).body.admins).toEqual([]);
  });
});

describe("seat locks and invites", () => {
  test("host locks seats; invites bypass locks; accept needs a live invite", async () => {
    const { host, roomId } = await liveRoom();
    const a = await joined(roomId, "lockA");
    const b = await joined(roomId, "lockB");

    expect((await api("POST", `/rooms/${roomId}/seats/2/lock`, a.token, { locked: true })).body.error.code).toBe("NOT_ROOM_ADMIN");
    expect((await api("POST", `/rooms/${roomId}/seats/0/lock`, host.token, { locked: true })).body.error.code).toBe("HOST_SEAT_RESERVED");
    expect((await api("POST", `/rooms/${roomId}/seats/2/lock`, host.token, { locked: true })).body.locked).toBe(true);
    expect((await api("GET", `/rooms/${roomId}`, a.token)).body.seats[2].locked).toBe(true);

    expect((await api("POST", `/rooms/${roomId}/seats/2/claim`, a.token)).body.error.code).toBe("SEAT_LOCKED");
    expect((await api("POST", `/rooms/${roomId}/seats/2/accept-invite`, a.token)).body.error.code).toBe("INVITE_EXPIRED");
    expect((await api("POST", `/rooms/${roomId}/seats/2/invite`, a.token, { userId: b.id })).body.error.code).toBe("NOT_ROOM_ADMIN");

    // Invite a over the socket channel, accept, and take the locked seat.
    const sa = socketFor(a.token);
    await emit(sa, "room:join", { roomId });
    const got = nextEvent(sa, "room:seat:invite");
    expect((await api("POST", `/rooms/${roomId}/seats/2/invite`, host.token, { userId: a.id })).body.invited).toBe(true);
    expect((await got).seatIndex).toBe(2);
    expect((await api("POST", `/rooms/${roomId}/seats/3/accept-invite`, a.token)).body.error.code).toBe("INVITE_EXPIRED"); // wrong seat
    const acc = await emit(sa, "room:seat:accept", { roomId, seatIndex: 2 });
    expect(acc.ok).toBe(true);
    expect(acc.data.zego.streamId).toBeString();
    const seats = (await api("GET", `/rooms/${roomId}`, a.token)).body.seats;
    expect(seats[2].occupant.userId).toBe(a.id);
    expect(seats[2].locked).toBe(true);
    // The invite is single-use, and occupied seats can't be (un)locked.
    expect((await api("POST", `/rooms/${roomId}/seats/2/accept-invite`, a.token)).body.error.code).toBe("INVITE_EXPIRED");
    expect((await api("POST", `/rooms/${roomId}/seats/2/lock`, host.token, { locked: false })).body.error.code).toBe("SEAT_OCCUPIED");
    expect((await api("POST", `/rooms/${roomId}/seats/3/invite`, host.token, { userId: a.id })).body.error.code).toBe("ALREADY_SEATED");

    // b declines; host hears about it.
    const sh = socketFor(host.token);
    await emit(sh, "room:join", { roomId });
    await api("POST", `/rooms/${roomId}/seats/4/invite`, host.token, { userId: b.id });
    const declined = nextEvent(sh, "room:seat:invite:declined");
    expect((await api("POST", `/rooms/${roomId}/invite/decline`, b.token)).body.declined).toBe(true);
    expect((await declined).user.userId).toBe(b.id);
    expect((await api("POST", `/rooms/${roomId}/seats/4/accept-invite`, b.token)).body.error.code).toBe("INVITE_EXPIRED");
  });
});

describe("gifts", () => {
  test("profile cards show this week's contribution (sent) and charisma (received); last week's gifts drop off", async () => {
    const { host, roomId } = await liveRoom();
    const fan = await joined(roomId, "wkfan");
    const gift = (giftId: string, quantity: number) =>
      api("POST", `/rooms/${roomId}/gifts`, fan.token, { recipientUserId: host.id, giftId, quantity }, { "Idempotency-Key": crypto.randomUUID() });
    expect((await gift("chai", 2)).status).toBe(200); // 20 coins
    expect((await gift("star", 1)).status).toBe(200); // 50 coins
    const week = async (id: string) => (await api("GET", `/users/${id}`, fan.token)).body.week;
    expect(await week(fan.id)).toMatchObject({ contribution: 70, charisma: 0 });
    expect(await week(host.id)).toMatchObject({ contribution: 0, charisma: 70 });
    const { endsAt } = await week(host.id);
    // Resets Monday 00:00 India time.
    const ist = new Date(new Date(endsAt).getTime() + 5.5 * 3600_000);
    expect([ist.getUTCDay(), ist.getUTCHours(), ist.getUTCMinutes()]).toEqual([1, 0, 0]);
    expect(new Date(endsAt).getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);

    await db.execute(sql`update gift_transactions set created_at = created_at - interval '8 days' where sender_id = ${fan.id}`);
    expect(await week(fan.id)).toMatchObject({ contribution: 0, charisma: 0 });
    expect(await week(host.id)).toMatchObject({ charisma: 0 });
  });

  test("only seated recipients, idempotent, no overspend", async () => {
    const { host, roomId } = await liveRoom();
    const sender = await joined(roomId, "giver");
    const listener = await joined(roomId, "listener");
    const send = (to: string, key: string, giftId = "chai", quantity = 1, token = sender.token) =>
      api("POST", `/rooms/${roomId}/gifts`, token, { recipientUserId: to, giftId, quantity }, { "Idempotency-Key": key });

    expect((await send(listener.id, "k0")).body.error.code).toBe("RECIPIENT_NOT_SEATED");
    expect((await send(sender.id, "k1")).body.error.code).toBe("RECIPIENT_NOT_SEATED");
    expect((await api("POST", `/rooms/${roomId}/gifts`, sender.token, { recipientUserId: host.id, giftId: "chai", quantity: 1 })).status).toBe(400);

    // Same key, sent twice in parallel and once more after: exactly one debit.
    const results = await Promise.all([send(host.id, "k2"), send(host.id, "k2")]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((await send(host.id, "k2")).body.replayed).toBe(true);
    expect((await send(host.id, "k2", "rose")).body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await api("GET", "/wallet", sender.token)).body.balance).toBe(config.signupBonusCoins - 10);

    // 990 left; ten parallel 100-coin sends: only nine fit.
    const crowns = await Promise.all(Array.from({ length: 10 }, (_, i) => send(host.id, `c${i}`, "star", 2)));
    const ok = crowns.filter((r) => r.status === 200).length;
    expect(ok).toBe(9);
    expect(crowns.find((r) => r.status !== 200)!.body.error.code).toBe("INSUFFICIENT_COINS");
    const balance = (await api("GET", "/wallet", sender.token)).body.balance;
    expect(balance).toBe(990 - 9 * 100);

    // Ledger reconciles with cached balance.
    const ledger = (await api("GET", "/wallet/transactions?limit=50", sender.token)).body.entries;
    expect(ledger.reduce((s: number, e: any) => s + e.amount, 0)).toBe(balance);
  });

  test("self-gift while seated, and one gift to everyone on stage", async () => {
    const { host, roomId } = await liveRoom();
    const a = await joined(roomId, "galla");
    const b = await joined(roomId, "gallb");
    const listener = await joined(roomId, "galll");
    await api("POST", `/rooms/${roomId}/seats/1/claim`, a.token);
    await api("POST", `/rooms/${roomId}/seats/2/claim`, b.token);
    const bal = async (u: { token: string }) => (await api("GET", "/wallet", u.token)).body.balance;

    // Seated users can gift themselves.
    const self = await api("POST", `/rooms/${roomId}/gifts`, a.token, { recipientUserId: a.id, giftId: "rose", quantity: 1 }, { "Idempotency-Key": "s1" });
    expect(self.status).toBe(200);
    expect(self.body.transaction.recipientId).toBe(a.id);

    // Everyone seated (host, a, b) gets 2x chai = 20 each; the listener pays 60 once.
    const sl = socketFor(listener.token);
    await emit(sl, "room:join", { roomId });
    const banner = nextEvent(sl, "room:gift:received");
    const before = await bal(listener);
    const all = (key: string, giftId = "chai", quantity = 2) =>
      api("POST", `/rooms/${roomId}/gifts/all-seated`, listener.token, { giftId, quantity }, { "Idempotency-Key": key });
    const r = await all("b1");
    expect(r.status).toBe(200);
    expect(r.body.transactions.map((t: any) => t.recipientId).sort()).toEqual([host.id, a.id, b.id].sort());
    expect(r.body.balance).toBe(before - 60);
    expect((await banner).recipients).toHaveLength(3);

    // Retrying the same batch never charges twice; reusing the key for something else is refused.
    expect((await all("b1")).body.replayed).toBe(true);
    expect(await bal(listener)).toBe(before - 60);
    expect((await all("b1", "rose", 1)).body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // Not enough coins for everyone: nothing is charged at all.
    const tooMuch = await all("b2", "crown", 10);
    expect(tooMuch.body.error.code).toBe("INSUFFICIENT_COINS");
    expect(await bal(listener)).toBe(before - 60);

    // Ledger still reconciles with the balance.
    const ledger = (await api("GET", "/wallet/transactions?limit=50", listener.token)).body.entries;
    expect(ledger.reduce((sum: number, e: any) => sum + e.amount, 0)).toBe(await bal(listener));
  });

  test("animated gift: artwork in the catalog and in the room event", async () => {
    const { host, roomId } = await liveRoom();
    const fan = await joined(roomId, "rocketfan");
    const catalog = (await api("GET", "/gifts", fan.token)).body;
    const rocket = catalog.find((g: any) => g.id === "rocket");
    expect(rocket).toMatchObject({ coinPrice: 100, animation: "launch" });
    expect(rocket.svg).toStartWith("<svg");

    const s = socketFor(host.token);
    await emit(s, "room:join", { roomId });
    const shown = nextEvent(s, "room:gift:received");
    const sent = await api("POST", `/rooms/${roomId}/gifts`, fan.token, { recipientUserId: host.id, giftId: "rocket", quantity: 2 }, { "Idempotency-Key": "rk1" });
    expect(sent.status).toBe(200);
    const evt = await shown;
    expect(evt.gift).toMatchObject({ id: "rocket", animation: "launch" });
    expect(evt.gift.svg).toContain("<svg");
    expect(evt.quantity).toBe(2);
  });

  test("recipient leaving seat makes gift fail", async () => {
    const { roomId } = await liveRoom();
    const sender = await joined(roomId, "g2");
    const seated = await joined(roomId, "s2");
    await api("POST", `/rooms/${roomId}/seats/2/claim`, seated.token);
    await api("POST", `/rooms/${roomId}/seats/2/release`, seated.token);
    const r = await api("POST", `/rooms/${roomId}/gifts`, sender.token, { recipientUserId: seated.id, giftId: "rose", quantity: 1 }, { "Idempotency-Key": "x" });
    expect(r.body.error.code).toBe("RECIPIENT_NOT_SEATED");
  });
});

describe("socket chat", () => {
  test("verified mentions, blocks, history, seat events", async () => {
    const { host, roomId } = await liveRoom();
    const a = await joined(roomId, "chatA");
    const b = await joined(roomId, "chatB");
    const outsider = await signup("out");
    const [sh, sa, sb] = [socketFor(host.token), socketFor(a.token), socketFor(b.token)];

    expect((await emit(sa, "room:join", { roomId })).ok).toBe(true);
    expect((await emit(sb, "room:join", { roomId })).ok).toBe(true);
    expect((await emit(sh, "room:join", { roomId })).data.seatCount).toBe(8);
    expect((await emit(socketFor(outsider.token), "room:join", { roomId })).error.code).toBe("NOT_IN_ROOM");

    const got = nextEvent(sb, "room:chat:new");
    const sent = await emit(sa, "room:chat:send", {
      roomId,
      body: `hi @${b.handle}`,
      mentions: [{ userId: b.id }, { userId: host.id }, { userId: outsider.id }],
      clientMessageId: "m1",
    });
    expect(sent.ok).toBe(true);
    expect(sent.data.mentions).toEqual([b.id]); // host not in text, outsider not in room
    expect((await got).body).toBe(`hi @${b.handle}`);

    // Retry with the same clientMessageId does not duplicate.
    const again = await emit(sa, "room:chat:send", { roomId, body: `hi @${b.handle}`, mentions: [], clientMessageId: "m1" });
    expect(again.data.messageId).toBe(sent.data.messageId);

    // b blocks a: b no longer receives a's messages, and history hides them.
    await api("POST", `/users/${a.id}/block`, b.token);
    let leaked = false;
    sb.on("room:chat:new", (m) => m.sender?.userId === a.id && (leaked = true));
    const hostGot = nextEvent(sh, "room:chat:new");
    await emit(sa, "room:chat:send", { roomId, body: "secret", mentions: [], clientMessageId: "m2" });
    await hostGot;
    expect(leaked).toBe(false);
    const hist = await api("GET", `/rooms/${roomId}/messages`, b.token);
    expect(hist.body.messages.some((m: any) => m.sender?.userId === a.id)).toBe(false);

    // Emotes: anyone in the room (b is not seated yet); the server draws the dice and the line stays in chat.
    const emoteGot = nextEvent(sh, "room:chat:new");
    const dice = await emit(sb, "room:emote", { roomId, emote: "dice", clientMessageId: "e1" });
    expect(dice.ok).toBe(true);
    const de = await emoteGot;
    expect(de.payload.emote).toBe("dice");
    expect(["1", "2", "3", "4", "5", "6"]).toContain(de.payload.result);
    expect(de.body).toBe(`🎲 rolled ${de.payload.result}`);
    expect((await emit(sb, "room:emote", { roomId, emote: "dance", clientMessageId: "e2" })).ok).toBe(false);
    const hist2 = await api("GET", `/rooms/${roomId}/messages`, host.token);
    expect(hist2.body.messages.some((m: any) => m.payload?.emote === "dice")).toBe(true);
    for (let i = 0; i < 200; i++) {
      expect(chat.drawEmote("roller").result).toMatch(/^\d{3}$/);
      expect(["Heads", "Tails"]).toContain(chat.drawEmote("coin").result!);
    }

    const seatEvt = nextEvent(sh, "room:seat:state");
    expect((await emit(sb, "room:seat:claim", { roomId, seatIndex: 5 })).ok).toBe(true);
    const evt = await seatEvt;
    expect(evt.seats[5].occupant.userId).toBe(b.id);
    expect(evt.roomVersion).toBeNumber();
  });

  test("owner disconnecting beyond grace just leaves; the room stays open", async () => {
    const { host, roomId } = await liveRoom();
    const a = await joined(roomId, "watcher");
    const sa = socketFor(a.token);
    await emit(sa, "room:join", { roomId });
    const sh = socketFor(host.token);
    await emit(sh, "room:join", { roomId });
    const left = nextEvent(sa, "room:participant:left");
    sh.close();
    expect((await left).userId).toBe(host.id);
    const snap = (await api("GET", `/rooms/${roomId}`, a.token)).body;
    expect(snap.status).toBe("LIVE");
    expect(snap.seats[0].occupant).toBeNull(); // the owner's seat was freed
  });

  test("closing the app frees the seat at once (no grace); a dropped connection that comes back is announced again", async () => {
    const { host, roomId } = await liveRoom();
    const a = await joined(roomId, "closer");
    await api("POST", `/rooms/${roomId}/seats/3/claim`, a.token);
    const sh = socketFor(host.token);
    await emit(sh, "room:join", { roomId });
    const sa = socketFor(a.token);
    await emit(sa, "room:join", { roomId });

    const left = nextEvent(sh, "room:participant:left");
    const t = Date.now();
    sa.close(); // a clean close: what the server sees when the app is swiped away
    expect((await left).userId).toBe(a.id);
    expect(Date.now() - t).toBeLessThan(250); // well under even the test grace (300ms)
    expect((await api("GET", `/rooms/${roomId}`, host.token)).body.seats[3].occupant).toBeNull();

    // Someone whose connection dropped (still in the room, marked away) and then reattaches gets the "joined" line again.
    const b = await joined(roomId, "comeback");
    await db.execute(sql`update room_participants set presence = 'DISCONNECTED' where room_id = ${roomId} and user_id = ${b.id} and left_at is null`);
    const sb = socketFor(b.token);
    await emit(sb, "room:join", { roomId });
    const joins = (await api("GET", `/rooms/${roomId}/messages`, host.token)).body.messages.filter((m: any) => m.payload?.kind === "JOIN" && m.payload.userId === b.id);
    expect(joins).toHaveLength(2); // entering, then coming back
    await emit(sb, "room:join", { roomId }); // attaching again while connected is not a comeback
    expect((await api("GET", `/rooms/${roomId}/messages`, host.token)).body.messages.filter((m: any) => m.payload?.kind === "JOIN" && m.payload.userId === b.id)).toHaveLength(2);
  });

  test("rooms are permanent: one per owner, never end, open to anyone, admins kept", async () => {
    const owner = await signup("perm");
    const created = await api("POST", "/rooms", owner.token, { title: "Forever Chai", seatCount: 10 });
    const roomId = created.body.room.roomId;
    expect(created.body.room.status).toBe("LIVE");
    expect((await api("GET", "/me/room", owner.token)).body.room.roomId).toBe(roomId);
    expect((await api("POST", "/rooms", owner.token, { title: "Another", seatCount: 8 })).body.error.code).toBe("ALREADY_HAS_ROOM");
    expect((await api("POST", `/rooms/${roomId}/end`, owner.token)).status).toBe(404); // no way to end a room

    const adm = await joined(roomId, "permadm");
    await api("POST", `/rooms/${roomId}/admins/${adm.id}`, owner.token);
    await api("POST", `/rooms/${roomId}/seats/3/lock`, owner.token, { locked: true });

    // Everyone leaves, owner included; the room stays open and listed.
    await api("POST", `/rooms/${roomId}/leave`, adm.token);
    await api("POST", `/rooms/${roomId}/leave`, owner.token);
    const empty = (await api("GET", `/rooms/${roomId}`, owner.token)).body;
    expect(empty).toMatchObject({ status: "LIVE", listenerCount: 0, title: "Forever Chai" });
    const list = (await everyRoom("/rooms", adm.token));
    expect(list.some((r: any) => r.roomId === roomId)).toBe(true);

    // A newcomer joins with nobody else there; the admin comes back still an admin; settings kept.
    const newbie = await joined(roomId, "permnew");
    expect((await api("POST", `/rooms/${roomId}/join`, adm.token)).status).toBe(200);
    const back = (await api("GET", `/rooms/${roomId}`, newbie.token)).body;
    expect(back.admins).toEqual([adm.id]);
    expect(back.seats[3].locked).toBe(true);
    expect(back.roomId).toBe(roomId);
    // The owner rejoins as a listener and can sit back down on the owner seat.
    await api("POST", `/rooms/${roomId}/join`, owner.token);
    expect((await api("POST", `/rooms/${roomId}/seats/0/claim`, owner.token)).status).toBe(200);
  });
});

describe("posts", () => {
  // Fake media: the server only checks magic bytes.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(64, 7)]);
  const upload = async (token: string, fields: Record<string, string | Buffer>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) typeof v === "string" ? form.append(k, v) : form.append(k, new Blob([v]), k);
    const res = await fetch(base + "/v1/posts", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: (await res.json()) as any };
  };

  test("photo, video and text posts; uncropped sizes; feed, likes, profile grid, delete", async () => {
    const a = await signup("posta");
    const b = await signup("postb");
    expect((await upload(a.token, { file: Buffer.from("not media"), width: "10", height: "10" })).body.error.code).toBe("BAD_MEDIA");
    expect((await upload(a.token, { caption: "   " })).body.error.code).toBe("EMPTY_POST");
    expect((await upload(a.token, { file: mp4, width: "1080", height: "1920" })).body.error.code).toBe("THUMB_REQUIRED");

    const photo = await upload(a.token, { file: png, width: "1080", height: "1350", caption: "sunset" });
    expect(photo.status).toBe(201);
    const video = await upload(b.token, { file: mp4, thumb: png, width: "1080", height: "1920", caption: "dance" });
    expect(video.status).toBe(201);
    const text = await upload(b.token, { caption: "Good morning everyone!" });
    expect(text.status).toBe(201);

    const feed = (await api("GET", "/posts?limit=2", a.token)).body;
    expect(feed.posts.map((x: any) => x.kind)).toEqual(["TEXT", "VIDEO"]);
    expect(feed.posts[0]).toMatchObject({ postId: text.body.postId, caption: "Good morning everyone!", imageUrl: null, videoUrl: null, width: null });
    const v = feed.posts[1];
    expect(v).toMatchObject({ postId: video.body.postId, width: 1080, height: 1920, likes: 0, likedByMe: false, author: { userId: b.id } });
    const older = (await api("GET", `/posts?limit=2&cursor=${encodeURIComponent(feed.nextCursor)}`, a.token)).body;
    expect(older.posts[0]).toMatchObject({ postId: photo.body.postId, kind: "IMAGE", width: 1080, height: 1350, videoUrl: null });

    // Media is served back as uploaded; videos support byte ranges for streaming.
    const img = await fetch(base + older.posts[0].imageUrl);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer()).equals(png)).toBe(true);
    const part = await fetch(base + v.videoUrl, { headers: { range: "bytes=4-11" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 4-11/${mp4.length}`);
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe("ftypmp42");
    expect((await fetch(base + v.videoUrl, { headers: { range: "bytes=9999-" } })).status).toBe(416);
    expect((await fetch(base + v.imageUrl)).headers.get("content-type")).toBe("image/png"); // poster frame

    // Liking twice counts once.
    await api("POST", `/posts/${video.body.postId}/like`, a.token);
    expect((await api("POST", `/posts/${video.body.postId}/like`, a.token)).body).toEqual({ likes: 1, likedByMe: true });
    expect((await api("GET", `/users/${b.id}/posts`, a.token)).body.posts[1]).toMatchObject({ likes: 1, likedByMe: true });
    expect((await api("GET", `/users/${b.id}`, a.token)).body.posts).toBe(2);
    expect((await api("DELETE", `/posts/${video.body.postId}/like`, a.token)).body).toEqual({ likes: 0, likedByMe: false });

    // Only the author can delete; the video and its poster go too.
    expect((await api("DELETE", `/posts/${video.body.postId}`, a.token)).status).toBe(404);
    expect((await api("DELETE", `/posts/${video.body.postId}`, b.token)).status).toBe(200);
    expect((await fetch(base + v.videoUrl)).status).toBe(404);
    expect((await fetch(base + v.imageUrl)).status).toBe(404);
    await api("DELETE", `/posts/${photo.body.postId}`, a.token);
    await api("DELETE", `/posts/${text.body.postId}`, b.token);
  });
});

describe("post comments", () => {
  test("comment, list newest first with paging, count on the post, delete rules", async () => {
    const owner = await signup("cmo");
    const a = await signup("cma");
    const b = await signup("cmb");
    const form = new FormData();
    form.append("caption", "Comment on me");
    const res = await fetch(base + "/v1/posts", { method: "POST", headers: { authorization: `Bearer ${owner.token}` }, body: form });
    const postId = ((await res.json()) as any).postId;

    expect((await api("POST", `/posts/${postId}/comments`, a.token, { body: "  " })).status).toBe(400);
    const c1 = (await api("POST", `/posts/${postId}/comments`, a.token, { body: "First!" })).body;
    expect(c1).toMatchObject({ body: "First!", user: { userId: a.id, displayName: a.handle } });
    const c2 = (await api("POST", `/posts/${postId}/comments`, b.token, { body: "Nice post" })).body;

    const page1 = (await api("GET", `/posts/${postId}/comments?limit=1`, a.token)).body;
    expect(page1.comments.map((x: any) => x.body)).toEqual(["Nice post"]);
    const page2 = (await api("GET", `/posts/${postId}/comments?limit=1&cursor=${page1.nextCursor}`, a.token)).body;
    expect(page2.comments.map((x: any) => x.body)).toEqual(["First!"]);
    expect((await api("GET", `/users/${owner.id}/posts`, a.token)).body.posts[0].comments).toBe(2);

    // b can't delete a's comment; the post owner can; a can delete their own.
    expect((await api("DELETE", `/posts/${postId}/comments/${c1.id}`, b.token)).status).toBe(403);
    expect((await api("DELETE", `/posts/${postId}/comments/${c2.id}`, owner.token)).status).toBe(200);
    expect((await api("DELETE", `/posts/${postId}/comments/${c1.id}`, a.token)).status).toBe(200);
    expect((await api("GET", `/posts/${postId}/comments`, a.token)).body.comments).toEqual([]);
    await api("DELETE", `/posts/${postId}`, owner.token);
  });
});

describe("followers, following and visitors", () => {
  test("lists are paged newest first; visits are counted and private to the owner", async () => {
    const owner = await signup("pvo");
    const a = await signup("pva");
    const b = await signup("pvb");
    await api("POST", `/users/${owner.id}/follow`, a.token);
    await api("POST", `/users/${owner.id}/follow`, b.token);
    await api("POST", `/users/${b.id}/follow`, owner.token);

    const first = (await api("GET", `/users/${owner.id}/followers?limit=1`, owner.token)).body;
    expect(first.people.map((p: any) => p.userId)).toEqual([b.id]);
    expect(first.people[0].isFollowing).toBe(true); // owner follows b back
    const next = (await api("GET", `/users/${owner.id}/followers?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, owner.token)).body;
    expect(next.people.map((p: any) => p.userId)).toEqual([a.id]);
    expect(next.people[0].isFollowing).toBe(false);
    expect((await api("GET", `/users/${owner.id}/following`, a.token)).body.people.map((p: any) => p.userId)).toEqual([b.id]);

    // Visits: a twice, b once; opening your own profile isn't a visit.
    await api("GET", `/users/${owner.id}`, a.token);
    await api("GET", `/users/${owner.id}`, b.token);
    await api("GET", `/users/${owner.id}`, a.token);
    const mine = (await api("GET", `/users/${owner.id}`, owner.token)).body;
    expect(mine.visitors).toBe(2);
    expect((await api("GET", `/users/${owner.id}`, a.token)).body.visitors).toBeUndefined();
    const visitors = (await api("GET", "/me/visitors", owner.token)).body.people;
    expect(visitors.map((p: any) => [p.userId, p.visits])).toEqual([[a.id, 3], [b.id, 1]]);

    // Batch cards (room prefetch): same profile shape, viewer-relative follow state, and not a visit.
    const cards = (await api("POST", "/users/cards", b.token, { ids: [owner.id, a.id, owner.id] })).body.profiles;
    expect(cards.length).toBe(2);
    const card = cards.find((p: any) => p.userId === owner.id);
    expect(card).toMatchObject({ followers: 2, isFollowing: true, followsMe: true, isMe: false });
    expect((await api("GET", "/me/visitors", owner.token)).body.people.map((p: any) => [p.userId, p.visits])).toEqual([[a.id, 3], [b.id, 1]]);
  });
});

describe("profile likes", () => {
  test("like once, unlike, count on the profile, never your own", async () => {
    const a = await signup("pla");
    const b = await signup("plb");
    expect((await api("GET", `/users/${b.id}`, a.token)).body).toMatchObject({ likes: 0, likedByMe: false });
    await api("POST", `/users/${b.id}/like`, a.token);
    expect((await api("POST", `/users/${b.id}/like`, a.token)).body).toEqual({ likes: 1, likedByMe: true });
    expect((await api("GET", `/users/${b.id}`, a.token)).body).toMatchObject({ likes: 1, likedByMe: true });
    expect((await api("GET", `/users/${b.id}`, b.token)).body).toMatchObject({ likes: 1, likedByMe: false });
    expect((await api("POST", `/users/${a.id}/like`, a.token)).status).toBe(400);
    expect((await api("DELETE", `/users/${b.id}/like`, a.token)).body).toEqual({ likes: 0, likedByMe: false });
  });
});

describe("user ids", () => {
  test("every user gets a unique 10-digit id; special ids are granted and searchable", async () => {
    const a = await signup("ida");
    const b = await signup("idb");
    const pa = (await api("GET", "/me", a.token)).body;
    const pb = (await api("GET", `/users/${b.id}`, a.token)).body;
    expect(String(pa.publicId)).toMatch(/^[1-9]\d{9}$/);
    expect(pb.publicId).not.toBe(pa.publicId);
    expect(pb.specialId).toBeNull();

    // Search by the 10-digit id.
    const byId = (await api("GET", `/users/search?q=${pb.publicId}`, a.token)).body.users;
    expect(byId).toHaveLength(1);
    expect(byId[0]).toMatchObject({ userId: b.id, displayName: b.handle, publicId: pb.publicId, specialId: null });

    // Special ids are granted separately, one owner each, and are searchable too.
    await setSpecialId(b.id, "888");
    expect((await setSpecialId(a.id, "888").catch((e) => e)).code).toBe("SPECIAL_ID_TAKEN");
    expect((await setSpecialId(a.id, "12").catch((e) => e)).code).toBe("BAD_SPECIAL_ID");
    expect((await api("GET", "/users/search?q=888", a.token)).body.users[0]).toMatchObject({ userId: b.id, specialId: "888" });
    expect((await api("GET", `/users/${b.id}`, a.token)).body.specialId).toBe("888");

    expect((await api("GET", "/users/search?q=0000000000", a.token)).body.users).toEqual([]);
    expect((await api("GET", "/users/search?q=abc", a.token)).body.users).toEqual([]); // letters are fine (special IDs can have them)
    expect((await api("GET", "/users/search?q=a%21b", a.token)).status).toBe(400);
    await setSpecialId(b.id, null);
    expect((await api("GET", "/users/search?q=888", a.token)).body.users).toEqual([]);
  });
});

describe("coin sellers", () => {
  test("apply once, staff approve, approved sellers are listed, rejected can re-apply", async () => {
    const a = await signup("sella");
    const b = await signup("sellb");
    expect((await api("GET", "/coin-sellers/me", a.token)).body).toEqual({ status: null, appliedAt: null });
    expect((await api("POST", "/coin-sellers/apply", a.token, { message: "hi" })).status).toBe(400);

    const applied = await api("POST", "/coin-sellers/apply", a.token, { message: "I run a recharge shop in Pune" });
    expect(applied.status).toBe(201);
    expect(applied.body.status).toBe("PENDING");
    expect((await api("POST", "/coin-sellers/apply", a.token, { message: "Applying a second time" })).body.error.code).toBe("ALREADY_APPLIED");
    // Pending applicants are not listed.
    expect((await api("GET", "/coin-sellers", b.token)).body.sellers.some((s: any) => s.userId === a.id)).toBe(false);

    await decideCoinSeller(a.id, true);
    const list = (await api("GET", "/coin-sellers", b.token)).body.sellers;
    expect(list.find((s: any) => s.userId === a.id)).toMatchObject({ displayName: a.handle, publicId: expect.any(Number) });
    expect((await api("GET", "/coin-sellers/me", a.token)).body.status).toBe("APPROVED");
    // Approval comes with the Coin Seller badge, shown first.
    expect((await api("GET", `/users/${a.id}`, b.token)).body.badges[0].id).toBe("coin_seller");

    await api("POST", "/coin-sellers/apply", b.token, { message: "I sell coins to my friends" });
    await decideCoinSeller(b.id, false);
    await decideCoinSeller(a.id, false);
    expect((await api("GET", `/users/${a.id}`, b.token)).body.badges.some((x: any) => x.id === "coin_seller")).toBe(false);
    expect((await api("POST", "/coin-sellers/apply", b.token, { message: "Trying again with a shop" })).body.status).toBe("PENDING");
  });
});

describe("staff console and seller wallets", () => {
  const key = () => crypto.randomUUID();
  const coins = async (token: string) => (await api("GET", "/wallet", token)).body.balance as number;
  const badgeIds = async (id: string, token: string) => ((await api("GET", `/users/${id}`, token)).body.badges as any[]).map((b) => b.id);

  test("only the owner sets staff roles; handing over ownership demotes the old owner", async () => {
    const owner = await signup("own");
    const adm = await signup("adm");
    const joe = await signup("joe");
    await db.execute(sql`update users set staff_role = null where staff_role = 'OWNER'`);
    await db.execute(sql`update users set staff_role = 'OWNER' where id = ${owner.id}`);
    await db.execute(sql`update users set staff_role = 'ADMIN' where id = ${adm.id}`);

    expect((await api("GET", `/admin/users?q=${joe.handle}`, joe.token)).status).toBe(403);
    expect((await api("GET", `/admin/users?q=${joe.handle}`, adm.token)).body.users[0].userId).toBe(joe.id);
    expect((await api("POST", `/admin/users/${joe.id}/staff-role`, adm.token, { role: "ADMIN" })).status).toBe(403);
    expect((await api("POST", `/admin/users/${owner.id}/staff-role`, owner.token, { role: null })).body.error.code).toBe("CANNOT_CHANGE_OWN_ROLE");
    expect((await api("POST", `/admin/users/${joe.id}/staff-role`, owner.token, { role: "MODERATOR" })).body.staffRole).toBe("MODERATOR");

    expect((await api("POST", `/admin/users/${adm.id}/staff-role`, owner.token, { role: "OWNER" })).body.staffRole).toBe("OWNER");
    expect((await api("GET", `/users/${owner.id}`, joe.token)).body.staffRole).toBe("ADMIN");
    expect((await api("POST", `/admin/users/${joe.id}/staff-role`, owner.token, { role: null })).status).toBe(403);
  });

  test("staff give and remove special ids", async () => {
    const adm = await signup("sid");
    const u = await signup("sidu");
    const v = await signup("sidv");
    await db.execute(sql`update users set staff_role = 'ADMIN' where id = ${adm.id}`);
    const set = (who: string, specialId: string | null, token = adm.token) => api("POST", `/admin/users/${who}/special-id`, token, { specialId });
    expect((await set(u.id, "7777", u.token)).status).toBe(403);
    expect((await set(u.id, "12")).body.error.code).toBe("BAD_SPECIAL_ID");
    expect((await set(u.id, "7777")).body.specialId).toBe("7777");
    expect((await set(v.id, "7777")).body.error.code).toBe("SPECIAL_ID_TAKEN");
    expect((await api("GET", "/admin/users?q=7777", adm.token)).body.users[0].userId).toBe(u.id);
    expect((await set(u.id, null)).body.specialId).toBeNull();

    // letters too, any case in, stored in capitals; found by every search in any case
    expect((await set(u.id, "vip88")).body.specialId).toBe("VIP88");
    expect((await set(v.id, "Vip88")).body.error.code).toBe("SPECIAL_ID_TAKEN");
    for (const bad of ["ab", "AB-12", "TOOLONGID1"]) expect((await set(v.id, bad)).body.error.code).toBe("BAD_SPECIAL_ID");
    expect((await api("GET", "/admin/users?q=vip88", adm.token)).body.users[0].userId).toBe(u.id);
    expect((await api("GET", "/users/search?q=Vip88", v.token)).body.users[0]).toMatchObject({ userId: u.id, specialId: "VIP88" });
    // a special ID that spells someone else's name wins the lookup (here: appointing a sub seller by "acename")
    const named = await signup("sidn");
    const nick = `ace${n}x`;
    expect((await api("PATCH", "/me/profile", named.token, { displayName: nick })).status).toBe(200);
    expect((await set(v.id, nick)).body.specialId).toBe(nick.toUpperCase());
    await decideCoinSeller(u.id, true);
    expect((await api("POST", "/coin-sellers/sub-sellers", u.token, { user: nick })).body.userId).toBe(v.id);
  });

  test("mint, sell, sub sellers, top-ups and removal move coins exactly once", async () => {
    const adm = await signup("mint");
    await db.execute(sql`update users set staff_role = 'ADMIN' where id = ${adm.id}`);
    const seller = await signup("sell");
    const sub = await signup("sub");
    const buyer = await signup("buy");
    const sid = (await api("GET", "/me", seller.token)).body.publicId;

    expect((await api("GET", "/coin-sellers/wallet", seller.token)).body.error.code).toBe("NOT_A_SELLER");
    expect((await api("POST", `/admin/coin-sellers/${seller.id}/decision`, adm.token, { approve: true })).body.status).toBe("APPROVED");
    expect(await badgeIds(seller.id, buyer.token)).toContain("coin_seller");

    const k = key();
    expect((await api("POST", `/admin/coin-sellers/${seller.id}/mint`, adm.token, { amount: 1000, idempotencyKey: k })).body.balance).toBe(1000);
    expect((await api("POST", `/admin/coin-sellers/${seller.id}/mint`, adm.token, { amount: 1000, idempotencyKey: k })).body.error.code).toBe("DUPLICATE_REQUEST");
    expect((await api("POST", `/admin/coin-sellers/${buyer.id}/mint`, adm.token, { amount: 5, idempotencyKey: key() })).body.error.code).toBe("NOT_A_SELLER");
    expect((await api("POST", `/admin/coin-sellers/${seller.id}/mint`, seller.token, { amount: 5, idempotencyKey: key() })).status).toBe(403);

    // sell to a user, then to my own main wallet
    const before = await coins(buyer.token);
    const sold = await api("POST", "/coin-sellers/wallet/sell", seller.token, { to: buyer.handle, amount: 300, idempotencyKey: key() });
    expect(sold.body).toMatchObject({ balance: 700, to: { userId: buyer.id } });
    expect(await coins(buyer.token)).toBe(before + 300);
    await Bun.sleep(100);
    const got = (await api("GET", "/dm/pending", buyer.token)).body.messages.at(-1);
    expect(got.notice).toMatchObject({ kind: "SELLER", status: "SUCCESS", coins: 300, balance: before + 300 });
    expect(got.body).not.toContain(seller.handle); // the seller stays anonymous
    expect((await api("GET", "/me", buyer.token)).body.level.xp).toBe(389); // 300 coins at the ₹6,499 / 5,000 coins rate
    // ...and counts toward SVIP like an app recharge.
    const { rows: svipRows } = await db.execute<{ paise: number }>(sql`select sum(price_paise)::int as paise from recharges where user_id = ${buyer.id}`);
    expect(svipRows[0]!.paise).toBe(38994);
    const mine = await coins(seller.token);
    expect((await api("POST", "/coin-sellers/wallet/sell", seller.token, { to: String(sid), amount: 100, idempotencyKey: key() })).body.balance).toBe(600);
    expect(await coins(seller.token)).toBe(mine + 100);
    expect((await api("POST", "/coin-sellers/wallet/sell", seller.token, { to: buyer.handle, amount: 601, idempotencyKey: key() })).body.error.code).toBe("INSUFFICIENT_SELLER_BALANCE");

    // sub seller
    expect((await api("POST", "/coin-sellers/sub-sellers", seller.token, { user: sub.handle })).status).toBe(201);
    expect((await api("POST", "/coin-sellers/sub-sellers", seller.token, { user: sub.handle })).body.error.code).toBe("ALREADY_SELLER");
    expect(await badgeIds(sub.id, buyer.token)).toContain("sub_seller");
    expect((await api("POST", "/coin-sellers/sub-sellers", sub.token, { user: buyer.handle })).body.error.code).toBe("SUB_CANNOT_APPOINT");
    expect((await api("POST", `/coin-sellers/sub-sellers/${sub.id}/topup`, buyer.token, { amount: 1, idempotencyKey: key() })).body.error.code).toBe("NOT_YOUR_SUB_SELLER");
    expect((await api("POST", `/coin-sellers/sub-sellers/${sub.id}/topup`, seller.token, { amount: 200, idempotencyKey: key() })).body.balance).toBe(400);
    expect((await api("POST", "/coin-sellers/wallet/sell", sub.token, { to: buyer.handle, amount: 50, idempotencyKey: key() })).body.balance).toBe(150);
    const w = (await api("GET", "/coin-sellers/wallet", seller.token)).body;
    expect(w.subSellers.map((s: any) => [s.userId, s.balance])).toEqual([[sub.id, 150]]);
    expect(w.history[0]).toMatchObject({ kind: "SUB_TOPUP", amount: -200, counterparty: { userId: sub.id } });
    expect((await api("GET", "/coin-sellers/wallet", sub.token)).body).toMatchObject({ isSub: true, parent: { userId: seller.id }, subSellers: [] });

    // removal returns the rest to the parent
    expect((await api("DELETE", `/coin-sellers/sub-sellers/${sub.id}`, seller.token)).body).toEqual({ returned: 150, balance: 550 });
    expect((await api("POST", "/coin-sellers/wallet/sell", sub.token, { to: buyer.handle, amount: 1, idempotencyKey: key() })).body.error.code).toBe("NOT_A_SELLER");
    expect(await badgeIds(sub.id, buyer.token)).not.toContain("sub_seller");

    // staff revoke freezes the wallet
    await api("POST", `/admin/coin-sellers/${seller.id}/decision`, adm.token, { approve: false });
    expect((await api("POST", "/coin-sellers/wallet/sell", seller.token, { to: buyer.handle, amount: 1, idempotencyKey: key() })).body.error.code).toBe("NOT_A_SELLER");
    expect((await api("GET", "/admin/coin-sellers?status=REJECTED", adm.token)).body.sellers.find((s: any) => s.userId === seller.id).balance).toBe(550);
  });
});

describe("room chat photos", () => {
  test("above Lv 10 only; everyone in the room gets it; a retry stores it once", async () => {
    const { host, roomId } = await liveRoom();
    const b = await joined(roomId, "pb");
    const sb = socketFor(b.token);
    await nextEvent(sb, "connect");
    await emit(sb, "room:join", { roomId });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);
    const send = async (token: string, clientMessageId: string) => {
      const form = new FormData();
      form.append("file", new File([png], "p.png", { type: "image/png" }));
      form.append("clientMessageId", clientMessageId);
      const res = await fetch(`${base}/v1/rooms/${roomId}/chat/image`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
      return { status: res.status, body: (await res.json()) as any };
    };

    expect((await send(host.token, "p1")).body.error.code).toBe("LEVEL_TOO_LOW"); // Lv 0
    await db.execute(sql`update users set xp = ${xpToReach(10)} where id = ${host.id}`); // exactly Lv 10: not yet
    expect((await send(host.token, "p0")).body.error.code).toBe("LEVEL_TOO_LOW");
    await db.execute(sql`update users set xp = ${xpToReach(11)} where id = ${host.id}`);
    const seen = nextEvent(sb, "room:chat:new");
    const sent = await send(host.token, "p2");
    expect(sent.status).toBe(200);
    expect(sent.body.payload.imageUrl).toMatch(/^\/v1\/uploads\/.+\.png$/);
    expect((await seen).payload.imageUrl).toBe(sent.body.payload.imageUrl);
    expect((await send(host.token, "p2")).body).toMatchObject({ messageId: sent.body.messageId, payload: { imageUrl: sent.body.payload.imageUrl } }); // retry
  });
});

describe("video mode", () => {
  test("owner/admins switch it on, pick a YouTube video and pause/resume; everyone gets it; not with Ludo", async () => {
    // YouTube's title lookup, stubbed: "privateVid1" is unavailable, anything else is a public video.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (!url.startsWith("https://www.youtube.com/oembed")) return realFetch(input, init);
      return url.includes("privateVid1") ? new Response("", { status: 401 }) : Response.json({ title: "Chai Songs" });
    }) as typeof fetch;
    try {
      const { host, roomId } = await liveRoom();
      const b = await joined(roomId, "vb");
      const sb = socketFor(b.token);
      await nextEvent(sb, "connect");
      await emit(sb, "room:join", { roomId });

      expect((await api("POST", `/rooms/${roomId}/video`, b.token, { on: true })).status).toBe(403);
      expect((await api("PUT", `/rooms/${roomId}/video`, host.token, { videoId: "dQw4w9WgXcQ" })).body.error.code).toBe("VIDEO_OFF");
      const on = nextEvent(sb, "room:video");
      expect((await api("POST", `/rooms/${roomId}/video`, host.token, { on: true })).body.video).toMatchObject({ videoId: null, playing: false });
      expect((await on).video).toMatchObject({ videoId: null });
      expect((await api("POST", `/rooms/${roomId}/ludo`, host.token, { on: true })).body.error.code).toBe("VIDEO_ON");

      // pick: an 11-character YouTube id only, and it must be playable
      expect((await api("PUT", `/rooms/${roomId}/video`, host.token, { videoId: "https://evil.example/x" })).status).toBe(400);
      expect((await api("PUT", `/rooms/${roomId}/video`, host.token, { videoId: "privateVid1" })).body.error.code).toBe("VIDEO_NOT_FOUND");
      expect((await api("PUT", `/rooms/${roomId}/video`, b.token, { videoId: "dQw4w9WgXcQ" })).status).toBe(403);
      const picked = nextEvent(sb, "room:video");
      expect((await api("PUT", `/rooms/${roomId}/video`, host.token, { videoId: "dQw4w9WgXcQ" })).status).toBe(200);
      expect((await picked).video).toMatchObject({ videoId: "dQw4w9WgXcQ", title: "Chai Songs", position: 0, playing: true });

      // pause where it is; late joiners get it in the snapshot
      const paused = (await api("POST", `/rooms/${roomId}/video/playback`, host.token, { playing: false, position: 42.5 })).body.video;
      expect(paused).toMatchObject({ videoId: "dQw4w9WgXcQ", playing: false, position: 42.5 });
      const c = await joined(roomId, "vc");
      const sc = socketFor(c.token);
      await nextEvent(sc, "connect");
      expect((await emit(sc, "room:join", { roomId })).data.video).toMatchObject({ playing: false, position: 42.5 });

      expect((await api("POST", `/rooms/${roomId}/video`, host.token, { on: false })).body.video).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("ludo", () => {
  const far = () => Date.now() + 10 * ludo.TURN_MS; // a "now" past every deadline
  const state = async (s: Socket, roomId: string) => (await emit(s, "ludo:watch", { roomId })).data.state;

  test("owner/admins switch it on; seated players join; the owner starts; turns, timeouts and leavers; play to a win", async () => {
    const { host, roomId } = await liveRoom();
    const b = await joined(roomId, "lb");
    const c = await joined(roomId, "lc"); // stays a listener
    const sh = socketFor(host.token), sb = socketFor(b.token), sc = socketFor(c.token);
    await Promise.all([sh, sb, sc].map((s) => nextEvent(s, "connect")));
    await emit(sh, "room:join", { roomId });
    await emit(sb, "room:join", { roomId });
    expect((await emit(sb, "room:seat:claim", { roomId, seatIndex: 1 })).ok).toBe(true);

    // mode: owner/admins only; snapshot and room event say so; listeners can watch
    expect((await api("POST", `/rooms/${roomId}/ludo`, b.token, { on: true })).status).toBe(403);
    const modeEvt = nextEvent(sb, "room:ludo");
    expect((await api("POST", `/rooms/${roomId}/ludo`, host.token, { on: true })).body).toEqual({ on: true });
    expect(await modeEvt).toEqual({ roomId, on: true });
    expect((await emit(sc, "room:join", { roomId })).data.ludo).toBe(true); // in the snapshot for everyone joining
    expect(await state(sc, roomId)).toMatchObject({ phase: "lobby", lobby: [] });

    // lobby: seated only; start needs the owner/admin and 2 players
    expect((await emit(sc, "ludo:join", { roomId })).error.code).toBe("LUDO_SEAT_REQUIRED");
    expect((await emit(sh, "ludo:join", { roomId })).ok).toBe(true);
    expect((await emit(sh, "ludo:start", { roomId })).error.code).toBe("LUDO_NEED_PLAYERS");
    const watcherSaw = nextEvent(sc, "ludo:state");
    expect((await emit(sb, "ludo:join", { roomId })).data.lobby.map((p: any) => p.userId)).toEqual([host.id, b.id]);
    expect((await watcherSaw).state.lobby).toHaveLength(2); // watchers get every change
    expect((await emit(sb, "ludo:start", { roomId })).error.code).toBe("NOT_ROOM_ADMIN");
    const started = (await emit(sh, "ludo:start", { roomId })).data;
    expect(started).toMatchObject({ phase: "playing", turn: 0, step: "roll" });
    expect(started.players.map((p: any) => [p.userId, p.color])).toEqual([[host.id, 0], [b.id, 2]]);

    // only the player on turn acts, one step at a time
    expect((await emit(sb, "ludo:roll", { roomId })).error.code).toBe("LUDO_NOT_YOUR_TURN");
    expect((await emit(sh, "ludo:move", { roomId, token: 0 })).error.code).toBe("LUDO_WRONG_STEP");
    const rolled = (await emit(sh, "ludo:roll", { roomId })).data;
    expect(rolled.last).toMatchObject({ userId: host.id, auto: false });
    expect(rolled.last.dice).toBeWithin(1, 7);

    // timeout: the server plays that step for whoever is on turn
    const before = (await state(sh, roomId)).v;
    await ludo.tick(far());
    const afterTimeout = await state(sh, roomId);
    expect(afterTimeout.v).toBe(before + 1);
    expect(afterTimeout.last.auto).toBe(true);

    // b leaves the seat: from b's next turn on, the server plays b
    await emit(sb, "room:seat:release", { roomId, seatIndex: 1 });
    for (let i = 0; i < 200 && !(await state(sh, roomId)).players[1].auto; i++) {
      const s = await state(sh, roomId);
      if (s.phase !== "playing") break;
      await ludo.tick(far());
    }
    expect((await state(sh, roomId)).players[1].auto).toBe(true);

    // play it out on the clock
    let s = await state(sh, roomId);
    for (let i = 0; i < 5000 && s.phase === "playing"; i++) {
      await ludo.tick(far());
      s = await state(sh, roomId);
    }
    expect(s.phase).toBe("finished");
    expect([host.id, b.id]).toContain(s.winner);
    expect(s.players.find((p: any) => p.userId === s.winner).tokens).toEqual([56, 56, 56, 56]);
    const hist = (await api("GET", `/rooms/${roomId}/messages`, host.token)).body.messages;
    expect(hist.some((m: any) => m.body.includes("won the Ludo game"))).toBe(true);

    // after a game the mode stays on; the next join opens a new lobby; off clears it for everyone
    expect((await emit(sh, "ludo:join", { roomId })).data).toMatchObject({ phase: "lobby", lobby: [{ userId: host.id }] });
    const off = nextEvent(sc, "ludo:state");
    await api("POST", `/rooms/${roomId}/ludo`, host.token, { on: false });
    expect((await off).state).toBeNull();
    expect((await emit(sh, "ludo:join", { roomId })).error.code).toBe("LUDO_OFF");
  }, 60_000);
});

describe("greedy game", () => {
  test("bets debit the wallet, winners are paid once, closed rounds refuse bets", async () => {
    const { openRound, settleRound } = await import("../src/services/greedy");
    const a = await signup("greedya");
    const b = await signup("greedyb");
    const sa = socketFor(a.token);
    const sb = socketFor(b.token);
    const round = await openRound();

    const join = await emit(sa, "greedy:join", {});
    expect(join.data).toMatchObject({ round: { roundId: round.id }, myBets: [], balance: 1000, me: a.id, maxBet: 1_000_000 });

    expect((await emit(sa, "greedy:bet", { roundId: round.id, item: 7, amount: 100 })).data).toMatchObject({ item: 7, itemTotal: 100, balance: 900 });
    expect((await emit(sa, "greedy:bet", { roundId: round.id, item: 7, amount: 100 })).data).toMatchObject({ itemTotal: 200, balance: 800 });
    expect((await emit(sa, "greedy:bet", { roundId: round.id, item: 0, amount: 10 })).data.balance).toBe(790);
    expect((await emit(sb, "greedy:bet", { roundId: round.id, item: 0, amount: 1000 })).data.balance).toBe(0);
    expect((await emit(sb, "greedy:bet", { roundId: round.id, item: 0, amount: 10 })).error.code).toBe("INSUFFICIENT_COINS");
    expect((await emit(sa, "greedy:bet", { roundId: round.id, item: 0, amount: 0 })).error.code).toBe("VALIDATION_ERROR");
    expect((await emit(sa, "greedy:bet", { roundId: round.id, item: 0, amount: 5.5 })).error.code).toBe("VALIDATION_ERROR");
    expect((await emit(sa, "greedy:bet", { roundId: round.id, item: 8, amount: 10 })).error.code).toBe("VALIDATION_ERROR");

    const result = await settleRound(round.id, 7); // Lion ×45
    expect(result!.winners).toEqual([{ userId: a.id, payout: 9000, balance: 9790 }]);
    expect(await settleRound(round.id, 7)).toBeNull(); // no double payout
    expect((await emit(sa, "greedy:bet", { roundId: round.id, item: 7, amount: 10 })).error.code).toBe("BETTING_CLOSED");

    for (const u of [a, b]) {
      const wallet = (await api("GET", "/wallet", u.token)).body.balance;
      const [{ sum }] = (await db.execute(sql`select coalesce(sum(amount),0)::int as sum from wallet_ledger where user_id = ${u.id}`)).rows as any;
      expect(sum).toBe(wallet); // ledger always adds up to the balance
    }
    expect((await api("GET", "/wallet", b.token)).body.balance).toBe(0);
  });

  test("custom amounts, the per-animal cap, and the winners list everyone sees", async () => {
    const { openRound, settleAndAnnounce, MAX_ITEM_BET } = await import("../src/services/greedy");
    const a = await signup("greedyc");
    const b = await signup("greedyd");
    await db.execute(sql`update wallet_accounts set balance = 2000000 where user_id = ${a.id}`);
    await db.execute(sql`insert into wallet_ledger (user_id, entry_type, amount, reference_type, reference_id) values (${a.id}, 'PROMO_GRANT', 1999000, 'TEST', 'test')`);
    const sa = socketFor(a.token);
    const sb = socketFor(b.token);
    const round = await openRound();
    await emit(sa, "greedy:join", {});
    await emit(sb, "greedy:join", {});

    expect((await emit(sb, "greedy:bet", { roundId: round.id, item: 4, amount: 520 })).data).toMatchObject({ itemTotal: 520, balance: 480 });
    expect((await emit(sa, "greedy:bet", { roundId: round.id, item: 4, amount: MAX_ITEM_BET })).data.itemTotal).toBe(MAX_ITEM_BET);
    expect((await emit(sa, "greedy:bet", { roundId: round.id, item: 4, amount: 1 })).error.code).toBe("BET_LIMIT");
    expect((await emit(sa, "greedy:bet", { roundId: round.id, item: 4, amount: MAX_ITEM_BET + 1 })).error.code).toBe("VALIDATION_ERROR");
    expect((await api("GET", "/wallet", a.token)).body.balance).toBe(1_000_000); // the refused bet was not charged

    const announced = nextEvent(sb, "greedy:result");
    await settleAndAnnounce(round.id, 4); // Zebra ×10
    expect(await announced).toMatchObject({
      roundId: round.id,
      item: 4,
      winnerCount: 2,
      totalPayout: 10_005_200,
      winners: [ // biggest first, with names for the winners screen
        { userId: a.id, displayName: a.handle, payout: 10_000_000 },
        { userId: b.id, displayName: b.handle, payout: 5200 },
      ],
    });
  });

  test("today's leaderboard ranks everyone who played by what they won; earlier days don't count", async () => {
    const { openRound, settleRound } = await import("../src/services/greedy");
    const [x, y, z] = [await signup("dayx"), await signup("dayy"), await signup("dayz")];
    const [sx, sy, sz] = [socketFor(x.token), socketFor(y.token), socketFor(z.token)];

    // An old round: y won big, but on a previous day.
    const old = await openRound();
    await emit(sy, "greedy:bet", { roundId: old.id, item: 7, amount: 10 });
    await settleRound(old.id, 7);
    await db.execute(sql`update greedy_rounds set created_at = now() - interval '2 days' where id = ${old.id}`);

    const r1 = await openRound();
    await emit(sx, "greedy:bet", { roundId: r1.id, item: 0, amount: 100 }); // wins 500
    await emit(sy, "greedy:bet", { roundId: r1.id, item: 4, amount: 100 }); // loses
    await emit(sz, "greedy:bet", { roundId: r1.id, item: 0, amount: 10 }); // wins 50
    await settleRound(r1.id, 0);
    const r2 = await openRound();
    await emit(sz, "greedy:bet", { roundId: r2.id, item: 5, amount: 100 }); // wins 1500
    await settleRound(r2.id, 5);

    const board = (await emit(sy, "greedy:today", {})).data;
    const ours = board.rows.filter((r: any) => [x.id, y.id, z.id].includes(r.userId));
    expect(ours.map((r: any) => [r.displayName, r.won, r.bet])).toEqual([
      [z.handle, 1550, 110],
      [x.handle, 500, 100],
      [y.handle, 0, 100], // played today, won nothing; yesterday's 450 is not counted
    ]);
    expect(ours[0].rank).toBeLessThan(ours[1].rank);
    expect(board.me).toMatchObject({ userId: y.id, won: 0 });
    expect(board.players).toBeGreaterThanOrEqual(3);
    const resetsAt = new Date(board.resetsAt);
    expect(resetsAt.getTime()).toBeGreaterThan(Date.now());
    expect(resetsAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    expect(resetsAt.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })).toBe("00:00:00"); // midnight IST
  });

  test("Meadow pays every small-animal bet, Kingdom every big-animal bet, each at its own multiplier", async () => {
    const { openRound, settleAndAnnounce, settleRound } = await import("../src/services/greedy");
    const v = await signup("salad");
    const sv = socketFor(v.token);
    await emit(sv, "greedy:join", {});

    const salad = await openRound();
    await emit(sv, "greedy:bet", { roundId: salad.id, item: 0, amount: 100 }); // rabbit ×5
    await emit(sv, "greedy:bet", { roundId: salad.id, item: 3, amount: 10 }); // turtle ×5
    await emit(sv, "greedy:bet", { roundId: salad.id, item: 7, amount: 10 }); // lion loses on Meadow
    const announced = nextEvent(sv, "greedy:result");
    const win = nextEvent(sv, "greedy:win");
    await settleAndAnnounce(salad.id, 8);
    expect(await announced).toMatchObject({ item: 8, wins: [0, 1, 2, 3], winnerCount: 1, winners: [{ userId: v.id, payout: 550 }] });
    expect(await win).toMatchObject({ payout: 550, balance: 1000 - 120 + 550 }); // one credit for both animals

    const pizza = await openRound();
    await emit(sv, "greedy:bet", { roundId: pizza.id, item: 4, amount: 10 }); // zebra ×10
    await emit(sv, "greedy:bet", { roundId: pizza.id, item: 7, amount: 10 }); // lion ×45
    await emit(sv, "greedy:bet", { roundId: pizza.id, item: 1, amount: 10 }); // monkey loses on Kingdom
    expect((await settleRound(pizza.id, 9))!.winners).toEqual([{ userId: v.id, payout: 550, balance: 1430 - 30 + 550 }]);

    const board = (await emit(sv, "greedy:today", {})).data;
    expect(board.me).toMatchObject({ won: 1100, bet: 150 }); // today's board counts specials too
    const [{ sum }] = (await db.execute(sql`select sum(amount)::int as sum from wallet_ledger where user_id = ${v.id}`)).rows as any;
    expect(sum).toBe(1950);
  });

  test("history pages back through every settled round, newest first", async () => {
    const { openRound, settleRound, history } = await import("../src/services/greedy");
    const ids: number[] = [];
    for (const outcome of [1, 8, 6]) {
      const r = await openRound();
      await settleRound(r.id, outcome);
      ids.push(r.id);
    }
    const open = await openRound(); // still betting: not in history

    const first = await history(undefined, 2);
    expect(first.rounds.map((r) => [r.roundId, r.item])).toEqual([[ids[2]!, 6], [ids[1]!, 8]]);
    expect(first.more).toBe(true);
    const next = await history(first.rounds.at(-1)!.roundId, 2);
    expect(next.rounds[0]).toMatchObject({ roundId: ids[0], item: 1 });
    expect(next.rounds[0]!.at).toBeInstanceOf(Date);

    const u = await signup("hist");
    const viaSocket = (await emit(socketFor(u.token), "greedy:history", {})).data;
    expect(viaSocket.rounds[0].roundId).toBe(ids[2]);
    expect(viaSocket.rounds.some((r: any) => r.roundId === open.id)).toBe(false);
    await settleRound(open.id);
  });

  test("jungle and galaxy are separate games: own names, rounds, results, history and leaderboard", async () => {
    const { openRound, settleAndAnnounce, settleRound, history } = await import("../src/services/greedy");
    const p = await signup("galaxyp");
    const j = await signup("junglej");
    const sp = socketFor(p.token);
    const sj = socketFor(j.token);

    const jr = await openRound("jungle");
    const gr = await openRound("galaxy");
    // Round numbers count per game: galaxy starts at 1 here, jungle keeps its own sequence despite galaxy rounds in between.
    expect(gr.number).toBe(1);
    const [lastJungle] = (await db.execute(sql`select max(number)::int as n from greedy_rounds where game = 'jungle'`)).rows as any;
    expect(jr.number).toBe(lastJungle.n);
    const gal = (await emit(sp, "greedy:join", { game: "galaxy" })).data;
    expect(gal).toMatchObject({ game: "galaxy", round: { roundId: gr.id } });
    expect(gal.items.map((i: any) => i.name)).toEqual(["Mercury", "Venus", "Earth", "Mars", "Neptune", "Uranus", "Jupiter", "Saturn"]);
    expect(gal.outcomes[9]).toMatchObject({ name: "Giants", blurb: "All giant planets win", special: true, wins: [4, 5, 6, 7] });
    expect((await emit(sj, "greedy:join", {})).data).toMatchObject({ game: "jungle", round: { roundId: jr.id } }); // no game = jungle

    await emit(sp, "greedy:bet", { roundId: gr.id, item: 7, amount: 100 }); // Saturn ×45
    await emit(sj, "greedy:bet", { roundId: jr.id, item: 7, amount: 10 }); // Lion ×45

    // Each socket only hears its own game's results.
    let jungleHeardGalaxy = false;
    sj.on("greedy:result", (r: any) => { if (r.roundId === gr.id) jungleHeardGalaxy = true; });
    const galaxyResult = nextEvent(sp, "greedy:result");
    await settleAndAnnounce(gr.id, 7);
    expect(await galaxyResult).toMatchObject({ roundId: gr.id, number: 1, item: 7, winners: [{ userId: p.id, payout: 4500 }] });
    await settleAndAnnounce(jr.id, 0);
    await Bun.sleep(100);
    expect(jungleHeardGalaxy).toBe(false);

    expect((await history(undefined, 50, "galaxy")).rounds.map((r) => r.roundId)).toContain(gr.id);
    const nextJungle = await openRound("jungle"), nextGalaxy = await openRound("galaxy");
    expect([nextJungle.number, nextGalaxy.number]).toEqual([jr.number + 1, 2]);
    expect((await history(undefined, 50, "galaxy")).rounds.find((r) => r.roundId === gr.id)?.number).toBe(1);
    await settleRound(nextJungle.id); await settleRound(nextGalaxy.id);
    expect((await history(undefined, 50, "galaxy")).rounds.map((r) => r.roundId)).not.toContain(jr.id);
    expect((await emit(sj, "greedy:history", { game: "jungle" })).data.rounds.map((r: any) => r.roundId)).not.toContain(gr.id);

    const galaxyBoard = (await emit(sp, "greedy:today", { game: "galaxy" })).data;
    expect(galaxyBoard.rows.find((r: any) => r.userId === p.id)).toMatchObject({ won: 4500 });
    expect(galaxyBoard.rows.some((r: any) => r.userId === j.id)).toBe(false); // j only played jungle
    expect((await emit(sj, "greedy:today", { game: "jungle" })).data.rows.some((r: any) => r.userId === p.id)).toBe(false);
    expect((await emit(sp, "greedy:join", { game: "poker" })).error.code).toBe("VALIDATION_ERROR");
  });

  test("draw follows the weights; every animal returns about 98% of what's bet on it", async () => {
    const { draw, ITEMS, OUTCOMES } = await import("../src/services/greedy");
    const total = OUTCOMES.reduce((s, o) => s + o.weight, 0);
    const counts = OUTCOMES.map(() => 0);
    for (let i = 0; i < 20_000; i++) counts[draw().id]!++;
    expect(counts[0]! / 20_000).toBeCloseTo(1945 / total, 1);
    expect(counts[7]!).toBeGreaterThan(0);
    for (const it of ITEMS) {
      const winChance = OUTCOMES.filter((o) => o.wins.includes(it.id)).reduce((s, o) => s + o.weight, 0) / total;
      expect(Math.abs(winChance * it.mult - 0.98)).toBeLessThan(0.002);
    }
    // Specials: about one round in 357.
    expect(Math.round(total / OUTCOMES.filter((o) => o.special).reduce((s, o) => s + o.weight, 0))).toBe(357);
  });
});

describe("rocket game", () => {
  test("crash points: about 2% at 1.00x, and every cash-out target returns about 98%", async () => {
    const { drawCrash100, CAP100 } = await import("../src/services/rocket");
    const N = 200_000;
    const draws = Array.from({ length: N }, drawCrash100);
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(100);
    expect(Math.max(...draws)).toBeLessThanOrEqual(CAP100);
    expect(draws.filter((c) => c === 100).length / N).toBeCloseTo(0.02, 2);
    for (const target of [150, 200, 500, 1000]) {
      const rtp = (draws.filter((c) => c > target).length * target) / 100 / N; // cash-out fires only if the rocket gets past the target
      expect(Math.abs(rtp - 0.98)).toBeLessThan(0.02);
    }
  });

  test("two bet panels: repeat bets add up, each panel cashes out on its own (by hand or auto); too late refused; hash verifies; ledger adds up", async () => {
    const rocket = await import("../src/services/rocket");
    const realNow = rocket.clock.now;
    let t = Date.now();
    rocket.clock.now = () => t;
    try {
      const [a, b, c, d] = [await signup("rocka"), await signup("rockb"), await signup("rockc"), await signup("rockd")];
      const [sa, sb, sc, sd] = [socketFor(a.token), socketFor(b.token), socketFor(c.token), socketFor(d.token)];
      const round = await rocket.openRound(300); // crashes at 3.00x
      const joined = (await emit(sa, "rocket:join", {})).data;
      expect(joined.round).toMatchObject({ roundId: round.id, number: round.number, phase: "betting", hash: round.hash });
      expect(joined.round.crash100).toBeUndefined(); // secret until the crash
      expect(joined.round.salt).toBeUndefined();

      // a bets twice on panel 0: the stake adds up.
      expect((await emit(sa, "rocket:bet", { roundId: round.id, amount: 100 })).data).toMatchObject({ slot: 0, amount: 100, balance: 900 });
      expect((await emit(sa, "rocket:bet", { roundId: round.id, slot: 0, amount: 100 })).data).toMatchObject({ slot: 0, added: 100, amount: 200, balance: 800 });
      // b: panel 0 safe at auto 2.00x, panel 1 riding by hand.
      expect((await emit(sb, "rocket:bet", { roundId: round.id, slot: 0, amount: 200, auto100: 200 })).data.balance).toBe(800);
      expect((await emit(sb, "rocket:bet", { roundId: round.id, slot: 1, amount: 100 })).data).toMatchObject({ slot: 1, amount: 100, balance: 700 });
      expect((await emit(sc, "rocket:bet", { roundId: round.id, amount: 100, auto100: 500 })).data.balance).toBe(900);
      expect((await emit(sa, "rocket:bet", { roundId: round.id, slot: 2, amount: 10 })).error.code).toBe("VALIDATION_ERROR");
      expect((await emit(sa, "rocket:bet", { roundId: round.id, amount: 0 })).error.code).toBe("VALIDATION_ERROR");
      // Per-panel cap: the bet that would go over it is refused and not charged.
      await db.execute(sql`update wallet_accounts set balance = balance + 200000 where user_id = ${d.id}`);
      await db.execute(sql`insert into wallet_ledger (user_id, entry_type, amount, reference_type, reference_id) values (${d.id}, 'PROMO_GRANT', 200000, 'TEST', 'test')`);
      expect((await emit(sd, "rocket:bet", { roundId: round.id, amount: rocket.MAX_BET })).data.amount).toBe(rocket.MAX_BET);
      expect((await emit(sd, "rocket:bet", { roundId: round.id, amount: 1 })).error.code).toBe("BET_LIMIT");
      expect((await api("GET", "/wallet", d.token)).body.balance).toBe(201000 - rocket.MAX_BET);
      expect((await emit(sa, "rocket:cashout", { roundId: round.id })).error.code).toBe("NOT_LAUNCHED");
      const live = (await emit(sd, "rocket:join", {})).data;
      expect([live.playerCount, live.totalBet]).toEqual([4, 600 + rocket.MAX_BET]); // players are people, not panels
      expect(live.myBets).toEqual([{ slot: 0, amount: rocket.MAX_BET, auto100: null, cashed100: null, payout: null }]);

      // In flight at 1.5x: a cashes out panel 0; b cashes out panel 1 only.
      t = round.launchAt.getTime() + Math.ceil((Math.log(1.5) / rocket.K) * 1000) + 5;
      const m = rocket.mult100At(t - round.launchAt.getTime());
      const out = (await emit(sa, "rocket:cashout", { roundId: round.id, slot: 0 })).data;
      expect(out).toEqual({ roundId: round.id, slot: 0, multiplier100: m, payout: Math.floor((200 * m) / 100), balance: 800 + Math.floor((200 * m) / 100) });
      expect((await emit(sa, "rocket:cashout", { roundId: round.id, slot: 0 })).error.code).toBe("NO_ACTIVE_BET");
      expect((await emit(sa, "rocket:cashout", { roundId: round.id, slot: 1 })).error.code).toBe("NO_ACTIVE_BET"); // never bet on panel 1
      expect((await emit(sb, "rocket:cashout", { roundId: round.id, slot: 1 })).data).toMatchObject({ slot: 1, payout: Math.floor((100 * m) / 100) });
      expect((await emit(sc, "rocket:bet", { roundId: round.id, slot: 1, amount: 100 })).error.code).toBe("BETTING_CLOSED");

      // Past the crash point: too late, even before the server has settled.
      t = round.launchAt.getTime() + rocket.crashMs(300) + 2;
      expect((await emit(sc, "rocket:cashout", { roundId: round.id })).error.code).toBe("CRASHED");

      const crashed = nextEvent(sd, "rocket:crash");
      const bWin = nextEvent(sb, "rocket:win");
      await rocket.crashAndAnnounce(round.id);
      expect(await bWin).toMatchObject({ slot: 0, multiplier100: 200, payout: 400 }); // panel 0's auto 2.00x fired below 3.00x
      const ev = await crashed;
      expect(ev).toMatchObject({ roundId: round.id, crash100: 300, phase: "crashed" });
      expect(createHash("sha256").update(`${ev.salt}:300`).digest("hex")).toBe(round.hash); // the pre-launch hash checks out
      expect(await rocket.crashAndAnnounce(round.id)).toBeNull(); // settles once

      expect((await api("GET", "/wallet", b.token)).body.balance).toBe(700 + Math.floor((100 * m) / 100) + 400); // both panels paid
      expect((await api("GET", "/wallet", c.token)).body.balance).toBe(900); // auto 5.00x never reached
      for (const u of [a, b, c, d]) {
        const wallet = (await api("GET", "/wallet", u.token)).body.balance;
        const [{ sum }] = (await db.execute(sql`select sum(amount)::int as sum from wallet_ledger where user_id = ${u.id}`)).rows as any;
        expect(sum).toBe(wallet);
      }
      const board = (await emit(sa, "rocket:today", {})).data;
      expect(board.rows.find((r: any) => r.userId === b.id)).toMatchObject({ won: 400 + Math.floor((100 * m) / 100) });
      expect((await emit(sa, "rocket:history", {})).data.rounds[0]).toMatchObject({ roundId: round.id, crash100: 300, salt: ev.salt });
    } finally {
      rocket.clock.now = realNow;
    }
  });
});

describe("rocket 50x cap", () => {
  test("the rocket explodes at exactly 50x: 49.5x pays, anything still in loses; auto targets must be below 50x", async () => {
    const rocket = await import("../src/services/rocket");
    expect(rocket.CAP100).toBe(5000);
    const draws = Array.from({ length: 200_000 }, rocket.drawCrash100);
    expect(Math.max(...draws)).toBe(5000);
    expect(draws.filter((c) => c === 5000).length / draws.length).toBeCloseTo(98 / 4999, 2); // ~2% of rounds reach the cap

    const realNow = rocket.clock.now;
    let t = Date.now();
    rocket.clock.now = () => t;
    try {
      const [a, b] = [await signup("capa"), await signup("capb")];
      const [sa, sb] = [socketFor(a.token), socketFor(b.token)];
      const round = await rocket.openRound(5000);
      expect((await emit(sa, "rocket:bet", { roundId: round.id, amount: 10, auto100: 5000 })).error.code).toBe("VALIDATION_ERROR");
      expect((await emit(sa, "rocket:bet", { roundId: round.id, amount: 10, auto100: 4999 })).data.auto100).toBe(4999);
      await emit(sa, "rocket:bet", { roundId: round.id, slot: 1, amount: 10 });
      await emit(sb, "rocket:bet", { roundId: round.id, amount: 10 });

      t = round.launchAt.getTime() + Math.ceil((Math.log(49.5) / rocket.K) * 1000) + 5; // 49.5x
      const m = rocket.mult100At(t - round.launchAt.getTime());
      expect(m).toBeGreaterThanOrEqual(4950);
      expect((await emit(sa, "rocket:cashout", { roundId: round.id, slot: 1 })).data).toMatchObject({ multiplier100: m, payout: Math.floor((10 * m) / 100) });
      t = round.launchAt.getTime() + rocket.crashMs(5000) + 2; // at 50x it's gone
      expect((await emit(sb, "rocket:cashout", { roundId: round.id })).error.code).toBe("CRASHED");
      const settled = await rocket.crashRound(round.id);
      expect(settled!.winners).toEqual([expect.objectContaining({ userId: a.id, slot: 0, multiplier100: 4999, payout: 499 })]); // auto 49.99x fired
      expect((await api("GET", "/wallet", b.token)).body.balance).toBe(990); // b held on to 50x and lost
    } finally {
      rocket.clock.now = realNow;
    }
  });
});

describe("game win announcements", () => {
  test("300+ posts a chat notice in the winner's room; 10,000+ also shows a banner to everyone; small wins stay quiet", async () => {
    const greedy = await import("../src/services/greedy");
    const rocket = await import("../src/services/rocket");
    const { roomId } = await liveRoom();
    const winner = await joined(roomId, "winner");
    const listener = await joined(roomId, "listener");
    const outsider = await signup("outsider"); // in no room
    const sw = socketFor(winner.token);
    const sl = socketFor(listener.token);
    const so = socketFor(outsider.token);
    await emit(sl, "room:join", { roomId });
    await emit(sw, "room:join", { roomId });
    await emit(so, "greedy:join", {}); // connected, but not in any room
    const notices: any[] = [], banners: any[] = [];
    sl.on("room:system", (m: any) => m.payload?.kind === "GAME_WIN" && notices.push(m));
    so.on("game:bigwin", (b: any) => banners.push(b));

    // Galaxy: 100 on Saturn ×45 = 4,500 → room notice only.
    const g = await greedy.openRound("galaxy");
    await emit(sw, "greedy:bet", { roundId: g.id, item: 7, amount: 100 });
    await greedy.settleAndAnnounce(g.id, 7);
    // Jungle: 45 on Rabbit ×5 = 225 → below 300, nothing.
    const j = await greedy.openRound("jungle");
    await emit(sw, "greedy:bet", { roundId: j.id, item: 0, amount: 45 });
    await greedy.settleAndAnnounce(j.id, 0);
    await Bun.sleep(300);
    expect(notices.map((n) => [n.body, n.payload.game, n.payload.amount])).toEqual([[`${winner.handle} won 4,500 coins in Greedy Galaxy`, "galaxy", 4500]]);
    expect(banners).toEqual([]);

    // Rocket: an auto cash-out of 10,000+ → notice in the room and a banner for everyone, including people in no room.
    await db.execute(sql`update wallet_accounts set balance = balance + 10000 where user_id = ${winner.id}`);
    await db.execute(sql`insert into wallet_ledger (user_id, entry_type, amount, reference_type, reference_id) values (${winner.id}, 'PROMO_GRANT', 10000, 'TEST', 'test')`);
    const realNow = rocket.clock.now;
    let t = Date.now();
    rocket.clock.now = () => t;
    try {
      const r = await rocket.openRound(500);
      await emit(sw, "rocket:bet", { roundId: r.id, amount: 5000, auto100: 300 }); // 15,000 at 3.00x
      t = r.launchAt.getTime() + rocket.crashMs(500) + 1;
      await rocket.crashAndAnnounce(r.id);
    } finally {
      rocket.clock.now = realNow;
    }
    await Bun.sleep(300);
    expect(notices.at(-1)).toMatchObject({ body: `${winner.handle} won 15,000 coins in Rocket`, payload: { kind: "GAME_WIN", game: "rocket", amount: 15000, userId: winner.id } });
    expect(banners).toEqual([expect.objectContaining({ userId: winner.id, displayName: winner.handle, game: "rocket", amount: 15000 })]);

    // A big win by someone in no room: no chat notice anywhere, but still the banner.
    await db.execute(sql`update wallet_accounts set balance = balance + 1000 where user_id = ${outsider.id}`);
    await db.execute(sql`insert into wallet_ledger (user_id, entry_type, amount, reference_type, reference_id) values (${outsider.id}, 'PROMO_GRANT', 1000, 'TEST', 'test')`);
    const before = notices.length;
    const g2 = await greedy.openRound("jungle");
    await emit(so, "greedy:bet", { roundId: g2.id, item: 7, amount: 1000 }); // Lion ×45 = 45,000
    await greedy.settleAndAnnounce(g2.id, 7);
    await Bun.sleep(300);
    expect(notices.length).toBe(before);
    expect(banners.at(-1)).toMatchObject({ userId: outsider.id, game: "jungle", amount: 45000 });
  });
});

describe("charisma counter", () => {
  test("owner/admins start and stop it; it counts gift coins received since the start, live, and restarts from zero", async () => {
    const { host, roomId } = await liveRoom(); // the host sits on seat 0
    const fan = await joined(roomId, "fan");
    const sf = socketFor(fan.token);
    await emit(sf, "room:join", { roomId });
    const gift = (giftId: string, quantity: number, key: string) =>
      api("POST", `/rooms/${roomId}/gifts`, fan.token, { recipientUserId: host.id, giftId, quantity }, { "Idempotency-Key": key });

    expect((await api("GET", `/rooms/${roomId}`, fan.token)).body.charisma).toBeNull();
    expect((await api("POST", `/rooms/${roomId}/charisma`, fan.token, { on: true })).body.error.code).toBe("NOT_ROOM_ADMIN");
    expect((await gift("chai", 1, "c-before")).status).toBe(200); // before the start: not counted

    const started = nextEvent(sf, "room:charisma");
    const on = await api("POST", `/rooms/${roomId}/charisma`, host.token, { on: true });
    expect(on.body.charisma).toMatchObject({ totals: {} });
    expect((await started).charisma.totals).toEqual({});

    const live = nextEvent(sf, "room:charisma");
    expect((await gift("chai", 2, "c-1")).status).toBe(200); // 2 × 10 coins
    expect((await live).charisma.totals).toEqual({ [host.id]: 20 });
    expect((await api("GET", `/rooms/${roomId}`, fan.token)).body.charisma.totals).toEqual({ [host.id]: 20 });

    // Starting again (Reset) restarts from zero for everyone; stopping turns it off.
    const reset = nextEvent(sf, "room:charisma");
    expect((await api("POST", `/rooms/${roomId}/charisma`, host.token, { on: true })).body.charisma.totals).toEqual({});
    expect((await reset).charisma.totals).toEqual({});
    const stopped = nextEvent(sf, "room:charisma");
    expect((await api("POST", `/rooms/${roomId}/charisma`, host.token, { on: false })).body.charisma).toBeNull();
    expect((await stopped).charisma).toBeNull();
    expect((await api("GET", `/rooms/${roomId}`, fan.token)).body.charisma).toBeNull();
    const msgs = (await api("GET", `/rooms/${roomId}/messages?limit=10`, fan.token)).body.messages.map((m: any) => m.body);
    expect(msgs.some((b: string) => b.endsWith("stopped the charisma counter"))).toBe(true);
    expect(msgs.some((b: string) => b.endsWith("reset the charisma counter to 0"))).toBe(true);
  });
});

describe("room settings", () => {
  test("owner/admins change name, background, cover and switches; everyone gets them live; entry notices can be hidden", async () => {
    const { host, roomId } = await liveRoom();
    const guest = await joined(roomId, "guest");
    const sg = socketFor(guest.token);
    await emit(sg, "room:join", { roomId });

    const snap0 = (await api("GET", `/rooms/${roomId}`, guest.token)).body;
    expect(snap0).toMatchObject({ background: "night", showEntry: true, giftAnimations: true });
    expect((await api("PATCH", `/rooms/${roomId}/settings`, guest.token, { title: "Mine now" })).body.error.code).toBe("NOT_ROOM_ADMIN");
    expect((await api("PATCH", `/rooms/${roomId}/settings`, host.token, { background: "lava" })).status).toBe(400);
    expect((await api("PATCH", `/rooms/${roomId}/settings`, host.token, { title: "   " })).status).toBe(400);

    const live = nextEvent(sg, "room:state");
    const patched = await api("PATCH", `/rooms/${roomId}/settings`, host.token, { title: "Late Night Chai", background: "ocean", showEntry: false, giftAnimations: false });
    expect(patched.body).toMatchObject({ title: "Late Night Chai", background: "ocean", showEntry: false, giftAnimations: false });
    expect(await live).toMatchObject({ title: "Late Night Chai", background: "ocean", showEntry: false, giftAnimations: false });

    // Entry notices off: a newcomer joins without a "joined" message; the rename was announced.
    const late = await joined(roomId, "late");
    const bodies = (await api("GET", `/rooms/${roomId}/messages?limit=20`, guest.token)).body.messages.map((m: any) => m.body);
    expect(bodies).toContain(`${host.handle} renamed the room to "Late Night Chai"`);
    expect(bodies.some((b: string) => b === `${late.handle} joined`)).toBe(false);
    expect(bodies.some((b: string) => b === `${guest.handle} joined`)).toBe(true); // joined while notices were on

    // Room image: a PNG upload becomes the cover, served from /v1/uploads.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);
    const form = new FormData();
    form.append("file", new File([png], "cover.png", { type: "image/png" }));
    const up = await fetch(`${base}/v1/rooms/${roomId}/cover`, { method: "POST", headers: { authorization: `Bearer ${host.token}` }, body: form });
    const upBody = (await up.json()) as any;
    expect(up.status).toBe(200);
    expect(upBody.coverUrl).toMatch(/^\/v1\/uploads\/[0-9a-f-]+\.png$/);
    expect((await fetch(base + upBody.coverUrl)).status).toBe(200);
    const notImage = new FormData();
    notImage.append("file", new File([new Uint8Array(32)], "x.txt", { type: "text/plain" }));
    expect((await fetch(`${base}/v1/rooms/${roomId}/cover`, { method: "POST", headers: { authorization: `Bearer ${host.token}` }, body: notImage })).status).toBe(400);
  });
});

describe("pk battles and room stats", () => {
  test("PK 1v1: admins only, both seated, scores from gifts during the battle, result announced; overdue PKs finish on read", async () => {
    const { host, roomId } = await liveRoom(); // host on seat 0
    const rival = await joined(roomId, "pkrival");
    const fan = await joined(roomId, "pkfan");
    const start = (token: string, a: string, b: string, minutes = 5) => api("POST", `/rooms/${roomId}/pk`, token, { a, b, minutes });
    expect((await start(fan.token, host.id, rival.id)).body.error.code).toBe("NOT_ROOM_ADMIN");
    expect((await start(host.token, host.id, rival.id)).body.error.code).toBe("PK_NOT_SEATED");
    expect((await start(host.token, host.id, host.id)).body.error.code).toBe("PK_SAME_PERSON");
    expect((await start(host.token, host.id, rival.id, 7)).status).toBe(400);
    await api("POST", `/rooms/${roomId}/seats/1/claim`, rival.token);

    const gift = (to: string, giftId: string) =>
      api("POST", `/rooms/${roomId}/gifts`, fan.token, { recipientUserId: to, giftId, quantity: 1 }, { "Idempotency-Key": crypto.randomUUID() });
    await gift(host.id, "star"); // before the PK: not counted
    const sf = socketFor(fan.token);
    await emit(sf, "room:join", { roomId });
    const started = await start(host.token, host.id, rival.id);
    expect(started.body.pk).toMatchObject({ a: { userId: host.id, score: 0 }, b: { userId: rival.id, score: 0 } });
    expect((await start(host.token, host.id, rival.id)).body.error.code).toBe("PK_RUNNING");

    const scored = new Promise<any>((r) => sf.on("room:pk", (e) => e.pk?.b.score === 50 && r(e)));
    await gift(rival.id, "star"); // 50
    expect((await scored).pk.a.score).toBe(0);
    await gift(host.id, "chai"); // 10
    expect((await api("GET", `/rooms/${roomId}`, fan.token)).body.pk).toMatchObject({ a: { score: 10 }, b: { score: 50 } });

    // Time's up (simulated): the next read finishes it and announces the winner.
    // Shift the whole battle (and the gifts sent during it) an hour back, so it's over.
    await db.execute(sql`update gift_transactions g set created_at = g.created_at - interval '1 hour' from rooms r
      where r.id = ${roomId} and g.room_id = r.id and g.created_at >= (r.pk->>'startedAt')::timestamptz`);
    await db.execute(sql`update rooms set pk = pk || jsonb_build_object('startedAt', (pk->>'startedAt')::timestamptz - interval '1 hour',
      'endsAt', (pk->>'endsAt')::timestamptz - interval '1 hour') where id = ${roomId}`);
    expect((await api("GET", `/rooms/${roomId}`, fan.token)).body.pk).toBeNull();
    const msgs = (await api("GET", `/rooms/${roomId}/messages?limit=50`, host.token)).body.messages;
    expect(msgs.find((m: any) => m.payload?.kind === "PK_END")).toMatchObject({ body: `🏆 ${rival.handle} won the PK · 50 to 10`, payload: { winner: rival.id } });

    // Cancel
    expect((await start(host.token, host.id, rival.id, 3)).status).toBe(200);
    expect((await api("DELETE", `/rooms/${roomId}/pk`, host.token)).body.pk).toBeNull();
    expect((await api("GET", `/rooms/${roomId}`, fan.token)).body.pk).toBeNull();
  });

  test("room stats: weekly rank across rooms and heart level from lifetime gift coins", async () => {
    const one = await liveRoom();
    const two = await liveRoom();
    const fan = await joined(one.roomId, "stfan");
    await api("POST", `/rooms/${two.roomId}/join`, fan.token);
    const stats = async (roomId: string) => (await api("GET", `/rooms/${roomId}/stats`, fan.token)).body;
    const fresh = await stats(one.roomId);
    expect(fresh).toMatchObject({ rank: null, weekCoins: 0, heart: { level: 1, coins: 0, nextAt: 1000 } });

    const gift = (roomId: string, to: string, giftId: string, quantity: number) =>
      api("POST", `/rooms/${roomId}/gifts`, fan.token, { recipientUserId: to, giftId, quantity }, { "Idempotency-Key": crypto.randomUUID() });
    expect((await gift(two.roomId, two.host.id, "star", 2)).status).toBe(200); // 100
    expect((await gift(one.roomId, one.host.id, "chai", 3)).status).toBe(200); // 30
    const a = await stats(one.roomId);
    const b = await stats(two.roomId);
    expect(a.weekCoins).toBe(30);
    expect(b.rank).toBeLessThan(a.rank);
    expect(a.heart).toMatchObject({ level: 1, coins: 30 });
    const outsider = await signup("stout");
    expect((await api("GET", `/rooms/${one.roomId}/stats`, outsider.token)).status).toBe(403);
  });
});

describe("top gifters", () => {
  test("a room's top gifters this week and this month, most coins first", async () => {
    const { host, roomId } = await liveRoom();
    const big = await joined(roomId, "tgbig");
    const small = await joined(roomId, "tgsmall");
    const gift = (u: { token: string }, giftId: string, quantity: number) =>
      api("POST", `/rooms/${roomId}/gifts`, u.token, { recipientUserId: host.id, giftId, quantity }, { "Idempotency-Key": crypto.randomUUID() });
    expect((await gift(small, "chai", 1)).status).toBe(200); // 10
    expect((await gift(big, "star", 2)).status).toBe(200); // 100
    expect((await gift(small, "chai", 2)).status).toBe(200); // +20 = 30
    const top = async (period: string) => (await api("GET", `/rooms/${roomId}/top-gifters?period=${period}`, host.token)).body;
    const week = await top("week");
    expect(week.map((x: any) => [x.userId, x.coins])).toEqual([[big.id, 100], [small.id, 30]]);
    expect(week[0]).toMatchObject({ displayName: big.handle, svip: 0 });
    // A gift from last month counts for neither.
    await db.execute(sql`update gift_transactions set created_at = created_at - interval '40 days' where sender_id = ${big.id}`);
    expect((await top("month")).map((x: any) => x.userId)).toEqual([small.id]);
    expect((await top("year")).length).toBeUndefined(); // 400: bad period
    const outsider = await signup("tgout");
    expect((await api("GET", `/rooms/${roomId}/top-gifters`, outsider.token)).status).toBe(403);
  });
});

describe("about me, friends and the badge wall", () => {
  test("gender, birthday (18+), hometown and interests from the fixed list", async () => {
    const a = await signup("abt");
    const b = await signup("abtb");
    const patch = (body: object) => api("PATCH", "/me/profile", a.token, body);
    const opts = (await api("GET", "/profile-options", a.token)).body;
    expect(opts).toMatchObject({ maxInterests: 10, maxPinnedBadges: 9, minAge: 18 });
    expect(opts.interests).toContain("Travel");

    expect((await patch({ gender: "MALE", birthday: "2001-08-29", hometown: "  Surat ", interests: ["Fun", "Travel", "Fun"] })).status).toBe(200);
    expect((await api("GET", `/users/${a.id}`, b.token)).body).toMatchObject({ gender: "MALE", birthday: "2001-08-29", hometown: "Surat", interests: ["Fun", "Travel"] });
    const young = new Date(Date.now() - 16 * 365.25 * 86_400_000).toISOString().slice(0, 10);
    expect((await patch({ birthday: young })).status).toBe(400);
    expect((await patch({ birthday: "2001-02-30" })).status).toBe(400);
    expect((await patch({ interests: ["Hacking"] })).status).toBe(400);
    expect((await patch({ interests: opts.interests.slice(0, 11) })).status).toBe(400);
    expect((await patch({ hometown: "", gender: null })).status).toBe(200);
    expect((await api("GET", `/users/${a.id}`, b.token)).body).toMatchObject({ hometown: null, gender: null });
  });

  test("friends = mutual follows; the badge wall pins owned badges only, and expired ones drop off", async () => {
    const a = await signup("fra");
    const b = await signup("frb");
    const c = await signup("frc");
    await api("POST", `/users/${b.id}/follow`, a.token);
    await api("POST", `/users/${a.id}/follow`, b.token);
    await api("POST", `/users/${c.id}/follow`, a.token); // one-way: not a friend
    expect((await api("GET", `/users/${a.id}`, c.token)).body).toMatchObject({ friends: 1, following: 2, followers: 1 });

    await grantBadge(a.id, "vip", 30);
    await grantBadge(a.id, "top_gifter", 1);
    expect((await api("PUT", "/me/pinned-badges", a.token, { badgeIds: ["party_star"] })).body.error.code).toBe("BADGE_NOT_OWNED");
    expect((await api("PUT", "/me/pinned-badges", a.token, { badgeIds: ["top_gifter", "vip", "vip"] })).body.pinnedBadges).toEqual(["top_gifter", "vip"]);
    expect((await api("GET", `/users/${a.id}`, b.token)).body.pinnedBadges).toEqual(["top_gifter", "vip"]);
    await db.execute(sql`update user_badges set expires_at = now() - interval '1 minute' where user_id = ${a.id} and badge_id = 'top_gifter'`);
    expect((await api("GET", `/users/${a.id}`, b.token)).body.pinnedBadges).toEqual(["vip"]);
  });
});

describe("profile picture and cover photos", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const send = async (path: string, token: string, file: Buffer) => {
    const form = new FormData();
    form.append("file", new Blob([file]), "file");
    const res = await fetch(base + "/v1" + path, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: (await res.json()) as any };
  };

  test("upload and remove a profile picture; any URL can't be set directly", async () => {
    const a = await signup("pic");
    const b = await signup("picb");
    expect((await send("/me/avatar", a.token, Buffer.from("not an image"))).body.error.code).toBe("BAD_MEDIA");
    const up = await send("/me/avatar", a.token, png);
    expect(up.body.avatarUrl).toMatch(/^\/v1\/uploads\/.+\.png$/);
    expect((await fetch(base + up.body.avatarUrl)).headers.get("content-type")).toBe("image/png");
    expect((await api("GET", `/users/${a.id}`, b.token)).body.avatarUrl).toBe(up.body.avatarUrl);
    expect((await api("PATCH", "/me/profile", a.token, { avatarUrl: "https://evil.example/x.png" })).status).toBe(200);
    expect((await api("GET", `/users/${a.id}`, b.token)).body.avatarUrl).toBe(up.body.avatarUrl); // ignored
    expect((await api("DELETE", "/me/avatar", a.token)).body.avatarUrl).toBeNull();
  });

  test("up to 6 cover photos, in order; reorder or remove only your own", async () => {
    const a = await signup("cov");
    const urls: string[] = [];
    for (let i = 0; i < 6; i++) urls.push((await send("/me/covers", a.token, png)).body.coverUrls.at(-1));
    expect(new Set(urls).size).toBe(6);
    expect((await send("/me/covers", a.token, png)).body.error.code).toBe("COVERS_FULL");
    const reordered = [urls[2], urls[0]];
    expect((await api("PUT", "/me/covers", a.token, { coverUrls: reordered })).body.coverUrls).toEqual(reordered);
    expect((await api("PUT", "/me/covers", a.token, { coverUrls: ["/v1/uploads/someone-else.png"] })).body.error.code).toBe("COVER_NOT_FOUND");
    expect((await api("GET", "/me", a.token)).body.coverUrls).toEqual(reordered);
    expect((await api("GET", "/profile-options", a.token)).body.maxCovers).toBe(6);
  });
});

describe("in a room, on the profile", () => {
  test("a profile shows the live room its owner is in, so visitors can join; gone once they leave", async () => {
    const { host, roomId } = await liveRoom();
    const guest = await joined(roomId, "irguest");
    const visitor = await signup("irvisit");
    const profile = async (id: string) => (await api("GET", `/users/${id}`, visitor.token)).body;
    expect((await profile(guest.id)).inRoom).toMatchObject({ roomId, title: "Evening Chai" });
    expect((await profile(host.id)).inRoom).toMatchObject({ roomId });
    expect((await profile(visitor.id)).inRoom).toBeNull();
    // Following the link joins that room.
    expect((await api("POST", `/rooms/${roomId}/join`, visitor.token)).status).toBe(200);
    await api("POST", `/rooms/${roomId}/leave`, guest.token);
    expect((await profile(guest.id)).inRoom).toBeNull();
  });
});

describe("room privacy", () => {
  test("locked: listed with a lock, 4-digit password to join (owner, admins and people already inside skip it)", async () => {
    const { host, roomId } = await liveRoom();
    const inside = await joined(roomId, "lkin");
    const set = (body: object, token = host.token) => api("PATCH", `/rooms/${roomId}/settings`, token, body);
    expect((await set({ privacy: "LOCKED" })).body.error.code).toBe("PASSWORD_NEEDED");
    expect((await set({ privacy: "LOCKED", password: "12a4" })).status).toBe(400);
    expect((await set({ privacy: "LOCKED", password: "1234" }, inside.token)).body.error.code).toBe("NOT_ROOM_ADMIN");
    const locked = await set({ privacy: "LOCKED", password: "1234" });
    expect(locked.body.privacy).toBe("LOCKED");
    expect(JSON.stringify(locked.body)).not.toContain("passwordHash");

    const list = (await everyRoom("/rooms", host.token));
    expect(list.find((r: any) => r.roomId === roomId).privacy).toBe("LOCKED");

    const guest = await signup("lkguest");
    const join = (password?: string) => api("POST", `/rooms/${roomId}/join`, guest.token, password ? { password } : undefined);
    expect((await join()).body.error.code).toBe("PASSWORD_REQUIRED");
    expect((await join("0000")).body.error.code).toBe("WRONG_PASSWORD");
    expect((await join("1234")).status).toBe(200);
    expect((await api("POST", `/rooms/${roomId}/join`, inside.token)).status).toBe(200); // already inside: no password
    // Changing the password; going public drops it.
    expect((await set({ password: "9999" })).status).toBe(200);
    await api("POST", `/rooms/${roomId}/leave`, guest.token);
    expect((await join("1234")).body.error.code).toBe("WRONG_PASSWORD");
    expect((await set({ privacy: "PUBLIC" })).body.privacy).toBe("PUBLIC");
    expect((await join()).status).toBe(200);
  });

  test("wrong passwords are rate limited", async () => {
    const { host, roomId } = await liveRoom();
    await api("PATCH", `/rooms/${roomId}/settings`, host.token, { privacy: "LOCKED", password: "4321" });
    const guess = await signup("lkguess");
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await api("POST", `/rooms/${roomId}/join`, guess.token, { password: "1111" })).body.error.code);
    expect(codes.slice(0, 5)).toEqual(Array(5).fill("WRONG_PASSWORD"));
    expect(codes[5]).toBe("RATE_LIMITED");
  });

  test("private: hidden from the list and from profiles; only the owner and admins can enter", async () => {
    const { host, roomId } = await liveRoom();
    const inside = await joined(roomId, "pvin");
    expect((await api("PATCH", `/rooms/${roomId}/settings`, host.token, { privacy: "PRIVATE" })).body.privacy).toBe("PRIVATE");
    const outsider = await signup("pvout");
    expect((await everyRoom("/rooms", outsider.token)).some((r: any) => r.roomId === roomId)).toBe(false);
    expect((await api("GET", `/users/${inside.id}`, outsider.token)).body.inRoom).toBeNull();
    expect((await api("GET", `/users/${host.id}`, outsider.token)).body.inRoom).toBeNull();
    expect((await api("POST", `/rooms/${roomId}/join`, outsider.token)).body.error.code).toBe("ROOM_PRIVATE");
    expect((await api("POST", `/rooms/${roomId}/join`, outsider.token, { password: "1234" })).body.error.code).toBe("ROOM_PRIVATE");
    expect((await api("POST", `/rooms/${roomId}/join`, host.token)).status).toBe(200); // the owner always can
    // A room admin can come back in after leaving.
    await api("POST", `/rooms/${roomId}/admins/${inside.id}`, host.token);
    await api("POST", `/rooms/${roomId}/leave`, inside.token);
    expect((await api("POST", `/rooms/${roomId}/join`, inside.token)).status).toBe(200);
    const msgs = (await api("GET", `/rooms/${roomId}/messages?limit=50`, host.token)).body.messages;
    expect(msgs.some((m: any) => m.payload?.kind === "ROOM_PRIVACY")).toBe(true);
  });
});

describe("animated profile pictures", () => {
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)]);
  const send = async (path: string, token: string, file: Buffer) => {
    const form = new FormData();
    form.append("file", new Blob([file]), "file");
    const res = await fetch(base + "/v1" + path, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: (await res.json()) as any };
  };
  const recharge = (userId: string, rupees: number) =>
    db.execute(sql`insert into recharges (user_id, package_id, coins, price_paise, provider, idempotency_key, created_at)
      values (${userId}, 'test', 1, ${rupees * 100}, 'DEV', ${crypto.randomUUID()}, now())`);

  test("GIF profile pictures need SVIP3; covers stay JPEG/PNG; a lapsed tier hides the GIF", async () => {
    const a = await signup("gifa");
    const b = await signup("gifb");
    expect((await send("/me/avatar", a.token, gif)).body.error).toMatchObject({ code: "SVIP_REQUIRED", message: "Animated profile pictures are an SVIP3 perk" });
    await recharge(a.id, 15_000); // SVIP3
    const up = await send("/me/avatar", a.token, gif);
    expect(up.body.avatarUrl).toMatch(/\.gif$/);
    const served = await fetch(base + up.body.avatarUrl);
    expect([served.status, served.headers.get("content-type")]).toEqual([200, "image/gif"]);
    const big = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(2 * 1024 * 1024)]); // just over 2 MB
    expect((await send("/me/avatar", a.token, big)).body.error).toMatchObject({ code: "MEDIA_TOO_LARGE", message: "GIF is too large (max 2 MB)" });
    expect((await send("/me/covers", a.token, gif)).body.error.code).toBe("BAD_MEDIA");
    expect((await api("GET", `/users/${a.id}`, b.token)).body.avatarUrl).toBe(up.body.avatarUrl);
    await api("POST", `/users/${a.id}/follow`, b.token);
    const following = async () => (await api("GET", `/users/${b.id}/following`, b.token)).body.people[0];
    expect((await following()).avatarUrl).toBe(up.body.avatarUrl);

    // The month rolls over: the GIF hides everywhere until SVIP3 again.
    await db.execute(sql`update recharges set created_at = created_at - interval '40 days' where user_id = ${a.id}`);
    expect((await api("GET", `/users/${a.id}`, b.token)).body.avatarUrl).toBeNull();
    expect((await following()).avatarUrl).toBeNull();
    expect((await api("GET", "/me", a.token)).body.avatarUrl).toBeNull();
    expect((await api("GET", "/me/svip", a.token)).body.tiers[2].perks.map((p: any) => p.title)).toContain("Animated profile picture");
  });
});

describe("live streams", () => {
  test("go live (alongside your audio room), listed separately, co-host seats, host ending or leaving ends it", async () => {
    const { host, roomId: audioRoom } = await liveRoom();
    const started = await api("POST", "/lives", host.token, { title: "Late night chat" });
    expect(started.status).toBe(201);
    const liveId = started.body.room.roomId as string;
    expect(started.body.room).toMatchObject({ kind: "LIVE", seatCount: 4 });
    expect(started.body.room.seats[0].occupant.userId).toBe(host.id);
    expect(started.body.zego.streamId).toBeTruthy(); // the host publishes camera + mic
    expect((await api("POST", "/lives", host.token, { title: "Again" })).body.error.code).toBe("ALREADY_LIVE");
    expect((await api("POST", `/rooms/${liveId}/seat-count`, host.token, { seatCount: 8 })).body.error.code).toBe("NOT_FOR_LIVE");

    const viewer = await signup("lvview");
    const lives = (await everyRoom("/lives", viewer.token));
    expect(lives.map((r: any) => r.roomId)).toContain(liveId);
    expect(lives.map((r: any) => r.roomId)).not.toContain(audioRoom);
    expect((await everyRoom("/rooms", viewer.token)).map((r: any) => r.roomId)).not.toContain(liveId);
    expect((await api("GET", "/me/live", host.token)).body.room.roomId).toBe(liveId);
    expect((await api("GET", `/users/${host.id}`, viewer.token)).body.inRoom).toBeTruthy();

    // Co-host: the host invites a viewer onto seat 1; they publish too.
    expect((await api("POST", `/rooms/${liveId}/join`, viewer.token)).status).toBe(200);
    expect((await api("POST", `/rooms/${liveId}/seats/1/invite`, host.token, { userId: viewer.id })).status).toBeLessThan(300);
    const claimed = await api("POST", `/rooms/${liveId}/seats/1/accept-invite`, viewer.token);
    expect(claimed.body).toMatchObject({ seatIndex: 1, zego: { streamId: expect.any(String) } }); // co-host publishes camera + mic
    // Audio-only co-host: camera off shows on the seat for everyone; cleared when the seat frees.
    expect((await api("POST", `/rooms/${liveId}/camera`, viewer.token, { off: true })).body.cameraOff).toBe(true);
    expect((await api("GET", `/rooms/${liveId}`, host.token)).body.seats[1]).toMatchObject({ cameraOff: true, occupant: { userId: viewer.id } });
    await api("POST", `/rooms/${liveId}/seats/1/release`, viewer.token);
    expect((await api("GET", `/rooms/${liveId}`, host.token)).body.seats[1]).toMatchObject({ cameraOff: false, occupant: null });
    expect((await api("POST", `/rooms/${liveId}/camera`, viewer.token, { off: true })).body.error.code).toBe("NOT_SEATED");

    expect((await api("POST", `/lives/${liveId}/end`, viewer.token)).body.error.code).toBe("NOT_HOST");
    expect((await api("POST", `/lives/${liveId}/end`, host.token)).body.ended).toBe(true);
    expect((await everyRoom("/lives", viewer.token)).map((r: any) => r.roomId)).not.toContain(liveId);
    expect((await api("POST", `/rooms/${liveId}/join`, viewer.token)).body.error.code).toBe("ROOM_NOT_LIVE");
    expect((await api("GET", "/me/room", host.token)).body.room.roomId).toBe(audioRoom); // the audio room is untouched

    // Leaving your own live stream ends it too.
    const again = (await api("POST", "/lives", host.token, { title: "Round two" })).body.room.roomId;
    await api("POST", `/rooms/${again}/leave`, host.token);
    expect((await api("GET", "/me/live", host.token)).body.room).toBeNull();
  });

  test("live PK: invite, accept, scores from each room's gifts, result in both rooms; decline and cancel", async () => {
    const a = await signup("lpka");
    const b = await signup("lpkb");
    const roomA = (await api("POST", "/lives", a.token, { title: "A live" })).body.room.roomId as string;
    const roomB = (await api("POST", "/lives", b.token, { title: "B live" })).body.room.roomId as string;
    const fan = await signup("lpkfan");
    await api("POST", `/rooms/${roomA}/join`, fan.token);
    // A co-host in room A before the battle.
    const co = await signup("lpkco");
    await api("POST", `/rooms/${roomA}/join`, co.token);
    await api("POST", `/rooms/${roomA}/seats/1/invite`, a.token, { userId: co.id });
    expect((await api("POST", `/rooms/${roomA}/seats/1/accept-invite`, co.token)).status).toBe(200);

    const sb = socketFor(b.token);
    await new Promise<void>((r) => sb.once("connect", () => r()));
    const invited = nextEvent(sb, "live:pk:invite");
    expect((await api("POST", `/lives/${roomA}/pk`, fan.token, { targetRoomId: roomB, minutes: 5 })).body.error.code).toBe("NOT_HOST");
    const inv = await api("POST", `/lives/${roomA}/pk`, a.token, { targetRoomId: roomB, minutes: 5 });
    expect((await invited).from).toMatchObject({ roomId: roomA, title: "A live" });
    expect((await api("POST", `/lives/${roomA}/pk`, a.token, { targetRoomId: roomB, minutes: 5 })).body.error.code).toBe("PK_BUSY");
    expect((await api("POST", `/live-pks/${inv.body.pkId}/accept`, a.token)).body.error.code).toBe("NOT_HOST"); // only B accepts

    const accepted = await api("POST", `/live-pks/${inv.body.pkId}/accept`, b.token);
    expect(accepted.body.pk).toMatchObject({ status: "ACTIVE", a: { roomId: roomA, score: 0 }, b: { roomId: roomB, score: 0 } });
    expect(accepted.body.pk.b.streamId).toBeTruthy(); // room A plays B's camera
    // Host vs host: the co-host stepped off, co-hosting is paused, and both show as in a PK.
    expect((await api("GET", `/rooms/${roomA}`, fan.token)).body.seats[1].occupant).toBeNull();
    expect((await api("POST", `/rooms/${roomA}/seats/1/invite`, a.token, { userId: co.id })).body.error.code).toBe("PK_IN_PROGRESS");
    const lives = (await everyRoom("/lives", fan.token));
    expect(lives.filter((r: any) => [roomA, roomB].includes(r.roomId)).map((r: any) => r.inPk)).toEqual([true, true]);

    const gift = (room: string, to: string, giftId: string) =>
      api("POST", `/rooms/${room}/gifts`, fan.token, { recipientUserId: to, giftId, quantity: 1 }, { "Idempotency-Key": crypto.randomUUID() });
    expect((await gift(roomA, a.id, "star")).status).toBe(200); // 50 for A
    expect((await api("GET", `/lives/${roomA}/pk`, fan.token)).body.pk).toMatchObject({ a: { score: 50 }, b: { score: 0 } });

    // Time's up (moved an hour back with its gifts): the next read finishes it.
    await db.execute(sql`update gift_transactions set created_at = created_at - interval '1 hour' where room_id = ${roomA}`);
    await db.execute(sql`update live_pks set started_at = started_at - interval '1 hour', ends_at = ends_at - interval '1 hour' where id = ${inv.body.pkId}`);
    expect((await api("GET", `/lives/${roomA}/pk`, fan.token)).body.pk).toBeNull();
    for (const room of [roomA, roomB]) {
      const host = room === roomA ? a : b;
      const msgs = (await api("GET", `/rooms/${room}/messages?limit=50`, host.token)).body.messages;
      expect(msgs.find((m: any) => m.payload?.kind === "PK_END")?.body).toBe(`🏆 ${a.handle} won the PK · 50 to 0`);
    }

    // Decline, then an invite withdrawn.
    const inv2 = await api("POST", `/lives/${roomB}/pk`, b.token, { targetRoomId: roomA, minutes: 3 });
    expect((await api("POST", `/live-pks/${inv2.body.pkId}/decline`, a.token)).body.declined).toBe(true);
    const inv3 = await api("POST", `/lives/${roomB}/pk`, b.token, { targetRoomId: roomA, minutes: 3 });
    expect((await api("DELETE", `/live-pks/${inv3.body.pkId}`, b.token)).body.cancelled).toBe(true);
    expect((await api("POST", `/live-pks/${inv3.body.pkId}/accept`, a.token)).body.error.code).toBe("PK_INVITE_EXPIRED");
  });
});

describe("chat history since joining", () => {
  test("new arrivals only see messages sent after they joined; rejoining starts fresh", async () => {
    const { host, roomId } = await liveRoom();
    const say = (token: string, body: string) => api("POST", `/rooms/${roomId}/messages`, token, { body, mentions: [], clientMessageId: crypto.randomUUID() });
    expect((await say(host.token, "before you came")).status).toBeLessThan(300);
    const late = await joined(roomId, "latechat");
    expect((await say(host.token, "welcome!")).status).toBeLessThan(300);
    const bodies = async (token: string) => (await api("GET", `/rooms/${roomId}/messages?limit=50`, token)).body.messages.map((m: any) => m.body);
    expect(await bodies(late.token)).toContain("welcome!");
    expect(await bodies(late.token)).not.toContain("before you came");
    expect(await bodies(host.token)).toContain("before you came"); // the host has been here all along

    await api("POST", `/rooms/${roomId}/leave`, late.token);
    await api("POST", `/rooms/${roomId}/join`, late.token);
    expect(await bodies(late.token)).not.toContain("welcome!");
  });
});

describe("room ranking and pins", () => {
  test("official room first, then staff pins (up to 4), then rooms ranked by gifts, people and activity", async () => {
    await db.execute(sql`update rooms set pin_slot = null, official = false`);
    const quiet = await liveRoom();
    const busy = await liveRoom();
    const official = await liveRoom();
    const pinnedRoom = await liveRoom();
    // Busy room: two listeners, a gift and some chat.
    const fan = await joined(busy.roomId, "rkfan");
    await joined(busy.roomId, "rkfan2");
    await api("POST", `/rooms/${busy.roomId}/gifts`, fan.token, { recipientUserId: busy.host.id, giftId: "star", quantity: 2 }, { "Idempotency-Key": crypto.randomUUID() });
    await api("POST", `/rooms/${busy.roomId}/messages`, fan.token, { body: "so fun", mentions: [], clientMessageId: crypto.randomUUID() });
    // The quiet room empties out (host leaves): it sinks.
    await api("POST", `/rooms/${quiet.roomId}/leave`, quiet.host.token);

    await db.execute(sql`update rooms set official = true, pin_slot = 1 where id = ${official.roomId}`);
    const staff = await signup("rkboss");
    await db.execute(sql`update users set staff_role = 'ADMIN' where id = ${staff.id}`);
    expect((await api("POST", `/rooms/${pinnedRoom.roomId}/pin`, fan.token, { pinned: true })).body.error.code).toBe("NOT_STAFF");
    expect((await api("POST", `/rooms/${pinnedRoom.roomId}/pin`, staff.token, { pinned: true })).body).toEqual({ pinned: true, pinSlot: 2 });
    expect((await api("POST", `/rooms/${official.roomId}/pin`, staff.token, { pinned: false })).body.error.code).toBe("OFFICIAL_ROOM");

    const list = (await everyRoom("/rooms", fan.token));
    const order = list.map((r: any) => r.roomId).filter((id: string) => [quiet, busy, official, pinnedRoom].some((x) => x.roomId === id));
    expect(order).toEqual([official.roomId, pinnedRoom.roomId, busy.roomId, quiet.roomId]);
    expect(list[0]).toMatchObject({ roomId: official.roomId, official: true, pinned: true });
    expect(list.find((r: any) => r.roomId === busy.roomId).rank).toBeGreaterThan(list.find((r: any) => r.roomId === quiet.roomId).rank);
    expect((await api("GET", `/rooms/${pinnedRoom.roomId}`, pinnedRoom.host.token)).body).toMatchObject({ pinned: true, official: false });

    // Only 4 pins in all (the official room counts).
    const more = [await liveRoom(), await liveRoom(), await liveRoom()];
    expect((await api("POST", `/rooms/${more[0]!.roomId}/pin`, staff.token, { pinned: true })).body.pinSlot).toBe(3);
    expect((await api("POST", `/rooms/${more[1]!.roomId}/pin`, staff.token, { pinned: true })).body.pinSlot).toBe(4);
    expect((await api("POST", `/rooms/${more[2]!.roomId}/pin`, staff.token, { pinned: true })).body.error.code).toBe("PIN_LIMIT");
    expect((await api("POST", `/rooms/${pinnedRoom.roomId}/pin`, staff.token, { pinned: false })).body.pinned).toBe(false);
    expect((await api("POST", `/rooms/${more[2]!.roomId}/pin`, staff.token, { pinned: true })).body.pinSlot).toBe(2);
    await db.execute(sql`update rooms set pin_slot = null, official = false`);
  });
});

describe("home feeds", () => {
  test("rooms by category, with who's on stage and free seats; friends feed shows where people you follow are", async () => {
    const host = await signup("hfhost");
    const music = (await api("POST", "/rooms", host.token, { title: "Late night songs", category: "Music", seatCount: 8 })).body.room.roomId as string;
    const guest = await joined(music, "hfguest");
    await api("POST", `/rooms/${music}/seats/2/claim`, guest.token);

    const musicList = await everyRoom("/rooms", host.token);
    const card = musicList.find((r: any) => r.roomId === music);
    expect(card.stage.map((s: any) => s.userId)).toEqual([host.id, guest.id]);
    expect(card.seatsFree).toBe(6); // 8 seats - host - guest
    const filtered = (await api("GET", "/rooms?limit=50&category=music", host.token)).body.rooms;
    expect(filtered.every((r: any) => r.category === "Music")).toBe(true);
    expect(filtered.map((r: any) => r.roomId)).toContain(music);
    expect((await api("GET", "/rooms?limit=50&category=Study", host.token)).body.rooms.map((r: any) => r.roomId)).not.toContain(music);

    // Friends feed: following the guest (and the host) shows that room once, with both friends.
    const fan = await signup("hffan");
    await api("POST", `/users/${guest.id}/follow`, fan.token);
    await api("POST", `/users/${host.id}/follow`, fan.token);
    const items = (await api("GET", "/me/following/active", fan.token)).body.items;
    const here = items.find((i: any) => i.room.roomId === music);
    expect(here.friends.map((f: any) => f.userId).sort()).toEqual([host.id, guest.id].sort());
    // Private rooms never show up.
    await api("PATCH", `/rooms/${music}/settings`, host.token, { privacy: "PRIVATE" });
    expect((await api("GET", "/me/following/active", fan.token)).body.items.some((i: any) => i.room.roomId === music)).toBe(false);
  });
});

describe("CP relationships", () => {
  const coins = async (token: string) => (await api("GET", "/wallet", token)).body.balance as number;
  const fund = (id: string, balance: number) => db.execute(sql`update wallet_accounts set balance = ${balance} where user_id = ${id}`);
  const propose = (from: { token: string }, to: { id: string }, type: string, label?: string) =>
    api("POST", "/cp/proposals", from.token, { toUserId: to.id, type, ...(label && { label }) });
  const rels = async (viewer: { token: string }, who: { id: string }) => (await api("GET", `/users/${who.id}`, viewer.token)).body.relationships as any[];

  test("love: pay to propose, the card arrives as a DM, accepting pairs you; one Love each", async () => {
    const [a, b, c] = [await signup("cpa"), await signup("cpb"), await signup("cpc")];
    for (const u of [a, b, c]) await fund(u.id, 5000);
    const sent = await propose(a, b, "LOVE");
    expect(sent.status).toBe(201);
    expect(sent.body.balance).toBe(5000 - 520);
    expect(await coins(a.token)).toBe(4480);
    // not friends, still delivered as a card in DMs
    const dm = (await api("GET", `/dm/${a.id}`, b.token)).body.messages;
    expect(dm[0].cp).toMatchObject({ id: sent.body.proposal.id, type: "LOVE", status: "PENDING", price: 520 });
    expect((await propose(b, a, "BESTIE")).body.error.code).toBe("CP_PENDING"); // one open request between two people

    expect((await api("POST", `/cp/proposals/${sent.body.proposal.id}/accept`, a.token)).status).toBe(404); // only the recipient answers
    expect((await api("POST", `/cp/proposals/${sent.body.proposal.id}/accept`, b.token)).body.status).toBe("ACCEPTED");
    expect(await rels(c, a)).toEqual([expect.objectContaining({ type: "LOVE", label: null, user: expect.objectContaining({ userId: b.id }) })]);
    expect((await rels(c, b))[0].user.userId).toBe(a.id);
    expect(await coins(a.token)).toBe(4480); // spent, not refunded

    expect((await propose(c, a, "LOVE")).body.error).toMatchObject({ code: "CP_LIMIT", message: "They have no free Love CP slot" });
    expect((await propose(a, c, "LOVE")).body.error).toMatchObject({ code: "CP_LIMIT", message: "You have no free Love CP slot" });
    expect((await propose(a, b, "BESTIE")).body.error.code).toBe("CP_ALREADY_PAIRED"); // one relationship per pair of people
  });

  test("decline, cancel and expiry all refund in full", async () => {
    const { expireProposals } = await import("../src/services/cp");
    const [a, b] = [await signup("cpd"), await signup("cpe")];
    await fund(a.id, 1000);
    const p1 = (await propose(a, b, "BESTIE")).body.proposal;
    expect(await coins(a.token)).toBe(801);
    expect((await api("POST", `/cp/proposals/${p1.id}/decline`, b.token)).body.status).toBe("DECLINED");
    expect(await coins(a.token)).toBe(1000);
    expect((await api("POST", `/cp/proposals/${p1.id}/accept`, b.token)).body.error.code).toBe("CP_NOT_PENDING");

    const p2 = (await propose(a, b, "SIBLING", "SISTER")).body.proposal;
    expect(p2).toMatchObject({ label: "SISTER", price: 99 });
    expect((await api("POST", `/cp/proposals/${p2.id}/cancel`, b.token)).status).toBe(404); // only the sender cancels
    expect((await api("POST", `/cp/proposals/${p2.id}/cancel`, a.token)).body.status).toBe("CANCELLED");
    expect(await coins(a.token)).toBe(1000);

    const p3 = (await propose(a, b, "LOVE")).body.proposal;
    await db.execute(sql`update cp_proposals set expires_at = now() - interval '1 minute' where id = ${p3.id}`);
    expect(await expireProposals()).toBeGreaterThanOrEqual(1);
    expect(await coins(a.token)).toBe(1000);
    expect((await api("GET", `/dm/${a.id}`, b.token)).body.messages[0].cp.status).toBe("EXPIRED");
    const ledger = (await api("GET", "/wallet/transactions", a.token)).body.entries.map((e: any) => e.entryType);
    expect(ledger.filter((t: string) => t === "CP_REFUND")).toHaveLength(3);
  });

  test("slot limits: 4 best friends, 7 Brother/Sister (label required), and not enough coins", async () => {
    const a = await signup("cpf");
    await fund(a.id, 100000);
    const friends = await Promise.all([1, 2, 3, 4, 5].map((i) => signup(`cpbf${i}`)));
    for (const f of friends.slice(0, 4)) {
      const p = (await propose(a, f, "BESTIE")).body.proposal;
      expect((await api("POST", `/cp/proposals/${p.id}/accept`, f.token)).status).toBe(200);
    }
    expect((await propose(a, friends[4]!, "BESTIE")).body.error.code).toBe("CP_LIMIT");
    expect((await propose(a, friends[4]!, "SIBLING")).status).toBe(400); // Brother or Sister must be chosen
    expect((await propose(a, friends[4]!, "BESTIE", "BROTHER")).status).toBe(400);

    const sibs = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => signup(`cpsib${i}`)));
    resetRateLimits(); // 10 requests a minute per sender
    for (const [i, s] of sibs.slice(0, 7).entries()) {
      const p = (await propose(a, s, "SIBLING", i % 2 ? "BROTHER" : "SISTER")).body.proposal;
      expect((await api("POST", `/cp/proposals/${p.id}/accept`, s.token)).status).toBe(200);
    }
    expect((await propose(sibs[7]!, a, "SIBLING", "BROTHER")).body.error.code).toBe("CP_LIMIT");
    expect((await rels(a, a)).map((r) => r.type)).toEqual([...Array(4).fill("BESTIE"), ...Array(7).fill("SIBLING")]);

    const poor = await signup("cppoor");
    await fund(poor.id, 98);
    expect((await propose(poor, friends[4]!, "SIBLING", "BROTHER")).status).toBe(402);
    expect(await coins(poor.token)).toBe(98);
  });

  test("a full slot at accept time is refused; ending a Love starts a 7-day cooldown; blocking ends the CP and refunds", async () => {
    const [a, b, c, d] = [await signup("cpg"), await signup("cph"), await signup("cpi"), await signup("cpj")];
    for (const u of [a, b, c, d]) await fund(u.id, 5000);
    // b gets two Love requests; accepting one fills b's slot, so the other can't be accepted (it stays open to decline)
    const fromA = (await propose(a, b, "LOVE")).body.proposal;
    const fromC = (await propose(c, b, "LOVE")).body.proposal;
    expect((await api("POST", `/cp/proposals/${fromA.id}/accept`, b.token)).status).toBe(200);
    expect((await api("POST", `/cp/proposals/${fromC.id}/accept`, b.token)).body.error.code).toBe("CP_LIMIT");
    expect((await api("POST", `/cp/proposals/${fromC.id}/decline`, b.token)).status).toBe(200);
    expect(await coins(c.token)).toBe(5000);

    const pairId = (await rels(a, a))[0].pairId;
    expect((await api("DELETE", `/cp/pairs/${pairId}`, c.token)).status).toBe(404); // not theirs
    expect((await api("DELETE", `/cp/pairs/${pairId}`, b.token)).status).toBe(200);
    expect(await rels(a, a)).toEqual([]);
    expect((await propose(a, d, "LOVE")).body.error.code).toBe("CP_COOLDOWN");
    expect((await propose(d, b, "LOVE")).body.error).toMatchObject({ code: "CP_COOLDOWN", message: "They ended a Love CP less than 7 days ago" });
    expect((await propose(a, d, "BESTIE")).status).toBe(201); // the cooldown is Love only

    const p = (await propose(c, d, "SIBLING", "BROTHER")).body.proposal;
    expect((await api("POST", `/cp/proposals/${p.id}/accept`, d.token)).status).toBe(200);
    expect((await propose(d, c, "LOVE")).body.error.code).toBe("CP_ALREADY_PAIRED");
    await propose(c, a, "BESTIE");
    await api("POST", `/users/${a.id}/block`, c.token);
    expect(await rels(c, c)).toEqual([expect.objectContaining({ type: "SIBLING", label: "BROTHER" })]); // c–d untouched
    expect((await api("GET", `/dm/${c.id}`, a.token)).body.messages[0].cp.status).toBe("CANCELLED");
    expect(await coins(c.token)).toBe(5000 - 99);
    expect((await propose(a, c, "BESTIE")).body.error.code).toBe("BLOCKED");
  });
});

describe("Families", () => {
  const fund = (id: string, balance: number) => db.execute(sql`update wallet_accounts set balance = ${balance} where user_id = ${id}`);

  test("create costs 500, one family each; owner appoints admins, admins remove members only", async () => {
    const [owner, adm, m, poor] = [await signup("fown"), await signup("fadm"), await signup("fmem"), await signup("fpoor")];
    await fund(owner.id, 600);
    await fund(poor.id, 499);
    expect((await api("POST", "/families", poor.token, { name: "Broke" })).body.error.code).toBe("INSUFFICIENT_COINS");
    const made = await api("POST", "/families", owner.token, { name: "Night Owls" });
    expect(made.status).toBe(201);
    expect(made.body.balance).toBe(100);
    const fid = made.body.familyId;
    expect((await api("POST", "/families", owner.token, { name: "Second" })).body.error.code).toBe("INSUFFICIENT_COINS");
    await fund(owner.id, 600);
    expect((await api("POST", "/families", owner.token, { name: "Second" })).body.error.code).toBe("ALREADY_IN_FAMILY");
    expect((await api("GET", "/wallet", owner.token)).body.balance).toBe(600); // the failed create was rolled back

    for (const u of [adm, m]) expect((await api("POST", `/families/${fid}/join`, u.token)).status).toBe(200);
    expect((await api("POST", `/families/${fid}/members/${adm.id}/role`, m.token, { role: "ADMIN" })).body.error.code).toBe("NOT_FAMILY_OWNER");
    expect((await api("POST", `/families/${fid}/members/${adm.id}/role`, owner.token, { role: "ADMIN" })).status).toBe(200);
    expect((await api("DELETE", `/families/${fid}/members/${owner.id}`, adm.token)).body.error.code).toBe("CANNOT_REMOVE");
    expect((await api("DELETE", `/families/${fid}/members/${m.id}`, adm.token)).status).toBe(200);
    expect((await api("POST", `/families/${fid}/leave`, owner.token)).body.error.code).toBe("OWNER_CANNOT_LEAVE");
    expect((await api("GET", "/families/me", adm.token)).body.family).toMatchObject({ familyId: fid, role: "ADMIN" });

    expect((await api("DELETE", `/families/${fid}`, adm.token)).body.error.code).toBe("NOT_FAMILY_OWNER");
    expect((await api("DELETE", `/families/${fid}`, owner.token)).status).toBe(200);
    expect((await api("GET", "/families/me", adm.token)).body.family).toBeNull();
  });

  test("members sort by gifts sent this month since joining; invites only to people you follow", async () => {
    const [owner, a, b, stranger] = [await signup("fo2"), await signup("fa2"), await signup("fb2"), await signup("fs2")];
    await fund(owner.id, 500);
    const fid = (await api("POST", "/families", owner.token, { name: "Gifters" })).body.familyId;
    for (const u of [a, b]) await api("POST", `/families/${fid}/join`, u.token);
    const { roomId } = await liveRoom();
    const [gift] = (await db.execute<{ id: string }>(sql`select id from gift_catalog limit 1`)).rows;
    const sent = (from: string, coins: number, at = sql`now()`) =>
      db.execute(sql`insert into gift_transactions (sender_id, recipient_id, gift_id, room_id, recipient_seat_index, quantity, coins_debited, idempotency_key, created_at)
        values (${from}, ${owner.id}, ${gift!.id}, ${roomId}, 0, 1, ${coins}, ${crypto.randomUUID()}, ${at})`);
    await sent(a.id, 100);
    await sent(b.id, 300);
    await sent(a.id, 5000, sql`now() - interval '40 days'`); // last month: doesn't count
    const d = (await api("GET", `/families/${fid}`, stranger.token)).body;
    expect(d.members.map((x: any) => [x.userId, x.contribution])).toEqual([[b.id, 300], [a.id, 100], [owner.id, 0]]);
    expect(d.family.monthTotal).toBe(400);
    expect(d.myRole).toBeNull();

    expect((await api("POST", `/families/${fid}/invite`, owner.token, { userId: stranger.id })).body.error.code).toBe("NOT_FOLLOWING");
    await api("POST", `/users/${stranger.id}/follow`, owner.token);
    expect((await api("POST", `/families/${fid}/invite`, a.token, { userId: stranger.id })).body.error.code).toBe("NOT_FAMILY_ADMIN");
    expect((await api("POST", `/families/${fid}/invite`, owner.token, { userId: stranger.id })).status).toBe(200);
    const dm = (await api("GET", `/dm/${owner.id}`, stranger.token)).body.messages;
    expect(dm[0]).toMatchObject({ familyId: fid });
  });
});

describe("CP levels", () => {
  test("the curve: level 1 at 0, each level costs more than the last, max 50", async () => {
    const { cpLevel, cpPointsFor, CP_MAX_LEVEL } = await import("../src/lib/cpLevels");
    expect(cpLevel(0)).toMatchObject({ level: 1, current: 0, next: 150 });
    expect(cpLevel(149).level).toBe(1);
    expect(cpLevel(150).level).toBe(2);
    for (let n = 2; n < CP_MAX_LEVEL; n++) expect(cpPointsFor(n + 1) - cpPointsFor(n)).toBeGreaterThan(cpPointsFor(n) - cpPointsFor(n - 1));
    expect(cpLevel(10_000_000)).toMatchObject({ level: CP_MAX_LEVEL, next: null });
  });

  test("partners earn points from gifts, inbox messages (capped daily) and time together in a room", async () => {
    const { awardTogether } = await import("../src/services/cp");
    const { host, roomId } = await liveRoom();
    const fan = await joined(roomId, "cplvfan");
    await db.execute(sql`update wallet_accounts set balance = 10000 where user_id in (${host.id}, ${fan.id})`);
    const p = (await api("POST", "/cp/proposals", fan.token, { toUserId: host.id, type: "LOVE" })).body.proposal;
    expect((await api("POST", `/cp/proposals/${p.id}/accept`, host.token)).status).toBe(200);
    const level = async () => (await api("GET", `/users/${host.id}`, fan.token)).body.relationships[0].level;
    expect(await level()).toMatchObject({ level: 1, points: 0 });

    // Gifts: 1 point per coin, either way.
    const gift = (giftId: string, quantity: number) =>
      api("POST", `/rooms/${roomId}/gifts`, fan.token, { recipientUserId: host.id, giftId, quantity }, { "Idempotency-Key": crypto.randomUUID() });
    expect((await gift("chai", 2)).status).toBe(200); // 20 coins
    expect((await level()).points).toBe(20);

    // Messages: 3 each, at most 60 a day.
    await api("POST", `/users/${host.id}/follow`, fan.token);
    await api("POST", `/users/${fan.id}/follow`, host.token);
    for (let i = 0; i < 25; i++) {
      if (i % 15 === 0) resetRateLimits();
      expect((await api("POST", `/dm/${host.id}`, fan.token, { body: `hi ${i}`, clientMessageId: `cpm${i}` })).status).toBe(201);
    }
    expect((await level()).points).toBe(20 + 60);

    // Together in the same live room: 1 a minute (2 when both are seated), at most 240 a day.
    expect(await awardTogether()).toBeGreaterThanOrEqual(1);
    expect((await level()).points).toBe(81);
    await db.execute(sql`update cp_points_daily set points = 239 where source = 'TOGETHER' and pair_id = (select id from cp_pairs where proposal_id = ${p.id})`);
    await awardTogether();
    await awardTogether();
    expect((await level()).points).toBe(82); // only 1 more fit under the cap

    // The inbox shows the CP and its level next to the conversation.
    const convo = (await api("GET", "/dm", fan.token)).body.conversations.find((c: any) => c.user.userId === host.id);
    expect(convo.cp).toMatchObject({ type: "LOVE", level: { level: 1, points: 82 } });
    expect((await api("GET", `/dm/${host.id}`, fan.token)).body.cp).toMatchObject({ type: "LOVE", level: { level: 1, points: 82 } }); // the chat header

    // Strangers earn nothing: a gift to someone you're not paired with leaves your CP alone.
    const other = await joined(roomId, "cplvother");
    await db.execute(sql`update wallet_accounts set balance = 1000 where user_id = ${other.id}`);
    expect((await api("POST", `/rooms/${roomId}/gifts`, other.token, { recipientUserId: host.id, giftId: "star", quantity: 1 }, { "Idempotency-Key": crypto.randomUUID() })).status).toBe(200);
    expect((await level()).points).toBe(82);
  });
});

describe("room invites", () => {
  test("friends in the room can invite friends; strangers and outsiders can't", async () => {
    const { host, roomId } = await liveRoom();
    const friend = await signup("invfriend");
    const stranger = await signup("invstranger");
    await api("POST", `/users/${friend.id}/follow`, host.token);
    await api("POST", `/users/${host.id}/follow`, friend.token);
    await api("POST", `/users/${stranger.id}/follow`, host.token); // one-way: not a friend

    expect((await api("GET", "/me/friends", host.token)).body.friends.map((f: any) => f.userId)).toEqual([friend.id]);

    const sf = socketFor(friend.token);
    const ss = socketFor(stranger.token);
    await Promise.all([sf, ss].map((s) => new Promise<void>((r) => s.once("connect", () => r()))));
    let strangerGot = false;
    ss.on("room:invite", () => (strangerGot = true));
    const got = nextEvent(sf, "room:invite");
    const r = await api("POST", `/rooms/${roomId}/invite`, host.token, { userIds: [friend.id, stranger.id] });
    expect(r.body).toEqual({ invited: 1, notified: 0 });
    expect(await got).toMatchObject({ roomId, title: "Evening Chai", from: { userId: host.id } });
    await new Promise((res) => setTimeout(res, 100));
    expect(strangerGot).toBe(false);

    // A friend who isn't online gets the invite as a message with the room attached (a Join button in the app).
    const away = await signup("invaway");
    await api("POST", `/users/${away.id}/follow`, host.token);
    await api("POST", `/users/${host.id}/follow`, away.token);
    const friends = (await api("GET", "/me/friends", host.token)).body.friends;
    expect(friends.map((f: any) => [f.userId, f.online])).toEqual([[friend.id, true], [away.id, false]]); // online first
    expect((await api("POST", `/rooms/${roomId}/invite`, host.token, { userIds: [away.id] })).body).toEqual({ invited: 0, notified: 1 });
    expect((await api("GET", `/dm/${host.id}`, away.token)).body.messages[0]).toMatchObject({ roomId, body: '📣 Join me in "Evening Chai"' });

    // Only people in the room can invite to it.
    expect((await api("POST", `/rooms/${roomId}/invite`, stranger.token, { userIds: [host.id] })).body.error.code).toBe("NOT_IN_ROOM");
  });

  test("the owner can clear the chat for everyone; other people can't", async () => {
    const { host, roomId } = await liveRoom();
    const guest = await joined(roomId, "clrguest");
    const sh = socketFor(host.token);
    await new Promise<void>((r) => sh.once("connect", () => r()));
    await emit(sh, "room:join", { roomId });
    await emit(sh, "room:chat:send", { roomId, body: "hello all", mentions: [], clientMessageId: "c1" });
    const said = async (token: string) => (await api("GET", `/rooms/${roomId}/messages`, token)).body.messages.filter((m: any) => m.type === "USER");
    expect(await said(host.token)).toHaveLength(1);

    expect((await api("POST", `/rooms/${roomId}/chat/clear`, guest.token)).body.error.code).toBe("NOT_ROOM_ADMIN");
    const cleared = nextEvent(sh, "room:chat:cleared");
    expect((await api("POST", `/rooms/${roomId}/chat/clear`, host.token)).status).toBe(200);
    expect(await cleared).toMatchObject({ roomId });
    expect(await said(host.token)).toEqual([]);
    expect(await said(guest.token)).toEqual([]);
  });
});

describe("profile likes", () => {
  test("a new like messages the liked person once a day; they can see who liked them and when", async () => {
    const [a, b, c] = [await signup("lka"), await signup("lkb"), await signup("lkc")];
    const sb = socketFor(b.token);
    await new Promise<void>((r) => sb.once("connect", () => r()));
    const got = nextEvent(sb, "dm:new");
    expect((await api("POST", `/users/${b.id}/like`, a.token)).body).toEqual({ likes: 1, likedByMe: true });
    expect(await got).toMatchObject({ senderId: a.id, recipientId: b.id, body: "❤️ liked your profile", senderName: a.handle });
    expect((await api("GET", "/dm/unread", b.token)).body.count).toBe(1);

    // Unlike and like again: no second message the same day.
    await api("DELETE", `/users/${b.id}/like`, a.token);
    await api("POST", `/users/${b.id}/like`, a.token);
    await api("POST", `/users/${b.id}/like`, c.token);
    const likedMsgs = (await api("GET", `/dm/${a.id}`, b.token)).body.messages.filter((m: any) => m.body === "❤️ liked your profile");
    expect(likedMsgs).toHaveLength(1);

    const likes = (await api("GET", "/me/likes", b.token)).body.people;
    expect(likes.map((p: any) => p.userId)).toEqual([c.id, a.id]); // newest first
    expect(likes[0].at).toEqual(expect.any(String));

    // Blocked: the like still counts, but no message.
    const d = await signup("lkd");
    await api("POST", `/users/${d.id}/block`, b.token);
    await api("POST", `/users/${b.id}/like`, d.token);
    expect((await api("GET", `/dm/${d.id}`, b.token)).body.messages).toEqual([]);
  });
});

describe("chat mentions", () => {
  test("messages carry the mentioned people's names, so mentions still work after they leave", async () => {
    const { host, roomId } = await liveRoom();
    const guest = await joined(roomId, "mentioned");
    const sh = socketFor(host.token);
    await emit(sh, "room:join", { roomId });
    const sent = await emit(sh, "room:chat:send", { roomId, body: `hi @${guest.handle}`, mentions: [{ userId: guest.id }], clientMessageId: "mn1" });
    expect(sent.data).toMatchObject({ mentions: [guest.id], mentionNames: { [guest.id]: guest.handle } });

    await api("POST", `/rooms/${roomId}/leave`, guest.token); // gone from the room
    const msg = (await api("GET", `/rooms/${roomId}/messages`, host.token)).body.messages.find((m: any) => m.clientMessageId === "mn1");
    expect(msg).toMatchObject({ mentions: [guest.id], mentionNames: { [guest.id]: guest.handle } });

    // Tagging someone who isn't in the room (left / offline) still makes a tappable mention; the @name must be in the text.
    const again = await emit(sh, "room:chat:send", { roomId, body: `miss you @${guest.handle}`, mentions: [{ userId: guest.id }], clientMessageId: "mn2" });
    expect(again.data).toMatchObject({ mentions: [guest.id], mentionNames: { [guest.id]: guest.handle } });
    const noName = await emit(sh, "room:chat:send", { roomId, body: "no tag here", mentions: [{ userId: guest.id }], clientMessageId: "mn3" });
    expect(noName.data.mentions).toEqual([]);
  });
});

describe("room background photo and owner info", () => {
  test("owner sets a photo backdrop (others can't); a preset replaces it; the room shows its owner", async () => {
    const { host, roomId } = await liveRoom();
    const guest = await joined(roomId, "bgguest");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);
    const upload = async (token: string) => {
      const form = new FormData();
      form.append("file", new File([png], "bg.png", { type: "image/png" }));
      const res = await fetch(`${base}/v1/rooms/${roomId}/background`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
      return { status: res.status, body: (await res.json()) as any };
    };

    expect((await upload(guest.token)).body.error.code).toBe("NOT_ROOM_ADMIN");
    const set = await upload(host.token);
    expect(set.status).toBe(200);
    const url = set.body.backgroundUrl;
    expect(url).toMatch(/^\/v1\/uploads\/.+\.png$/);
    expect((await api("GET", `/rooms/${roomId}`, guest.token)).body.backgroundUrl).toBe(url);

    const preset = await api("PATCH", `/rooms/${roomId}/settings`, host.token, { background: "ocean" });
    expect(preset.body).toMatchObject({ background: "ocean", backgroundUrl: null });

    const snap = (await api("GET", `/rooms/${roomId}`, guest.token)).body;
    expect(snap.owner).toMatchObject({ userId: host.id, displayName: host.handle, publicId: expect.any(Number) });
    expect(snap.createdAt).toEqual(expect.any(String));
  });
});

describe("inbox lives on phones", () => {
  test("the server holds a message only until the recipient's phone acks it; reports keep the reported messages", async () => {
    const [a, b] = [await signup("pha"), await signup("phb")];
    await api("POST", `/users/${b.id}/follow`, a.token);
    await api("POST", `/users/${a.id}/follow`, b.token);
    const sb = socketFor(b.token);
    await new Promise<void>((r) => sb.once("connect", () => r()));
    const live = nextEvent(sb, "dm:new");
    const sent = (await api("POST", `/dm/${b.id}`, a.token, { body: "hello phone", clientMessageId: "ph1" })).body;
    expect(await live).toMatchObject({ id: sent.id, body: "hello phone", sender: { userId: a.id, displayName: a.handle } });

    // The sender's phone can fill in its own side while the recipient hasn't picked it up yet.
    expect((await api("GET", "/dm/sent", a.token)).body.messages).toEqual([expect.objectContaining({ id: sent.id, recipient: expect.objectContaining({ userId: b.id }) })]);

    // Missed it live? It waits for b's phone, with who sent it.
    const pending = (await api("GET", "/dm/pending", b.token)).body.messages;
    expect(pending).toEqual([expect.objectContaining({ id: sent.id, sender: expect.objectContaining({ userId: a.id }) })]);
    // Only the recipient can ack; then it's gone from the server.
    expect((await api("POST", "/dm/ack", a.token, { ids: [sent.id] })).body.deleted).toBe(0);
    expect((await api("POST", "/dm/ack", b.token, { ids: [sent.id] })).body.deleted).toBe(1);
    expect((await api("GET", "/dm/pending", b.token)).body.messages).toEqual([]);
    expect((await db.execute(sql`select count(*)::int as n from direct_messages where id = ${sent.id}`)).rows[0]).toEqual({ n: 0 });

    // Reporting from the chat: the reported messages (from the phone) are the only copy kept.
    const r = await api("POST", "/reports", b.token, {
      targetType: "USER",
      targetId: a.id,
      reason: "harassment",
      evidence: [{ senderId: a.id, body: "hello phone", createdAt: new Date().toISOString() }],
    });
    expect(r.status).toBe(201);
    const [row] = (await db.execute(sql`select evidence from reports where id = ${r.body.reportId}`)).rows as any[];
    expect(row.evidence).toEqual([expect.objectContaining({ body: "hello phone" })]);
  });
});

describe("online and last seen", () => {
  test("online while the app is connected; last seen is stamped when it goes away", async () => {
    const [a, b] = [await signup("sea"), await signup("seb")];
    const presence = async () => (await api("POST", "/users/presence", a.token, { ids: [b.id] })).body.presence[0];
    expect(await presence()).toMatchObject({ userId: b.id, online: false, lastSeenAt: null });

    const sb = socketFor(b.token);
    await new Promise<void>((r) => sb.once("connect", () => r()));
    await new Promise((r) => setTimeout(r, 100));
    expect((await presence()).online).toBe(true);
    expect((await api("GET", `/users/${b.id}`, a.token)).body).toMatchObject({ online: true, lastSeenAt: expect.any(String) });

    const before = Date.now();
    sb.close();
    await new Promise((r) => setTimeout(r, 200));
    const after = await presence();
    expect(after.online).toBe(false);
    expect(new Date(after.lastSeenAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("shareable room links", () => {
  test("/r/<room> has a preview card and opens the app; unknown rooms and the install page", async () => {
    const { roomId } = await liveRoom();
    const res = await fetch(`${base}/r/${roomId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Evening Chai">');
    expect(html).toContain(`intent://room/${roomId}#Intent;scheme=voyalive;package=com.partylive`);
    expect(html).toContain(encodeURIComponent(`${base}/download`)); // no Play Store link set: our install page

    expect((await fetch(`${base}/r/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await fetch(`${base}/r/not-a-room`)).status).toBe(404);
    expect((await fetch(`${base}/download`)).status).toBe(200);
  });
});

describe("bans", () => {
  test("staff ban for a time or for good, with a reason; the person is shut out and sees until when; it lifts itself", async () => {
    const [mod, bad, other] = [await signup("banmod"), await signup("banbad"), await signup("banother")];
    await db.execute(sql`update users set staff_role = 'ADMIN' where id = ${mod.id}`);

    expect((await api("POST", `/admin/users/${bad.id}/ban`, other.token, { duration: "24h", reason: "spam" })).status).toBe(403); // not staff
    expect((await api("POST", `/admin/users/${mod.id}/ban`, mod.token, { duration: "24h", reason: "self" })).body.error.code).toBe("CANNOT_BAN_SELF");

    const before = Date.now();
    const banned = await api("POST", `/admin/users/${bad.id}/ban`, mod.token, { duration: "24h", reason: "Spamming in rooms" });
    expect(banned.body).toMatchObject({ status: "BANNED", banReason: "Spamming in rooms" });
    const until = new Date(banned.body.bannedUntil).getTime();
    expect(until - before).toBeGreaterThan(23.9 * 3600_000);

    // Shut out at once: every request says why and until when (an open app is also told live, then disconnected).
    const shut = await api("GET", "/me", bad.token);
    expect(shut.status).toBe(403);
    expect(shut.body.error).toMatchObject({ code: "ACCOUNT_BANNED", data: { reason: "Spamming in rooms", until: banned.body.bannedUntil } });
    const phone = (await db.execute(sql`select phone from users where id = ${bad.id}`)).rows[0] as { phone: string };
    const { body: otp } = await api("POST", "/auth/otp/request", undefined, { phone: phone.phone });
    const login = await api("POST", "/auth/otp/verify", undefined, { phone: phone.phone, code: otp.devCode });
    expect(login.status).toBe(403);
    expect(login.body.error).toMatchObject({ code: "ACCOUNT_BANNED", data: { reason: "Spamming in rooms", until: banned.body.bannedUntil } });

    // Admins see it when looking them up.
    const found = (await api("GET", `/admin/users?q=${bad.handle}`, mod.token)).body.users[0];
    expect(found).toMatchObject({ status: "BANNED", banReason: "Spamming in rooms" });

    // Time's up: the ban lifts by itself on their next sign-in.
    await db.execute(sql`update users set banned_until = now() - interval '1 minute' where id = ${bad.id}`);
    const { body: otp2 } = await api("POST", "/auth/otp/request", undefined, { phone: phone.phone });
    const back = await api("POST", "/auth/otp/verify", undefined, { phone: phone.phone, code: otp2.devCode });
    expect(back.status).toBe(200);
    expect((await api("GET", `/admin/users?q=${bad.handle}`, mod.token)).body.users[0]).toMatchObject({ status: "ACTIVE", bannedUntil: null });

    // Lifetime: no end date. An open app is told live (then disconnected). Unban lets them straight back in.
    const so = socketFor(other.token);
    await new Promise<void>((r) => so.once("connect", () => r()));
    const told = nextEvent(so, "account:banned");
    const life = await api("POST", `/admin/users/${other.id}/ban`, mod.token, { duration: "life", reason: "Harassment" });
    expect(life.body).toMatchObject({ bannedUntil: null });
    expect(await told).toEqual({ until: null, reason: "Harassment" });
    expect((await api("POST", `/admin/users/${other.id}/unban`, mod.token)).body.status).toBe("ACTIVE");

    // Staff can't be banned (remove their role first).
    const mod2 = await signup("banmod2");
    await db.execute(sql`update users set staff_role = 'MODERATOR' where id = ${mod2.id}`);
    expect((await api("POST", `/admin/users/${mod2.id}/ban`, mod.token, { duration: "7d", reason: "testing" })).body.error.code).toBe("CANNOT_BAN_STAFF");
  });
});
