-- Carry the old generated LiveKit names into the modality-specific naming
-- scheme. The old rows do not record whether a name was generated or typed,
-- so this clean cut treats every exact livekit_room-N shape as legacy. Every
-- name outside that former generated namespace remains customer-owned.
--
-- A custom or already-migrated connection may own a direct target such as
-- livekit_chat-1. Keep that row and give the legacy row the first free number,
-- while reserving the direct target of every legacy row still to be renamed.
-- Archived rows take part too, so every migrated name can be restored later.

lock table "connection" in share row exclusive mode;

do $$
declare
  legacy record;
  stem text;
  target_name text;
  candidate_number bigint;
begin
  for legacy in
    select id, agent_id, modality, name, archived_at
      from "connection"
     where connection_type = 'livekit_room'
       and name ~ '^livekit_room-[1-9][0-9]*$'
     order by agent_id, archived_at is not null, name collate "C", id
  loop
    stem := case legacy.modality
      when 'chat' then 'livekit_chat'
      else 'livekit_voice'
    end;
    target_name := stem || '-' || substring(
      legacy.name from '^livekit_room-([1-9][0-9]*)$'
    );

    if exists (
      select 1
       from "connection" occupied
       where occupied.agent_id = legacy.agent_id
         and occupied.id <> legacy.id
         and occupied.name = target_name
    ) then
      candidate_number := 1;
      loop
        target_name := stem || '-' || candidate_number::text;
        exit when not exists (
          select 1
            from "connection" occupied
           where occupied.agent_id = legacy.agent_id
             and occupied.id <> legacy.id
             and occupied.name = target_name
        ) and not exists (
          select 1
            from "connection" reserved
           where reserved.agent_id = legacy.agent_id
             and reserved.id <> legacy.id
             and reserved.connection_type = 'livekit_room'
             and reserved.modality = legacy.modality
             and reserved.name ~ '^livekit_room-[1-9][0-9]*$'
             and stem || '-' || substring(
               reserved.name from '^livekit_room-([1-9][0-9]*)$'
             ) = target_name
        );
        candidate_number := candidate_number + 1;
      end loop;
    end if;

    update "connection"
       set name = target_name,
           updated_at = now()
     where id = legacy.id;
  end loop;
end
$$;
