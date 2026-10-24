import { AppError } from "./errors";

// shortcut: in-process fixed window, only correct with one server instance; move to Redis before scaling out.
const windows = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  if (windows.size > 50_000) for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
  const w = windows.get(key);
  if (!w || w.resetAt <= now) return void windows.set(key, { count: 1, resetAt: now + windowMs });
  if (++w.count > max) throw new AppError("RATE_LIMITED", 429, "Too many requests");
}

export const resetRateLimits = () => windows.clear();
