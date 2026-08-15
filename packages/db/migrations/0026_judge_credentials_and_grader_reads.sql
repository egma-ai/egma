-- Judge credentials move to the organization, and a grader version says what
-- it reads and what it can score.
--
-- Two changes, and the order inside each is the whole of its safety.
--
-- **A grader version gains `reads` and `modalities`.** Both are added
-- nullable, backfilled from the type registry's defaults, and only then made
-- NOT NULL and checked. The defaults are not a decision taken here: they state
-- the behaviour these versions have already been shipping, which is why this
-- backfill mints no new version and changes no verdict's meaning.
--
-- **A project's judge key moves onto an organization credential.** Every
-- existing `judge_configuration` row gets **its own** credential, carrying its
-- own sealed envelope byte for byte — never one credential shared by several
-- projects. Two projects of one organization configured with two different
-- keys therefore stay two keys, because merging them would silently start
-- billing one team's account for the other team's grading, and nothing in a
-- migration could tell that the two keys were meant to be the same.
--
-- The envelope is moved rather than re-sealed: it is already sealed with this
-- deployment's own key, so copying the ciphertext keeps every existing
-- configuration judging without anything having to open a secret to upgrade.
--
-- A row that stays `platform` is one nothing has migrated *to* — the
-- deployment's own judge, written by seeding — and none exists at this point,
-- because seeding only started writing the word in this same release. Existing
-- rows are all `credential` after this runs.

CREATE TABLE "judge_credential" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"organization_id" text COLLATE "C" NOT NULL,
	"label" text NOT NULL,
	"provider" text NOT NULL,
	"credentials" text NOT NULL,
	"credentials_hint" text NOT NULL,
	"revision" text COLLATE "C" NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text COLLATE "C",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judge_credential_id_prefix" CHECK ("judge_credential"."id" ~ '^jcr_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "judge_credential_revision_prefix" CHECK ("judge_credential"."revision" ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "judge_credential_provider_allowed" CHECK ("judge_credential"."provider" in ('openai'))
);
--> statement-breakpoint
ALTER TABLE "judge_credential" ADD CONSTRAINT "judge_credential_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_credential" ADD CONSTRAINT "judge_credential_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "judge_credential_organization_id_idx" ON "judge_credential" USING btree ("organization_id") WHERE "judge_credential"."archived_at" is null;--> statement-breakpoint

-- An identifier in egma's own format, minted in SQL for rows nobody was there
-- to mint one for. Uppercase hexadecimal is a subset of the Crockford alphabet
-- the check constraint names, so these pass the same pattern every minted
-- identifier does; they sort by nothing meaningful, which is correct, because
-- their order is a migration's rather than anybody's mint order.
--
-- **Derived from the row it is for rather than from a clock**, so the statement
-- that creates a credential and the statement that points a project at it work
-- the identifier out independently and arrive at the same one. The alternative
-- is joining rows back together on their ciphertext, which is a match on a
-- secret and is exactly the kind of thing a migration should not need.
CREATE FUNCTION pg_temp.migration_id(prefix text, seed text) RETURNS text AS $$
	SELECT prefix || '_' || upper(substr(md5(seed), 1, 26));
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint

-- The live revision of every grader that already exists. Any value satisfying
-- the format will do: what a revision means is "the state you read", and no
-- caller has read one of these yet.
ALTER TABLE "grader" ADD COLUMN "revision" text COLLATE "C";--> statement-breakpoint
UPDATE "grader" SET "revision" = pg_temp.migration_id('rev', 'grader:' || "id") WHERE "revision" IS NULL;--> statement-breakpoint
ALTER TABLE "grader" ALTER COLUMN "revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "grader" ADD CONSTRAINT "grader_revision_prefix" CHECK ("grader"."revision" ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$');--> statement-breakpoint

