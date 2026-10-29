// Host salary levels (draft numbers; the website's /salary page shows the same table).
// A host reaches the highest level whose diamond AND mic-hour targets they met this month, and is paid that level's
// fixed salary: (target + bonus) diamonds × ₹0.05. Diamonds above the target don't add to it.

export const RUPEES_PER_DIAMOND = 0.05;
export const AGENCY_SHARE = 0.1; // the owner earns 10% of each host's salary
export const COIN_LEVELS = 2; // levels 1..2 are paid in coins, higher levels in cash

export const MIC = { minSessionMinutes: 10, maxMinutesPerDay: 120 }; // shorter stretches don't count; each India day caps at 2 h

export const LEVELS = [
  { level: 1, diamonds: 10_000, hours: 10, bonusPct: 0 },
  { level: 2, diamonds: 25_000, hours: 15, bonusPct: 2 },
  { level: 3, diamonds: 50_000, hours: 20, bonusPct: 4 },
  { level: 4, diamonds: 100_000, hours: 25, bonusPct: 5 },
  { level: 5, diamonds: 200_000, hours: 30, bonusPct: 6 },
  { level: 6, diamonds: 350_000, hours: 35, bonusPct: 7 },
  { level: 7, diamonds: 500_000, hours: 0, bonusPct: 8 },
  { level: 8, diamonds: 750_000, hours: 0, bonusPct: 9 },
  { level: 9, diamonds: 1_000_000, hours: 0, bonusPct: 10 },
  { level: 10, diamonds: 1_500_000, hours: 0, bonusPct: 11 },
  { level: 11, diamonds: 2_000_000, hours: 0, bonusPct: 12 },
  { level: 12, diamonds: 3_000_000, hours: 0, bonusPct: 13 },
  { level: 13, diamonds: 5_000_000, hours: 0, bonusPct: 14 },
  { level: 14, diamonds: 7_500_000, hours: 0, bonusPct: 15 },
  { level: 15, diamonds: 10_000_000, hours: 0, bonusPct: 16 },
];
type Level = (typeof LEVELS)[number];

export const salaryOf = (l: Level) => Math.round(l.diamonds * (1 + l.bonusPct / 100) * RUPEES_PER_DIAMOND);

// Everything the app and the website's /salary page show about levels. This file is the only copy of these numbers.
export const levelTable = () => ({
  levels: LEVELS.map((l) => ({ ...l, bonusDiamonds: Math.round((l.diamonds * l.bonusPct) / 100), salary: salaryOf(l) })),
  mic: MIC,
  coinLevels: COIN_LEVELS,
  agencyShare: AGENCY_SHARE,
  rupeesPerDiamond: RUPEES_PER_DIAMOND,
});

// Where a host stands this month: level reached, its salary, and what the next level still needs.
export function standing(diamonds: number, micMinutes: number) {
  const level = LEVELS.findLast((l) => diamonds >= l.diamonds && micMinutes >= l.hours * 60) ?? null;
  const next = LEVELS.find((l) => l.level === (level?.level ?? 0) + 1) ?? null;
  const salary = level ? salaryOf(level) : 0;
  return {
    level: level?.level ?? 0,
    salary, // ₹
    paidIn: level ? (level.level <= COIN_LEVELS ? "COINS" : "CASH") : null,
    agencyBonus: Math.round(salary * AGENCY_SHARE * 100) / 100, // ₹
    next: next && { level: next.level, diamonds: next.diamonds, minutes: next.hours * 60, salary: salaryOf(next) },
  };
}
