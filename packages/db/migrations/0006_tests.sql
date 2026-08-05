CREATE TABLE "test" (
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
	CONSTRAINT "test_id_prefix" CHECK ("test"."id" ~ '^tst_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "test_version" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"test_id" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_version_test_id_version_unique" UNIQUE("test_id","version"),
	CONSTRAINT "test_version_id_prefix" CHECK ("test_version"."id" ~ '^tstv_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "test_version_persona" (
	"test_version_id" text COLLATE "C" NOT NULL,
	"persona_id" text COLLATE "C" NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "test_version_persona_pk" PRIMARY KEY("test_version_id","persona_id"),
	CONSTRAINT "test_version_persona_version_id_position_unique" UNIQUE("test_version_id","position"),
	CONSTRAINT "test_version_persona_test_version_id_prefix" CHECK ("test_version_persona"."test_version_id" ~ '^tstv_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "default_persona_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- DEFERRABLE is written here by hand: the schema source cannot express it, and
-- without it the identity row could never be inserted ahead of the version row
-- it points at. Carry this clause forward if this constraint is ever recreated.
ALTER TABLE "test" ADD CONSTRAINT "test_current_version_id_test_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."test_version"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_version" ADD CONSTRAINT "test_version_test_id_test_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."test"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_version" ADD CONSTRAINT "test_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_version_persona" ADD CONSTRAINT "test_version_persona_test_version_id_test_version_id_fk" FOREIGN KEY ("test_version_id") REFERENCES "public"."test_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_version_persona" ADD CONSTRAINT "test_version_persona_persona_id_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."persona"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_organization_id_project_id_idx" ON "test" USING btree ("organization_id","project_id") WHERE "test"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "test_version_persona_persona_id_idx" ON "test_version_persona" USING btree ("persona_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_default_persona_id_persona_id_fk" FOREIGN KEY ("default_persona_id") REFERENCES "public"."persona"("id") ON DELETE set null ON UPDATE no action;