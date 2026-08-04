CREATE TABLE "agent" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"deleted_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "agent_id_prefix" CHECK ("agent"."id" ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"modality" text NOT NULL,
	"topology" text NOT NULL,
	"environment" text,
	"config" jsonb NOT NULL,
	"credentials" text,
	"credentials_hint" text,
	"capabilities" jsonb,
	"deleted_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_id_agent_id_unique" UNIQUE("id","agent_id"),
	CONSTRAINT "connection_id_prefix" CHECK ("connection"."id" ~ '^con_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "connection_type_allowed" CHECK ("connection"."type" in ('retell', 'phone')),
	CONSTRAINT "connection_modality_allowed" CHECK ("connection"."modality" in ('voice', 'chat')),
	CONSTRAINT "connection_topology_allowed" CHECK ("connection"."topology" in ('agent-dials-out', 'hosted-broker', 'egma-dials-in')),
	CONSTRAINT "connection_credentials_hint_agrees" CHECK (("connection"."credentials" is null) = ("connection"."credentials_hint" is null))
);
--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_project_id_name_unique" ON "agent" USING btree ("project_id","name") WHERE "agent"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "agent_organization_id_project_id_idx" ON "agent" USING btree ("organization_id","project_id") WHERE "agent"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_agent_id_name_unique" ON "connection" USING btree ("agent_id","name") WHERE "connection"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "connection_agent_id_idx" ON "connection" USING btree ("agent_id") WHERE "connection"."deleted_at" is null;