import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from ".";
import { SAMPLE_BADGES } from "./badgesSeed";
import { SAMPLE_COSMETICS } from "./cosmeticsSeed";
import { SVIP_COSMETICS } from "./svipCosmeticsSeed";
import { MORE_GIFTS } from "./giftsMore";
import { ANIMATED_GIFTS } from "./giftsSeed";
import { SVGA_GIFTS } from "./svgaGifts";
import { DEFAULT_THRESHOLDS, loadLevels } from "../lib/levels";
import { rechargeBot } from "../services/dmPush";
import { badges, cosmetics, giftCatalog, levelThresholds } from "./schema";

export async function migrateAndSeed() {
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` });
  await db
    .insert(giftCatalog)
    .values([
      { id: "rose", name: "Rose", assetUrl: "gifts/rose.png", coinPrice: 1, sortOrder: 1 },
      { id: "chai", name: "Chai", assetUrl: "gifts/chai.png", coinPrice: 10, sortOrder: 2 },
      { id: "star", name: "Star", assetUrl: "gifts/star.png", coinPrice: 50, sortOrder: 3 },
      { id: "crown", name: "Crown", assetUrl: "gifts/crown.png", coinPrice: 500, maxQuantity: 10, sortOrder: 4 },
    ])
    .onConflictDoNothing();
  await db.insert(cosmetics).values(SAMPLE_COSMETICS).onConflictDoNothing();
  await db.insert(cosmetics).values(SVIP_COSMETICS).onConflictDoNothing();
  await db.insert(badges).values(SAMPLE_BADGES).onConflictDoNothing();
  await db.insert(giftCatalog).values(ANIMATED_GIFTS).onConflictDoNothing();
  await db.insert(giftCatalog).values(MORE_GIFTS).onConflictDoNothing();
  await db.insert(giftCatalog).values(SVGA_GIFTS).onConflictDoNothing();
  // Seed level thresholds once; later edits in the table are kept.
  await db
    .insert(levelThresholds)
    .values(DEFAULT_THRESHOLDS.map((xpRequired, i) => ({ level: i + 1, xpRequired })))
    .onConflictDoNothing();
  await loadLevels();
  await rechargeBot(); // reserves the "Recharge Notification" name before any user can take it
}

if (import.meta.main) {
  await migrateAndSeed();
  console.log("migrated + seeded");
  process.exit(0);
}
