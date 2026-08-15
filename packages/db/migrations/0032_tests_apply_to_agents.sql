-- A test says which agents it applies to, and carries its own live revisions.
--
-- Four changes, and they are one change to what a test *is*: a specification
-- that names the targets it is worth running against, edited through two
-- separate optimistic tokens, archived rather than deleted.
--
-- **The generated body for this diff would have been wrong on any installed
-- deployment**, in the two ways a naive diff always is. `ADD COLUMN … NOT NULL`
-- with no default fails outright on a table that holds rows, and nothing in it
-- moves data — so every existing test would have come out of the upgrade with
-- no applicable agent at all, which is the one state this relation exists to
-- rule out. The snapshot and the journal entry are drizzle's, untouched, so the
-- next `generate` diffs against a schema this file really produces; the body is
-- written, in the order that makes it safe: add nullable, backfill, then
-- `SET NOT NULL`.
--
-- **Every existing test is linked to every active agent in its project.** That
-- is not a choice about coverage — it is the old rule written down. Before this
-- migration any test of a project could be selected for any agent of that
-- project, and a backfill that picked one agent would be egma authoring
-- somebody's coverage on no evidence. Archived agents receive no link, because
-- a link a run can never use is a promise egma cannot keep; archived *tests*
-- are linked exactly like active ones, so restoring one finds the coverage it
-- would have had.
--
-- **A test whose project holds no active agent is archived, with the reason
-- said out loud.** There is nothing honest to link it to, and leaving it active
-- and targetless would make every run start against it a refusal nobody could
-- explain. It keeps every version, every run that pinned one, and its place
-- under the archived filter — and `restoreTest` takes an active agent in the
-- same transaction that brings it back, so it can never return to the state
-- this migration found it in.

CREATE TABLE "test_agent" (
	"test_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_agent_pk" PRIMARY KEY("test_id","agent_id"),
	CONSTRAINT "test_agent_test_id_prefix" CHECK ("test_agent"."test_id" ~ '^tst_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "test_agent" ADD CONSTRAINT "test_agent_test_id_test_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."test"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_agent" ADD CONSTRAINT "test_agent_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_agent" ADD CONSTRAINT "test_agent_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_agent" ADD CONSTRAINT "test_agent_test_project_fk" FOREIGN KEY ("test_id","project_id") REFERENCES "public"."test"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_agent" ADD CONSTRAINT "test_agent_agent_project_fk" FOREIGN KEY ("agent_id","project_id") REFERENCES "public"."agent"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_agent_agent_id_idx" ON "test_agent" USING btree ("agent_id");--> statement-breakpoint

-- Archive is what this marker always was: the row stayed, every version stayed,
-- and every run that pinned one stayed readable. Renamed rather than replaced,
-- so no test loses the day it left the authoring lists.
ALTER TABLE "test" RENAME COLUMN "deleted_at" TO "archived_at";--> statement-breakpoint
DROP INDEX "test_organization_id_project_id_idx";--> statement-breakpoint
CREATE INDEX "test_organization_id_project_id_idx" ON "test" USING btree ("organization_id","project_id") WHERE "test"."archived_at" is null;--> statement-breakpoint

-- An identifier in egma's own format, minted in SQL for rows nobody was there
-- to mint one for — 0026's helper, verbatim, for the same reason it was written
-- there. Uppercase hexadecimal is a subset of the Crockford alphabet the check
-- constraints name, so these pass the same pattern every minted identifier
-- does; they sort by nothing meaningful, which is correct, because their order
-- is a migration's rather than anybody's mint order.
--
-- `OR REPLACE`, because 0026 defines the same helper and both run in one
-- session: a migration is applied on the connection the one before it used, so
-- a plain CREATE would fail on the second of them for a name neither owns.
CREATE OR REPLACE FUNCTION pg_temp.migration_id(prefix text, seed text) RETURNS text AS $$
	SELECT prefix || '_' || upper(substr(md5(seed), 1, 26));
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint

-- **Before the first row is written**, and this line is load-bearing on exactly
-- the databases this migration is for. A test's `current_version_id` pointer is
-- DEFERRABLE INITIALLY DEFERRED, so any write to `test` leaves a trigger event
-- pending until commit — and Postgres refuses to `ALTER TABLE` a table that has
-- one. On an empty database nothing is written and nothing is pending, so the
-- naive order passes; on a database that actually holds tests, the first
-- backfill below would make every `ALTER TABLE` after it fail. Firing the
-- checks as each write happens costs nothing here — this migration writes no
-- new test and no new version, so there is no circular pair for the deferral to
-- exist for.
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint

-- The two live tokens of every test that already exists. Any value satisfying
-- the format will do: what a revision means is "the state you read", and no
-- caller has read one of these yet. The two are seeded differently so that one
-- test's identity revision is never also its applicability revision — a pair
-- that happened to match would let an edit written against one be accepted
-- against the other, which is the one confusion two tokens exist to prevent.
ALTER TABLE "test" ADD COLUMN "revision" text COLLATE "C";--> statement-breakpoint
UPDATE "test" SET "revision" = pg_temp.migration_id('rev', 'test:' || "id") WHERE "revision" IS NULL;--> statement-breakpoint
ALTER TABLE "test" ALTER COLUMN "revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_revision_prefix" CHECK ("test"."revision" ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$');--> statement-breakpoint

ALTER TABLE "test" ADD COLUMN "applicability_revision" text COLLATE "C";--> statement-breakpoint
UPDATE "test" SET "applicability_revision" = pg_temp.migration_id('rev', 'test-applicability:' || "id") WHERE "applicability_revision" IS NULL;--> statement-breakpoint
ALTER TABLE "test" ALTER COLUMN "applicability_revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_applicability_revision_prefix" CHECK ("test"."applicability_revision" ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$');--> statement-breakpoint

ALTER TABLE "test" ADD COLUMN "archive_reason" text;--> statement-breakpoint

-- The backfill: every test linked to every active agent of its own project.
-- `created_by` is left null on purpose — nobody made this decision, an upgrade
-- did, and naming the test's author would put somebody's name on a link they
-- never chose.
INSERT INTO "test_agent" ("test_id", "agent_id", "project_id", "created_at")
SELECT t."id", a."id", t."project_id", now()
FROM "test" AS t
JOIN "agent" AS a
	ON a."project_id" = t."project_id"
	AND a."archived_at" IS NULL;--> statement-breakpoint

-- And the tests the backfill could not reach, because their project holds no
-- active agent at all. Already-archived tests are left exactly as they are:
-- they carry no reason, because the reason they are archived is that somebody
-- archived them.
UPDATE "test"
SET "archived_at" = now(),
	"archive_reason" = 'needs_agent',
	"revision" = pg_temp.migration_id('rev', 'test-needs-agent:' || "id"),
	"updated_at" = now()
WHERE "archived_at" IS NULL
	AND NOT EXISTS (
		SELECT 1 FROM "test_agent" AS ta WHERE ta."test_id" = "test"."id"
	);--> statement-breakpoint

ALTER TABLE "test" ADD CONSTRAINT "test_archive_reason_allowed" CHECK ("test"."archive_reason" in ('needs_agent'));--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_archive_reason_needs_an_archive" CHECK ("test"."archive_reason" is null or "test"."archived_at" is not null);
