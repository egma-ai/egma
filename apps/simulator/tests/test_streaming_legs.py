"""The two streaming legs, and what each of them is built with.

The pair a real deployment speaks and hears with over a phone line:
Cartesia's mouth and OpenAI's realtime ears. Both hold a socket open and
work while the far end is still talking, which is the whole reason they
exist beside the segmented legs already here.

Nothing in this file reaches a provider. What is checked is what a leg is
built with — the model, the voice, and where the turn boundary is decided.
The live suites beside this one
prove the audio really flows; this one proves the wiring.
"""

from __future__ import annotations

from typing import Any

import pytest

from egma_simulator.config import (
    DEFAULT_CARTESIA_TTS_MODEL,
    DEFAULT_DEEPGRAM_STT_MODEL,
    DEFAULT_REALTIME_STT_MODEL,
    DEFAULT_STT_MODEL,
    SimulatorConfig,
)
from egma_simulator.speech import (
    DEFAULT_CARTESIA_VOICE_ID,
    PersonaVoice,
    SpeechFault,
    SpeechProviders,
    _ears,
    _mouth,
    voice_from_traits,
)

A_KEY = "sk-only-this-test-holds-this-one"

def _speaking(leg):
    """The provider's own service inside the openai mouth.

    It used to be one of two processors in a little pipeline — the service
    and a band correction after it — and this helper found it by what it
    is rather than by where it sat. The band the correction carried audio
    to is retired, so the mouth is the stock service again and there is
    nothing to look inside. The helper stays because every caller reads
    the same thing through it, and because a mouth that grows a wrapper
    again should change one function rather than six assertions.
    """
    from pipecat.services.openai.tts import OpenAITTSService

    assert isinstance(leg, OpenAITTSService)
    return leg


def capture_construction(
    monkeypatch: pytest.MonkeyPatch, service: type
) -> list[dict[str, Any]]:
    """Remember the public arguments Egma hands a provider service."""
    calls: list[dict[str, Any]] = []
    original = service.__init__

    def remember(instance: object, *args: object, **kwargs: Any) -> None:
        calls.append(kwargs)
        original(instance, *args, **kwargs)

    monkeypatch.setattr(service, "__init__", remember)
    return calls


# -- The cartesia mouth -------------------------------------------------------


def test_the_cartesia_mouth_uses_the_default_voice():
    _leg, spoken_with, closers = _mouth(
        SpeechProviders(tts="cartesia", tts_key=A_KEY),
        voice_from_traits({}),
    )

    assert spoken_with.voice_id == DEFAULT_CARTESIA_VOICE_ID
    assert spoken_with.provider == "cartesia"
    assert closers == ()


def test_the_cartesia_mouth_asks_for_this_providers_model_when_nobody_named_one(
    monkeypatch: pytest.MonkeyPatch,
):
    from pipecat.services.cartesia.tts import CartesiaTTSService

    calls = capture_construction(monkeypatch, CartesiaTTSService)
    _mouth(
        SpeechProviders(tts="cartesia", tts_key=A_KEY),
        voice_from_traits({}),
    )

    assert calls[0]["settings"].model == DEFAULT_CARTESIA_TTS_MODEL


def test_a_named_model_and_voice_reach_the_cartesia_mouth(
    monkeypatch: pytest.MonkeyPatch,
):
    """What the platform said wins over the provider's own default."""
    from pipecat.services.cartesia.tts import CartesiaTTSService

    calls = capture_construction(monkeypatch, CartesiaTTSService)
    _leg, spoken_with, _ = _mouth(
        SpeechProviders(
            tts="cartesia",
            tts_key=A_KEY,
            tts_model="sonic-something-newer",
            tts_voice="a-voice-the-platform-chose",
        ),
        voice_from_traits({}),
    )

    assert calls[0]["settings"].model == "sonic-something-newer"
    assert spoken_with.voice_id == "a-voice-the-platform-chose"


def test_a_persona_authored_for_another_provider_speaks_with_the_default_voice():
    """A voice id belongs to whoever minted it. Handing Cartesia an
    ElevenLabs identifier is a refusal at the first word, and a simulation
    must not fail on a timbre."""
    _, spoken_with, _ = _mouth(
        SpeechProviders(tts="cartesia", tts_key=A_KEY),
        voice_from_traits(
            {"voice": {"voiceId": "EXAVITQu4vr4xnSDxMaL", "provider": "elevenlabs"}}
        ),
    )

    assert spoken_with.voice_id == DEFAULT_CARTESIA_VOICE_ID


