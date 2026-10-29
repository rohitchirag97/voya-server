import { sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { agencyHosts, hostMonths, micSessions, roomParticipants, rooms, roomSeats } from "../db/schema";
import { MIC, standing } from "../lib/salaryLevels";

// ---------- mic time ----------

// Every minute: each agency host on a seat in a live room (and connected) extends their session in that room, or starts
// a new one. A gap of more than ~1.5 minutes starts a new session. Muted time counts. Sessions remember the agency.
export async function sampleMicTime() {
  const { rows } = await db.execute(sql`
    with seated as (
      select distinct s.occupant_user_id as user_id, s.room_id, h.agency_id
      from ${roomSeats} s
      join ${rooms} r on r.id = s.room_id and r.status = 'LIVE'
      join ${roomParticipants} p on p.room_id = s.room_id and p.user_id = s.occupant_user_id and p.left_at is null and p.presence = 'CONNECTED'
      join ${agencyHosts} h on h.user_id = s.occupant_user_id and h.status in ('ACTIVE', 'LEAVING')
    ), extended as (
      update ${micSessions} m set last_at = now() from seated
      where m.user_id = seated.user_id and m.room_id = seated.room_id and m.agency_id = seated.agency_id and m.last_at > now() - interval '90 seconds'
      returning m.user_id, m.room_id
    )
    insert into ${micSessions} (user_id, room_id, agency_id, started_at, last_at)
    select user_id, room_id, agency_id, now(), now() from seated
    where not exists (select 1 from extended e where e.user_id = seated.user_id and e.room_id = seated.room_id)
    returning id`);
  return rows.length;
}

export function runMicLoop(ms = 60_000) {
  return setInterval(() => sampleMicTime().catch((e) => console.error(JSON.stringify({ level: "error", msg: "mic-sample-failed", err: String(e) }))), ms);
}

// ---------- a month's figures ----------

const IST = sql.raw(`'Asia/Kolkata'`);
// First day of the current India month, as a date ('2026-10-01').
export const currentMonth = sql<string>`date_trunc('month', now() at time zone ${IST})::date`;

// Counted mic minutes per (host, agency) in the India month starting `month` (a date): sessions of 10+ minutes, split
// at India midnight, each day capped at 2 hours.
async function micMinutes(month: SQL, scope: SQL) {
  const { rows } = await db.execute<{ user_id: string; agency_id: string; minutes: number }>(sql`
    with b as (select (${month})::timestamp at time zone ${IST} as s, ((${month})::timestamp + interval '1 month') at time zone ${IST} as e),
    pieces as (
      select m.user_id, m.agency_id, d.day,
        extract(epoch from least(m.last_at, (d.day + interval '1 day') at time zone ${IST}, b.e)
                         - greatest(m.started_at, d.day at time zone ${IST}, b.s)) / 60 as minutes
      from ${micSessions} m cross join b
      cross join lateral generate_series((m.started_at at time zone ${IST})::date, (m.last_at at time zone ${IST})::date, interval '1 day') as d(day)
      where m.last_at > b.s and m.started_at < b.e and m.agency_id is not null
        and m.last_at - m.started_at >= ${`${MIC.minSessionMinutes} minutes`}::interval and ${scope}
    ), days as (
      select user_id, agency_id, least(sum(greatest(minutes, 0)), ${MIC.maxMinutesPerDay}) as minutes from pieces group by user_id, agency_id, day
    )
    select user_id, agency_id, floor(sum(minutes))::int as minutes from days group by user_id, agency_id`);
  return new Map(rows.map((r) => [`${r.user_id}|${r.agency_id}`, Number(r.minutes)]));
}

// Every salary pool of a month (in `scope`), with its mic time and the level it reaches.
export async function poolsOf(month: SQL, scope: { pool: SQL; mic: SQL }) {
  const [pools, mic] = await Promise.all([
    db.execute<{ user_id: string; agency_id: string; earned: number; converted: number; settled: boolean }>(
      sql`select user_id, agency_id, earned, converted, settled_at is not null as settled from ${hostMonths} where month = ${month} and ${scope.pool}`,
    ),
    micMinutes(month, scope.mic),
  ]);
  const keys = new Set([...pools.rows.map((p) => `${p.user_id}|${p.agency_id}`), ...mic.keys()]);
  const byKey = new Map(pools.rows.map((p) => [`${p.user_id}|${p.agency_id}`, p]));
  return [...keys].map((k) => {
    const [userId, agencyId] = k.split("|") as [string, string];
    const p = byKey.get(k);
    const diamonds = Number(p?.earned ?? 0);
    const micM = mic.get(k) ?? 0;
    return { userId, agencyId, diamonds, converted: Number(p?.converted ?? 0), settled: !!p?.settled, micMinutes: micM, ...standing(diamonds, micM) };
  });
}

// This month so far, for the dashboard.
export async function monthForAgency(agencyId: string) {
  const rows = await poolsOf(currentMonth, { pool: sql`agency_id = ${agencyId}`, mic: sql`m.agency_id = ${agencyId}` });
  return new Map(rows.map((r) => [r.userId, r]));
}
export async function monthForHost(userId: string, agencyId: string) {
  const [row] = await poolsOf(currentMonth, { pool: sql`user_id = ${userId} and agency_id = ${agencyId}`, mic: sql`m.user_id = ${userId} and m.agency_id = ${agencyId}` });
  return row ?? { userId, agencyId, diamonds: 0, converted: 0, settled: false, micMinutes: 0, ...standing(0, 0) };
}
