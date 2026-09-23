ALTER TABLE public.agent
  DROP CONSTRAINT agent_platform_allowed,
  ADD CONSTRAINT agent_platform_allowed CHECK ((agent_platform = ANY (ARRAY['retell'::text, 'livekit'::text, 'pipecat'::text])));

ALTER TABLE public.connection
  DROP CONSTRAINT connection_type_allowed,
  ADD CONSTRAINT connection_type_allowed CHECK ((connection_type = ANY (ARRAY['retell_chat_api'::text, 'retell_text_mode'::text, 'retell_web_call'::text, 'phone_number'::text, 'livekit_room'::text, 'daily_room'::text])));

ALTER TABLE public.connection
  DROP CONSTRAINT connection_access_variant_allowed,
  ADD CONSTRAINT connection_access_variant_allowed CHECK ((access_variant = ANY (ARRAY['retell_chat_api.api_key'::text, 'retell_text_mode.api_key'::text, 'retell_web_call.api_key'::text, 'phone_number.public_e164'::text, 'livekit_room.project_credentials'::text, 'livekit_room.customer_token_endpoint'::text, 'daily_room.pipecat_cloud'::text, 'daily_room.self_hosted'::text])));

ALTER TABLE public.simulation
  DROP CONSTRAINT simulation_connection_type_allowed,
  ADD CONSTRAINT simulation_connection_type_allowed CHECK ((connection_type = ANY (ARRAY['retell_chat_api'::text, 'retell_text_mode'::text, 'retell_web_call'::text, 'phone_number'::text, 'livekit_room'::text, 'daily_room'::text])));

ALTER TABLE public.simulation
  ADD COLUMN IF NOT EXISTS agent_report jsonb;

ALTER TABLE public.simulation
  ADD CONSTRAINT simulation_agent_report_is_object CHECK (agent_report IS NULL OR jsonb_typeof(agent_report) = 'object');
