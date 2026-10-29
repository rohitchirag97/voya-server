CREATE TABLE "mic_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mic_sessions" ADD CONSTRAINT "mic_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mic_sessions" ADD CONSTRAINT "mic_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mic_sessions_user" ON "mic_sessions" USING btree ("user_id","last_at");