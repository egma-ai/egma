-- Mock tools: what egma answers with when the agent calls one of its tools
-- during a simulation, so a test never books a real appointment and can order
-- up the branch it was written for.
--
-- One table and deliberately no version table beside it. Every other authored
-- thing here is a pair, because editing one must never rewrite what an old
-- result meant; a mock tool is the one exemption, and the two mechanisms that
-- carry its history instead are the answers landing on each simulation's record
-- and the snapshot the run column below freezes.
CREATE TABLE "mock_tool" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"tool_name" text NOT NULL,
	"answer" jsonb NOT NULL,
	"delay_milliseconds" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_tool_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "mock_tool_id_prefix" CHECK ("mock_tool"."id" ~ '^mck_[0-9A-HJKMNP-TV-Z]{26}$'),
	-- 30 seconds is what the exchange's 45-second budget has left after 10 for
	-- the round trip and 5 for egma's serving margin, so a delay this admits can
	-- never collide with the transport that has to carry it.
	CONSTRAINT "mock_tool_delay_within_budget" CHECK ("mock_tool"."delay_milliseconds" between 0 and 30000)
);
--> statement-breakpoint
-- Which agents a mock tool applies to. No rows means every agent, which is the
-- ordinary case and what keeps two prompt variants tested against one world.
CREATE TABLE "mock_tool_agent" (
	"mock_tool_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "mock_tool_agent_pk" PRIMARY KEY("mock_tool_id","agent_id"),
	CONSTRAINT "mock_tool_agent_mock_tool_id_position_unique" UNIQUE("mock_tool_id","position"),
	CONSTRAINT "mock_tool_agent_mock_tool_id_prefix" CHECK ("mock_tool_agent"."mock_tool_id" ~ '^mck_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
-- The mocked world a run executes in, frozen at creation.
--
-- Written with a default and then stripped of it, which is the whole of what
-- this migration says about the rows it found: an instance upgrading across it
-- holds runs conducted before anything could be mocked, and `{}` says they
-- mocked nothing rather than inventing a world they never saw. The default
-- comes straight back off, so every run written from now on states its world
-- rather than inheriting one.
ALTER TABLE "run" ADD COLUMN "mock_tool_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ALTER COLUMN "mock_tool_snapshot" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "mock_tool" ADD CONSTRAINT "mock_tool_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tool" ADD CONSTRAINT "mock_tool_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tool" ADD CONSTRAINT "mock_tool_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tool_agent" ADD CONSTRAINT "mock_tool_agent_mock_tool_id_mock_tool_id_fk" FOREIGN KEY ("mock_tool_id") REFERENCES "public"."mock_tool"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- No `on delete` clause, exactly as the test junctions have none: removing the
-- agent outright is refused rather than quietly widening a mock tool to every
-- agent in the project.
ALTER TABLE "mock_tool_agent" ADD CONSTRAINT "mock_tool_agent_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Both edges of the triangle, so a scope reaching another project's agent — or
-- another customer's — is unrepresentable rather than merely unwritten.
ALTER TABLE "mock_tool_agent" ADD CONSTRAINT "mock_tool_agent_mock_tool_project_fk" FOREIGN KEY ("mock_tool_id","project_id") REFERENCES "public"."mock_tool"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_tool_agent" ADD CONSTRAINT "mock_tool_agent_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One answer per tool name, held by the database rather than by the factory
-- alone: two rows answering for one tool would be two answers with no rule to
-- choose between them. Deleted rows are outside it, so a tool whose mock
-- somebody removed can be answered for again.
CREATE UNIQUE INDEX "mock_tool_project_id_tool_name_unique" ON "mock_tool" USING btree ("project_id","tool_name") WHERE "mock_tool"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "mock_tool_organization_id_project_id_idx" ON "mock_tool" USING btree ("organization_id","project_id") WHERE "mock_tool"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "mock_tool_agent_agent_id_idx" ON "mock_tool_agent" USING btree ("agent_id");