@pytest.mark.parametrize(
    ("authored", "spoken"),
    [(1.2, 1.2), (3.0, 1.5), (0.1, 0.6)],
)
def test_a_speed_outside_what_cartesia_accepts_is_clamped_rather_than_refused(
    authored: float, spoken: float, monkeypatch: pytest.MonkeyPatch
):
    """Speed rides this provider's own generation block, and a persona's
    speed was authored against whichever provider it was written for. Out
    of range is clamped, because a refused request would fail a whole
    simulation over a timbre."""
    from pipecat.services.cartesia.tts import CartesiaTTSService

    calls = capture_construction(monkeypatch, CartesiaTTSService)
    _mouth(
        SpeechProviders(tts="cartesia", tts_key=A_KEY),
        voice_from_traits({"voice": {"speed": authored}}),
    )

    generation = calls[0]["settings"].generation_config
    assert generation.speed == pytest.approx(spoken)


def test_the_cartesia_mouth_refuses_without_a_key_rather_than_at_the_first_turn():
    with pytest.raises(SpeechFault, match="without a key"):
        _mouth(
            SpeechProviders(tts="cartesia"),
            voice_from_traits({}),
        )


# -- The openai realtime ears -------------------------------------------------


def test_the_realtime_ears_ask_for_the_streaming_model_by_default(
    monkeypatch: pytest.MonkeyPatch,
):
    """The two openai transports are two provider names, and each has its
    own default model. The segmented leg's default reaching the streaming
    one would be a name asked of the wrong endpoint."""
    from pipecat.services.openai.stt import OpenAIRealtimeSTTService

    calls = capture_construction(monkeypatch, OpenAIRealtimeSTTService)
    _leg, connected = _ears(
        SpeechProviders(stt="openai_realtime", stt_key=A_KEY)
    )

    model = calls[0]["settings"].model
    assert model == DEFAULT_REALTIME_STT_MODEL
    assert model != DEFAULT_STT_MODEL
    # A streaming leg drops audio handed to it before it can hear, so it
    # must offer something to wait on. The segmented leg has nothing to
    # wait for and offers none.
    assert connected is not None


def test_the_segmented_ears_keep_their_own_default(
    monkeypatch: pytest.MonkeyPatch,
):
    from pipecat.services.openai.stt import OpenAISTTService

    calls = capture_construction(monkeypatch, OpenAISTTService)
    _leg, connected = _ears(SpeechProviders(stt="openai", stt_key=A_KEY))

    assert calls[0]["settings"].model == DEFAULT_STT_MODEL
    assert connected is None


def test_a_named_model_reaches_the_realtime_ears(
    monkeypatch: pytest.MonkeyPatch,
):
    from pipecat.services.openai.stt import OpenAIRealtimeSTTService

    calls = capture_construction(monkeypatch, OpenAIRealtimeSTTService)
    _ears(
        SpeechProviders(
            stt="openai_realtime", stt_key=A_KEY, stt_model="gpt-live-something-newer"
        ),
    )

    assert calls[0]["settings"].model == "gpt-live-something-newer"


def test_the_realtime_ears_leave_the_turn_boundary_to_the_detector_in_the_pipeline(
    monkeypatch: pytest.MonkeyPatch,
):
    """The one setting on this leg that is not a name.

    Server-side detection would be a second opinion about where a turn
    ended, arriving on a different clock from the ear that stamps the
    record's sample positions — and the transcript and the timings would
    then disagree. False is this service's word for "the detector is in
    the pipeline", which is where egma's is.
    """
    from pipecat.services.openai.stt import OpenAIRealtimeSTTService

    calls = capture_construction(monkeypatch, OpenAIRealtimeSTTService)
    _ears(SpeechProviders(stt="openai_realtime", stt_key=A_KEY))

    assert calls[0]["turn_detection"] is False


def test_the_realtime_ears_refuse_without_a_key_rather_than_at_the_first_turn():
    with pytest.raises(SpeechFault, match="without a key"):
        _ears(SpeechProviders(stt="openai_realtime"))


# -- Where a leg is reached ---------------------------------------------------

