import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { sign, verify } from "hono/jwt";
import { config } from "../config";
import { db, isUniqueViolation } from "../db";
import { otpCodes, userSessions, users, walletAccounts, walletLedger, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;

const otpHash = (phone: string, code: string) => createHmac("sha256", config.jwtSecret).update(`${phone}:${code}`).digest("hex");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// shortcut: no SMS provider yet, so codes are logged and returned outside production; wire a provider before launch.
async function sendSms(phone: string, text: string) {
  if (config.env === "production") throw new AppError("SMS_NOT_CONFIGURED", 503);
  console.log(JSON.stringify({ level: "info", msg: "dev-otp", phone, text }));
}

export async function requestOtp(phone: string) {
  rateLimit(`otp:req:${phone}`, 5, 15 * 60_000);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = { phone, codeHash: otpHash(phone, code), attempts: 0, expiresAt: new Date(Date.now() + OTP_TTL_MS) };
  await db.insert(otpCodes).values(row).onConflictDoUpdate({ target: otpCodes.phone, set: row });
  await sendSms(phone, `Your VoyaLive code is ${code}`);
  return config.env === "production" ? {} : { devCode: code };
}

export async function verifyOtp(phone: string, code: string) {
  await checkOtp(phone, code);
  return signIn({ phone });
}

export async function verifyGoogle(idToken: string) {
  return signIn({ googleSub: await googleSub(idToken) });
}

// Adds a second way to sign in to an existing account; each account holds at most one phone and one Google account.
export async function linkPhone(userId: string, phone: string, code: string) {
  await checkOtp(phone, code);
  return link(userId, { phone });
}

export async function linkGoogle(userId: string, idToken: string) {
  return link(userId, { googleSub: await googleSub(idToken) });
}

type Identity = { phone: string } | { googleSub: string };

async function link(userId: string, id: Identity) {
  const column = "phone" in id ? users.phone : users.googleSub;
  try {
    const [u] = await db.update(users).set(id).where(and(eq(users.id, userId), isNull(column))).returning();
    if (!u) throw new AppError("ALREADY_LINKED", 409, "Your account already has one linked");
    return u;
  } catch (e) {
    throw taken(e);
  }
}

const taken = (e: unknown) => (isUniqueViolation(e) ? new AppError("IDENTITY_TAKEN", 409, "That is already used by another account") : e);

// Changing the phone takes a code from both numbers. Step 1 proves the current one and returns a 15-minute pass,
// signed with its own key so it can never work as an access token.
const CHANGE_TTL_S = 15 * 60;
const changeKey = () => `${config.jwtSecret}:phone-change`;
const changeExpired = () => new AppError("CHANGE_EXPIRED", 401, "Verify your current number again");

export async function verifyCurrentPhone(user: User, code: string) {
  if (!user.phone) throw new AppError("NO_PHONE", 409, "Add a phone number first");
  await checkOtp(user.phone, code);
  return sign({ sub: user.id, phone: user.phone, exp: Math.floor(Date.now() / 1000) + CHANGE_TTL_S }, changeKey(), "HS256");
}

// Step 2: prove the new number and swap it in, only if the current number is still the one proven in step 1.
export async function changePhone(userId: string, changeToken: string, phone: string, code: string) {
  const pass = await verify(changeToken, changeKey(), "HS256").catch(() => null);
  if (!pass || pass.sub !== userId) throw changeExpired();
  if (pass.phone === phone) throw new AppError("SAME_PHONE", 400, "That is already your number");
  await checkOtp(phone, code);
  try {
    const [u] = await db.update(users).set({ phone }).where(and(eq(users.id, userId), eq(users.phone, pass.phone as string))).returning();
    if (!u) throw changeExpired();
    return u;
  } catch (e) {
    throw taken(e);
  }
}

async function checkOtp(phone: string, code: string) {
  rateLimit(`otp:verify:${phone}`, 10, 15 * 60_000);
  const [otp] = await db
    .update(otpCodes)
    .set({ attempts: sql`${otpCodes.attempts} + 1` })
    .where(and(eq(otpCodes.phone, phone), gt(otpCodes.expiresAt, new Date())))
    .returning();
  if (!otp || otp.attempts > OTP_MAX_ATTEMPTS) throw new AppError("OTP_INVALID", 401, "Code is invalid or expired");
  const ok = timingSafeEqual(Buffer.from(otp.codeHash), Buffer.from(otpHash(phone, code)));
  if (!ok) throw new AppError("OTP_INVALID", 401, "Code is invalid or expired");
  await db.delete(otpCodes).where(eq(otpCodes.phone, phone));
}

// shortcut: Google's tokeninfo endpoint checks the signature and expiry (one HTTP call per sign-in); verify against Google's JWKS locally if sign-in volume grows.
async function googleSub(idToken: string) {
  if (!config.googleClientId) throw new AppError("GOOGLE_NOT_CONFIGURED", 503);
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const t = res.ok ? ((await res.json()) as { aud?: string; iss?: string; sub?: string; email_verified?: string }) : null;
  const ok = t?.sub && t.aud === config.googleClientId && ["accounts.google.com", "https://accounts.google.com"].includes(t.iss ?? "") && t.email_verified === "true";
  if (!ok) throw new AppError("GOOGLE_INVALID", 401, "Google sign-in failed");
  rateLimit(`google:${t.sub}`, 10, 15 * 60_000);
  return t.sub!;
}

// Finds or creates the user for a verified identity, then opens a session.
async function signIn(id: Identity) {
  const user = await db.transaction(async (tx) => {
    const [created] = await tx.insert(users).values(id).onConflictDoNothing().returning();
    if (!created) return (await tx.select().from(users).where("phone" in id ? eq(users.phone, id.phone) : eq(users.googleSub, id.googleSub)))[0]!;
    // P0 test coins only; no real-money value.
    await tx.insert(walletAccounts).values({ userId: created.id, balance: config.signupBonusCoins });
    await tx.insert(walletLedger).values({
      userId: created.id,
      entryType: "PROMO_GRANT",
      amount: config.signupBonusCoins,
      referenceType: "SIGNUP_BONUS",
      referenceId: created.id,
    });
    return created;
  });
  if (user.status === "BANNED") throw new AppError("ACCOUNT_BANNED", 403);
  return { user, ...(await createSession(user.id)) };
}

async function issueTokens(sessionId: string, userId: string) {
  const refreshToken = randomBytes(32).toString("base64url");
  await db
    .update(userSessions)
    .set({ refreshTokenHash: sha256(refreshToken), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) })
    .where(eq(userSessions.id, sessionId));
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_S;
  const accessToken = await sign({ sub: userId, sid: sessionId, exp }, config.jwtSecret, "HS256");
  return { accessToken, refreshToken, accessTokenExpiresAt: exp };
}

