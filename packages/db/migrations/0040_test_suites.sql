-- Prelaunch cleanup exception: the founder confirmed that no older API or
-- rollback contract is supported for this cutover. The prior build cannot run
-- after this migration. A suite is the required, stable home of every test.
-- The nullable column
-- exists only inside this migration while installed test rows are backfilled.
CREATE TABLE "test_suite" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"project_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_suite_id_project_id_unique" UNIQUE("id","project_id"),
	CONSTRAINT "test_suite_id_prefix" CHECK ("test_suite"."id" ~ '^ste_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "test_suite_name_is_not_blank" CHECK (btrim("test_suite"."name") <> '')
);
--> statement-breakpoint
ALTER TABLE "test_suite" ADD CONSTRAINT "test_suite_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "test_suite" ADD CONSTRAINT "test_suite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "test_suite" ADD CONSTRAINT "test_suite_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "test_suite_organization_id_project_id_idx" ON "test_suite" USING btree ("organization_id","project_id") WHERE "test_suite"."deleted_at" is null;
--> statement-breakpoint
ALTER TABLE "test" ADD COLUMN "suite_id" text COLLATE "C";
--> statement-breakpoint

-- Migration-only UUIDv7 encoder. Egma ids are the 128 UUID bits rendered as
-- 26 Crockford base32 characters (the first character includes two leading
-- zero bits). This keeps the same time-sortable identity invariant as the
-- application generator without leaving a database default or helper behind.
CREATE FUNCTION _migration_0040_test_suite_id() RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
	raw bytea := uuid_send(uuidv7());
	alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
	encoded text := '';
	group_index integer;
	bit_index integer;
	source_index integer;
	digit integer;
BEGIN
	FOR group_index IN 0..25 LOOP
		digit := 0;
		FOR bit_index IN 0..4 LOOP
			digit := digit * 2;
			source_index := group_index * 5 + bit_index - 2;
			IF source_index >= 0 THEN
				digit := digit + ((get_byte(raw, source_index / 8)
					>> (7 - (source_index % 8))) & 1);
			END IF;
		END LOOP;
		encoded := encoded || substr(alphabet, digit + 1, 1);
	END LOOP;
	RETURN 'ste_' || encoded;
END
$$;
--> statement-breakpoint
INSERT INTO "test_suite" ("id", "organization_id", "project_id", "name")
SELECT
	_migration_0040_test_suite_id(),
	"organization_id",
	"project_id",
	'Default'
FROM "test"
GROUP BY "organization_id", "project_id";
--> statement-breakpoint
UPDATE "test" AS existing
SET "suite_id" = suite."id"
FROM "test_suite" AS suite
WHERE suite."organization_id" = existing."organization_id"
	AND suite."project_id" = existing."project_id";
--> statement-breakpoint
DROP FUNCTION _migration_0040_test_suite_id();
--> statement-breakpoint
ALTER TABLE "test" ALTER COLUMN "suite_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "test" RENAME COLUMN "archived_at" TO "deleted_at";
--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_suite_project_fk" FOREIGN KEY ("suite_id","project_id") REFERENCES "public"."test_suite"("id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "test_suite_id_id_idx" ON "test" USING btree ("suite_id","id") WHERE "test"."deleted_at" is null;
--> statement-breakpoint

-- Old runs selected arbitrary versions. They cannot be presented as complete
-- suite runs, so their Postgres control plane is removed before suite_id and
-- required simulation pins are enforced. Cascades remove run events, plans,
-- simulations, and simulation grading jobs. Production grading jobs have no
-- run or simulation reference and remain.
DELETE FROM "idempotent_operation" WHERE "operation" = 'start_run';
--> statement-breakpoint
DELETE FROM "run";
--> statement-breakpoint

ALTER TABLE "run" RENAME COLUMN "label" TO "name";
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "suite_id" text COLLATE "C" NOT NULL;
--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_suite_project_fk" FOREIGN KEY ("suite_id","project_id") REFERENCES "public"."test_suite"("id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "run_suite_id_idx" ON "run" USING btree ("suite_id");
--> statement-breakpoint

ALTER TABLE "test_agent" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP TABLE "test_agent" CASCADE;
--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_capability_state_allowed";
--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_capability_evidence_agrees";
--> statement-breakpoint
ALTER TABLE "connection" DROP CONSTRAINT "connection_capabilities_supported_were_measured";
--> statement-breakpoint
ALTER TABLE "test" DROP CONSTRAINT "test_applicability_revision_prefix";
--> statement-breakpoint
ALTER TABLE "test" DROP CONSTRAINT "test_archive_reason_allowed";
--> statement-breakpoint
ALTER TABLE "test" DROP CONSTRAINT "test_archive_reason_needs_an_archive";
--> statement-breakpoint
ALTER TABLE "run" DROP CONSTRAINT "run_counts_written_together";
--> statement-breakpoint
ALTER TABLE "run" DROP CONSTRAINT "run_counts_are_counts";
--> statement-breakpoint
ALTER TABLE "run_event" DROP CONSTRAINT "run_event_simulation_shape";
--> statement-breakpoint
ALTER TABLE "run_event" DROP CONSTRAINT "run_event_verdict_agrees";
--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_test_pin_columns_agree";
--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_skipped_shape";
--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_skip_reason_belongs_to_a_skip";
--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_skip_reason_allowed";
--> statement-breakpoint
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_status_allowed";
--> statement-breakpoint
ALTER TABLE "grading_plan" DROP CONSTRAINT "grading_plan_recorded_plans_carry_their_moment";
--> statement-breakpoint
ALTER TABLE "grading_plan" DROP CONSTRAINT "grading_plan_unrecorded_holds_nothing";
--> statement-breakpoint
ALTER TABLE "grading_plan" DROP CONSTRAINT "grading_plan_state_allowed";
--> statement-breakpoint
ALTER TABLE "run" DROP CONSTRAINT "run_retry_of_run_id_run_id_fk";
--> statement-breakpoint
DROP INDEX "test_organization_id_project_id_idx";
--> statement-breakpoint

