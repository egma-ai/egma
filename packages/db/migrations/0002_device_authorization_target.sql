-- Which organization and project a terminal is being authorized for. The
-- provider's device flow has no field for either, and the choice is made in the
-- browser at the moment of approval, so it is recorded here and read again when
-- the terminal exchanges its code for a key.
ALTER TABLE "device_code" ADD COLUMN "organization_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "device_code" ADD COLUMN "project_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_code_expires_at_idx" ON "device_code" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_authorized_for_agrees" CHECK (("device_code"."organization_id" is null) = ("device_code"."project_id" is null));