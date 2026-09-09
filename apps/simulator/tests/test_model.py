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
from types import SimpleNamespace

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
        self.answers.append(web.json_response({"choices": [{"message": message}]}))

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


async def test_the_daytona_model_uses_the_environment_proxy(monkeypatch):
    requests: list[tuple[str, str | None]] = []

    async def proxy(request: web.Request) -> web.Response:
        requests.append((request.raw_path, request.headers.get("Authorization")))
        return web.json_response(
            {"choices": [{"message": {"role": "assistant", "content": "Hello."}}]}
        )

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", proxy)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    proxy_url = f"http://127.0.0.1:{runner.addresses[0][1]}"
    monkeypatch.setenv("HTTP_PROXY", proxy_url)
    monkeypatch.setenv("http_proxy", proxy_url)
    monkeypatch.setenv("NO_PROXY", "")
    monkeypatch.setenv("no_proxy", "")

    client = build_model_client(
        SimpleNamespace(
            runtime=object(),
            models=SimpleNamespace(
                llm=SimpleNamespace(
                    adapter="openai_chat_completions",
                    key="dtn_secret_openai_under_test",
                    model="model-under-test",
                    reasoning_effort=None,
                    funding_receipt=None,
                )
            ),
        ),
        _base_url="http://model.invalid/v1",
    )
    try:
        await client.reply(system_and_history())
    finally:
        await client.close()
        await runner.cleanup()

    assert requests == [
        (
            "http://model.invalid/v1/chat/completions",
            "Bearer dtn_secret_openai_under_test",
        )
    ]


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
            PersonaToolCall(tool_call_id="call_end", name="end_call", arguments={}),
        ),
    )


@pytest.mark.parametrize("content", [None, ""])
async def test_end_call_without_provider_words_keeps_the_end_action_textless(
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
    assert reply.text == ""
    assert reply.requests_end_call is True


@pytest.mark.parametrize("content", [None, " "])
async def test_blank_completion_failure_keeps_only_safe_provider_metadata(
    model_stub, content
):
    model_stub.answers.append(
        web.json_response(
            {
                "id": "response-123",
                "model": "served-model-2026-09-09",
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": content,
                            "refusal": "private refusal text",
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 0,
                    "total_tokens": 12,
                    "private": "provider body must not be retained",
                },
            }
        )
    )
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="secret-key", model_name="selected"
    )
    try:
        with pytest.raises(ModelFailure) as caught:
            await client.reply(system_and_history())
    finally:
        await client.close()

    assert caught.value.diagnostic_attributes == {
        "gen_ai.response.id": "response-123",
        "gen_ai.response.model": "served-model-2026-09-09",
        "gen_ai.response.finish_reason": "stop",
        "gen_ai.response.refusal_present": True,
        "gen_ai.usage.input_tokens": 12,
        "gen_ai.usage.output_tokens": 0,
        "gen_ai.usage.total_tokens": 12,
    }
    assert "private refusal text" not in repr(caught.value.diagnostic_attributes)


async def test_malformed_metadata_does_not_hide_blank_failure(model_stub):
    model_stub.answers.append(
        web.json_response(
            {
                "id": {"unexpected": "shape"},
                "model": ["unexpected"],
                "choices": [{"finish_reason": {}, "message": {"content": ""}}],
                "usage": {"prompt_tokens": "twelve"},
            }
        )
    )
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="selected"
    )
    try:
        with pytest.raises(ModelFailure, match="no words") as caught:
            await client.reply(system_and_history())
    finally:
        await client.close()
    assert caught.value.diagnostic_attributes == {
        "gen_ai.response.refusal_present": False
    }


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


@pytest.mark.parametrize(
    "status,customer,typed",
    [
        (401, True, True),
        (403, True, True),
        (429, True, False),
        (503, True, False),
        (401, False, False),
    ],
)
async def test_customer_auth_failure_names_the_provider_without_fallback(
    model_stub, status, customer, typed
):
    from egma_simulator.plugs import failed_ending
    from egma_simulator.provider_keys import ProviderKeyUnavailable

    model_stub.answers.append(
        web.json_response({"error": "secret-customer-key"}, status=status)
    )
    model = OpenAICompatibleModel(
        base_url=model_stub.base_url,
        api_key="secret-customer-key",
        model_name="gpt-4o-mini",
        customer_funded=customer,
    )
    try:
        with pytest.raises(ProviderKeyUnavailable if typed else ModelFailure) as caught:
            await model.reply(system_and_history())
    finally:
        await model.close()
    assert len(model_stub.requests) == 1
    assert "secret-customer-key" not in str(caught.value)
    assert failed_ending(caught.value) == (
        "provider_key_unavailable" if typed else "error"
    )
