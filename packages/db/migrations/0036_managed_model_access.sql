-- Managed model access: the two halves of one inference key, in the two
-- deployments that hold them.
--
--  * `inference_key` is hosted Egma's half — the hash of a key an organization
--    administrator created, its name, its safe hint and its lifecycle times.
--    There is no column a readable copy could live in, which is what makes
--    "shown once" a property of the schema rather than of a route's manners.
--    Several rows may be active for one organization at once, so a replacement
--    can be brought up before the old key is revoked.
--  * `managed_access_key` is a self-hosted deployment's half — the key itself,
--    sealed with the same master key and the same envelope every other
--    credential in this schema uses, plus the Egma Cloud organization that
--    validation said owns it. One row per organization: connecting replaces,
--    disconnecting removes, and the binding is what refuses a key belonging to
--    somebody else's Egma Cloud organization.
--
-- Additive. Nothing is dropped, nothing is backfilled, and no organization's
-- model access is decided here.

CREATE TABLE "inference_key" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"display_suffix" text NOT NULL,
	"created_by" text COLLATE "C",
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_key_hash_unique" UNIQUE("hash"),
	CONSTRAINT "inference_key_id_prefix" CHECK ("inference_key"."id" ~ '^ifk_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "managed_access_key" (
	"organization_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"cloud_organization_id" text COLLATE "C" NOT NULL,
	"credentials" text NOT NULL,
	"credentials_hint" text NOT NULL,
	"connected_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_access_key_organization_id_prefix" CHECK ("managed_access_key"."organization_id" ~ '^org_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "inference_key" ADD CONSTRAINT "inference_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_key" ADD CONSTRAINT "inference_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_access_key" ADD CONSTRAINT "managed_access_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_access_key" ADD CONSTRAINT "managed_access_key_connected_by_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;