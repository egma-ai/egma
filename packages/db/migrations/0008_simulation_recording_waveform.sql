ALTER TABLE public.simulation
  ADD COLUMN IF NOT EXISTS recording_waveform jsonb;

ALTER TABLE public.simulation
  ADD CONSTRAINT simulation_waveform_needs_recording CHECK (recording_waveform IS NULL OR recording_reference IS NOT NULL);

ALTER TABLE public.simulation
  ADD CONSTRAINT simulation_waveform_channels_match CHECK (recording_waveform IS NULL OR jsonb_array_length(recording_waveform->'human') = jsonb_array_length(recording_waveform->'agent'));
