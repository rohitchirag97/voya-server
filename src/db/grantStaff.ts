// Make someone app staff (shows the Official mark), or remove it, until the admin console exists:
//   bun run grant <user ID or displayName> <SUPPORT|MODERATOR|ADMIN|OWNER|none>
// On the VPS: docker compose -f docker-compose.prod.yml --env-file .env.production exec api bun run grant <user> <role>
import { and, eq, ne, or, sql } from "drizzle-orm";
import { db } from ".";
import { staffRole, users } from "./schema";

const [who, roleArg] = process.argv.slice(2);
const role = roleArg?.toLowerCase() === "none" ? null : staffRole.enumValues.find((r) => r === roleArg?.toUpperCase());
if (!who || role === undefined) {
  console.error(`usage: bun run grant <user ID or displayName> <${staffRole.enumValues.join("|")}|none>`);
  process.exit(1);
}
// The ID shown on the profile (publicId or special ID), else the display name (unique ignoring case).
const match = /^\d+$/.test(who)
  ? or(eq(users.specialId, who), who.length === 10 ? eq(users.publicId, Number(who)) : undefined)
  : eq(sql`lower(${users.displayName})`, who.toLowerCase());
const [u] = await db.select({ id: users.id, name: users.displayName }).from(users).where(match);
if (!u) {
  console.error(`no user ${who}`);
  process.exit(1);
}
if (role === "OWNER") {
  const [owner] = await db.select({ name: users.displayName }).from(users).where(and(eq(users.staffRole, "OWNER"), ne(users.id, u.id)));
  if (owner) {
    console.error(`${owner.name} is already the owner (only one allowed). Demote them first: bun run grant "${owner.name}" ADMIN`);
    process.exit(1);
  }
}
await db.update(users).set({ staffRole: role, updatedAt: new Date() }).where(eq(users.id, u.id));
console.log(`${u.name} is now ${role ?? "a regular user"}`);
process.exit(0);
