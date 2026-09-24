"""The model-client seam: scripted determinism, and a real wire behind it.

The scripted client is what CI runs on — same messages in, same reply out,
every time, derived from nothing but the spec. The OpenAI-compatible client
is the real-provider side of the seam, proven here against a local stub so
its request shape, reply parsing, tool-call handling, and failure translation
are pinned without a live model anywhere.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from aiohttp import web
from conftest import loopback_spec
from pipecat.processors.aggregators.llm_context import LLMContext

from egma_simulator.model import (
    PERSONA_TOOLS,
    ModelFailure,
    OpenAICompatibleModel,
    PersonaReply,
    build_model_client,
)
from egma_simulator.persona import Persona, Turn
from egma_simulator.redaction import REDACTED
from egma_simulator.spec import SimulationSpec


def system_and_history(*speakers_and_texts: tuple[str, str]) -> LLMContext:
    messages = [{"role": "system", "content": "the composed prompt"}]
    messages.extend(
        {"role": role, "content": text} for role, text in speakers_and_texts
    )
    return LLMContext(messages=messages, tools=PERSONA_TOOLS, tool_choice="auto")


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


@pytest.mark.parametrize("content", [None])
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
async def test_an_empty_answer_is_the_persona_staying_silent(model_stub, content):
    """No words and no end_call is a turn the persona chose not to speak."""
    model_stub.answers.append(
        web.json_response(
            {
                "id": "response-silent",
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": content,
                            "refusal": None,
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 961,
                    "completion_tokens": 3,
                    "total_tokens": 964,
                },
            }
        )
    )
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="selected"
    )
    try:
        reply = await client.reply(system_and_history())
    finally:
        await client.close()

    assert reply.text == ""
    assert reply.concluded is False
    assert reply.tool_calls == ()
    assert reply.requests_end_call is False
    assert reply.usage is not None


async def test_an_empty_answer_cut_short_is_still_a_model_failure(model_stub):
    model_stub.answers.append(
        web.json_response(
            {"choices": [{"finish_reason": "length", "message": {"content": ""}}]}
        )
    )
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="selected"
    )
    try:
        with pytest.raises(ModelFailure, match="finish reason: length") as caught:
            await client.reply(system_and_history())
    finally:
        await client.close()
    assert caught.value.diagnostic_attributes == {
        "gen_ai.response.finish_reason": "length",
        "gen_ai.response.refusal_present": False,
    }


@pytest.mark.parametrize(
    "choice",
    [
        {"finish_reason": None, "message": {"content": ""}},
    ],
)
async def test_an_empty_answer_without_a_finish_reason_is_a_model_failure(
    model_stub, choice
):
    """Only an explicit stop says that the empty answer was complete."""
    model_stub.answers.append(web.json_response({"choices": [choice]}))
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="selected"
    )
    try:
        with pytest.raises(ModelFailure, match="finish reason: None") as caught:
            await client.reply(system_and_history())
    finally:
        await client.close()
    assert caught.value.diagnostic_attributes == {
        "gen_ai.response.refusal_present": False
    }


@pytest.mark.parametrize(
    ("finish_reason", "message"),
    [
        ("stop", {"content": "Sure, here is"}),
        (
            "tool_calls",
            {
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_end",
                        "type": "function",
                        "function": {"name": "end_call", "arguments": "{}"},
                    }
                ],
            },
        ),
    ],
)
async def test_a_refusal_with_words_or_end_call_is_still_a_model_failure(
    model_stub, finish_reason, message
):
    """A refusal is not spoken and does not end the call as the persona's choice."""
    model_stub.answers.append(
        web.json_response(
            {
                "choices": [
                    {
                        "finish_reason": finish_reason,
                        "message": {
                            "role": "assistant",
                            "refusal": "private refusal text",
                            **message,
                        },
                    }
                ]
            }
        )
    )
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="selected"
    )
    try:
        with pytest.raises(ModelFailure, match="refused to answer") as caught:
            await client.reply(system_and_history())
    finally:
        await client.close()
    assert caught.value.diagnostic_attributes == {
        "gen_ai.response.finish_reason": finish_reason,
        "gen_ai.response.refusal_present": True,
    }


async def test_an_interjection_request_names_no_tools_and_still_reaches_the_provider(
    model_stub,
):
    """The interruption context carries no tools, so Pipecat's adapter fills
    ``tools`` and ``tool_choice`` with the OpenAI SDK's own placeholder. The
    request body must leave both out rather than fail to serialize."""
    model_stub.answer_with("Sorry, one second.")
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url,
        api_key="k",
        model_name="model-under-test",
    )
    spec = SimulationSpec.from_document(loopback_spec("sim-interjection"))
    persona = Persona(
        authored=spec.persona,
        scenario_instructions=spec.scenario_instructions,
        model=client,
    )
    try:
        reply = await persona.reply_to(
            persona.interruption_context([Turn("agent", "Let me read the schedule.")])
        )
    finally:
        await client.close()

    assert reply == PersonaReply(text="Sorry, one second.", concluded=False)
    sent = model_stub.requests[0]
    assert "tools" not in sent
    assert "tool_choice" not in sent
    assert sent["messages"][-1]["role"] == "user"
    assert "Interrupt now" in sent["messages"][-1]["content"]


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
        ("gpt-5.4", "none"),
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
