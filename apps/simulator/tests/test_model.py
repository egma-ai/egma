"""The model-client seam: scripted determinism, and a real wire behind it.

The scripted client is what CI runs on — same messages in, same reply out,
every time, derived from nothing but the spec. The OpenAI-compatible client
is the real-provider side of the seam, proven here against a local stub so
its request shape, reply parsing, tool-call handling, and failure translation
are pinned without a live model anywhere.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from aiohttp import web
from pipecat.processors.aggregators.llm_context import LLMContext

from egma_simulator.model import (
    END_CALL_TOOL,
    GOODBYE,
    PERSONA_TOOLS,
    ModelFailure,
    OpenAICompatibleModel,
    PersonaReply,
    PersonaToolCall,
    ScriptedModel,
    build_model_client,
    split_sentences,
)
from egma_simulator.redaction import REDACTED
from egma_simulator.spec import SimulationSpec


def test_sentences_split_deterministically():
    instructions = "Move my appointment. I forget the time! Can we do Thursday?"
    assert split_sentences(instructions) == [
        "Move my appointment.",
        "I forget the time!",
        "Can we do Thursday?",
    ]
    assert split_sentences("no punctuation at all") == ["no punctuation at all"]


def system_and_history(*speakers_and_texts: tuple[str, str]) -> LLMContext:
    messages = [{"role": "system", "content": "the composed prompt"}]
    messages.extend(
        {"role": role, "content": text} for role, text in speakers_and_texts
    )
    return LLMContext(messages=messages, tools=PERSONA_TOOLS, tool_choice="auto")


async def test_the_scripted_model_walks_the_scenario_sentence_by_sentence():
    model = ScriptedModel("One thing. Another thing. A third.")

    first = await model.reply(system_and_history())
    assert first == PersonaReply(text="One thing.", concluded=False)

    # The next sentence is picked by counting the persona's own prior turns
    # (assistant messages), so the reply is a pure function of the messages.
    second = await model.reply(
        system_and_history(
            ("assistant", "One thing."), ("user", "Noted, anything else?")
        )
    )
    assert second == PersonaReply(text="Another thing.", concluded=False)

    third = await model.reply(
        system_and_history(
            ("assistant", "One thing."),
            ("user", "Noted."),
            ("assistant", "Another thing."),
            ("user", "Noted again."),
        )
    )
    assert third == PersonaReply(text="A third.", concluded=False)


async def test_the_scripted_model_concludes_with_a_goodbye_when_the_script_is_dry():
    model = ScriptedModel("Only one thing.")
    opening = await model.reply(system_and_history())
    assert opening.concluded is False

    done = await model.reply(
        system_and_history(("assistant", "Only one thing."), ("user", "Done!"))
    )
    assert done == PersonaReply(text=GOODBYE, concluded=True)


async def test_the_scripted_model_is_deterministic_across_calls():
    messages = system_and_history(("assistant", "One thing."), ("user", "Ok."))
    first = await ScriptedModel("One thing. Two things.").reply(messages)
    again = await ScriptedModel("One thing. Two things.").reply(messages)
    assert first == again


# -- The OpenAI-compatible client, against a local stub -----------------------


class ModelStub:
    """A chat-completions endpoint that answers from a queue and records."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.headers: list[dict] = []
        self.answers: list[web.Response | str] = []
        self.hold_seconds = 0.0

    def answer_with(
        self, content: str | None, *, tool_calls: list[dict] | None = None
    ) -> None:
        message: dict = {"role": "assistant", "content": content}
        if tool_calls is not None:
            message["tool_calls"] = tool_calls
        self.answers.append(
            web.json_response({"choices": [{"message": message}]})
        )

    async def handle(self, request: web.Request) -> web.Response:
        self.requests.append(await request.json())
        self.headers.append(dict(request.headers))
        if self.hold_seconds:
            await asyncio.sleep(self.hold_seconds)
        if not self.answers:
            return web.json_response({"error": "nothing scripted"}, status=500)
        answer = self.answers.pop(0)
        if isinstance(answer, str):
            return web.Response(text=answer, content_type="application/json")
        return answer


@pytest.fixture
async def model_stub():
    stub = ModelStub()
    app = web.Application()
    app.router.add_post("/v1/chat/completions", stub.handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    stub.base_url = f"http://127.0.0.1:{port}/v1"
    try:
        yield stub
    finally:
        await runner.cleanup()


async def test_the_openai_client_sends_the_messages_and_returns_the_reply(
    model_stub,
):
    model_stub.answer_with("I would like to move my appointment, please.")
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url,
        api_key="key-under-test",
        model_name="model-under-test",
    )
    try:
        context = system_and_history(("user", "Hello, how can I help?"))
        reply = await client.reply(context)
    finally:
        await client.close()

    assert reply == PersonaReply(
        text="I would like to move my appointment, please.", concluded=False
    )
    sent = model_stub.requests[0]
    assert sent["model"] == "model-under-test"
    assert sent["messages"] == context.get_messages()
    assert sent["tools"] == [
        {"type": "function", "function": END_CALL_TOOL.to_default_dict()}
    ]
    assert sent["tool_choice"] == "auto"
    assert model_stub.headers[0]["Authorization"] == "Bearer key-under-test"


async def test_the_structured_end_call_is_returned_for_pipecat_to_execute(model_stub):
    model_stub.answer_with(
        "Thank you, that is everything. Goodbye.",
        tool_calls=[
            {
                "id": "call_end",
                "type": "function",
                "function": {"name": "end_call", "arguments": "{}"},
            }
        ],
    )
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="m"
    )
    try:
        reply = await client.reply(system_and_history())
    finally:
        await client.close()
    assert reply == PersonaReply(
        text="Thank you, that is everything. Goodbye.",
        concluded=False,
        tool_calls=(
            PersonaToolCall(
                tool_call_id="call_end", name="end_call", arguments={}
            ),
        ),
    )


