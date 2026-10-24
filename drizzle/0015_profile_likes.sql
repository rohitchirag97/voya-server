CREATE TABLE "profile_likes" (
	"liker_id" uuid NOT NULL,
	"liked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_likes_liker_id_liked_id_pk" PRIMARY KEY("liker_id","liked_id"),
	CONSTRAINT "profile_like_no_self" CHECK ("profile_likes"."liker_id" <> "profile_likes"."liked_id")
);
--> statement-breakpoint
ALTER TABLE "profile_likes" ADD CONSTRAINT "profile_likes_liker_id_users_id_fk" FOREIGN KEY ("liker_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_likes" ADD CONSTRAINT "profile_likes_liked_id_users_id_fk" FOREIGN KEY ("liked_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_likes_liked" ON "profile_likes" USING btree ("liked_id");