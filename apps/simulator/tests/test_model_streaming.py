"""Provider streaming through the real OpenAI SDK, with held network chunks."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from openai import AsyncOpenAI
from pipecat.processors.aggregators.llm_context import LLMContext

from egma_simulator.model import PERSONA_TOOLS, ModelFailure, OpenAICompatibleModel


def event(delta=None, *, finish=None, usage=None):
    return (
        "data: "
        + json.dumps(
            {
                "id": "completion_fixture",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "gpt-4o-mini",
                "choices": []
                if usage
                else [{"index": 0, "delta": delta or {}, "finish_reason": finish}],
                "usage": usage,
            }
        )
        + "\n\n"
    ).encode()


class HeldStream(httpx.AsyncByteStream):
    def __init__(self, first, last):
        self.first = first
        self.last = last
        self.release = asyncio.Event()
        self.closed = False

    async def __aiter__(self):
        yield self.first
        await self.release.wait()
        yield self.last

    async def aclose(self):
        self.closed = True


def model_with_stream(stream, *, key="test-key", status=200):
    requests = []

    async def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(
            status, stream=stream, headers={"content-type": "text/event-stream"}
        )

    model = OpenAICompatibleModel(
        base_url="https://fixture.test/v1", api_key=key, model_name="gpt-4o-mini"
    )
    model._stream_client = AsyncOpenAI(
        api_key=key,
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
    )
    return model, requests


async def test_stream_releases_words_before_completion_and_retains_tool_and_usage():
    stream = HeldStream(
        event({"content": "First sentence. "}),
        event(
            {
                "content": "Goodbye.",
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_end",
                        "type": "function",
                        "function": {"name": "end_call", "arguments": "{"},
                    }
                ],
            }
        )
        + event(
            {"tool_calls": [{"index": 0, "function": {"arguments": "}"}}]},
            finish="tool_calls",
        )
        + event(usage={"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18})
        + b"data: [DONE]\n\n",
    )
    model, requests = model_with_stream(stream)
    heard = []
    first = asyncio.Event()

    async def emit(text):
        heard.append(text)
        first.set()

    response = asyncio.create_task(
        model.reply_streamed(
            LLMContext(
                messages=[{"role": "user", "content": "Hello"}], tools=PERSONA_TOOLS
            ),
            emit,
        )
    )
    try:
        await asyncio.wait_for(first.wait(), 2)
        assert "".join(heard) == "First sentence. "
        assert not response.done()
        stream.release.set()
        reply = await asyncio.wait_for(response, 2)
        assert "".join(heard) == reply.text == "First sentence. Goodbye."
        assert reply.requests_end_call
        assert reply.tool_calls[0].arguments == {}
        assert reply.usage is not None
        assert requests[0]["stream"] is True
        assert requests[0]["stream_options"] == {"include_usage": True}
        assert stream.closed
    finally:
        response.cancel()
        await model.close()


@pytest.mark.parametrize("key", ["abcabcabc", "key", "sk-fixture-credential"])
async def test_stream_never_releases_a_credential_split_between_chunks(key):
    text = f"Echo {key}. Goodbye."
    stream = HeldStream(
        b"".join(event({"content": char}) for char in text),
        event(finish="stop") + b"data: [DONE]\n\n",
    )
    stream.release.set()
    model, _ = model_with_stream(stream, key=key)
    chunks = []

    async def emit(text):
        chunks.append(text)

    try:
        reply = await model.reply_streamed(LLMContext(messages=[]), emit)
        assert "".join(chunks) == reply.text == "Echo [redacted]. Goodbye."
        assert key not in "".join(chunks)
    finally:
        await model.close()


async def test_stream_disconnect_is_not_a_completed_reply():
    stream = HeldStream(event({"content": "First sentence."}), b"")
    stream.release.set()
    model, _ = model_with_stream(stream)

    async def emit(_text):
        pass

    try:
        with pytest.raises(ModelFailure, match="before its reply completed"):
            await model.reply_streamed(LLMContext(messages=[]), emit)
        assert stream.closed
    finally:
        await model.close()
