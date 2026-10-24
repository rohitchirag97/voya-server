// Give or remove a special ID until the admin console exists:
//   bun src/db/grantSpecialId.ts <displayName> <3-9 digits|none>
import { eq } from "drizzle-orm";
import { db } from ".";
import { setSpecialId } from "../services/specialIds";
import { users } from "./schema";

const [name, idArg] = process.argv.slice(2);
if (!name || !idArg) {
  console.error("usage: bun src/db/grantSpecialId.ts <displayName> <3-9 digits|none>");
  process.exit(1);
}
const [u] = await db.select({ id: users.id }).from(users).where(eq(users.displayName, name));
if (!u) {
  console.error(`no user named ${name}`);
  process.exit(1);
}
const row = await setSpecialId(u.id, idArg === "none" ? null : idArg);
console.log(`${name}: ID ${row.publicId}, special ID ${row.specialId ?? "none"}`);
process.exit(0);
