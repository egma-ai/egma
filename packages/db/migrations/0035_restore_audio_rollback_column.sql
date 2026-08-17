-- An earlier release candidate removed this field before the production-watch
-- migration reached main. A database that tested that candidate keeps the
-- removal even after the final 0034 is applied, while the mixed-release schema
-- needs the nullable field so an older API replica can still write it.
--
-- On an ordinary main database the column and all three checks already exist,
-- so this migration does nothing. Rebuilding valid checks would take a strong
-- table lock and revalidate every simulation for no repair benefit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'simulation'
       AND column_name = 'measured_audio_band_hertz'
  ) THEN
    ALTER TABLE "simulation"
      ADD COLUMN IF NOT EXISTS "measured_audio_band_hertz" integer;

    ALTER TABLE "simulation"
      DROP CONSTRAINT IF EXISTS "simulation_report_only_when_ended";
    ALTER TABLE "simulation"
      DROP CONSTRAINT IF EXISTS "simulation_audio_facts_are_voice_facts";
    ALTER TABLE "simulation"
      DROP CONSTRAINT IF EXISTS "simulation_audio_band_is_a_rate";

    ALTER TABLE "simulation"
      ADD CONSTRAINT "simulation_report_only_when_ended"
      CHECK ("simulation"."ended_at" is not null
        or ("simulation"."recording_reference" is null
          and "simulation"."measured_audio_band_hertz" is null));
    ALTER TABLE "simulation"
      ADD CONSTRAINT "simulation_audio_facts_are_voice_facts"
      CHECK ("simulation"."modality" = 'voice'
        or ("simulation"."measured_audio_band_hertz" is null
          and "simulation"."recording_reference" is null));
    ALTER TABLE "simulation"
      ADD CONSTRAINT "simulation_audio_band_is_a_rate"
      CHECK ("simulation"."measured_audio_band_hertz" is null
        or "simulation"."measured_audio_band_hertz" > 0);
  END IF;
END
$$;
