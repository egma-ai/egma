CREATE TABLE "digital_human" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"current_version_id" text COLLATE "C" NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digital_human_id_prefix" CHECK ("digital_human"."id" ~ '^dh_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "digital_human_version" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"digital_human_id" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"traits" jsonb NOT NULL,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digital_human_version_digital_human_id_version_unique" UNIQUE("digital_human_id","version"),
	CONSTRAINT "digital_human_version_id_prefix" CHECK ("digital_human_version"."id" ~ '^dhv_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "digital_human" ADD CONSTRAINT "digital_human_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- DEFERRABLE is written here by hand: the schema source cannot express it, and
-- without it the identity row could never be inserted ahead of the version row
-- it points at. Carry this clause forward if this constraint is ever recreated.
ALTER TABLE "digital_human" ADD CONSTRAINT "digital_human_current_version_id_digital_human_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."digital_human_version"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "digital_human" ADD CONSTRAINT "digital_human_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_human" ADD CONSTRAINT "digital_human_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_human_version" ADD CONSTRAINT "digital_human_version_digital_human_id_digital_human_id_fk" FOREIGN KEY ("digital_human_id") REFERENCES "public"."digital_human"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_human_version" ADD CONSTRAINT "digital_human_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digital_human_organization_id_project_id_idx" ON "digital_human" USING btree ("organization_id","project_id") WHERE "digital_human"."deleted_at" is null;
