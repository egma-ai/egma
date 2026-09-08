"""What a simulation spends, measured where the provider answers.

Every model call a simulation makes costs money, and the provider is the only
witness to what it charged. These examples hold the three places that witness
is heard — the persona's chat completion, OpenAI's realtime transcription, and
Pipecat's own count of what a speaking or listening leg was handed — and the
one span every one of them becomes.

The seams are the ones the effort agreed: the model client against a loopback
provider, the pipeline's usage collector against Pipecat's own metrics data,
the span emitter's document, and the chat conversation loop end to end.
"""

from __future__ import annotations

import json

import pytest
from pipecat.frames.frames import MetricsFrame
from pipecat.metrics.metrics import (
    MetricsData,
    STTUsage,
    STTUsageMetricsData,
    TTFBMetricsData,
    TTSUsageMetricsData,
)
from pipecat.tests.utils import run_test

from egma_simulator.conductor import _UsageLedger
from egma_simulator.conversation import ConversationControls, conduct
from egma_simulator.model import ModelClient, PersonaReply
from egma_simulator.persona import Persona
from egma_simulator.plugs.scripted import ScriptedCounterpart
from egma_simulator.spans import PROVIDER_USAGE_SPAN, SpanEmitter
from egma_simulator.spec import AuthoredPersona
from egma_simulator.speech import ProviderUsageMetricsData, SpeechProviders
from egma_simulator.usage import (
    CLIENT_MEASURED,
    PROVIDER_REPORTED,
    ProviderUsage,
    llm_usage,
    realtime_transcription_usage,
)

WORKED_EXAMPLE_ID = "sim_01K3XQ7M4E8YB2FVN0H9TZQWER"


class Sink:
    """Catches the documents a flush hands over, in order."""

    def __init__(self) -> None:
        self.documents: list[dict] = []

    def __call__(self, serialized: bytes) -> None:
        self.documents.append(json.loads(serialized))


def spans_of(document: dict) -> list[dict]:
    return document["resourceSpans"][0]["scopeSpans"][0]["spans"]


def attribute(span: dict, key: str) -> str | None:
    for entry in span.get("attributes", []):
        if entry["key"] == key:
            return entry["value"]["stringValue"]
    return None


# -- What the persona's own provider says ---------------------------------


def test_a_chat_completion_reports_the_uncached_half_of_its_prompt():
    """OpenAI's ``prompt_tokens`` includes what it served from its cache.

    The cached tokens cost a tenth of the uncached ones, so a record that
    carried the gross figure and rated it at the uncached price would
    overcharge every prompt that repeated — which is every persona turn after
    the first, because the whole history is re-sent each time.
    """
    usage = llm_usage(
        {
            "id": "chatcmpl-9f2b1c",
            "model": "gpt-4o-mini-2026-01-01",
            "usage": {
                "prompt_tokens": 1_400,
                "completion_tokens": 100,
                "total_tokens": 1_500,
                "prompt_tokens_details": {"cached_tokens": 400},
            },
        },
        selection_model="gpt-4o-mini",
    )

    assert usage is not None
    assert usage.quantities == {
        "input_tokens": 1_000,
        "cached_input_tokens": 400,
        "output_tokens": 100,
    }
    assert usage.measurement == PROVIDER_REPORTED
    assert usage.provider_ref == "chatcmpl-9f2b1c"
    # The pinned catalog model, not the dated variant the provider served: the
    # rate card is keyed by the catalog Egma itself closed.
    assert usage.model == "gpt-4o-mini"
    assert usage.operation == "openai_chat_completions"
    # The provider's own object, whole, so a wrong reading can be re-rated.
    assert usage.raw["total_tokens"] == 1_500


def test_a_body_with_no_usage_reports_nothing():
    """A gap is honest. An invented token count would not be."""
    assert llm_usage({"id": "chatcmpl-1"}, selection_model="gpt-4o-mini") is None
    assert llm_usage(None, selection_model="gpt-4o-mini") is None


# -- What OpenAI's realtime transcription says ----------------------------


def test_a_duration_billed_transcription_reports_the_seconds_it_billed():
    usage = realtime_transcription_usage(
        {
            "item_id": "item_A1b2C3",
            "usage": {"type": "duration", "seconds": 7.3},
        },
        selection_model="gpt-live-transcribe",
    )

    assert usage is not None
    assert usage.quantities == {"audio_seconds": 7.3}
    assert usage.operation == "openai_realtime"
    assert usage.provider_ref == "item_A1b2C3"
    assert usage.measurement == PROVIDER_REPORTED


def test_a_token_billed_transcription_reports_its_audio_and_text_tokens():
    """The other shape the same event carries, and the model decides which."""
    usage = realtime_transcription_usage(
        {
            "item_id": "item_D4e5F6",
            "usage": {
                "type": "tokens",
                "input_tokens": 2_400,
                "input_token_details": {"audio_tokens": 2_300, "text_tokens": 100},
                "output_tokens": 42,
            },
        },
        selection_model="gpt-4o-transcribe",
    )

    assert usage is not None
    assert usage.quantities == {
        "audio_input_tokens": 2_300,
        "text_input_tokens": 100,
        "output_tokens": 42,
    }