A_GATEWAY = "https://a-gateway.example"
A_SOCKET_GATEWAY = "wss://a-gateway.example"
"""The same address, in the scheme a socket client will open. See
:func:`egma_simulator.speech._socket_address`."""


def test_the_cartesia_mouth_is_reached_where_the_deployment_says():
    """The whole of what managed model access asks of a speech factory.

    A leg reached through the Egma model gateway is the same shipped
    Pipecat service, told a different address and given a different
    credential. Nothing else changes — not the model, not the voice, not
    the band, not the protocol — which is what keeps this repository from
    growing a second provider-adapter layer beside Pipecat.
    """
    leg, _, _ = _mouth(
        SpeechProviders(
            tts="cartesia",
            tts_key=A_KEY,
            tts_base_url=f"{A_GATEWAY}/cartesia/tts/websocket",
        ),
        voice_from_traits({}),
    )

    # The address it was told, in the scheme a socket client will open.
    assert leg._url == f"{A_SOCKET_GATEWAY}/cartesia/tts/websocket"


def test_the_cartesia_mouth_speaks_to_its_own_provider_when_nobody_named_an_address():
    leg, _, _ = _mouth(
        SpeechProviders(tts="cartesia", tts_key=A_KEY),
        voice_from_traits({}),
    )

    assert "cartesia.ai" in leg._url


def test_the_deepgram_ears_are_reached_where_the_deployment_says():
    leg, _ = _ears(
        SpeechProviders(
            stt="deepgram", stt_key=A_KEY, stt_base_url=f"{A_GATEWAY}/deepgram"
        ),
    )

    # Read off the address the built client really holds. This provider's
    # SDK derives both a socket and an HTTP address from one base, so a
    # release that changes where it keeps them must fail here, loudly,
    # rather than by a simulation quietly reaching the provider directly
    # while a deployment believes its traffic goes through the gateway.
    environment = leg._client._client_wrapper.get_environment()
    assert environment.production == "wss://a-gateway.example/deepgram"
    assert environment.base == f"{A_GATEWAY}/deepgram"


def test_the_deepgram_ears_listen_at_their_own_provider_when_nobody_named_an_address():
    leg, _ = _ears(
        SpeechProviders(stt="deepgram", stt_key=A_KEY)
    )

    assert "deepgram.com" in leg._client._client_wrapper.get_environment().production


# -- What a selected model, voice and speed really reach ----------------------


def test_the_deepgram_ears_are_told_which_model_to_listen_with():
    """The hole this test closed, and it is worth saying plainly.

    This leg used to be built with a key, a band and an address and
    *nothing else*. It listened with whatever the shipped service's own
    default was, so a persona that selected ``nova-3-general`` and one
    that selected anything else were transcribed by the same model and
    neither selection reached the wire. A model that does not reach the
    provider is a catalog entry that does not mean anything.
    """
    leg, _ = _ears(
        SpeechProviders(stt="deepgram", stt_key=A_KEY, stt_model="nova-2-phonecall"),
    )

    assert leg._settings.model == "nova-2-phonecall"


def test_the_deepgram_ears_ask_for_this_providers_model_when_nobody_named_one():
    leg, _ = _ears(SpeechProviders(stt="deepgram", stt_key=A_KEY))

    assert leg._settings.model == DEFAULT_DEEPGRAM_STT_MODEL


def test_a_model_id_this_release_has_never_heard_of_still_reaches_the_provider():
    """Egma allowlists no model id, and this is where that is true or not.

    A release proves one recommended default per catalog entry; a user may
    type any id the shipped adapter accepts. A leg that quietly replaced
    an unfamiliar id with its own default would make the catalog a list of
    every model Egma knows about, which is a list that is wrong the week
    after it ships — and its wrongness would read as "Egma does not
    support this model" for a model that works. The provider is the
    authority, so the id crosses and the provider decides.
    """
    listening, _ = _ears(
        SpeechProviders(
            stt="deepgram", stt_key=A_KEY, stt_model="a-model-shipped-next-year"
        ),
    )
    assert listening._settings.model == "a-model-shipped-next-year"

    speaking, spoken_with, _ = _mouth(
        SpeechProviders(
            tts="cartesia",
            tts_key=A_KEY,
            tts_model="sonic-not-yet-released",
            tts_voice="a-voice-minted-this-morning",
        ),
        voice_from_traits({}),
    )
    assert speaking._settings.model == "sonic-not-yet-released"
    assert spoken_with.voice_id == "a-voice-minted-this-morning"