ALTER TABLE "simulation" ALTER COLUMN "test_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "simulation" ALTER COLUMN "test_version_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "grading_plan" ALTER COLUMN "captured_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "capability_state";
--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "capabilities_measured";
--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "capabilities_supported";
--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "capabilities_checked_at";
--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "capability_source";
--> statement-breakpoint
ALTER TABLE "test" DROP COLUMN "applicability_revision";
--> statement-breakpoint
ALTER TABLE "test" DROP COLUMN "archive_reason";
--> statement-breakpoint
UPDATE "test_version"
SET "content" = "content" - 'requiredCapabilities'
WHERE "content" ? 'requiredCapabilities';
--> statement-breakpoint
ALTER TABLE "run" DROP COLUMN "pinned_test_versions";
--> statement-breakpoint
ALTER TABLE "run" DROP COLUMN "requested_personas";
--> statement-breakpoint
ALTER TABLE "run" DROP COLUMN "skipped_count";
--> statement-breakpoint
ALTER TABLE "run" DROP COLUMN "retry_of_run_id";
--> statement-breakpoint
ALTER TABLE "simulation" DROP COLUMN "skip_reason";
--> statement-breakpoint
ALTER TABLE "simulation" DROP COLUMN "skipped_capabilities";
--> statement-breakpoint

ALTER TABLE "run" ADD CONSTRAINT "run_counts_written_together" CHECK ((("run"."completed_count" is null) = ("run"."failed_count" is null))
	and (("run"."failed_count" is null) = ("run"."canceled_count" is null))
	and (("run"."canceled_count" is null) = ("run"."finished_at" is null)));
--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_counts_are_counts" CHECK (("run"."completed_count" is null)
	or ("run"."completed_count" >= 0 and "run"."failed_count" >= 0
		and "run"."canceled_count" >= 0));
--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_simulation_shape" CHECK ("run_event"."kind" <> 'simulation'
	or ("run_event"."simulation_id" is not null
		and "run_event"."status" in ('queued', 'claimed', 'running', 'completed', 'failed', 'canceled')));
--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_verdict_agrees" CHECK ("run_event"."verdict" is null
	or ("run_event"."status" = 'completed' and "run_event"."verdict" in ('passed', 'failed', 'skipped'))
	or ("run_event"."status" = 'failed' and "run_event"."verdict" = 'errored')
	or ("run_event"."status" = 'canceled' and "run_event"."verdict" = 'skipped'));
--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_status_allowed" CHECK ("simulation"."status" in ('queued', 'claimed', 'running', 'completed', 'failed', 'canceled'));
--> statement-breakpoint
ALTER TABLE "grading_plan" ADD CONSTRAINT "grading_plan_state_allowed" CHECK ("grading_plan"."state" in ('run_start'));
--> statement-breakpoint
CREATE INDEX "test_organization_id_project_id_idx" ON "test" USING btree ("organization_id","project_id") WHERE "test"."deleted_at" is null;
--> statement-breakpoint

-- The clean cutover removes execution-level skipped status. Replace the
-- installed transition guard as well as its row checks, so the database does
-- not keep teaching or accepting the retired state through a hidden function.
CREATE OR REPLACE FUNCTION guard_simulation_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status IN ('completed', 'failed', 'canceled') THEN
		RAISE EXCEPTION 'simulation % is %, and a terminal simulation is written once',
			OLD.id, OLD.status;
	END IF;

	IF NEW.status = OLD.status THEN
		RETURN NEW;
	END IF;

	IF (OLD.status = 'queued' AND NEW.status IN ('claimed', 'canceled'))
	OR (OLD.status = 'claimed' AND NEW.status IN ('queued', 'running', 'failed', 'canceled'))
	OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'canceled'))
	THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'simulation % may not move from % to %',
		OLD.id, OLD.status, NEW.status;
END
$$;
--> statement-breakpoint

-- Membership never moves after create. A database trigger, rather than only
-- access checks, makes reparenting unrepresentable for every writer.
CREATE FUNCTION guard_test_suite_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.suite_id IS DISTINCT FROM OLD.suite_id THEN
		RAISE EXCEPTION 'test % belongs to suite % for life', OLD.id, OLD.suite_id
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER test_suite_membership_immutable
	BEFORE UPDATE OF suite_id ON "test"
	FOR EACH ROW EXECUTE FUNCTION guard_test_suite_membership();
