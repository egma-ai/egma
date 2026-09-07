-- THE STRIPE OBJECTS A PLAN IS SOLD THROUGH: the product, and the two meters
-- the overage prices read.
--
-- Purely additive: three nullable columns on `cloud_plan` and nothing else. The
-- code running before this migration never selects them, and a rollback leaves
-- three empty columns nothing reads.
--
-- `cloud_plan` already carried the three price ids. What it could not say was
-- which Stripe product they belong to, and which meter each metered price is
-- priced from — and a meter is the one Stripe object that cannot be recreated
-- from nothing, because Stripe's test-data deletion does not remove one. So the
-- meter id is kept here as the proof that this deployment already has it, found
-- by event name and created once.
--
-- All six stay nullable. Hobby has no Stripe object of any kind, a deployment
-- whose sandbox has not been set up has none either, and the allowances are
-- enforced from Egma's own rows and never from Stripe. See ADR-0024.

ALTER TABLE "cloud_plan" ADD COLUMN "stripe_product_id" text;--> statement-breakpoint
ALTER TABLE "cloud_plan" ADD COLUMN "stripe_web_call_meter_id" text;--> statement-breakpoint
ALTER TABLE "cloud_plan" ADD COLUMN "stripe_phone_meter_id" text;
