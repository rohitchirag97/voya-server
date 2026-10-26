CREATE TABLE "dm_reads" (
	"user_id" uuid NOT NULL,
	"peer_id" uuid NOT NULL,
	"last_read_id" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "dm_reads_user_id_peer_id_pk" PRIMARY KEY("user_id","peer_id")
);
--> statement-breakpoint
ALTER TABLE "dm_reads" ADD CONSTRAINT "dm_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_reads" ADD CONSTRAINT "dm_reads_peer_id_users_id_fk" FOREIGN KEY ("peer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "direct_messages_inbox" ON "direct_messages" USING btree ("recipient_id","id");--> statement-breakpoint
-- Everything sent before unread counts existed counts as read, so nobody starts with a wall of old "unread" messages.
INSERT INTO "dm_reads" ("user_id", "peer_id", "last_read_id")
SELECT "recipient_id", "sender_id", max("id") FROM "direct_messages" GROUP BY "recipient_id", "sender_id"
ON CONFLICT DO NOTHING;
