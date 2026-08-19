-- PRELAUNCH COMPATIBILITY EXCEPTION, confirmed by the founder on 2026-08-19:
-- Egma has not launched in production. This release intentionally changes a
-- persona from project-owned to Egma-owned in one step. An older API, a rollback
-- to it, or an old web client left open across this deployment is not supported.
-- The shared identity cannot satisfy the old API's project-owned-persona rule,
-- and keeping a compatibility copy would defeat this product decision.
ALTER TABLE "simulation" DROP CONSTRAINT "simulation_persona_project_fk";--> statement-breakpoint
ALTER TABLE "persona" DROP CONSTRAINT "persona_id_project_id_unique";--> statement-breakpoint
ALTER TABLE "persona" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "persona" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_tenancy_is_whole_or_egmas" CHECK (("persona"."organization_id" is null) = ("persona"."project_id" is null));--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_predefined_is_active" CHECK ("persona"."organization_id" is not null or "persona"."archived_at" is null);--> statement-breakpoint
CREATE UNIQUE INDEX "persona_predefined_name_unique" ON "persona" USING btree ("name") WHERE "persona"."organization_id" is null;--> statement-breakpoint

-- A normal foreign key cannot say "the persona is owned by this project OR by
-- Egma." Keep that rule in one database function and make every stored use of
-- a persona pass through it. Project ids are globally unique, so matching a
-- project-owned row also proves its organization.
CREATE FUNCTION persona_is_available_to_project(wanted_persona_id text, wanted_project_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
	SELECT EXISTS (
		SELECT 1
		FROM persona p
		WHERE p.id = wanted_persona_id
			AND (
				p.project_id = wanted_project_id
				OR (p.organization_id IS NULL AND p.project_id IS NULL)
			)
	);
$$;--> statement-breakpoint

-- The old default pointer proved only that the persona existed. Refuse the
-- upgrade if a raw write pointed a project at another project's persona; the
-- guards below must not be installed over a violation they would reject on the
-- next write. Use the future-write guard's SQLSTATE and constraint name so old
-- and new violations give an operator the same actionable integrity error.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM project target
		WHERE target.default_persona_id IS NOT NULL
			AND NOT persona_is_available_to_project(
				target.default_persona_id,
				target.id
			)
	) THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'project_default_persona_availability',
			MESSAGE = 'an installed default persona is not available to its project';
	END IF;
END;
$$;--> statement-breakpoint

-- The old schema checked only that both rows existed. Refuse the upgrade if a
-- raw write already linked a test version to another project's persona; adding
-- guards over bad installed data would preserve a violation behind them. This
-- uses the same SQLSTATE and constraint name as the write guard below, so an
-- operator gets one actionable integrity error for old and new violations.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM test_persona tp
		JOIN test_version tv ON tv.id = tp.test_version_id
		JOIN test t ON t.id = tv.test_id
		WHERE NOT persona_is_available_to_project(tp.persona_id, t.project_id)
	) THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'test_persona_availability',
			MESSAGE = 'an installed persona is not available to its test project';
	END IF;
END;
$$;--> statement-breakpoint

-- A project may point at one of its own personas or at a predefined persona,
-- and never at another project's. The old plain id foreign key still proves
-- the row exists; this trigger proves it is available here.
CREATE FUNCTION guard_project_default_persona_availability() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.default_persona_id IS NOT NULL
		AND NOT persona_is_available_to_project(NEW.default_persona_id, NEW.id)
	THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'project_default_persona_availability',
			MESSAGE = 'the default persona is not available to this project';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER project_default_persona_availability_insert_guard
BEFORE INSERT ON project
FOR EACH ROW EXECUTE FUNCTION guard_project_default_persona_availability();--> statement-breakpoint
CREATE TRIGGER project_default_persona_availability_update_guard
BEFORE UPDATE OF default_persona_id ON project
FOR EACH ROW EXECUTE FUNCTION guard_project_default_persona_availability();--> statement-breakpoint

-- test_persona does not carry project_id. Resolve it through the immutable
-- test-version identity and hold the same rule there. This also closes the old
-- raw-SQL hole that let a test version name another project's persona.
CREATE FUNCTION guard_test_persona_availability() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_project_id text;
BEGIN
	SELECT t.project_id INTO target_project_id
	FROM test_version tv
	JOIN test t ON t.id = tv.test_id
	WHERE tv.id = NEW.test_version_id;

	-- Let the existing prefix and foreign-key constraints explain a missing
	-- test version. This trigger adds only the project-availability rule.
	IF target_project_id IS NOT NULL
		AND NOT persona_is_available_to_project(NEW.persona_id, target_project_id)
	THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'test_persona_availability',
			MESSAGE = 'the persona is not available to this test project';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER test_persona_availability_insert_guard
BEFORE INSERT ON test_persona
FOR EACH ROW EXECUTE FUNCTION guard_test_persona_availability();--> statement-breakpoint
CREATE TRIGGER test_persona_availability_update_guard
BEFORE UPDATE OF test_version_id, persona_id ON test_persona
FOR EACH ROW EXECUTE FUNCTION guard_test_persona_availability();--> statement-breakpoint

-- Test ownership and a version's test are identity facts. If either could move
-- after a test_persona row passed the guard above, that link could become
-- invalid without touching the guarded row. Normal authoring never moves these
-- fields; it creates another identity or version instead.
CREATE FUNCTION guard_test_ownership_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.project_id IS DISTINCT FROM OLD.project_id
	THEN
		RAISE EXCEPTION 'a test ownership cannot change';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER test_ownership_immutable_guard
BEFORE UPDATE OF organization_id, project_id ON test
FOR EACH ROW EXECUTE FUNCTION guard_test_ownership_immutable();--> statement-breakpoint

CREATE FUNCTION guard_test_version_test_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.test_id IS DISTINCT FROM OLD.test_id
	THEN
		RAISE EXCEPTION 'a test version cannot move between tests';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER test_version_test_immutable_guard
BEFORE UPDATE OF test_id ON test_version
FOR EACH ROW EXECUTE FUNCTION guard_test_version_test_immutable();--> statement-breakpoint

-- A simulation keeps the persona/version composite foreign key. This guard
-- replaces only the project edge that a nullable predefined owner made unable
-- to fit in a normal composite key.
CREATE FUNCTION guard_simulation_persona_availability() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT persona_is_available_to_project(NEW.persona_id, NEW.project_id)
	THEN
		RAISE foreign_key_violation USING
			CONSTRAINT = 'simulation_persona_availability',
			MESSAGE = 'the persona is not available to this simulation project';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER simulation_persona_availability_insert_guard
BEFORE INSERT ON simulation
FOR EACH ROW EXECUTE FUNCTION guard_simulation_persona_availability();--> statement-breakpoint
CREATE TRIGGER simulation_persona_availability_update_guard
BEFORE UPDATE OF persona_id, project_id ON simulation
FOR EACH ROW EXECUTE FUNCTION guard_simulation_persona_availability();--> statement-breakpoint

-- Ownership is identity. Moving a persona between a project and Egma would
-- invalidate the three availability decisions above without touching their
-- rows, so it is refused at the row that owns the fact.
CREATE FUNCTION guard_persona_ownership_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.project_id IS DISTINCT FROM OLD.project_id
	THEN
		RAISE EXCEPTION 'a persona ownership cannot change';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER persona_ownership_immutable_guard
BEFORE UPDATE OF organization_id, project_id ON persona
FOR EACH ROW EXECUTE FUNCTION guard_persona_ownership_immutable();
