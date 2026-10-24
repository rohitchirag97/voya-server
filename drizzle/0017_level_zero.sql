-- New users are level 0 (no badge); Lv 1 now needs 1 XP, i.e. any recharge. Only touches the old default.
UPDATE "level_thresholds" SET "xp_required" = 1 WHERE "level" = 1 AND "xp_required" = 0;
