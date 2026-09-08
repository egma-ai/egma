"""What one provider request consumed, as the record Egma keeps of it.

Every model call a simulation makes costs money. The provider is the only
witness to what it charged, so wherever a provider says what it consumed, that
number is kept whole and Egma counts nothing of its own; where a provider says
nothing — Cartesia returns no usage field at all — Egma counts what it sent and
the record says which of the two it is.

**The units are the providers' own and the names are normalised.** The
providers do not agree with each other, and one of them does not agree with
itself: OpenAI's ``prompt_tokens`` *includes* the tokens it served from its
cache, at a tenth of the price, while Anthropic's ``input_tokens`` excludes
them. So ``input_tokens`` here always means the **uncached** part of the
prompt, the subtraction is done once, at the moment the body is read, and the
provider's own object rides along untouched so a wrong reading can be re-rated
later rather than measured again.

Nothing here decides what anything costs. A usage record is priced where it is
stored, against a rate card the platform holds, so a price change never needs a
release of this process.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

PROVIDER_REPORTED = "provider_reported"
"""The numbers are the provider's own, off the body it answered with."""

CLIENT_MEASURED = "client_measured"
"""Egma counted what it sent, because the provider said nothing."""


@dataclass(frozen=True)
class ProviderUsage:
    """One provider request, measured.

    ``operation`` is the catalog adapter that spoke to the provider — one
    vocabulary for the protocol, shared with the platform's own tables, rather
    than a second list of words meaning the same thing.
    """

    provider: str
    model: str
    operation: str
    measurement: str
    quantities: dict[str, float]
    provider_ref: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def measured_anything(self) -> bool:
        """Whether there is a quantity worth recording at all."""
        return any(quantity > 0 for quantity in self.quantities.values())


def _counted(held: Any, key: str) -> float:
    """One non-negative number out of a provider's object, or zero."""
    if not isinstance(held, dict):
        return 0.0
    value = held.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    return float(value) if value > 0 else 0.0


def _without_zeroes(quantities: dict[str, float]) -> dict[str, float]:
    """Only what was actually consumed.

    A zero is a fact nobody learns anything from finding, and a record whose
    every quantity is zero is a request that consumed nothing — which is not a
    bill and is not written.
    """
    return {name: value for name, value in quantities.items() if value > 0}


def llm_usage(body: Any, *, selection_model: str) -> ProviderUsage | None:
    """What one chat completion consumed, off the body Egma already parsed.

    ``selection_model`` is the pinned catalog model, and it is what the record
    carries: OpenAI answers ``gpt-5.6-terra-2026-08-01`` for a request that
    asked for ``gpt-5.6-terra``, and the rate card is keyed by the catalog Egma
    itself closed. The provider's own string stays inside the raw object.
    """
    if not isinstance(body, dict):
        return None
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return None

    prompt_tokens = _counted(usage, "prompt_tokens")
    cached = _counted(usage.get("prompt_tokens_details"), "cached_tokens")
    quantities = _without_zeroes(
        {
            "input_tokens": max(prompt_tokens - cached, 0.0),
            "cached_input_tokens": cached,
            "output_tokens": _counted(usage, "completion_tokens"),
        }
    )
    if not quantities:
        return None

    reference = body.get("id")
    return ProviderUsage(
        provider="openai",
        model=selection_model,
        operation="openai_chat_completions",
        measurement=PROVIDER_REPORTED,
        quantities=quantities,
        provider_ref=reference if isinstance(reference, str) and reference else None,
        raw=dict(usage),
    )


def realtime_transcription_usage(
    event: Any, *, selection_model: str
) -> ProviderUsage | None:
    """What one realtime transcription consumed, off the completed event.

    OpenAI bills these two ways and says which on the event itself: ``duration``
    models are billed on the seconds of audio the commit carried, ``tokens``
    models on the audio and text tokens it became. Both shapes are read rather
    than assumed, because which one a model uses is the provider's decision and
    it has changed before.
    """
    if not isinstance(event, dict):
        return None
    usage = event.get("usage")
    if not isinstance(usage, dict):
        return None

    shape = usage.get("type")
    if shape == "duration":
        quantities = _without_zeroes({"audio_seconds": _counted(usage, "seconds")})
    elif shape == "tokens":
        details = usage.get("input_token_details")
        quantities = _without_zeroes(
            {
                "audio_input_tokens": _counted(details, "audio_tokens"),
                "text_input_tokens": _counted(details, "text_tokens"),
                "output_tokens": _counted(usage, "output_tokens"),
            }
        )
    else:
        # A shape this release has never seen. Recording it under a guessed
        # unit would be worse than the gap: the platform would price a number
        # that means something else.
        return None
    if not quantities:
        return None

    item = event.get("item_id")
    return ProviderUsage(
        provider="openai",
        model=selection_model,
        operation="openai_realtime",
        measurement=PROVIDER_REPORTED,
        quantities=quantities,
        provider_ref=item if isinstance(item, str) and item else None,
        raw=dict(usage),
    )


def audio_seconds_usage(
    seconds: float, *, provider: str, model: str, operation: str
) -> ProviderUsage | None:
    """Seconds of audio Egma sent to a listening leg, as Pipecat counted them.

    Client-measured, and the record says so. A streaming service is sent every
    frame including the silence between turns, which is what the providers bill
    for — so this approximates the billed figure rather than reporting it.
    """
    if seconds <= 0:
        return None
    return ProviderUsage(
        provider=provider,
        model=model,
        operation=operation,
        measurement=CLIENT_MEASURED,
        quantities={"audio_seconds": float(seconds)},
    )


def characters_usage(
    characters: int, *, provider: str, model: str, operation: str
) -> ProviderUsage | None:
    """Characters Egma handed a speaking leg.

    Client-measured everywhere, because no speaking provider in this release
    returns a usage object at all. Cartesia says its own count "can vary
    slightly due to transcript pre-processing", so this is Egma's estimate of a
    number only Cartesia holds.
    """
    if characters <= 0:
        return None
    return ProviderUsage(
        provider=provider,
        model=model,
        operation=operation,
        measurement=CLIENT_MEASURED,
        quantities={"characters": float(characters)},
    )


def as_json(value: Any) -> str:
    """The compact JSON a span attribute carries, or ``{}`` for anything else."""
    try:
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    except (TypeError, ValueError):
        return "{}"
