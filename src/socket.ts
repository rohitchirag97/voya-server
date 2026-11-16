import type { Socket } from "socket.io";
import { config } from "./config";
import type { User } from "./db/schema";
import { schemas } from "./http";
import { io, isOnline, roomChannel, userChannel } from "./io";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "./db/schema";
import { toSafeError } from "./lib/errors";
import { authenticate, loadUser } from "./services/auth";
import * as chat from "./services/chat";
import * as gifts from "./services/gifts";
import * as greedy from "./services/greedy";
import * as ludo from "./services/ludo";
import * as pool from "./services/pool";
import * as draw from "./services/draw";
import * as mafia from "./services/mafia";
import * as karaoke from "./services/karaoke";
import * as rocket from "./services/rocket";
import { assertGamesOn } from "./services/flags";
import * as roulette from "./services/roulette";
import * as slots from "./services/slots";
import * as rooms from "./services/rooms";

// shortcut: grace timers live in memory, so a restart forgets them; add a stale-session reconciler job before scaling out.
const graceTimers = new Map<string, Timer>();
const graceKey = (roomId: string, userId: string) => `${roomId}:${userId}`;

// "Last seen": stamped when someone's app connects and when it goes away. Fire-and-forget.
const seen = (userId: string) => void db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId)).catch(toSafeError);

function cancelGrace(roomId: string, userId: string) {
  clearTimeout(graceTimers.get(graceKey(roomId, userId)));
  graceTimers.delete(graceKey(roomId, userId));
}

// Why the connection ended, from socket.io: the app closing its connection (swiped away, killed, or the room screen
// leaving) ends with a clean close, so that person is gone and their seat frees at once; a timeout or transport error
// is usually bad network (tunnel, lift), so they get 30s to come back and keep their seat. Anyone let go who comes
// back (e.g. after switching networks) rejoins and is announced again.
const closedOnPurpose = (reason: string) => reason === "transport close" || reason === "client namespace disconnect" || reason === "server namespace disconnect";

async function onDropped(roomId: string, userId: string, socketId: string, reason: string) {
  const others = (await io.in(roomChannel(roomId)).fetchSockets()).some((s) => s.data.userId === userId && s.id !== socketId);
  if (others) return;
  await rooms.setPresence(roomId, userId, "DISCONNECTED");
  cancelGrace(roomId, userId);
  graceTimers.set(
    graceKey(roomId, userId),
    setTimeout(async () => {
      graceTimers.delete(graceKey(roomId, userId));
      try {
        await rooms.leaveRoom(await loadUser(userId), roomId);
      } catch (e) {
        toSafeError(e);
      }
    }, closedOnPurpose(reason) ? Math.min(config.seatQuickGraceMs, config.seatGraceMs) : config.seatGraceMs),
  );
}

io.use(async (socket, next) => {
  try {
    socket.data.userId = (await authenticate(socket.handshake.auth?.token)).user.id;
    next();
  } catch {
    next(new Error("UNAUTHORIZED"));
  }
});

