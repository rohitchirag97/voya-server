const need = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env ${key}`);
  return v;
};

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: need("DATABASE_URL"),
  jwtSecret: need("JWT_SECRET"),
  zegoAppId: Number(need("ZEGO_APP_ID")),
  zegoServerSecret: need("ZEGO_SERVER_SECRET"),
  seatGraceMs: Number(process.env.SEAT_GRACE_MS ?? 30_000), // connection lost: time to come back before the seat frees up
  seatQuickGraceMs: Number(process.env.SEAT_QUICK_GRACE_MS ?? 0), // app closed (connection closed cleanly): the seat frees at once
  signupBonusCoins: Number(process.env.SIGNUP_BONUS_COINS ?? 10000),
  // OAuth "Web application" client ID; Google sign-in is off when unset.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  uploadsDir:process.env.UPLOADS_DIR ?? "uploads",
  // Where shared room links send people without the app: the Play Store page once published; empty = our /download page.
  appStoreUrl: process.env.APP_STORE_URL ?? "",
};

if (config.zegoServerSecret.length !== 32) {
  throw new Error("ZEGO_SERVER_SECRET must be exactly 32 characters");
}
