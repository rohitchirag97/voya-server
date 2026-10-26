// One-off cleanup: give everyone who isn't staff and has "voya" in their name (any spelling) a random friendly name.
// Usage: bun src/db/renameVoyaNames.ts          (dry run: lists who would change)
//        bun src/db/renameVoyaNames.ts --apply  (renames them)
import { isNull, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { db } from "./index";
import { users } from "./schema";
import { mentionsVoya } from "../lib/impersonation";

const ADJ = ["Sunny", "Happy", "Lucky", "Cosmic", "Velvet", "Misty", "Golden", "Silver", "Brave", "Gentle", "Starry", "Breezy", "Mellow", "Swift", "Rosy"];
const NOUN = ["Panda", "Falcon", "Lotus", "Comet", "Tiger", "Koala", "Maple", "River", "Pixel", "Sparrow", "Mango", "Orbit", "Echo", "Willow", "Otter"];

const apply = process.argv.includes("--apply");
const taken = new Set((await db.select({ n: users.displayName }).from(users)).flatMap((r) => (r.n ? [r.n.toLowerCase()] : [])));
const pick = () => {
  for (;;) {
    const name = `${ADJ[randomInt(ADJ.length)]}${NOUN[randomInt(NOUN.length)]}${randomInt(100, 1000)}`;
    if (!taken.has(name.toLowerCase())) return taken.add(name.toLowerCase()), name;
  }
};

const candidates = await db.select({ id: users.id, name: users.displayName, publicId: users.publicId }).from(users).where(isNull(users.staffRole));
const hits = candidates.filter((u) => u.name && mentionsVoya(u.name));
console.log(`${hits.length} non-staff name(s) contain "voya":`);
for (const u of hits) {
  const next = pick();
  console.log(`  ${u.publicId}  ${JSON.stringify(u.name)}  ->  ${next}`);
  if (apply) await db.update(users).set({ displayName: next, updatedAt: new Date() }).where(sql`${users.id} = ${u.id}`);
}
console.log(apply ? "Renamed." : "Dry run: nothing changed. Run with --apply to rename.");
process.exit(0);
