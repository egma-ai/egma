-- 0042 is already recorded in the hosted test database and is immutable.
-- Apply the required-platform cutover here instead. Agents created after 0042
-- may hold its original LiveKit value, which is normalized before the new
-- constraint is installed. Pre-0042 agents have no recoverable platform after
-- that migration dropped connection.agent_platform; a reset must remove those
-- null rows before this accepted pre-launch cutover can run.
ALTER TABLE "agent" DROP CONSTRAINT "agent_platform_allowed";--> statement-breakpoint
UPDATE "agent"
SET "agent_platform" = 'livekit'
WHERE "agent_platform" = 'livekit_agents';--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "agent_platform" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_platform_allowed" CHECK ("agent"."agent_platform" in ('retell', 'livekit'));
