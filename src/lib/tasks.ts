// Daily and weekly tasks (India time; weeks start Monday). Claiming a finished one adds its reward to the user's XP
// (USER tasks) or to their room's level points (ROOM tasks), so tasks level people and rooms up alongside recharges,
// gifts and time. Progress is counted live from what the server already records. This file is the only copy of these numbers.

export type TaskScope = "USER" | "ROOM";
export type TaskPeriod = "DAY" | "WEEK";
// USER: my minutes in any room, coins of gifts I sent. ROOM: minutes others spent in my room, gift coins sent in it.
export type TaskMetric = "MINUTES_IN_ROOMS" | "GIFTS_SENT" | "LISTENER_MINUTES" | "ROOM_GIFTS";
export type Task = { id: string; scope: TaskScope; period: TaskPeriod; metric: TaskMetric; target: number; reward: number; title: string };

export const TASKS: Task[] = [
  { id: "user-day-minutes", scope: "USER", period: "DAY", metric: "MINUTES_IN_ROOMS", target: 30, reward: 2000, title: "Spend 30 minutes in rooms" },
  { id: "user-day-gifts", scope: "USER", period: "DAY", metric: "GIFTS_SENT", target: 1000, reward: 2000, title: "Send gifts worth 1,000 coins" },
  { id: "user-week-minutes", scope: "USER", period: "WEEK", metric: "MINUTES_IN_ROOMS", target: 300, reward: 15_000, title: "Spend 5 hours in rooms" },
  { id: "user-week-gifts", scope: "USER", period: "WEEK", metric: "GIFTS_SENT", target: 20_000, reward: 15_000, title: "Send gifts worth 20,000 coins" },
  { id: "room-day-minutes", scope: "ROOM", period: "DAY", metric: "LISTENER_MINUTES", target: 300, reward: 20_000, title: "Visitors spend 300 minutes in your room" },
  { id: "room-day-gifts", scope: "ROOM", period: "DAY", metric: "ROOM_GIFTS", target: 50_000, reward: 20_000, title: "Gifts worth 50,000 coins sent in your room" },
  { id: "room-week-minutes", scope: "ROOM", period: "WEEK", metric: "LISTENER_MINUTES", target: 3000, reward: 200_000, title: "Visitors spend 50 hours in your room" },
  { id: "room-week-gifts", scope: "ROOM", period: "WEEK", metric: "ROOM_GIFTS", target: 500_000, reward: 200_000, title: "Gifts worth 500,000 coins sent in your room" },
];
