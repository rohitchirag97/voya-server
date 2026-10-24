// Make a room the official VoyaLive help room: always first in the list (pin slot 1), labelled Official.
// New users can drop in and ask questions there. Only one room is official at a time.
//   bun src/db/officialRoom.ts <room title | host display name>
import { eq, or, sql } from "drizzle-orm";
import { db } from ".";
import { rooms, users } from "./schema";

const [name] = process.argv.slice(2);
if (!name) {
  console.error("usage: bun src/db/officialRoom.ts <room title | host display name>");
  process.exit(1);
}
const [room] = await db
  .select({ id: rooms.id, title: rooms.title })
  .from(rooms)
  .innerJoin(users, eq(users.id, rooms.hostUserId))
  .where(sql`${rooms.kind} = 'AUDIO' and ${rooms.status} = 'LIVE' and (${or(eq(rooms.title, name), eq(users.displayName, name))})`)
  .limit(1);
if (!room) {
  console.error(`no open party room titled or hosted by ${name}`);
  process.exit(1);
}
await db.transaction(async (tx) => {
  await tx.update(rooms).set({ official: false, pinSlot: null }).where(eq(rooms.official, true));
  await tx.update(rooms).set({ pinSlot: null }).where(eq(rooms.pinSlot, 1)); // whoever held slot 1 moves down to the ranked list
  await tx.update(rooms).set({ official: true, pinSlot: 1 }).where(eq(rooms.id, room.id));
});
console.log(`${room.title} is now the official room (pinned first)`);
process.exit(0);