def test_a_transcription_shape_this_release_has_never_seen_reports_nothing():
    """Guessing a unit is worse than the gap: the platform would price it."""
    assert (
        realtime_transcription_usage(
            {"usage": {"type": "credits", "credits": 12}},
            selection_model="gpt-live-transcribe",
        )
        is None
    )


# -- What the pipeline collects -------------------------------------------


VOICE_LEGS = SpeechProviders(
    stt="deepgram",
    tts="cartesia",
    vad="silero",
    stt_model="nova-3-general",
    tts_model="sonic-3.5",
    stt_provider="deepgram",
    tts_provider="cartesia",
)


async def collected(*data: MetricsData) -> list[ProviderUsage]:
    """What the ledger reports when those metrics flow past it in a pipeline.

    Driven through Pipecat's own test harness rather than by calling the
    processor directly, because the claim is that a metrics frame *reaches*
    this processor: a system frame's route through a pipeline is exactly the
    part a direct call would not exercise.
    """
    spent: list[ProviderUsage] = []

    async def report(usage: ProviderUsage) -> None:
        spent.append(usage)

    ledger = _UsageLedger(speech=VOICE_LEGS, report=report)
    await run_test(
        ledger,
        frames_to_send=[MetricsFrame(data=list(data))],
        expected_down_frames=[MetricsFrame],
    )
    return spent


@pytest.mark.asyncio
async def test_the_listening_leg_reports_the_seconds_egma_sent_it():
    spent = await collected(
        STTUsageMetricsData(
            processor="DeepgramSTTService",
            model="nova-3-general",
            value=STTUsage(audio_seconds=12.5),
        )
    )

    assert len(spent) == 1
    assert spent[0].provider == "deepgram"
    assert spent[0].model == "nova-3-general"
    assert spent[0].operation == "deepgram"
    assert spent[0].quantities == {"audio_seconds": 12.5}
    # Deepgram returns no usage object, so this is Egma's own count and the
    # record says so rather than pretending the provider reported it.
    assert spent[0].measurement == CLIENT_MEASURED


@pytest.mark.asyncio
async def test_the_speaking_leg_reports_the_characters_it_was_handed():
    spent = await collected(
        TTSUsageMetricsData(processor="CartesiaTTSService", model="sonic-3.5", value=64)
    )

    assert len(spent) == 1
    assert spent[0].provider == "cartesia"
    assert spent[0].operation == "cartesia"
    assert spent[0].quantities == {"characters": 64}
    assert spent[0].measurement == CLIENT_MEASURED


@pytest.mark.asyncio
async def test_a_leg_holding_the_providers_own_numbers_is_passed_through_whole():
    reported = realtime_transcription_usage(
        {"item_id": "item_1", "usage": {"type": "duration", "seconds": 3.0}},
        selection_model="gpt-live-transcribe",
    )
    assert reported is not None

    spent = await collected(
        ProviderUsageMetricsData(
            processor="OpenAIRealtimeSTTService",
            model="gpt-live-transcribe",
            usage=reported,
        )
    )

    assert spent == [reported]


@pytest.mark.asyncio
async def test_a_timing_metric_is_not_a_bill():
    """Time to first byte is a measurement. The measure catalog owns those."""
    spent = await collected(TTFBMetricsData(processor="CartesiaTTSService", value=0.21))

    assert spent == []


# -- What reaches the platform --------------------------------------------


def test_one_provider_request_becomes_one_span_the_vocabulary_declares():
    sink = Sink()
    spans = SpanEmitter(WORKED_EXAMPLE_ID, flush=sink)
    spans.opened()
    try:
        spans.provider_usage(
            ProviderUsage(
                provider="openai",
                model="gpt-4o-mini",
                operation="openai_chat_completions",
                measurement=PROVIDER_REPORTED,
                quantities={"input_tokens": 1_000, "output_tokens": 100},
                provider_ref="chatcmpl-1",
                raw={"prompt_tokens": 1_000, "completion_tokens": 100},
            )
        )
        spans.flush()
    finally:
        spans.abort()

    bills = [
        span
        for document in sink.documents
        for span in spans_of(document)
        if span["name"] == PROVIDER_USAGE_SPAN
    ]
    assert len(bills) == 1
    span = bills[0]
    assert attribute(span, "egma.usage.provider") == "openai"
    assert attribute(span, "egma.usage.model") == "gpt-4o-mini"
    assert attribute(span, "egma.usage.operation") == "openai_chat_completions"
    assert attribute(span, "egma.usage.measurement") == PROVIDER_REPORTED
    assert attribute(span, "egma.usage.provider_ref") == "chatcmpl-1"
    assert json.loads(attribute(span, "egma.usage.quantities") or "null") == {
        "input_tokens": 1_000,
        "output_tokens": 100,
    }
    assert json.loads(attribute(span, "egma.usage.raw") or "null") == {
        "prompt_tokens": 1_000,
        "completion_tokens": 100,
    }
    # The instant the provider answered, not an interval: how long the request
    # took is a timing fact and Pipecat's own service span already carries it.
    assert span["endTimeUnixNano"] == span["startTimeUnixNano"]


