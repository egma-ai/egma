ALTER TABLE "agent" ADD COLUMN "monitoring_export_api_key_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_id_project_id_unique" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_monitoring_export_api_key_project_fk" FOREIGN KEY ("monitoring_export_api_key_id","project_id") REFERENCES "public"."api_key"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_monitoring_export_api_key_unique" ON "agent" USING btree ("monitoring_export_api_key_id") WHERE "agent"."monitoring_export_api_key_id" is not null;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_monitoring_export_key_needs_livekit" CHECK ("agent"."monitoring_export_api_key_id" is null or "agent"."agent_platform" = 'livekit');
