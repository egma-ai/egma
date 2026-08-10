-- Who this deployment is: one row, minted on first ask and never rewritten.
--
-- An agent repository commits the platform it belongs to, and an origin alone
-- cannot say whether the egma answering there today is the egma that minted its
-- identifiers. This is the fact that can: it lives with the data, so a restart,
-- a new container or a moved address keeps it, and a different deployment later
-- served at the same address never has it.
--
-- `only` is the whole primary key, so a second row is unrepresentable and two
-- instances booting together race on it rather than both writing one.
CREATE TABLE "platform_instance" (
	"only" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" text COLLATE "C" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_instance_only_one" CHECK ("platform_instance"."only"),
	CONSTRAINT "platform_instance_id_prefix" CHECK ("platform_instance"."id" ~ '^ins_[0-9A-HJKMNP-TV-Z]{26}$')
);
