import { and, eq, inArray, isNull, sql, type AnyColumn } from "drizzle-orm";
import { db } from "../db";
import { giftTransactions, roomParticipants, rooms, taskClaims, users, type User } from "../db/schema";
import { io, userChannel } from "../io";
import { AppError } from "../lib/errors";
import { levelInfo, levelOf } from "../lib/levels";
import { MAX_MINUTES_PER_VISIT } from "../lib/roomLevels";
import { TASKS, type Task, type TaskPeriod } from "../lib/tasks";
import { getMyRoom, roomLevelOf } from "./rooms";

const IST = sql.raw(`'Asia/Kolkata'`);
const p = roomParticipants;
const g = giftTransactions;
const claimKey = (subjectId: string, taskId: string, period: string) => `${subjectId}:${taskId}:${period}`;

// The current India-time day and week (its Monday), as YYYY-MM-DD: each task period's key.
async function periodKeys(): Promise<Record<TaskPeriod, string>> {
  const { rows: [r] } = await db.execute<{ day: string; week: string }>(sql`select
    (now() at time zone ${IST})::date::text as day, date_trunc('week', now() at time zone ${IST})::date::text as week`);
  return { DAY: r!.day, WEEK: r!.week };
}

// This period's progress for each subject (users for USER tasks, rooms for ROOM tasks); missing = 0. Minutes of visits
// since the period began (each visit capped like room levels; a room's owner doesn't count in it), or gift coins.
async function progressOf(t: Task, ids: string[], period: string) {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const start = sql`(${period}::date::timestamp at time zone ${IST})`;
  const minutes = (key: AnyColumn, extra = sql``) => sql`select ${key}::text as k, floor(sum(least(
      extract(epoch from coalesce(${p.leftAt}, now()) - greatest(${p.joinedAt}, ${start})) / 60, ${MAX_MINUTES_PER_VISIT})))::int as v
    from ${p} where ${inArray(key, ids)}${extra} and coalesce(${p.leftAt}, now()) > ${start} group by 1`;
  const gifts = (key: AnyColumn) => sql`select ${key}::text as k, sum(${g.coinsDebited})::int as v from ${g} where ${inArray(key, ids)} and ${g.createdAt} >= ${start} group by 1`;
  const q = {
    MINUTES_IN_ROOMS: minutes(p.userId),
    LISTENER_MINUTES: minutes(p.roomId, sql` and ${p.userId} <> (select ${rooms.hostUserId} from ${rooms} where ${rooms.id} = ${p.roomId})`),
    GIFTS_SENT: gifts(g.senderId),
    ROOM_GIFTS: gifts(g.roomId),
  }[t.metric];
  for (const r of (await db.execute<{ k: string; v: number }>(q)).rows) out.set(r.k, Number(r.v));
  return out;
}
const progress = async (t: Task, subjectId: string, period: string) => (await progressOf(t, [subjectId], period)).get(subjectId) ?? 0;

async function claimedSet(subjects: string[], periods: string[]) {
  if (!subjects.length) return new Set<string>();
  const rows = await db.select().from(taskClaims).where(and(inArray(taskClaims.subjectId, subjects), inArray(taskClaims.period, periods)));
  return new Set(rows.map((c) => claimKey(c.subjectId, c.taskId, c.period)));
}

// My tasks and, if I own a room, my room's: progress this period and whether the reward was claimed.
export async function myTasks(user: User) {
  const [keys, room] = await Promise.all([periodKeys(), getMyRoom(user)]);
  const claimed = await claimedSet(room ? [user.id, room.roomId] : [user.id], [keys.DAY, keys.WEEK]);
  const view = async (t: Task, subjectId: string) => {
    const period = keys[t.period];
    return { ...t, progress: Math.min(t.target, await progress(t, subjectId, period)), claimed: claimed.has(claimKey(subjectId, t.id, period)) };
  };
  return {
    user: await Promise.all(TASKS.filter((t) => t.scope === "USER").map((t) => view(t, user.id))),
    room: room ? { roomId: room.roomId, title: room.title, tasks: await Promise.all(TASKS.filter((t) => t.scope === "ROOM").map((t) => view(t, room.roomId))) } : null,
  };
}

// Claim a finished task once per period: XP for the user, or level points for their room.
export async function claimTask(user: User, taskId: string) {
  const t = TASKS.find((x) => x.id === taskId);
  if (!t) throw new AppError("TASK_NOT_FOUND", 404, "No such task");
  const room = t.scope === "ROOM" ? await getMyRoom(user) : null;
  if (t.scope === "ROOM" && !room) throw new AppError("NO_ROOM", 400, "Create a room to do room tasks");
  const subjectId = room?.roomId ?? user.id;
  const period = (await periodKeys())[t.period];
  if ((await progress(t, subjectId, period)) < t.target) throw new AppError("TASK_NOT_DONE", 400, "This task isn't finished yet");

  return db.transaction(async (tx) => {
    const [claim] = await tx.insert(taskClaims).values({ taskId: t.id, subjectId, period, points: t.reward, claimedBy: user.id }).onConflictDoNothing().returning();
    if (!claim) throw new AppError("TASK_CLAIMED", 409, "Already claimed");
    if (room) return { reward: t.reward, roomLevel: await roomLevelOf({ id: room.roomId, hostUserId: user.id }, tx) };
    const [u] = await tx.update(users).set({ xp: sql`${users.xp} + ${t.reward}` }).where(eq(users.id, user.id)).returning({ xp: users.xp });
    const level = levelInfo(u!.xp);
    return { reward: t.reward, level, leveledUp: level.level > levelOf(u!.xp - t.reward) };
  });
}

// Done-but-unclaimed tasks already announced (claimKey).
// shortcut: kept in memory, one server only; after a restart each still-unclaimed done task is announced once more.
const announced = new Set<string>();

// Tell each person (only them) when one of their tasks, or their room's, has just been finished: `task:done` on their
// own channel. Only people in a room right now (and rooms with people in them) can have just finished one.
export async function announceDoneTasks() {
  const keys = await periodKeys();
  const periods = [keys.DAY, keys.WEEK];
  for (const k of announced) if (!periods.includes(k.split(":")[2]!)) announced.delete(k);
  const here = await db
    .selectDistinct({ userId: p.userId, roomId: p.roomId, ownerId: rooms.hostUserId, kind: rooms.kind, status: rooms.status })
    .from(p)
    .innerJoin(rooms, eq(rooms.id, p.roomId))
    .where(isNull(p.leftAt));
  const people = [...new Set(here.map((h) => h.userId))];
  const owners = new Map(here.filter((h) => h.kind === "AUDIO" && h.status === "LIVE").map((h) => [h.roomId, h.ownerId])); // as getMyRoom
  const claimed = await claimedSet([...people, ...owners.keys()], periods);
  for (const t of TASKS) {
    const period = keys[t.period];
    const ids = (t.scope === "USER" ? people : [...owners.keys()]).filter((id) => !announced.has(claimKey(id, t.id, period)) && !claimed.has(claimKey(id, t.id, period)));
    for (const [id, v] of await progressOf(t, ids, period)) {
      if (v < t.target) continue;
      announced.add(claimKey(id, t.id, period));
      io.to(userChannel(t.scope === "USER" ? id : owners.get(id)!)).emit("task:done", { taskId: t.id, title: t.title, scope: t.scope, reward: t.reward });
    }
  }
}

export const runTaskAnnouncer = (ms = 60_000) =>
  setInterval(() => announceDoneTasks().catch((e) => console.error(JSON.stringify({ level: "error", msg: "task-announce-failed", err: String(e) }))), ms);
