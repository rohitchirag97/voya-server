// Approve or reject a coin seller application until the admin console exists:
//   bun src/db/decideCoinSeller.ts <displayName> <approve|reject>
// List pending ones with: select u.display_name, c.message from coin_sellers c join users u on u.id = c.user_id where c.status = 'PENDING';
import { eq } from "drizzle-orm";
import { db } from ".";
import { decideCoinSeller } from "../routes/coinSellers";
import { users } from "./schema";

const [name, decision] = process.argv.slice(2);
if (!name || (decision !== "approve" && decision !== "reject")) {
  console.error("usage: bun src/db/decideCoinSeller.ts <displayName> <approve|reject>");
  process.exit(1);
}
const [u] = await db.select({ id: users.id }).from(users).where(eq(users.displayName, name));
if (!u) {
  console.error(`no user named ${name}`);
  process.exit(1);
}
const row = await decideCoinSeller(u.id, decision === "approve");
console.log(`${name}: coin seller ${row.status}`);
process.exit(0);