async function createSession(userId: string) {
  const [s] = await db
    .insert(userSessions)
    .values({ userId, refreshTokenHash: randomBytes(32).toString("hex"), expiresAt: new Date() })
    .returning();
  return issueTokens(s!.id, userId);
}

export async function refresh(refreshToken: string) {
  const [s] = await db
    .select()
    .from(userSessions)
    .where(and(eq(userSessions.refreshTokenHash, sha256(refreshToken)), isNull(userSessions.revokedAt), gt(userSessions.expiresAt, new Date())));
  if (!s) throw new AppError("UNAUTHORIZED", 401);
  return issueTokens(s.id, s.userId); // rotates the refresh token
}

export async function revokeSession(sessionId: string) {
  await db.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.id, sessionId));
}

// Verifies the access JWT and that its session is still live; used by REST and Socket.IO.
export async function authenticate(token: string | undefined): Promise<{ user: User; sessionId: string }> {
  if (!token) throw new AppError("UNAUTHORIZED", 401);
  let sid: string;
  try {
    sid = (await verify(token, config.jwtSecret, "HS256")).sid as string;
  } catch {
    throw new AppError("UNAUTHORIZED", 401);
  }
  const [row] = await db
    .select({ user: users, revokedAt: userSessions.revokedAt })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(eq(userSessions.id, sid));
  if (!row || row.revokedAt) throw new AppError("UNAUTHORIZED", 401);
  if (row.user.status === "BANNED") throw new AppError("ACCOUNT_BANNED", 403);
  return { user: row.user, sessionId: sid };
}

export async function loadUser(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.status === "BANNED") throw new AppError("UNAUTHORIZED", 401);
  return u;
}

// Gate for joining, creating, chatting, seating and gifting.
export function assertCanParticipate(user: User) {
  if (user.status !== "ACTIVE") throw new AppError("ACCOUNT_SUSPENDED", 403);
  if (!user.displayName) throw new AppError("PROFILE_INCOMPLETE", 403, "Set a display name first");
}
