# VoyaLive server (P0 audio rooms)

Bun + Hono + Drizzle (Postgres) + Socket.IO (`@socket.io/bun-engine`).

```sh
docker compose up -d      # Postgres on :5433 (creates voya + voya_test)
cp .env.example .env      # set real ZEGO_APP_ID / ZEGO_SERVER_SECRET / JWT_SECRET
bun install
bun run db:migrate        # applies drizzle/ migrations + seeds gift catalog
bun run dev
bun test                  # integration tests against voya_test
```

Schema change: edit `src/db/schema.ts`, then `bun run db:generate`.

## Client flow

1. `POST /v1/auth/otp/request {phone}` → `POST /v1/auth/otp/verify {phone, code}` → access + refresh tokens. Outside production the code is returned as `devCode`.
2. `PATCH /v1/me/profile {displayName}`. Rooms, chat and gifts need a display name.
3. Host: `POST /v1/rooms {title, seatCount}` → ZEGO login + publish with the returned `zego` creds → `POST /v1/rooms/:id/live`.
   Listener: `POST /v1/rooms/:id/join` → ZEGO login (play only).
4. Socket.IO with `auth: { token }`, then `room:join {roomId}` (ack = full snapshot).
5. Seat: `room:seat:claim {roomId, seatIndex}`. **Start publishing only after the ack is ok.** The ack has a fresh ZEGO token with publish rights (`renewToken`) and the `streamId` to publish.
6. Gifts: `POST /v1/rooms/:id/gifts` with an `Idempotency-Key` header, or `room:gift:send {..., idempotencyKey}`.

7. Greedy games: two skins over the same odds, each with its own rounds, history and leaderboard: `jungle` (animals) and `galaxy` (planets). The app opens `/games/greedy/?game=jungle|galaxy` in a WebView, and every `greedy:join` / `greedy:today` / `greedy:history` carries `{game}` (default `jungle`). The page asks the app for a token (`postMessage {type:'token'}`, answered with `window.voyaToken(token)`), then emits `greedy:join` (ack = state) and `greedy:bet {roundId, item, amount}`. Server events: `greedy:round`, `greedy:result` (`item` is the outcome: an animal 0–7, or 8 = Meadow / 9 = Kingdom; `wins` lists the animals that paid), `greedy:win` (to the winner only). `greedy:today` acks today's leaderboard. To test in a desktop browser: `/games/greedy/#token=<accessToken>`. `GREEDY_BET_MS` shortens rounds for local testing.

8. Rocket (crash) game: `/games/rocket/`. Events: `rocket:join` (ack = state), `rocket:bet {roundId, slot: 0|1, amount, auto100?}` (two bet panels; repeat bets on a panel add up; multipliers in hundredths, 200 = 2.00x; the rocket never passes 50x, so auto targets stop at 4999), `rocket:cashout {roundId, slot}`, `rocket:today`, `rocket:history {before?}`. Server events: `rocket:round` (with the crash point's sha256 `hash`), `rocket:launch`, `rocket:bet`, `rocket:cashout`, `rocket:crash` (reveals `crash100` + `salt`; sha256("salt:crash100") = hash), `rocket:win` (auto cash-outs, to the winner). Multiplier = e^(0.07·s). `ROCKET_BET_MS` shortens the countdown for local testing.

Socket mutations ack `{ok:true,data}` / `{ok:false,error:{code,message}}`. Server events: `room:state`, `room:seat:state`, `room:participant:joined|left`, `room:chat:new`, `room:system`, `room:gift:received`, `room:typing`, `room:removed`, `room:ended`, `room:error`. Every state event carries `roomVersion`. If it skips a number, refetch `GET /v1/rooms/:id`.

## Deploy (VPS)

Ubuntu 24.04 with Docker CE and Caddy on the host. Point a DNS A record at the VPS (ports 80/443 open).

```sh
cp .env.production.example .env.production   # fill in real secrets
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
sudo cp Caddyfile /etc/caddy/Caddyfile        # edit the domain first
sudo systemctl reload caddy                   # Caddy gets the TLS cert
```

Migrations run on every container start. Update: pull the code, then run the same compose command again. Postgres data and uploads live in Docker volumes (`pgdata`, `uploads`), so back those up.
