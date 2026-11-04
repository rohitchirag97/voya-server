import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { taskClaims, users, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { levelInfo, levelOf } from "../lib/levels";
import { MAX_MINUTES_PER_VISIT } from "../lib/roomLevels";
import { TASKS, type Task, type TaskPeriod } from "../lib/tasks";
import { getMyRoom, roomLevelOf } from "./rooms";

const IST = sql.raw(`'Asia/Kolkata'`);

// The current India-time day and week (its Monday), as YYYY-MM-DD: each task period's key.
async function periodKeys(): Promise<Record<TaskPeriod, string>> {
  const { rows: [r] } = await db.execute<{ day: string; week: string }>(sql`select
    (now() at time zone ${IST})::date::text as day, date_trunc('week', now() at time zone ${IST})::date::text as week`);
  return { DAY: r!.day, WEEK: r!.week };
}

// Minutes of visits since `start` (each visit capped like room levels), or gift coins since `start`.
async function progress(t: Task, subjectId: string, hostId: string, period: string) {
  const start = sql`(${period}::date::timestamp at time zone ${IST})`;
  const minutes = (who: ReturnType<typeof sql>) => sql`select coalesce(floor(sum(least(
      extract(epoch from coalesce(left_at, now()) - greatest(joined_at, ${start})) / 60, ${MAX_MINUTES_PER_VISIT}))), 0)::int as v
    from room_participants where ${who} and coalesce(left_at, now()) > ${start}`;
  const gifts = (who: ReturnType<typeof sql>) => sql`select coalesce(sum(coins_debited), 0)::int as v from gift_transactions where ${who} and created_at >= ${start}`;
  const q = {
    MINUTES_IN_ROOMS: minutes(sql`user_id = ${subjectId}`),
    LISTENER_MINUTES: minutes(sql`room_id = ${subjectId} and user_id <> ${hostId}`),
    GIFTS_SENT: gifts(sql`sender_id = ${subjectId}`),
    ROOM_GIFTS: gifts(sql`room_id = ${subjectId}`),
  }[t.metric];
  const { rows: [r] } = await db.execute<{ v: number }>(q);
  return Number(r!.v);
}

// My tasks and, if I own a room, my room's: progress this period and whether the reward was claimed.
export async function myTasks(user: User) {
  const [keys, room] = await Promise.all([periodKeys(), getMyRoom(user)]);
  const subjects = room ? [user.id, room.roomId] : [user.id];
  const claimed = new Set(
    (await db.select().from(taskClaims).where(and(inArray(taskClaims.subjectId, subjects), inArray(taskClaims.period, [keys.DAY, keys.WEEK])))).map(
      (c) => `${c.subjectId}:${c.taskId}:${c.period}`,
    ),
  );
  const view = async (t: Task, subjectId: string) => {
    const period = keys[t.period];
    return { ...t, progress: Math.min(t.target, await progress(t, subjectId, user.id, period)), claimed: claimed.has(`${subjectId}:${t.id}:${period}`) };
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
  if ((await progress(t, subjectId, user.id, period)) < t.target) throw new AppError("TASK_NOT_DONE", 400, "This task isn't finished yet");

  return db.transaction(async (tx) => {
    const [claim] = await tx.insert(taskClaims).values({ taskId: t.id, subjectId, period, points: t.reward, claimedBy: user.id }).onConflictDoNothing().returning();
    if (!claim) throw new AppError("TASK_CLAIMED", 409, "Already claimed");
    if (room) return { reward: t.reward, roomLevel: await roomLevelOf({ id: room.roomId, hostUserId: user.id }, tx) };
    const [u] = await tx.update(users).set({ xp: sql`${users.xp} + ${t.reward}` }).where(eq(users.id, user.id)).returning({ xp: users.xp });
    const level = levelInfo(u!.xp);
    return { reward: t.reward, level, leveledUp: level.level > levelOf(u!.xp - t.reward) };
  });
}
