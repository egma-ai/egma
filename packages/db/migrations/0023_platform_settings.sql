CREATE TABLE "platform_setting" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_setting_name_unique" UNIQUE("name"),
	CONSTRAINT "platform_setting_id_prefix" CHECK ("platform_setting"."id" ~ '^pfs_[0-9A-HJKMNP-TV-Z]{26}$')
);
