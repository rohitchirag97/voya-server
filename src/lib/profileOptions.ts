// "About me" choices. Interests are a fixed list so tags stay tidy (and can't be used for spam); the app fetches it.
export const INTERESTS = [
  "Single", "Married", "Understanding", "Fun", "Romantic", "Freshly young", "Game", "Party", "Fashion", "Travel",
  "Dance", "Music", "Singing", "Movies", "Food", "Cricket", "Fitness", "Pets", "Reading", "Art",
] as const;
export const MAX_INTERESTS = 10;
export const MAX_PINNED_BADGES = 9;
export const MIN_AGE = 18;
export const MAX_COVERS = 6;

// Whole years between an ISO birthday (YYYY-MM-DD) and today.
export function ageOn(birthday: string, today = new Date()) {
  const [y, m, d] = birthday.split("-").map(Number) as [number, number, number];
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
  return age;
}
