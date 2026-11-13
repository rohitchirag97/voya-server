# Deploy

Every deploy uses these exact commands. Update this file when something about the setup changes.

## Where things are

| What | Where |
|------|-------|
| Server code (git repo) on the PC | `/run/media/chirag/Data/gitHub/2026/new Projects/voya/server` |
| Server code on the VPS | `/opt/voya-server` (logged in as `root`) |
| Secrets on the VPS | `/opt/voya-server/.env.production` (never commit it) |
| Public API | `https://voyalive.tech` (host Caddy → `127.0.0.1:3000`) |
| App (React Native, Android) | `/run/media/chirag/Data/gitHub/2026/new Projects/voya/app` |
| Website + admin panel (Next.js) on the PC | `/run/media/chirag/Data/gitHub/2026/new Projects/voya/client` (repo `voya-website`) |
| Website + admin panel code on the VPS | `/opt/voya-website` (git checkout, only `git pull` here) |
| Website + admin panel container on the VPS | `/opt/voya-web/compose.yml` (builds from `/opt/voya-website`, listens on `127.0.0.1:3001` behind Caddy, `API_URL=http://127.0.0.1:3000`) |

Short alias used below:

```sh
DC="docker compose -f docker-compose.prod.yml --env-file .env.production"
```

## 1. Push the server (on the PC)

```sh
cd "/run/media/chirag/Data/gitHub/2026/new Projects/voya/server"
git status --short          # check every file listed is meant to ship
git add <files>
git commit -m "<what changed>"
git push
```

## 2. Deploy the server (on the VPS)

```sh
cd /opt/voya-server
DC="docker compose -f docker-compose.prod.yml --env-file .env.production"

# Backup first when the deploy has a new file in drizzle/ (a migration). Safe to always run.
mkdir -p /root/backups
$DC exec -T postgres pg_dump -U voya voya > /root/backups/voya-$(date +%F-%H%M).sql
ls -lh /root/backups | tail -3     # newest file must be well over 0 bytes

git pull
$DC up -d --build                  # migrations run automatically on start
```

## 3. Check it worked (on the VPS)

```sh
curl -s http://127.0.0.1:3000/health                  # {"ok":true}
$DC logs --tail=50 api | grep -E 'migrated|"level":"error"'
```

`migrated + seeded` means migrations ran. Any `"level":"error"` line is a problem: send it over.

## Find the cause of an error (on the VPS)

The app only shows "Internal error"; the real error is in the log:

```sh
cd /opt/voya-server
DC="docker compose -f docker-compose.prod.yml --env-file .env.production"
$DC logs --since 30m api | grep '"level":"error"' | tail -20
```

Look at a table:

```sh
$DC exec -T postgres psql -U voya voya -c '\d <table_name>'
```

## Roll back (on the VPS)

```sh
cd /opt/voya-server
DC="docker compose -f docker-compose.prod.yml --env-file .env.production"
git log --oneline -5               # pick the last good commit
git checkout <commit>
$DC up -d --build
```

Go back to normal afterwards with `git checkout main`. A new table from a migration can stay in place, because older code ignores it.
To restore the database from a backup (wipes current data):

```sh
$DC exec -T postgres psql -U voya -d postgres -c 'drop database voya with (force)' -c 'create database voya owner voya'
$DC exec -T postgres psql -U voya voya < /root/backups/<file>.sql
$DC restart api
```

## Website and admin panel

Deploy the server first when a panel page needs new API endpoints.

On the PC:

```sh
cd "/run/media/chirag/Data/gitHub/2026/new Projects/voya/client"
git status --short
git add <files>
git commit -m "<what changed>"
git push
```

On the VPS:

```sh
cd /opt/voya-website && git pull
git log --oneline -1                     # must show the commit just pushed
cd /opt/voya-web && docker compose up -d --build
docker compose logs --tail=30 web        # should end with Next's "Ready"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/login   # 200
```

## 4. Build and install the app (on the PC, phone on USB)

Release builds talk to `https://voyalive.tech`. Deploy the server first when the app needs new endpoints.

```sh
cd "/run/media/chirag/Data/gitHub/2026/new Projects/voya/app/android"
./gradlew assembleRelease
adb devices                                       # the phone must show as "device"
adb install -r app/build/outputs/apk/release/app-release.apk
```

APK file: `app/android/app/build/outputs/apk/release/app-release.apk`. It's signed with the debug key, which is fine for testing; the Play Store needs a real release key.

## Rules

- Run git commands for the server on the **PC**, never on the VPS (the VPS only runs `git pull`).
- Keep backups in `/root/backups`, outside the repo folder, so they can't be committed.
- Never `git add .` on the VPS.
- Coins can't be changed by hand with SQL any more (since migration 0083): a balance change without a ledger row, or an
  edit/delete of a ledger row, is refused. Give coins with the panel's **Give to user**. If a correction is ever needed in
  SQL, do both in one transaction:
  ```sql
  begin;
  insert into wallet_ledger (user_id, entry_type, amount, reference_type, reference_id) values ('<user uuid>', 'MANUAL_CORRECTION', <+/- coins>, 'STAFF', '<ticket or reason>');
  update wallet_accounts set balance = balance + <same +/- coins> where user_id = '<user uuid>';
  commit;
  ```