def test_the_realtime_ears_are_reached_where_the_deployment_says():
    """The listening half of managed access for this provider.

    This service takes a whole socket address and appends its own
    ``?intent=transcription``, so the gateway's route for the pair is the
    whole of what it is told. Until it was told one, a managed persona
    that selected OpenAI to listen with would have opened a socket
    straight at the provider holding an Egma gateway credential.
    """
    leg, _ = _ears(
        SpeechProviders(
            stt="openai_realtime",
            stt_key=A_KEY,
            stt_base_url=f"{A_GATEWAY}/openai/v1/realtime",
        ),
    )

    assert leg._base_url == f"{A_SOCKET_GATEWAY}/openai/v1/realtime"


def test_the_realtime_ears_listen_at_their_own_provider_when_nobody_named_an_address():
    leg, _ = _ears(
        SpeechProviders(stt="openai_realtime", stt_key=A_KEY)
    )

    assert "openai.com" in leg._base_url


def test_the_segmented_ears_are_reached_where_the_deployment_says():
    leg, _ = _ears(
        SpeechProviders(
            stt="openai", stt_key=A_KEY, stt_base_url=f"{A_GATEWAY}/openai/v1"
        ),
    )

    assert str(leg._client.base_url).rstrip("/") == f"{A_GATEWAY}/openai/v1"


def test_the_openai_mouth_is_reached_where_the_deployment_says():
    leg, _, _ = _mouth(
        SpeechProviders(
            tts="openai", tts_key=A_KEY, tts_base_url=f"{A_GATEWAY}/openai/v1"
        ),
        voice_from_traits({}),
    )

    assert str(_speaking(leg)._client.base_url).rstrip("/") == f"{A_GATEWAY}/openai/v1"


def test_the_openai_mouth_speaks_to_its_own_provider_when_nobody_named_an_address():
    leg, _, _ = _mouth(
        SpeechProviders(tts="openai", tts_key=A_KEY),
        voice_from_traits({}),
    )

    assert "openai.com" in str(_speaking(leg)._client.base_url)


def test_a_named_model_voice_and_speed_reach_the_openai_mouth():
    """All three of the things a TTS selection carries, on one leg.

    Speed is the one that fails silently when it is wrong: a persona
    authored to speak quickly and a persona authored to speak slowly
    sound identical, and nothing anywhere says so.
    """
    leg, spoken_with, _ = _mouth(
        SpeechProviders(
            tts="openai", tts_key=A_KEY, tts_model="tts-1-hd", tts_voice="onyx"
        ),
        PersonaVoice(voice_id="onyx", provider="openai", speed=1.25),
    )

    speaking = _speaking(leg)
    assert speaking._settings.model == "tts-1-hd"
    assert speaking._settings.voice == "onyx"
    assert speaking._settings.speed == 1.25
    assert spoken_with.voice_id == "onyx"


def test_a_selected_openai_stt_persona_listens_on_the_proved_adapter(monkeypatch):
    """The catalog's word, and the leg it means.

    "OpenAI STT" is a provider account rather than a transport, and this
    provider has two interfaces that transcribe. The catalog exposes the
    socket, because the segmented one cannot begin until the speaker has
    stopped. What a persona selected is ``openai``; what gets built has to
    be the socket, or the entry means the interface it was measured
    against and rejected.
    """
    from egma_simulator.spec import (
        ModelSelection,
        SelectedModels,
        SpeechSelection,
    )

    selected = SelectedModels(
        access="customer-owned",
        llm=ModelSelection(provider="openai", model="a-model", key=A_KEY),
        stt=ModelSelection(provider="openai", model="gpt-live-transcribe", key=A_KEY),
        tts=SpeechSelection(
            provider="cartesia",
            model="sonic-3.5",
            key=A_KEY,
            voice_id="a-voice",
            speed=1.0,
        ),
    )
    monkeypatch.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", "https://control.example")
    providers = SpeechProviders.for_simulation(
        SimulatorConfig.from_env(), None, selected
    )

    assert providers.stt == "openai_realtime"
    leg, _ = _ears(providers)
    assert type(leg).__name__ == "OpenAIRealtimeSTTService"
    assert leg._settings.model == "gpt-live-transcribe"