io.on("connection", (socket: Socket) => {
  const userId: string = socket.data.userId;
  socket.join(userChannel(userId));
  seen(userId);

  // Every mutation acks { ok, data } or { ok:false, error }; without an ack the error goes out as room:error.
  const handle = (event: string, fn: (user: User, payload: any) => Promise<unknown>) =>
    socket.on(event, async (payload, ack) => {
      try {
        const data = await fn(await loadUser(userId), payload ?? {});
        if (typeof ack === "function") ack({ ok: true, data });
      } catch (e) {
        const { code, message } = toSafeError(e);
        if (typeof ack === "function") ack({ ok: false, error: { code, message } });
        else socket.emit("room:error", { event, code, message });
      }
    });

  const id = (p: any) => schemas.uuid.parse(p.roomId);
  const inRoom = (roomId: string) => socket.rooms.has(roomChannel(roomId));

  handle("room:join", async (user, p) => {
    const roomId = id(p);
    await rooms.assertMember(roomId, user.id); // REST /join first; this only attaches the realtime channel
    socket.join(roomChannel(roomId));
    cancelGrace(roomId, user.id);
    // Back after a dropped connection (bad network, switching networks): announce them again.
    if (await rooms.setPresence(roomId, user.id, "CONNECTED")) await rooms.announceEntry(roomId, user);
    return rooms.getSnapshot(roomId);
  });

  handle("room:chat:send", (user, p) => chat.sendChat(user, id(p), schemas.chat.parse(p)));
  handle("room:emote", (user, p) => chat.sendEmote(user, id(p), chat.emoteSchema.parse(p)));
  handle("room:seat:claim", (user, p) => rooms.claimSeat(user, id(p), schemas.seatIndex.parse(p.seatIndex)));
  handle("room:seat:release", (user, p) => rooms.releaseSeat(user, id(p), schemas.seatIndex.parse(p.seatIndex)));
  handle("room:seat:accept", (user, p) => rooms.claimSeat(user, id(p), schemas.seatIndex.parse(p.seatIndex), { invited: true }));
  handle("room:gift:send", (user, p) => gifts.sendGift(user, id(p), schemas.gift.parse(p), p.idempotencyKey));
  handle("room:gift:send-all", (user, p) => gifts.sendGiftToAllSeated(user, id(p), schemas.giftAll.parse(p), p.idempotencyKey));

  // Greedy mini-game: one global round shared by every room.
  // A socket follows one game at a time; the round id in a bet already says which game it is for.
  // The coin games sit behind one admin-panel switch (Feature switches > Games): while it's off nobody can open them or bet. Cash-outs of bets already
  // placed still go through, so turning a game off mid-round never costs anyone their coins.
  handle("greedy:join", async (user, p) => {
    await assertGamesOn();
    const game = greedy.gameSchema.parse(p.game);
    for (const g of Object.keys(greedy.GAMES) as greedy.Game[]) socket.leave(greedy.channel(g));
    socket.join(greedy.channel(game));
    return greedy.getState(user.id, game);
  });
  handle("greedy:bet", async (user, p) => (await assertGamesOn(), greedy.placeBet(user, greedy.betSchema.parse(p))));
  handle("greedy:today", (user, p) => greedy.todayLeaderboard(user.id, greedy.gameSchema.parse(p.game)));
  handle("greedy:history", async (_user, p) => {
    const q = greedy.historySchema.parse(p);
    return greedy.history(q.before, 50, q.game);
  });

  // Ludo (rooms in Ludo mode). Watching needs only room membership; the board page then follows the ludo channel.
  handle("ludo:watch", async (user, p) => {
    const roomId = id(p);
    const state = await ludo.watch(user, roomId);
    socket.join(ludo.channel(roomId));
    return state;
  });
  handle("ludo:join", (user, p) => ludo.join(user, id(p), p.color === undefined ? undefined : ludo.colorSchema.parse(p.color)));
  handle("ludo:leave", (user, p) => ludo.leaveLobby(user, id(p)));
  handle("ludo:remove", (user, p) => ludo.removeFromLobby(user, id(p), schemas.uuid.parse(p.userId)));
  handle("ludo:start", (user, p) => ludo.start(user, id(p)));
  handle("ludo:discover", (user, p) => ludo.discover(user, id(p)));
  handle("ludo:roll", (user, p) => ludo.rollDice(user, id(p)));
  handle("ludo:move", (user, p) => ludo.moveToken(user, id(p), ludo.tokenSchema.parse(p.token)));

  // 8 Ball Pool (rooms in Pool mode), same shape as Ludo. The server simulates every shot; aim is only relayed.
  handle("pool:watch", async (user, p) => {
    const roomId = id(p);
    const state = await pool.watch(user, roomId);
    socket.join(pool.channel(roomId));
    return state;
  });
  handle("pool:join", (user, p) => pool.join(user, id(p)));
  handle("pool:leave", (user, p) => pool.leave(user, id(p)));
  handle("pool:remove", (user, p) => pool.removeFromLobby(user, id(p), schemas.uuid.parse(p.userId)));
  handle("pool:start", (user, p) => pool.start(user, id(p)));
  handle("pool:aim", (user, p) => pool.aim(user, id(p), pool.aimSchema.parse(p)));
  handle("pool:shoot", (user, p) => pool.shoot(user, id(p), pool.shotSchema.parse(p)));

  // Draw & Guess (rooms in Draw mode), same shape again. Guesses are room chat; only the drawer sends strokes.
  handle("draw:watch", async (user, p) => {
    const roomId = id(p);
    const state = await draw.watch(user, roomId);
    socket.join(draw.channel(roomId));
    return state;
  });
  handle("draw:join", (user, p) => draw.join(user, id(p)));
  handle("draw:leave", (user, p) => draw.leave(user, id(p)));
  handle("draw:remove", (user, p) => draw.removeFromLobby(user, id(p), schemas.uuid.parse(p.userId)));
  handle("draw:start", (user, p) => draw.start(user, id(p)));
  handle("draw:word", (user, p) => draw.myWord(user, id(p)));
  handle("draw:stroke", (user, p) => draw.stroke(user, id(p), draw.strokeSchema.parse(p)));
  handle("draw:clear", (user, p) => draw.edit(user, id(p), "clear"));
  handle("draw:undo", (user, p) => draw.edit(user, id(p), "undo"));

  // Mafia (rooms in Mafia mode), same shape again. The channel is public; each page asks for its own secrets.
  handle("mafia:watch", async (user, p) => {
    const roomId = id(p);
    const state = await mafia.watch(user, roomId);
    socket.join(mafia.channel(roomId));
    return state;
  });
  handle("mafia:me", (user, p) => mafia.me(user, id(p)));
  handle("mafia:join", (user, p) => mafia.join(user, id(p)));
  handle("mafia:leave", (user, p) => mafia.leave(user, id(p)));
  handle("mafia:remove", (user, p) => mafia.removeFromLobby(user, id(p), schemas.uuid.parse(p.userId)));
  handle("mafia:start", (user, p) => mafia.start(user, id(p)));
  handle("mafia:act", (user, p) => mafia.act(user, id(p), mafia.targetSchema.parse(p).target));
  handle("mafia:vote", (user, p) => mafia.vote(user, id(p), mafia.targetSchema.parse(p).target));

  // Karaoke (rooms in Karaoke mode): the state goes to the whole room channel, so there's nothing to watch.
  handle("karaoke:queue", (user, p) => karaoke.queueSong(user, id(p), schemas.uuid.parse(p.songId)));
  handle("karaoke:started", (user, p) => karaoke.started(user, id(p), karaoke.entrySchema.parse(p).entryId));
  handle("karaoke:finish", (user, p) => karaoke.finish(user, id(p), karaoke.entrySchema.parse(p).entryId));
  handle("karaoke:remove", (user, p) => karaoke.remove(user, id(p), karaoke.entrySchema.parse(p).entryId));
  handle("karaoke:progress", (user, p) => karaoke.progress(user, id(p), karaoke.progressSchema.parse(p)));

  // Rocket (crash) game: one global round at a time.
  handle("rocket:join", async (user) => {
    await assertGamesOn();
    socket.join(rocket.CHANNEL);
    return rocket.getState(user.id);
  });
  handle("rocket:bet", async (user, p) => (await assertGamesOn(), rocket.placeBet(user, rocket.betSchema.parse(p))));
  handle("rocket:cashout", (user, p) => rocket.cashOut(user, rocket.cashOutSchema.parse(p)));
  handle("rocket:today", (user) => rocket.todayLeaderboard(user.id));
  handle("rocket:history", async (_user, p) => rocket.history(rocket.historySchema.parse(p).before));
  // Slots: every spin is played alone and settled at once.
  handle("slot:join", async (user) => (await assertGamesOn(), slots.getState(user.id)));
  handle("slot:spin", async (user, p) => (await assertGamesOn(), slots.spin(user, slots.spinSchema.parse(p))));
  // Roulette: same, one spin at a time.
  handle("roulette:join", async (user) => (await assertGamesOn(), roulette.getState(user.id)));
  handle("roulette:spin", async (user, p) => (await assertGamesOn(), roulette.spin(user, roulette.spinSchema.parse(p))));

  socket.on("room:typing", (p) => {
    const roomId = typeof p?.roomId === "string" ? p.roomId : "";
    if (inRoom(roomId) && chat.typingAllowed(userId)) socket.to(roomChannel(roomId)).emit("room:typing", { roomId, userId });
  });

  // Their last connection closed: that's when they were last seen.
  socket.on("disconnect", () => {
    if (!isOnline(userId)) seen(userId);
  });

  socket.on("disconnecting", (reason) => {
    for (const ch of socket.rooms) {
      if (ch.startsWith("room:")) onDropped(ch.slice(5), userId, socket.id, reason).catch(toSafeError);
    }
  });
});