-- What each existing version reads, from its grader's type — the registry's
-- defaults, which state the behaviour already shipped rather than choose a new
-- one. Every existing version scores both modalities, which is what every one
-- of them has been doing.
ALTER TABLE "grader_version" ADD COLUMN "reads" text[];--> statement-breakpoint
ALTER TABLE "grader_version" ADD COLUMN "modalities" text[];--> statement-breakpoint
UPDATE "grader_version" AS gv
SET "reads" = CASE g."type"
		WHEN 'metric_threshold' THEN array['measures']
		WHEN 'tool_calls' THEN array['tool_calls']
		ELSE array['transcript']
	END,
	"modalities" = array['voice', 'chat']
FROM "grader" AS g
WHERE g."id" = gv."grader_id";--> statement-breakpoint
-- A version whose grader row has gone leaves the join above with nothing, and
-- a verdict may still name it. It reads the transcript and scores both, which
-- is the widest honest reading of a row nothing can ask about any more.
UPDATE "grader_version"
SET "reads" = array['transcript'], "modalities" = array['voice', 'chat']
WHERE "reads" IS NULL OR "modalities" IS NULL;--> statement-breakpoint
ALTER TABLE "grader_version" ALTER COLUMN "reads" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "grader_version" ALTER COLUMN "modalities" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "grader_version" ADD CONSTRAINT "grader_version_reads_are_a_nonempty_known_set" CHECK (array_length("grader_version"."reads", 1) >= 1 and "grader_version"."reads" <@ array['transcript', 'outcome', 'tool_calls', 'measures']::text[]);--> statement-breakpoint
ALTER TABLE "grader_version" ADD CONSTRAINT "grader_version_modalities_are_a_nonempty_known_set" CHECK (array_length("grader_version"."modalities", 1) >= 1 and "grader_version"."modalities" <@ array['voice', 'chat']::text[]);--> statement-breakpoint

ALTER TABLE "judge_configuration" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "judge_configuration" ADD COLUMN "credential_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "judge_configuration" ADD CONSTRAINT "judge_configuration_credential_id_judge_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."judge_credential"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- One credential per existing configuration, labelled from the project it was
-- configured for, holding that configuration's own sealed envelope.
INSERT INTO "judge_credential" (
	"id", "organization_id", "label", "provider",
	"credentials", "credentials_hint", "revision", "created_by",
	"created_at", "updated_at"
)
SELECT
	pg_temp.migration_id('jcr', 'judge-credential:' || jc."project_id"),
	jc."organization_id",
	coalesce(p."slug", jc."project_id") || ' judge key',
	jc."provider",
	jc."credentials",
	jc."credentials_hint",
	pg_temp.migration_id('rev', 'judge-credential:' || jc."project_id"),
	jc."created_by",
	jc."created_at",
	jc."updated_at"
FROM "judge_configuration" AS jc
LEFT JOIN "project" AS p ON p."id" = jc."project_id"
WHERE jc."credentials" IS NOT NULL;--> statement-breakpoint

-- The columns stop being required before anything empties them, because a
-- project that has handed its envelope to a credential must hold none.
ALTER TABLE "judge_configuration" ALTER COLUMN "credentials" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "judge_configuration" ALTER COLUMN "credentials_hint" DROP NOT NULL;--> statement-breakpoint

-- Then, and only then, the project points at its credential and stops holding
-- a secret of its own. Reference written and envelope dropped in one statement,
-- so there is no instant at which a configuration names neither.
UPDATE "judge_configuration" AS jc
SET "source" = 'credential',
	"credential_id" = pg_temp.migration_id('jcr', 'judge-credential:' || jc."project_id"),
	"credentials" = NULL,
	"credentials_hint" = NULL
WHERE jc."credentials" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "judge_configuration" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "judge_configuration" ADD CONSTRAINT "judge_configuration_source_allowed" CHECK ("judge_configuration"."source" in ('credential', 'platform'));--> statement-breakpoint
ALTER TABLE "judge_configuration" ADD CONSTRAINT "judge_configuration_has_one_key_source" CHECK (("judge_configuration"."source" = 'credential' and "judge_configuration"."credential_id" is not null and "judge_configuration"."credentials" is null and "judge_configuration"."credentials_hint" is null) or ("judge_configuration"."source" = 'platform' and "judge_configuration"."credential_id" is null and "judge_configuration"."credentials" is not null));