# -- The scheme a socket client will actually open ---------------------------


def test_a_socket_leg_is_given_an_address_it_can_open():
    """The bug this closes never said anything, which is why it is here.

    A gateway address is written ``https://``, because that is how anybody
    writes an address and because the control plane refuses a plain-text
    one. The two legs that are handed a *whole socket address* pass it to a
    library that raises ``InvalidURI`` for any scheme that is not ``ws`` or
    ``wss`` — and both legs catch their own connection failures, so a
    deployment on managed access saw a leg that never connected rather than
    an address that could never have been opened. Found by running the
    catalog's own live proof through the deployed gateway.
    """
    speaking, _, _ = _mouth(
        SpeechProviders(
            tts="cartesia",
            tts_key=A_KEY,
            tts_base_url="https://gateway.example/cartesia/tts/websocket",
        ),
        voice_from_traits({}),
    )
    assert speaking._url == "wss://gateway.example/cartesia/tts/websocket"

    listening, _ = _ears(
        SpeechProviders(
            stt="openai_realtime",
            stt_key=A_KEY,
            stt_base_url="https://gateway.example/openai/v1/realtime",
        ),
    )
    assert listening._base_url == "wss://gateway.example/openai/v1/realtime"


def test_an_address_already_written_as_a_socket_is_left_alone():
    """The third case, and the one a translation gets wrong quietly.

    Both shipped socket adapters default to a ``wss://`` address of their
    own, and a deployment or a harness may name one directly. A conversion
    that only knew how to rewrite ``http`` schemes would be fine; one that
    assumed it was always handed an ``https`` address and sliced a fixed
    number of characters off the front would mangle this and say nothing.
    So what is asserted is that an address already in the scheme a socket
    client opens crosses untouched.
    """
    speaking, _, _ = _mouth(
        SpeechProviders(
            tts="cartesia",
            tts_key=A_KEY,
            tts_base_url="wss://gateway.example/cartesia/tts/websocket",
        ),
        voice_from_traits({}),
    )
    assert speaking._url == "wss://gateway.example/cartesia/tts/websocket"

    listening, _ = _ears(
        SpeechProviders(
            stt="openai_realtime",
            stt_key=A_KEY,
            stt_base_url="ws://127.0.0.1:8787/openai/v1/realtime",
        ),
    )
    assert listening._base_url == "ws://127.0.0.1:8787/openai/v1/realtime"


def test_a_loopback_gateway_keeps_its_own_scheme_rather_than_gaining_tls():
    """The deterministic suite runs a real gateway on `127.0.0.1` over plain
    HTTP, and a leg that upgraded that to `wss` would be asking for a
    certificate nobody issued."""
    speaking, _, _ = _mouth(
        SpeechProviders(
            tts="cartesia",
            tts_key=A_KEY,
            tts_base_url="http://127.0.0.1:8787/cartesia/tts/websocket",
        ),
        voice_from_traits({}),
    )
    assert speaking._url == "ws://127.0.0.1:8787/cartesia/tts/websocket"


async def test_realtime_readiness_refuses_if_the_pinned_pipecat_signal_moves(
    monkeypatch: pytest.MonkeyPatch,
):
    """A dependency rename is an explicit refusal, not a lost first turn."""
    from pipecat.processors.frame_processor import FrameProcessor
    from pipecat.services.openai import stt as openai_stt

    class SessionlessRealtimeSTT(FrameProcessor):
        created: SessionlessRealtimeSTT | None = None

        class Settings:
            def __init__(self, *, model: str) -> None:
                self.model = model

        def __init__(self, **_kwargs: object) -> None:
            super().__init__()
            self.handlers: dict[str, Any] = {}
            SessionlessRealtimeSTT.created = self

        def event_handler(self, name: str):
            def register(handler):
                self.handlers[name] = handler
                return handler

            return register

        async def announce_connected(self) -> None:
            await self.handlers["on_connected"](self)

    monkeypatch.setattr(
        openai_stt, "OpenAIRealtimeSTTService", SessionlessRealtimeSTT
    )
    _leg, connected = _ears(
        SpeechProviders(stt="openai_realtime", stt_key=A_KEY)
    )
    leg = SessionlessRealtimeSTT.created
    assert leg is not None
    assert connected is not None

    await leg.announce_connected()
    with pytest.raises(SpeechFault, match="no longer says when"):
        await connected()
