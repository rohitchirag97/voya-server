-- "Last seen" started being recorded only when the column was added. Give everyone without one a best guess from
-- what we already know: when they were last active in a room, else when their profile last changed.
UPDATE "users" u
SET "last_seen_at" = COALESCE(
  (SELECT max(rp."last_seen_at") FROM "room_participants" rp WHERE rp."user_id" = u."id"),
  u."updated_at"
)
WHERE u."last_seen_at" IS NULL;