def test_a_request_that_consumed_nothing_is_not_written_down():
    sink = Sink()
    spans = SpanEmitter(WORKED_EXAMPLE_ID, flush=sink)
    spans.opened()
    try:
        spans.provider_usage(
            ProviderUsage(
                provider="cartesia",
                model="sonic-3.5",
                operation="cartesia",
                measurement=CLIENT_MEASURED,
                quantities={"characters": 0},
            )
        )
        spans.flush()
    finally:
        spans.abort()

    assert [
        span
        for document in sink.documents
        for span in spans_of(document)
        if span["name"] == PROVIDER_USAGE_SPAN
    ] == []


def test_a_client_measured_request_carries_no_provider_object():
    """Cartesia returns none, so the record shows none rather than an empty one."""
    sink = Sink()
    spans = SpanEmitter(WORKED_EXAMPLE_ID, flush=sink)
    spans.opened()
    try:
        spans.provider_usage(
            ProviderUsage(
                provider="cartesia",
                model="sonic-3.5",
                operation="cartesia",
                measurement=CLIENT_MEASURED,
                quantities={"characters": 42},
            )
        )
        spans.flush()
    finally:
        spans.abort()

    span = next(
        span
        for document in sink.documents
        for span in spans_of(document)
        if span["name"] == PROVIDER_USAGE_SPAN
    )
    assert attribute(span, "egma.usage.raw") is None
    assert attribute(span, "egma.usage.provider_ref") is None


# -- What a chat simulation spends ----------------------------------------


class _BillingModel:
    """A persona model that answers and says what the answer cost."""

    def __init__(self, turns: int) -> None:
        self._turns = turns
        self._said = 0

    @property
    def model_name(self) -> str:
        return "gpt-4o-mini"

    async def reply(self, context: object) -> PersonaReply:
        self._said += 1
        return PersonaReply(
            text="Can you move my cleaning to Thursday?",
            concluded=self._said >= self._turns,
            usage=llm_usage(
                {
                    "id": f"chatcmpl-{self._said}",
                    "usage": {"prompt_tokens": 500, "completion_tokens": 20},
                },
                selection_model="gpt-4o-mini",
            ),
        )

    async def close(self) -> None:
        return None


@pytest.mark.asyncio
async def test_a_chat_simulation_bills_its_persona_turns_and_nothing_else():
    """Chat has no speech legs, so the only provider it reaches is the LLM."""
    model: ModelClient = _BillingModel(turns=2)
    persona = Persona(
        authored=AuthoredPersona(
            name="Robin", personality="Terse test person.", language="en-US"
        ),
        scenario_instructions="Move the cleaning to Thursday.",
        model=model,
    )
    spent: list[ProviderUsage] = []

    async def on_turn(speaker: str, text: str, notes: tuple[str, ...] = ()) -> None:
        return None

    async def on_provider_usage(usage: ProviderUsage) -> None:
        spent.append(usage)

    conducted = await conduct(
        persona=persona,
        plug=ScriptedCounterpart(
            modality="chat",
            access_variant="scripted.in_memory",
            config={"greeting": "Front desk.", "replies": ["Thursday works."]},
            credentials=None,
        ),
        max_turns=10,
        max_duration_seconds=30,
        on_turn=on_turn,
        on_timing=None,
        controls=ConversationControls(),
        name="chat-usage",
        on_provider_usage=on_provider_usage,
    )

    assert conducted.status == "completed"
    # One bill per persona turn, and every one of them an LLM call: a chat
    # simulation reaches no speaking leg and no listening leg at all.
    assert len(spent) == 2
    assert {usage.operation for usage in spent} == {"openai_chat_completions"}
    assert [usage.provider_ref for usage in spent] == ["chatcmpl-1", "chatcmpl-2"]
    assert all(usage.quantities["output_tokens"] == 20 for usage in spent)


def test_customer_funding_receipt_is_forwarded_unchanged_without_a_key():
    sink = Sink()
    spans = SpanEmitter(WORKED_EXAMPLE_ID, flush=sink)
    spans.opened()
    try:
        spans.provider_usage(
            ProviderUsage(
                provider="openai",
                model="gpt-4o-mini",
                operation="openai_chat_completions",
                measurement=PROVIDER_REPORTED,
                quantities={"input_tokens": 10},
                provider_ref="chatcmpl-customer",
                raw={"prompt_tokens": 10},
            ),
            funding_receipt="opaque-server-sealed-receipt",
        )
        spans.flush()
    finally:
        spans.abort()
    bills = [
        span
        for document in sink.documents
        for span in spans_of(document)
        if span["name"] == PROVIDER_USAGE_SPAN
    ]
    assert len(bills) == 1
    assert (
        attribute(bills[0], "egma.usage.funding_receipt")
        == "opaque-server-sealed-receipt"
    )
    assert attribute(bills[0], "egma.usage.payment_source") is None
    assert attribute(bills[0], "egma.usage.api_key") is None
