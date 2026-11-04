// Room levels. A room earns points from gifts sent in it (1 coin = 1 point) and from people's time in it (other than
// the owner). Each level allows more room admins. This file is the only copy of these numbers.

export const POINTS_PER_LISTENER_MINUTE = 10;
export const MAX_MINUTES_PER_VISIT = 120; // one visit counts at most 2 h, so idle phones can't farm points

export const ROOM_LEVELS = [
  { level: 1, points: 0, admins: 3 },
  { level: 2, points: 50_000, admins: 5 },
  { level: 3, points: 200_000, admins: 7 },
  { level: 4, points: 1_000_000, admins: 9 },
  { level: 5, points: 5_000_000, admins: 12 },
  { level: 6, points: 20_000_000, admins: 15 },
];

// The level a room with these points is at, and what the next one needs (null at the top).
export function roomLevel(points: number) {
  const i = ROOM_LEVELS.findLastIndex((l) => points >= l.points);
  const cur = ROOM_LEVELS[i]!;
  const next = ROOM_LEVELS[i + 1];
  return { level: cur.level, points, adminLimit: cur.admins, next: next ? { level: next.level, points: next.points, adminLimit: next.admins } : null };
}