@pytest.mark.parametrize("content", [None, ""])
async def test_end_call_without_provider_words_gets_an_audible_goodbye(
    model_stub, content
):
    model_stub.answer_with(
        content,
        tool_calls=[
            {
                "id": "call_end",
                "type": "function",
                "function": {"name": "end_call", "arguments": "{}"},
            }
        ],
    )
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="m"
    )
    try:
        reply = await client.reply(system_and_history())
    finally:
        await client.close()
    assert reply.text == GOODBYE
    assert reply.requests_end_call is True


async def test_a_literal_old_marker_has_no_control_meaning(model_stub):
    model_stub.answer_with("I am not done. [CONCLUDED]")
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="m"
    )
    try:
        reply = await client.reply(system_and_history())
    finally:
        await client.close()

    assert reply == PersonaReply(text="I am not done. [CONCLUDED]", concluded=False)


async def test_the_selected_reasoning_effort_is_sent_to_openai(model_stub):
    model_stub.answer_with("I need an appointment.")
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url,
        api_key="k",
        model_name="gpt-5.6-terra",
        reasoning_effort="none",
    )
    try:
        await client.reply(system_and_history())
    finally:
        await client.close()

    assert model_stub.requests[0]["reasoning_effort"] == "none"


async def test_a_provider_cannot_echo_its_key_in_a_successful_reply(model_stub):
    secret = "model-key-must-not-be-spoken"
    model_stub.answer_with(f"Provider echoed {secret}.")
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key=secret, model_name="m"
    )
    try:
        reply = await client.reply(system_and_history())
    finally:
        await client.close()

    assert secret not in reply.text
    assert reply.text == f"Provider echoed {REDACTED}."


async def test_a_refusing_provider_is_a_model_failure(model_stub):
    model_stub.answers.append(web.json_response({"error": "nope"}, status=401))
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="m"
    )
    try:
        with pytest.raises(ModelFailure) as failure:
            await client.reply(system_and_history())
    finally:
        await client.close()
    assert "401" in str(failure.value)


async def test_a_provider_cannot_echo_its_key_into_a_model_failure(model_stub):
    secret = "model-key-must-not-enter-tracing"
    model_stub.answers.append(
        web.json_response({"error": f"provider echoed {secret}"}, status=401)
    )
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key=secret, model_name="m"
    )
    try:
        with pytest.raises(ModelFailure) as failure:
            await client.reply(system_and_history())
    finally:
        await client.close()

    assert secret not in str(failure.value)
    assert REDACTED in str(failure.value)


async def test_an_unreadable_answer_is_a_model_failure(model_stub):
    model_stub.answers.append(json.dumps({"choices": []}))
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="m"
    )
    try:
        with pytest.raises(ModelFailure):
            await client.reply(system_and_history())
    finally:
        await client.close()


async def test_a_model_that_never_answers_is_a_model_failure(model_stub):
    model_stub.hold_seconds = 5.0
    model_stub.answer_with("too late")
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url,
        api_key="k",
        model_name="m",
        timeout_seconds=0.2,
    )
    try:
        with pytest.raises(ModelFailure):
            await client.reply(system_and_history())
    finally:
        await client.close()


@pytest.mark.parametrize(
    ("model_name", "reasoning_effort"),
    [
        ("gpt-4o-mini", None),
        ("gpt-4o", None),
        ("gpt-5.4", "none"),
        ("gpt-5.5", "none"),
        ("gpt-5.6-terra", "none"),
        ("gpt-5.6-sol", "none"),
        ("gpt-5.6-luna", "none"),
    ],
)
async def test_runtime_model_forwards_the_claimed_reasoning_policy(
    model_stub, model_name, reasoning_effort
):
    """The work order supplies provider, model, and current direct key."""
    model_stub.answer_with("I need the next available appointment.")
    llm = {
        "provider": "openai",
        "model": model_name,
        "adapter": "openai_chat_completions",
        "key": "claim-key-under-test",
    }
    if reasoning_effort is not None:
        llm["reasoning_effort"] = reasoning_effort
    document = {
        "contract_version": 5,
        "simulation_id": "sim_direct_model_selection",
        "modality": "chat",
        "connection": {
            "agent_platform": "retell",
            "connection_type": "retell_chat_api",
            "access_variant": "retell_chat_api.api_key",
            "config": {"retellAgentId": "agent_fixture"},
            "credentials": None,
        },
        "persona": {
            "name": "Alex",
            "personality": "Patient and direct.",
            "language": "en-US",
        },
        "scenario": {"instructions": "Ask for the next appointment."},
        "limits": {"max_duration_seconds": 300, "max_turns": 20},
        "models": {
            "llm": llm,
            "stt": {
                "provider": "deepgram",
                "model": "nova-3-general",
                "adapter": "deepgram",
            },
            "tts": {
                "provider": "cartesia",
                "model": "sonic-3.5",
                "adapter": "cartesia",
                "voice_id": "fixture-voice",
                "speed": 1,
            },
        },
    }
    spec = SimulationSpec.from_document(document)
    client = build_model_client(spec, _base_url=model_stub.base_url)
    try:
        await client.reply(system_and_history(("user", "How can I help?")))
    finally:
        await client.close()

    assert model_stub.requests[0]["model"] == model_name
    if reasoning_effort is None:
        assert "reasoning_effort" not in model_stub.requests[0]
    else:
        assert model_stub.requests[0]["reasoning_effort"] == reasoning_effort
    assert model_stub.headers[0]["Authorization"] == "Bearer claim-key-under-test"
