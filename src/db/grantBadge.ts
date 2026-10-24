// Grant a badge until the admin console exists:
//   bun src/db/grantBadge.ts <displayName> <badgeId> <days|forever>
import { eq } from "drizzle-orm";
import { db } from ".";
import { grantBadge } from "../services/badges";
import { users } from "./schema";

const [name, badgeId, daysArg] = process.argv.slice(2);
if (!name || !badgeId || !daysArg) {
  console.error("usage: bun src/db/grantBadge.ts <displayName> <badgeId> <days|forever>");
  process.exit(1);
}
const [u] = await db.select({ id: users.id }).from(users).where(eq(users.displayName, name));
if (!u) {
  console.error(`no user named ${name}`);
  process.exit(1);
}
const row = await grantBadge(u.id, badgeId, daysArg === "forever" ? null : Number(daysArg));
console.log(`${name} has ${badgeId} until ${row.expiresAt?.toISOString() ?? "forever"}`);
process.exit(0);
