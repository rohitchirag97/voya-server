import { asc } from "drizzle-orm";
import { db } from "../db";
import { levelThresholds } from "../db/schema";

// Levels come from recharge points: 1 XP per ₹1 recharged (spending never lowers it).
// The table of "total XP needed to reach each level" lives in the `level_thresholds` table so it
// can be tuned without a release. These are the starting values seeded on first migrate.
// Each step costs at least as much as the previous one; anchors: Lv10 ₹12,000 · Lv20 ₹48,000 ·
// Lv30 ₹2,50,000 · Lv40 ₹5,87,000 · Lv50 ₹12,00,000 (max level).
// New users are level 0 (no badge); the first XP earned (any recharge) unlocks Lv 1.
export const DEFAULT_THRESHOLDS = [
  1, 100, 300, 600, 1000, 2600, 4500, 6700, 9200, 12000, 14900, 18000, 21200, 24500, 28100, 31700, 35600, 39600, 43700, 48000, 61400, 76300,
  92700, 110700, 130100, 151100, 173500, 197500, 223000, 250000, 277000, 305500, 335500, 366900, 399900, 434300, 470300, 507700, 546600, 587000,
  627400, 672400, 722100, 776500, 835400, 899100, 967300, 1040200, 1117800, 1200000,
];

// thresholds[i] = total XP needed for level i+1. Cached in memory; refreshed from the DB periodically.
let thresholds: number[] = DEFAULT_THRESHOLDS;

export async function loadLevels() {
  const rows = await db.select().from(levelThresholds).orderBy(asc(levelThresholds.level));
  if (rows.length) thresholds = rows.map((r) => r.xpRequired);
}

// Pick up edits to the table within a minute, no restart needed.
export function watchLevels(ms = 60_000) {
  return setInterval(() => loadLevels().catch(() => {}), ms);
}

export const maxLevel = () => thresholds.length;
export const xpToReach = (level: number) => (level <= 0 ? 0 : thresholds[Math.min(level, thresholds.length) - 1]!);

export function levelOf(xp: number) {
  let level = 0;
  for (let i = 0; i < thresholds.length && thresholds[i]! <= xp; i++) level = i + 1;
  return level;
}

// What the app needs to draw a badge and a progress bar.
export function levelInfo(xp: number) {
  const level = levelOf(xp);
  const floor = xpToReach(level);
  const next = level >= maxLevel() ? null : xpToReach(level + 1);
  return { level, xp, levelXp: xp - floor, levelXpNeeded: next === null ? 0 : next - floor, nextLevelAt: next };
}
