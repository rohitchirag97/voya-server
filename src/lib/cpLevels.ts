// CP level: points ("intimacy") a pair earns together, and the curve that turns them into a level.

// How much each shared activity is worth. Capped sources stop counting for the day (India time) once the cap is hit,
// so the level reflects time spent together, not spam; gifts cost coins, so they're uncapped.
export const CP_POINTS = {
  giftPerCoin: 1, // a gift between the two, either direction
  dm: { each: 3, dailyCap: 60 }, // a message in their inbox chat (~20 a day count)
  together: { present: 1, seated: 2, dailyCap: 240 }, // per minute in the same live room; more when both are on seats
} as const;

export const CP_MAX_LEVEL = 15; // the top CP level
// Points needed to reach level n (level 1 at 0). Exponent > 1, so every level costs more than the one before.
export const cpPointsFor = (level: number) => (level <= 1 ? 0 : Math.round((150 * (level - 1) ** 2.1) / 10) * 10);

export function cpLevel(points: number) {
  let level = 1;
  while (level < CP_MAX_LEVEL && cpPointsFor(level + 1) <= points) level++;
  return {
    level,
    points,
    current: cpPointsFor(level), // points where this level started
    next: level < CP_MAX_LEVEL ? cpPointsFor(level + 1) : null, // points for the next level (null at max)
  };
}
