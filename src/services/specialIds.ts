import { eq } from "drizzle-orm";
import { db, isUniqueViolation } from "../db";
import { users } from "../db/schema";
import { AppError } from "../lib/errors";

// Special IDs are 3-9 letters/digits, stored in capitals so "vip88" and "VIP88" are the same ID.
export const normalizeSpecialId = (s: string) => s.trim().toUpperCase();

// Give a user a special ID, or remove it with null. Each special ID belongs to one user.
export async function setSpecialId(userId: string, raw: string | null) {
  const specialId = raw === null ? null : normalizeSpecialId(raw);
  if (specialId !== null && !/^[A-Z0-9]{3,9}$/.test(specialId)) throw new AppError("BAD_SPECIAL_ID", 400, "Special ID must be 3-9 letters or numbers");
  try {
    const [u] = await db.update(users).set({ specialId, updatedAt: new Date() }).where(eq(users.id, userId)).returning();
    if (!u) throw new AppError("USER_NOT_FOUND", 404);
    return u;
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("SPECIAL_ID_TAKEN", 409, "That special ID belongs to someone else");
    throw e;
  }
}
