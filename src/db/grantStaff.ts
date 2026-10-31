// Give someone a staff role (or none) from the command line, e.g. the first owner. Usually done in the admin panel.
//   bun run grant <user ID or displayName> <role id, e.g. OWNER|ADMIN|MODERATOR|SUPPORT|none>
// On the VPS: docker compose -f docker-compose.prod.yml --env-file .env.production exec api bun run grant <user> <role>
import { and, eq, ne } from "drizzle-orm";
import { findUserByRef } from "../services/auth";
import { db } from ".";
import { staffRoles, users } from "./schema";

const [who, roleArg] = process.argv.slice(2);
const ids = (await db.select({ id: staffRoles.id }).from(staffRoles)).map((r) => r.id);
const role = roleArg?.toLowerCase() === "none" ? null : ids.find((r) => r.toUpperCase() === roleArg?.toUpperCase());
if (!who || role === undefined) {
  console.error(`usage: bun run grant <user ID or displayName> <${ids.join("|")}|none>`);
  process.exit(1);
}
const found = await findUserByRef(who).catch(() => null);
if (!found) {
  console.error(`no user ${who}`);
  process.exit(1);
}
const u = { id: found.id, name: found.displayName };
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
