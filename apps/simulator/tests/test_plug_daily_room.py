"""The daily_room plug: readiness, every startup failure, and chat turns.

The lifecycle, RTVI handling and turn logic are production code; the room and
the start request are the offline doubles in daily_room_stub.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from daily_room_stub import (
    BOT_ID,
    FakeBot,
    Step,
    answer,
    answer_through_a_tool,
    rigged,
    rtvi,
)

from egma_simulator.contract import AGENT_NEVER_JOINED, ERROR
from egma_simulator.media import MediaBackendError
from egma_simulator.media import daily_room as daily
from egma_simulator.media.daily_room import (
    AgentReport,
    AgentReportLost,
    DailyVoiceRoom,
    DailyWayIn,
    PipecatChatBackend,
    PipecatVoiceBackend,
    RoomEvents,
    RtviTurns,
    StartSettings,
)
from egma_simulator.plugs import PlugError, VoiceConnection, plug_for
from egma_simulator.plugs import daily_room as daily_plug
from egma_simulator.plugs.daily_room import DailyRoomChat, DailyRoomVoice

A_SIMULATION = "sim_01K5TB2H8Y4P7QCWF9XKMD6RZP"
A_PUBLIC_KEY = "pk_SENTINEL0public0key0for0tests"
FLOWS_REFUSAL = (
    'the test mocks "route_to_billing", and this is a Pipecat Flows function; '
    "Egma cannot mock it yet. Remove it from the test's mock tools. Flows "
    "functions that are not mocked run for real and are recorded."
)


def cloud() -> StartSettings:
    return StartSettings.from_connection(
        "daily_room.pipecat_cloud",
        {"agentName": "lakeside-front-desk"},
        {"publicApiKey": A_PUBLIC_KEY},
    )


def self_hosted() -> StartSettings:
    return StartSettings.from_connection(
        "daily_room.self_hosted",
        {"startUrl": "https://bots.lakeside-dental.example/start"},
        {"headers": json.dumps({"Authorization": "Bearer SENTINEL"})},
    )


@pytest.fixture
def quick(monkeypatch: pytest.MonkeyPatch) -> None:
    """Short windows, so a timed-out startup takes a fraction of a second."""
    monkeypatch.setattr(daily, "PIPECAT_STARTUP_SECONDS", 0.4)
    monkeypatch.setattr(daily, "AGENT_REPORT_POLL_SECONDS", 0.02)
    monkeypatch.setattr(daily, "AGENT_REPORT_WATCH_SECONDS", 0.02)
    monkeypatch.setattr(daily, "QUIET_SECONDS", 0.3)
    monkeypatch.setattr(daily, "SPEECH_WAIT_SECONDS", 2.0)
    monkeypatch.setattr(daily_plug, "GREETING_SECONDS", 0.3)
    monkeypatch.setattr(daily_plug, "REPLY_SECONDS", 0.3)


async def voice_ready(rig: Any) -> str:
    await rig.backend.create_transport()
    await rig.backend.dial()
    return await rig.backend.wait_started()


async def chat_ready(rig: Any) -> str:
    await rig.backend.open_room()
    return await rig.backend.wait_started()


def client_readies(rig: Any) -> list[dict[str, Any]]:
    return [message for message in rig.room.sent if message["type"] == "client-ready"]


# -- The plug registry ---------------------------------------------------------


def test_daily_room_is_registered_for_voice_and_chat():
    factory = plug_for("daily_room")
    assert factory is not None
    common = {
        "access_variant": "daily_room.pipecat_cloud",
        "config": {"agentName": "lakeside-front-desk"},
        "credentials": {"publicApiKey": A_PUBLIC_KEY},
        "simulation_id": A_SIMULATION,
        "max_duration_seconds": 600,
        "pipecat_body_params": {"tenant": "lakeside"},
    }
    voice = factory(modality="voice", **common)
    chat = factory(modality="chat", **common)
    assert isinstance(voice, DailyRoomVoice)
    assert isinstance(voice, VoiceConnection)
    assert isinstance(chat, DailyRoomChat)
    assert voice.provider_reference is None


def test_an_unusable_connection_is_a_plug_refusal():
    factory = plug_for("daily_room")
    assert factory is not None
    with pytest.raises(PlugError) as refused:
        factory(
            modality="voice",
            access_variant="daily_room.self_hosted",
            config={"startUrl": "http://bots.example/start"},
            credentials={"headers": '{"Authorization": "Bearer x"}'},
            simulation_id=A_SIMULATION,
            max_duration_seconds=600,
        )
    assert "startUrl" in str(refused.value)
    assert refused.value.ending == ERROR


# -- Readiness -------------------------------------------------------------------


async def test_the_reference_is_registered_before_the_start_request():
    rig = rigged(PipecatVoiceBackend, settings=cloud())
    try:
        reference = await voice_ready(rig)
    finally:
        await rig.backend.teardown()
    assert rig.order == [f"register:{A_SIMULATION}", "start"]
    assert reference == A_SIMULATION
    assert rig.backend.provider_reference == A_SIMULATION


@pytest.mark.parametrize("kind", [PipecatVoiceBackend, PipecatChatBackend])
async def test_a_warm_bot_starts_at_once(kind: Any, quick: None):
    rig = rigged(kind, settings=cloud())
    loop = asyncio.get_running_loop()
    began = loop.time()
    try:
        if kind is PipecatVoiceBackend:
            await voice_ready(rig)
        else:
            await chat_ready(rig)
        took = loop.time() - began
    finally:
        await rig.backend.teardown()
    assert took < 0.2
    (ready,) = client_readies(rig)
    assert ready["label"] == "rtvi-ai"
    assert ready["data"]["version"] == "2.1.0"
    assert ready["id"]


async def test_client_ready_waits_for_the_bot_to_be_in_the_room(quick: None):
    rig = rigged(PipecatVoiceBackend, settings=cloud(), bot_here_at_join=False)
    try:
        await rig.backend.create_transport()
        await rig.backend.dial()
        waiting = asyncio.ensure_future(rig.backend.wait_started())
        await asyncio.sleep(0.05)
        assert client_readies(rig) == []
        rig.room.bot_joins()
        await asyncio.wait_for(waiting, 1)
        assert len(client_readies(rig)) == 1
    finally:
        await rig.backend.teardown()


async def test_client_ready_is_sent_exactly_once_even_without_bot_ready(
    quick: None,
):
    rig = rigged(PipecatVoiceBackend, settings=cloud(), bot=FakeBot(rtvi_on=False))
    try:
        await voice_ready(rig)
        rig.room.bot_joins()
        await asyncio.sleep(0.3)
        assert len(client_readies(rig)) == 1
    finally:
        await rig.backend.teardown()


@pytest.mark.parametrize(
    ("kind", "modality"),
    [(PipecatVoiceBackend, "voice"), (PipecatChatBackend, "chat")],
)
def test_the_start_body_tells_the_sdk_the_modality(kind: Any, modality: str):
    rig = rigged(kind, settings=cloud())
    body = rig.backend.starter.request_body()["body"]
    assert body == {"egma": {"simulation_id": A_SIMULATION, "modality": modality}}


@pytest.mark.parametrize("kind", [PipecatVoiceBackend, PipecatChatBackend])
async def test_a_hello_refused_after_readiness_ends_the_simulation(
    kind: Any, quick: None
):
    rig = rigged(
        kind,
        settings=cloud(),
        reports=[
            AgentReport(state="accepted"),
            AgentReport(state="accepted"),
            AgentReport(state="refused", code=905, message=FLOWS_REFUSAL),
        ],
    )
    try:
        if kind is PipecatVoiceBackend:
            media = await rig.backend.create_transport()
            await rig.backend.dial()
            await rig.backend.wait_started()
            await asyncio.wait_for(media.failed.wait(), 1)
            assert media.fault() == FLOWS_REFUSAL
        else:
            await chat_ready(rig)
            with pytest.raises(MediaBackendError) as refused:
                await asyncio.wait_for(rig.backend.wait_failed(), 1)
            assert str(refused.value) == FLOWS_REFUSAL
            assert refused.value.ending == ERROR
    finally:
        await rig.backend.teardown()
    assert rig.probes >= 3


async def test_a_refused_hello_ends_a_chat_turn_in_progress(
    quick: None, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(daily_plug, "REPLY_SECONDS", 5.0)
    refuse = asyncio.Event()

    async def report() -> AgentReport:
        if refuse.is_set():
            return AgentReport(state="refused", code=905, message=FLOWS_REFUSAL)
        return AgentReport(state="accepted")

    rig = rigged(PipecatChatBackend, settings=cloud(), bot=FakeBot(replies=[]))
    rig.backend._agent_report = report
    plug = chat_plug(rig)
    try:
        await plug.open()
        delivering = asyncio.ensure_future(plug.deliver("Transfer me to billing."))
        await asyncio.sleep(0.05)
        assert not delivering.done()
        refuse.set()
        with pytest.raises(PlugError) as refused:
            await asyncio.wait_for(delivering, 2)
    finally:
        await plug.close()
    assert str(refused.value) == FLOWS_REFUSAL
    assert refused.value.ending == ERROR


@pytest.mark.parametrize(
    ("settings", "advice"),
    [
        (cloud, "keep one instance warm with min_agents = 1 in pcc-deploy.toml"),
        (self_hosted, "Check your starter's and your bot's logs for a crash"),
    ],
)
async def test_a_bot_that_never_joins_is_named(settings: Any, advice: str, quick: None):
    rig = rigged(PipecatVoiceBackend, settings=settings(), bot_here_at_join=False)
    try:
        with pytest.raises(MediaBackendError) as refused:
            await voice_ready(rig)
    finally:
        await rig.backend.teardown()
    assert str(refused.value).startswith("your bot did not join within")
    assert advice in str(refused.value)
    assert refused.value.ending == AGENT_NEVER_JOINED


async def test_a_bot_that_joins_without_the_sdk_is_named(quick: None):
    rig = rigged(
        PipecatVoiceBackend, settings=cloud(), reports=[AgentReport(state="waiting")]
    )
    try:
        with pytest.raises(MediaBackendError) as refused:
            await voice_ready(rig)
    finally:
        await rig.backend.teardown()
    assert str(refused.value).startswith(
        "your bot joined but did not report to Egma within"
    )
    assert refused.value.ending == ERROR
    assert rig.probes > 3


async def test_a_mocked_flows_function_fails_at_once_in_the_servers_words(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(daily, "AGENT_REPORT_POLL_SECONDS", 0.01)
    rig = rigged(
        PipecatVoiceBackend,
        settings=cloud(),
        bot_here_at_join=False,
        reports=[
            AgentReport(state="waiting"),
            AgentReport(state="refused", code=905, message=FLOWS_REFUSAL),
        ],
    )
    loop = asyncio.get_running_loop()
    began = loop.time()
    try:
        with pytest.raises(MediaBackendError) as refused:
            await voice_ready(rig)
    finally:
        await rig.backend.teardown()
    assert str(refused.value) == FLOWS_REFUSAL
    assert refused.value.ending == ERROR
    assert loop.time() - began < 1.0


async def test_another_refused_report_is_named_as_egmas_refusal(quick: None):
    rig = rigged(
        PipecatChatBackend,
        settings=cloud(),
        reports=[AgentReport(state="refused", code=904, message="version 2")],
    )
    try:
        with pytest.raises(MediaBackendError) as refused:
            await chat_ready(rig)
    finally:
        await rig.backend.teardown()
    assert str(refused.value) == (
        "your bot reported to Egma and Egma refused the report (version 2), so no "
        "tool was isolated."
    )


async def test_a_voice_bot_without_an_audio_track_is_named(quick: None):
    rig = rigged(PipecatVoiceBackend, settings=cloud(), bot_audio=False)
    try:
        with pytest.raises(MediaBackendError) as refused:
            await voice_ready(rig)
    finally:
        await rig.backend.teardown()
    assert str(refused.value).startswith(
        "your bot joined and reported to Egma but published no audio track"
    )


async def test_a_voice_bot_is_ready_when_its_audio_arrives(quick: None):
    rig = rigged(PipecatVoiceBackend, settings=cloud(), bot_audio=False)
    try:
        await rig.backend.create_transport()
        await rig.backend.dial()
        waiting = asyncio.ensure_future(rig.backend.wait_started())
        await asyncio.sleep(0.05)
        assert not waiting.done()
        rig.room.events.audio(BOT_ID)
        await asyncio.wait_for(waiting, 1)
    finally:
        await rig.backend.teardown()


async def test_a_chat_bot_with_rtvi_off_is_named(quick: None):
    rig = rigged(PipecatChatBackend, settings=cloud(), bot=FakeBot(rtvi_on=False))
    try:
        with pytest.raises(MediaBackendError) as refused:
            await chat_ready(rig)
    finally:
        await rig.backend.teardown()
    assert str(refused.value).startswith("your bot has RTVI turned off:")
    assert refused.value.ending == ERROR


async def test_a_voice_bot_with_rtvi_off_still_starts(quick: None):
    rig = rigged(PipecatVoiceBackend, settings=cloud(), bot=FakeBot(rtvi_on=False))
    try:
        assert await voice_ready(rig) == A_SIMULATION
    finally:
        await rig.backend.teardown()


async def test_a_lost_claim_stops_the_startup(quick: None):
    async def lost() -> AgentReport:
        raise AgentReportLost("This claim does not hold that simulation.")

    rig = rigged(PipecatVoiceBackend, settings=cloud())
    rig.backend._agent_report = lost
    try:
        with pytest.raises(MediaBackendError) as refused:
            await voice_ready(rig)
    finally:
        await rig.backend.teardown()
    assert "no longer lets this simulator hold" in str(refused.value)


async def test_the_duration_limit_during_startup_names_the_missing_fact(quick: None):
    rig = rigged(
        PipecatVoiceBackend, settings=cloud(), reports=[AgentReport(state="waiting")]
    )
    voice = DailyRoomVoice(
        modality="voice",
        access_variant="daily_room.pipecat_cloud",
        config={"agentName": "lakeside-front-desk"},
        credentials={"publicApiKey": A_PUBLIC_KEY},
        simulation_id=A_SIMULATION,
        max_duration_seconds=600,
        driver=lambda **_kwargs: rig.backend,
    )
    try:
        await voice.prepare()
        opening = asyncio.ensure_future(voice.open())
        await asyncio.sleep(0.05)
        opening.cancel()
        await asyncio.gather(opening, return_exceptions=True)
        failure = voice.startup_duration_failure(30)
    finally:
        await voice.close()
    assert isinstance(failure, PlugError)
    assert str(failure).startswith(
        "your bot joined but did not report to Egma within 30 seconds."
    )
    assert str(failure).endswith(
        "; the simulation's configured 30s duration expired during startup"
    )


async def test_the_duration_limit_during_start_retries_names_capacity(quick: None):
    rig = rigged(PipecatVoiceBackend, settings=cloud())
    starter = rig.backend.starter
    starter.attempts = 3
    starter.last_retry = daily._Retry(status=429, cause="HTTP 429")
    failure = rig.backend.startup_duration_failure(60)
    assert str(failure) == (
        'Pipecat Cloud had no free capacity for agent "lakeside-front-desk": it '
        "answered HTTP 429 to every start request for 60 seconds. Raise the "
        "agent's max_agents in Pipecat Cloud, or run fewer simulations at once.; "
        "the simulation's configured 60s duration expired during startup"
    )


async def test_a_voice_plug_turns_room_faults_into_plug_errors(quick: None):
    rig = rigged(PipecatVoiceBackend, settings=cloud(), bot_here_at_join=False)
    voice = DailyRoomVoice(
        modality="voice",
        access_variant="daily_room.pipecat_cloud",
        config={"agentName": "lakeside-front-desk"},
        credentials={"publicApiKey": A_PUBLIC_KEY},
        simulation_id=A_SIMULATION,
        max_duration_seconds=600,
        driver=lambda **_kwargs: rig.backend,
    )
    try:
        await voice.prepare()
        with pytest.raises(PlugError) as refused:
            await voice.open()
    finally:
        await voice.close()
    assert refused.value.ending == AGENT_NEVER_JOINED
    assert voice.provider_reference == A_SIMULATION


async def test_the_bot_leaving_ends_the_voice_exchange(quick: None):
    rig = rigged(PipecatVoiceBackend, settings=cloud())
    try:
        media = await rig.backend.create_transport()
        await rig.backend.dial()
        await rig.backend.wait_started()
        await rig.room.bot_leaves()
        assert media.ended.is_set()
        assert rig.room.departures == 1
    finally:
        await rig.backend.teardown()


async def test_teardown_asks_an_rtvi_bot_to_end_and_leaves(quick: None):
    rig = rigged(PipecatChatBackend, settings=cloud())
    await chat_ready(rig)
    room = rig.room
    await rig.backend.teardown()
    assert room.left
    assert room.sent[-1]["type"] == "disconnect-bot"


# -- Chat turns ------------------------------------------------------------------


def chat_plug(rig: Any) -> DailyRoomChat:
    return DailyRoomChat(
        modality="chat",
        access_variant="daily_room.pipecat_cloud",
        config={"agentName": "lakeside-front-desk"},
        credentials={"publicApiKey": A_PUBLIC_KEY},
        simulation_id=A_SIMULATION,
        max_duration_seconds=600,
        driver=lambda **_kwargs: rig.backend,
    )


async def test_a_chat_turn_is_sent_as_send_text_and_read_from_llm_text(quick: None):
    bot = FakeBot(replies=[answer("We open at nine on Saturday.")])
    rig = rigged(PipecatChatBackend, settings=cloud(), bot=bot)
    plug = chat_plug(rig)
    try:
        assert await plug.open() is None
        loop = asyncio.get_running_loop()
        asked_at = loop.time()
        reply = await plug.deliver("When are you open on Saturday?")
    finally:
        await plug.close()
    assert reply.text == "We open at nine on Saturday."
    assert not reply.ended
    assert reply.answered_at is not None and reply.answered_at >= asked_at
    (sent,) = [m for m in bot.heard if m["type"] == "send-text"]
    assert sent["label"] == "rtvi-ai"
    assert sent["data"] == {
        "content": "When are you open on Saturday?",
        "options": {"run_immediately": True, "audio_response": False},
    }


async def test_the_greeting_opens_the_chat(quick: None):
    bot = FakeBot(greeting=answer("Hi, Lakeside Dental, how can I help?"))
    rig = rigged(PipecatChatBackend, settings=cloud(), bot=bot)
    plug = chat_plug(rig)
    try:
        assert await plug.open() == "Hi, Lakeside Dental, how can I help?"
    finally:
        await plug.close()


async def test_an_answer_through_a_tool_call_is_one_turn(quick: None):
    bot = FakeBot(
        replies=[
            answer_through_a_tool(
                "Let me check that.",
                "Order A100 has shipped.",
                tool_seconds=0.2,
            )
        ]
    )
    rig = rigged(PipecatChatBackend, settings=cloud(), bot=bot)
    plug = chat_plug(rig)
    try:
        await plug.open()
        reply = await plug.deliver("Where is order A100?")
    finally:
        await plug.close()
    assert reply.text == "Let me check that.\nOrder A100 has shipped."


async def test_a_tool_result_without_a_follow_up_ends_the_turn_when_quiet(
    quick: None,
):
    steps = [
        Step(rtvi("bot-llm-started")),
        Step(rtvi("llm-function-call-started")),
        Step(rtvi("bot-llm-stopped")),
        Step(rtvi("llm-function-call-in-progress", tool_call_id="c1")),
        Step(rtvi("llm-function-call-stopped", tool_call_id="c1", cancelled=False)),
    ]
    rig = rigged(PipecatChatBackend, settings=cloud(), bot=FakeBot(replies=[steps]))
    plug = chat_plug(rig)
    loop = asyncio.get_running_loop()
    try:
        await plug.open()
        began = loop.time()
        reply = await plug.deliver("Transfer me.")
        took = loop.time() - began
    finally:
        await plug.close()
    assert reply.text is None
    assert 0.25 < took < 1.0


async def test_the_turn_waits_for_the_bot_to_stop_speaking(quick: None):
    steps = [
        Step(rtvi("bot-llm-started")),
        Step(rtvi("bot-llm-text", text="Order A100 has shipped.")),
        Step(rtvi("bot-started-speaking")),
        Step(rtvi("bot-llm-stopped")),
        Step(rtvi("bot-stopped-speaking"), after=0.4),
    ]
    rig = rigged(PipecatChatBackend, settings=cloud(), bot=FakeBot(replies=[steps]))
    plug = chat_plug(rig)
    loop = asyncio.get_running_loop()
    try:
        await plug.open()
        began = loop.time()
        reply = await plug.deliver("Where is my order?")
        took = loop.time() - began
    finally:
        await plug.close()
    assert reply.text == "Order A100 has shipped."
    assert took >= 0.4


async def test_a_bot_that_answers_nothing_ends_the_exchange(quick: None):
    rig = rigged(PipecatChatBackend, settings=cloud(), bot=FakeBot(replies=[]))
    plug = chat_plug(rig)
    try:
        await plug.open()
        with pytest.raises(PlugError) as refused:
            await plug.deliver("Hello?")
    finally:
        await plug.close()
    assert str(refused.value).startswith("the bot answered nothing for")


async def test_a_refused_send_text_is_named(quick: None):
    bot = FakeBot(refuse_send_text="Invalid message")
    rig = rigged(PipecatChatBackend, settings=cloud(), bot=bot)
    plug = chat_plug(rig)
    try:
        await plug.open()
        with pytest.raises(PlugError) as refused:
            await plug.deliver("Hello?")
    finally:
        await plug.close()
    assert str(refused.value) == (
        "the bot refused Egma's RTVI send-text: Invalid message"
    )


async def test_the_bot_leaving_ends_the_chat(quick: None):
    rig = rigged(PipecatChatBackend, settings=cloud(), bot=FakeBot(replies=[]))
    plug = chat_plug(rig)
    try:
        await plug.open()
        delivering = asyncio.ensure_future(plug.deliver("Goodbye then."))
        await asyncio.sleep(0.05)
        await rig.room.bot_leaves()
        reply = await asyncio.wait_for(delivering, 1)
        assert reply.ended
        assert plug.has_ended
    finally:
        await plug.close()


async def test_listening_reads_only_what_the_bot_writes_next(quick: None):
    bot = FakeBot(replies=[answer("First answer.")])
    rig = rigged(PipecatChatBackend, settings=cloud(), bot=bot)
    plug = chat_plug(rig)
    try:
        await plug.open()
        await plug.deliver("One.")
        assert await plug.listen(0.2) is None
        rig.room.play(answer("And one more thing."))
        heard = await plug.listen(1.0)
    finally:
        await plug.close()
    assert heard is not None
    assert heard.text == "And one more thing."


async def test_finishing_sends_the_last_words_without_waiting(quick: None):
    bot = FakeBot(replies=[])
    rig = rigged(PipecatChatBackend, settings=cloud(), bot=bot)
    plug = chat_plug(rig)
    try:
        await plug.open()
        assert await plug.finish("Thanks, goodbye.") is None
    finally:
        await plug.close()
    assert [m["data"]["content"] for m in bot.heard if m["type"] == "send-text"] == [
        "Thanks, goodbye."
    ]


async def test_a_late_run_of_an_earlier_turn_is_not_the_next_answer():
    turns = RtviTurns()
    turns.feed(rtvi("bot-llm-started"))
    turns.feed(rtvi("bot-llm-text", text="old"))
    turn = turns.begin_turn("m1")
    turns.feed(rtvi("bot-llm-text", text=" still old"))
    turns.feed(rtvi("bot-llm-stopped"))
    turns.feed(rtvi("bot-llm-started"))
    turns.feed(rtvi("bot-llm-text", text="new"))
    turns.feed(rtvi("bot-llm-stopped"))
    assert turns.text_of(turn) == "new"
    assert turns.text_of(0) == "old still old"


async def test_calls_in_flight_are_counted_from_function_call_started():
    turns = RtviTurns()
    turn = turns.begin_turn("m1")
    turns.feed(rtvi("bot-interrupted"))
    turns.feed(rtvi("bot-llm-started"))
    turns.feed(rtvi("bot-llm-text", text="Let me check."))
    turns.feed(rtvi("llm-function-call-started"))
    turns.feed(rtvi("bot-llm-stopped"))
    assert turns.over_at(turn) is None, "a call started before the model stopped"
    turns.feed(rtvi("llm-function-call-in-progress", tool_call_id="c1"))
    assert turns.over_at(turn) is None
    turns.feed(rtvi("llm-function-call-stopped", tool_call_id="c1", cancelled=False))
    quiet_end = turns.over_at(turn)
    assert quiet_end is not None, "a finished call leaves the quiet fallback"
    turns.feed(rtvi("bot-llm-started"))
    assert turns.over_at(turn) is None
    turns.feed(rtvi("bot-llm-text", text="It shipped."))
    turns.feed(rtvi("bot-llm-stopped"))
    ended_at = turns.over_at(turn)
    assert ended_at is not None
    assert ended_at <= asyncio.get_running_loop().time(), "over at once"
    assert turns.text_of(turn) == "Let me check.\nIt shipped."


async def test_a_turn_without_text_waits_for_the_quiet_fallback():
    turns = RtviTurns()
    turn = turns.begin_turn("m1")
    turns.feed(rtvi("bot-llm-started"))
    turns.feed(rtvi("bot-llm-stopped"))
    ended_at = turns.over_at(turn)
    assert ended_at is not None
    assert ended_at > asyncio.get_running_loop().time()


# -- The voice room's departure --------------------------------------------------------


async def test_the_departure_marker_follows_the_bots_last_audio():
    from egma_simulator.media import RemoteParticipantLeftFrame

    callbacks: asyncio.Queue[str] = asyncio.Queue()
    frames: asyncio.Queue[str] = asyncio.Queue()
    pushed: list[str] = []

    class Input:
        _audio_in_queue = frames

        async def push_frame(self, frame: Any) -> None:
            assert isinstance(frame, RemoteParticipantLeftFrame)
            pushed.append("marker")
            frame.completed.set()

    class Client:
        _audio_queue = callbacks

    class Transport:
        _client = Client()

    room = DailyVoiceRoom(
        way_in=DailyWayIn(room_url="https://lakeside.daily.co/r"),
        events=RoomEvents(
            joined=lambda _data: None,
            participant=lambda _participant: None,
            left=_nothing,
            message=lambda _message, _sender: None,
            audio=lambda _participant: None,
        ),
        quotable=lambda told: told,
    )
    room._transport = Transport()
    room._input = Input()
    callbacks.put_nowait("frame-1")
    frames.put_nowait("frame-0")

    async def the_pipeline_catches_up() -> None:
        await asyncio.sleep(0.05)
        pushed.append(callbacks.get_nowait())
        callbacks.task_done()
        pushed.append(frames.get_nowait())
        frames.task_done()

    catching_up = asyncio.ensure_future(the_pipeline_catches_up())
    await room.bot_departed()
    await catching_up
    assert pushed == ["frame-1", "frame-0", "marker"]
    assert room.ended.is_set()
    assert not room.failed.is_set()


async def _nothing(_participant_id: str) -> None:
    return None
