ALTER TABLE "simulation" ADD COLUMN "test_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "simulation" ADD COLUMN "test_version_id" text COLLATE "C";--> statement-breakpoint
-- Moved ahead of the two foreign keys that target them; the generator emits
-- the unique constraints last, and a key cannot reference one that does not
-- exist yet. The same reordering 0007 made for the persona pin's pair.
ALTER TABLE "test" ADD CONSTRAINT "test_id_project_id_unique" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "test_version" ADD CONSTRAINT "test_version_id_test_id_unique" UNIQUE("id","test_id");--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_test_version_test_fk" FOREIGN KEY ("test_version_id","test_id") REFERENCES "public"."test_version"("id","test_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_test_project_fk" FOREIGN KEY ("test_id","project_id") REFERENCES "public"."test"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "simulation_test_version_id_idx" ON "simulation" USING btree ("test_version_id");--> statement-breakpoint
CREATE INDEX "simulation_test_id_idx" ON "simulation" USING btree ("test_id");--> statement-breakpoint
ALTER TABLE "simulation" ADD CONSTRAINT "simulation_test_pin_columns_agree" CHECK (("simulation"."test_id" is null) = ("simulation"."test_version_id" is null));