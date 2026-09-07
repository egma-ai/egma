-- WHICH SUBSCRIPTION EVENT AN ACCOUNT IS ALREADY AT.
--
-- Purely additive: one nullable column on `cloud_billing_account`. The code
-- running before this migration never selects it, and a rollback leaves an
-- empty column nothing reads.
--
-- Stripe does not promise the order it delivers webhooks in, and the plan, the
-- status and the anchor were written from whichever subscription event turned
-- up. So an older `customer.subscription.updated` arriving after a newer
-- `customer.subscription.deleted` put a customer who had cancelled back on Pro
-- and left them there until Stripe sent something else. This column holds the
-- `created` instant of the last subscription event applied, and an event
-- stamped no later than it is recorded as seen and changes nothing.
--
-- Null on every existing row, which is the right start: the first subscription
-- event an account meets is applied and sets the mark, and a Hobby account
-- that never buys a plan keeps a null for ever.

ALTER TABLE "cloud_billing_account" ADD COLUMN "stripe_subscription_event_at" timestamp with time zone;
