CREATE TABLE "platform_instance" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" text COLLATE "C" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_instance_id_format" CHECK ("platform_instance"."id" ~ '^pf_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_instance_id_unique" ON "platform_instance" USING btree ("id");