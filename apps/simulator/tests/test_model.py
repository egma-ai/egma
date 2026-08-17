"""The model-client seam: scripted determinism, and a real wire behind it.

The scripted client is what CI runs on — same messages in, same reply out,
every time, derived from nothing but the spec. The OpenAI-compatible client
is the real-provider side of the seam, proven here against a local stub so
its request shape, reply parsing, marker handling, and failure translation
are pinned without a live model anywhere.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from aiohttp import web

from egma_simulator.model import (
    CONCLUDE_MARKER,
    GOODBYE,
    ModelFailure,
    OpenAICompatibleModel,
    PersonaReply,
    ScriptedModel,
    split_sentences,
)
from egma_simulator.redaction import REDACTED


def test_sentences_split_deterministically():
    instructions = "Move my appointment. I forget the time! Can we do Thursday?"
    assert split_sentences(instructions) == [
        "Move my appointment.",
        "I forget the time!",
        "Can we do Thursday?",
    ]
    assert split_sentences("no punctuation at all") == ["no punctuation at all"]


def system_and_history(*speakers_and_texts: tuple[str, str]) -> list[dict]:
    messages = [{"role": "system", "content": "the composed prompt"}]
    messages.extend(
        {"role": role, "content": text} for role, text in speakers_and_texts
    )
    return messages


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

    def answer_with(self, content: str) -> None:
        self.answers.append(
            web.json_response(
                {"choices": [{"message": {"role": "assistant", "content": content}}]}
            )
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
        messages = system_and_history(("user", "Hello, how can I help?"))
        reply = await client.reply(messages)
    finally:
        await client.close()

    assert reply == PersonaReply(
        text="I would like to move my appointment, please.", concluded=False
    )
    sent = model_stub.requests[0]
    assert sent["model"] == "model-under-test"
    assert sent["messages"] == messages
    assert model_stub.headers[0]["Authorization"] == "Bearer key-under-test"


async def test_the_conclude_marker_is_read_and_stripped(model_stub):
    model_stub.answer_with(f"Thank you, that is everything. {CONCLUDE_MARKER}")
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="m"
    )
    try:
        reply = await client.reply(system_and_history())
    finally:
        await client.close()
    assert reply.concluded is True
    assert reply.text == "Thank you, that is everything."
    assert CONCLUDE_MARKER not in reply.text


async def test_a_conclude_marker_without_words_is_a_model_failure(model_stub):
    model_stub.answer_with(CONCLUDE_MARKER)
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url, api_key="k", model_name="m"
    )
    try:
        with pytest.raises(ModelFailure, match="no words"):
            await client.reply(system_and_history())
    finally:
        await client.close()


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


async def test_a_reasoning_effort_rides_the_request_when_one_was_asked_for(
    model_stub,
):
    model_stub.answer_with("Hello, I am calling about my appointment.")
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url,
        api_key="key-under-test",
        model_name="model-under-test",
        reasoning_effort="none",
    )
    try:
        await client.reply(system_and_history(("user", "Hello?")))
    finally:
        await client.close()

    assert model_stub.requests[0]["reasoning_effort"] == "none"


async def test_no_reasoning_field_is_sent_when_nobody_asked(model_stub):
    """Absent stays absent on the wire.

    Providers speaking one chat-completions shape do not agree on the
    accepted values, and some models refuse the field outright — so a
    request that always carried it would narrow which models a deployment
    can run to the ones this file happened to know about.
    """
    model_stub.answer_with("Hello, I am calling about my appointment.")
    client = OpenAICompatibleModel(
        base_url=model_stub.base_url,
        api_key="key-under-test",
        model_name="model-under-test",
    )
    try:
        await client.reply(system_and_history(("user", "Hello?")))
    finally:
        await client.close()

    assert "reasoning_effort" not in model_stub.requests[0]
