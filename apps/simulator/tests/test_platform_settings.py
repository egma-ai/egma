"""The platform's own settings, arriving on the work order.

**This file holds the proof of the whole change.** A setting used to be a
variable in each simulator's environment, which meant a second simulator on
another machine needed a file copied to it, and a container started without
one dialled nothing while reporting itself healthy. The settings belong to
the deployment now: it holds them, it seals them, and it hands them down on
the work order a simulator already claims.

The claim under test is therefore a *precedence* claim, and it is only worth
anything when both sides are set at once. So the tests below put one value
in the simulator's environment and a different value for the same setting on
the work order, and then observe which one was used. A test that set only one
side would pass against a simulator that read neither.

The acceptance tests here are black-box like the rest of that suite: a real
child process, configured only through its environment, claiming real
documents over real HTTP from the workbench, and every assertion read back
out of the workbench's records or the process's own output.
"""

from __future__ import annotations

import pytest
from conftest import (
    SENTINEL_TRUNK_ENV,
    assert_kept_secret,
    has_terminal,
    phone_spec,
    scripted_spec,
    terminal_event_for,
    turns_for,
)

from egma_simulator.config import MediaSettings, SimulatorConfig
from egma_simulator.model import GOODBYE, OpenAICompatibleModel, build_model_client
from egma_simulator.spec import (
    Limits,
    PlatformCarrier,
    PlatformModel,
    PlatformSettings,
    PlatformSpeech,
    SimulationSpec,
)
from egma_simulator.speech import SpeechProviders

# -- The proof, conducted -----------------------------------------------------

A_MODEL_THIS_CONTAINER_WOULD_HAVE_USED = {
    "EGMA_SIMULATOR_MODEL_PROVIDER": "openai",
    "EGMA_SIMULATOR_MODEL_NAME": "the-model-this-container-was-told-about",
    "EGMA_SIMULATOR_MODEL_API_KEY": "SENTINEL-container-model-key-4f19",
    # A port nothing answers on. If this container's own configuration were
    # what conducted the exchange, every persona turn would fail against it —
    # which is exactly what makes the assertion below a real observation
    # rather than two settings that happen to agree.
    "EGMA_SIMULATOR_MODEL_BASE_URL": "http://127.0.0.1:1/v1",
}


async def test_the_work_orders_model_is_what_conducts_not_this_containers(
    workbench, start_simulator
):
    """One value here, a different value for the same setting there.

    The container is told to think with a real provider at an address
    nothing answers on. The work order says `scripted`. The exchange
    happens, turn for turn — which it could not have if this container's
    own configuration had been what was read.
    """
    spec = scripted_spec(
        "sim-platform-model-001",
        scenario="State the first point. State the second point.",
        greeting="Lakeside Dental, how can I help?",
        replies=["Noted.", "Noted again."],
        platform={"model": {"provider": "scripted"}},
    )
    await workbench.offer(spec)
    simulator = start_simulator(
        workbench, extra_env=A_MODEL_THIS_CONTAINER_WOULD_HAVE_USED
    )

    records = await workbench.wait_for(has_terminal("sim-platform-model-001"))

    assert turns_for(records, "sim-platform-model-001") == [
        ("agent", "Lakeside Dental, how can I help?"),
        ("human", "State the first point."),
        ("agent", "Noted."),
        ("human", "State the second point."),
        ("agent", "Noted again."),
        ("human", GOODBYE),
    ]
    terminal = terminal_event_for(records, "sim-platform-model-001")
    assert terminal["facts"]["ending"] == "persona_concluded"

    # And the key this container was started with never left it, which is
    # the standing promise about every credential in this process.
    assert_kept_secret(
        "SENTINEL-container-model-key-4f19",
        records=records,
        simulator=simulator,
    )


A_CARRIER_ONLY_THE_PLATFORM_HOLDS = {
    "media_backend": "scripted",
    "trunk_address": "the-platform-holds-this.pstn.twilio.com",
    "trunk_number": "+15551110000",
    "trunk_username": "platform-trunk-user",
    "trunk_password": "SENTINEL-platform-trunk-password-8c02",
}


async def test_a_phone_simulation_dials_with_a_trunk_no_container_holds(
    workbench, start_simulator
):
    """The carrier lives only in the platform, and a call still happens.

    Nothing in this container's environment says it may dial or what it
    would dial with — no backend, no trunk address, no number, no
    credential. Everything arrives on the work order, and the conversation
    completes over the telephone connection.

    This is the self-hoster's story the effort was written for: the Twilio
    paperwork is done once, it lives in the platform's own store, and
    adding a second simulator is starting a container and nothing else.
    """
    spec = phone_spec(
        "sim-platform-carrier-001",
        greeting="Lakeside Dental.",
        replies=["Noted."],
        provider_reference="platform-carrier-1",
        platform={"carrier": A_CARRIER_ONLY_THE_PLATFORM_HOLDS},
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench)

    records = await workbench.wait_for(
        has_terminal("sim-platform-carrier-001"), within_seconds=60.0
    )

    terminal = terminal_event_for(records, "sim-platform-carrier-001")
    assert terminal["status"] == "completed", terminal
    assert terminal["facts"]["provider_reference"] == "platform-carrier-1"

    # A trunk password that arrived on a work order is exactly as much a
    # secret as one that arrived in this container's environment, and the
    # filter that keeps it out of the log has to know about it either way.
    assert_kept_secret(
        "SENTINEL-platform-trunk-password-8c02",
        records=records,
        simulator=simulator,
    )


async def test_the_work_orders_trunk_is_what_is_dialled_not_this_containers(
    workbench, start_simulator
):
    """And when both sides hold a carrier, the platform's is the one used.

    The container is given a whole LiveKit deployment pointed at a port
    nothing answers on — a real bridge, a real trunk, every secret a
    sentinel. The work order names the scripted bridge and its own trunk.
    The call completes, which it could not have done over the bridge in
    this container's environment.
    """
    spec = phone_spec(
        "sim-platform-carrier-002",
        greeting="Lakeside Dental.",
        replies=["Noted."],
        platform={"carrier": A_CARRIER_ONLY_THE_PLATFORM_HOLDS},
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench, extra_env=SENTINEL_TRUNK_ENV)

    records = await workbench.wait_for(
        has_terminal("sim-platform-carrier-002"), within_seconds=60.0
    )

    terminal = terminal_event_for(records, "sim-platform-carrier-002")
    assert terminal["status"] == "completed", terminal
    assert_kept_secret(
        SENTINEL_TRUNK_ENV["EGMA_SIMULATOR_SIP_TRUNK_PASSWORD"],
        records=records,
        simulator=simulator,
    )


async def test_a_deployment_that_configured_nothing_conducts_exactly_as_before(
    workbench, start_simulator
):
    """The other direction, and the one that must never regress.

    A work order with no platform block at all is what every spec written
    before these settings existed looks like, and what the control plane
    really sends for a deployment nobody has configured. This container's
    own values stand, and the exchange is the one it always was.
    """
    spec = scripted_spec(
        "sim-platform-absent-001",
        greeting="Lakeside Dental.",
        replies=["Noted.", "Noted again."],
    )
    assert "platform" not in spec

    await workbench.offer(spec)
    start_simulator(workbench)

    records = await workbench.wait_for(has_terminal("sim-platform-absent-001"))
    terminal = terminal_event_for(records, "sim-platform-absent-001")
    assert terminal["facts"]["ending"] == "persona_concluded"


# -- The same claim at each seam, read directly -------------------------------
#
# The acceptance tests above prove the whole path and are slow. These prove
# the same precedence rule at each of the three seams the settings enter
# through, which is where a reader goes to find out what wins and why.


A_URL = "http://control-plane.internal"


@pytest.fixture
def a_container(env) -> None:
    """A simulator configured the way one with no platform behind it is."""
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)


def a_spec_with(platform: PlatformSettings) -> SimulationSpec:
    """One claimed spec, carrying whatever settings a test is about."""
    return SimulationSpec(
        simulation_id="sim-under-test",
        modality="chat",
        scenario_instructions="State the first point.",
        limits=Limits(max_duration_seconds=600, max_turns=60),
        persona_traits={},
        agent_platform=None,
        connection_kind="scripted",
        access_variant="scripted.in_memory",
        connection_config={},
        credentials=None,
        platform=platform,
    )


def test_the_work_orders_model_replaces_this_containers_field_by_field(
    a_container, env
):
    """Each of the three stands on its own.

    A platform that holds the provider and the model but not the key yet is
    an ordinary platform mid-setup, and what it says about the two it holds
    has to apply without the third.
    """
    env.setenv("EGMA_SIMULATOR_MODEL_PROVIDER", "openai")
    env.setenv("EGMA_SIMULATOR_MODEL_NAME", "this-containers-model")
    env.setenv("EGMA_SIMULATOR_MODEL_API_KEY", "this-containers-key")
    config = SimulatorConfig.from_env()

    client = build_model_client(
        config,
        a_spec_with(
            PlatformSettings(
                model=PlatformModel(provider="openai", model="the-platforms-model")
            )
        ),
    )

    assert isinstance(client, OpenAICompatibleModel)
    assert client._model_name == "the-platforms-model"
    # The key the platform said nothing about is this container's, still.
    assert client._api_key == "this-containers-key"


def test_the_work_orders_speech_legs_replace_this_containers(a_container, env):
    """One leg at a time, and each leg's key follows its leg's provider."""
    env.setenv("EGMA_SIMULATOR_STT_PROVIDER", "scripted")
    env.setenv("EGMA_SIMULATOR_TTS_PROVIDER", "scripted")
    config = SimulatorConfig.from_env()

    providers = SpeechProviders.for_simulation(
        config,
        PlatformSpeech(
            stt_provider="deepgram",
            stt_key="the-platforms-listening-key",
            tts_provider="elevenlabs",
            tts_key="the-platforms-speaking-key",
            tts_voice="a-voice-the-platform-chose",
            vad_provider="silero",
        ),
    )

    assert providers.stt == "deepgram"
    assert providers.stt_key == "the-platforms-listening-key"
    assert providers.tts == "elevenlabs"
    assert providers.tts_key == "the-platforms-speaking-key"
    assert providers.tts_voice == "a-voice-the-platform-chose"
    assert providers.vad == "silero"


def test_a_platform_that_names_a_provider_and_no_key_uses_this_containers(
    a_container, env
):
    """Which is what a self-hoster who set one openai key for both legs
    means: use this company, with the key you already have."""
    env.setenv("EGMA_SIMULATOR_STT_PROVIDER", "openai")
    env.setenv("EGMA_SIMULATOR_TTS_PROVIDER", "openai")
    env.setenv("EGMA_SIMULATOR_OPENAI_API_KEY", "one-account-for-both-legs")
    config = SimulatorConfig.from_env()

    providers = SpeechProviders.for_simulation(config, PlatformSpeech())

    assert providers.stt_key == "one-account-for-both-legs"
    assert providers.tts_key == "one-account-for-both-legs"


def test_a_platform_that_says_nothing_leaves_every_leg_where_it_was(
    a_container, env
):
    env.setenv("EGMA_SIMULATOR_STT_PROVIDER", "deepgram")
    env.setenv("EGMA_SIMULATOR_DEEPGRAM_API_KEY", "this-containers-key")
    config = SimulatorConfig.from_env()

    providers = SpeechProviders.for_simulation(config)

    assert providers.stt == "deepgram"
    assert providers.stt_key == "this-containers-key"
    assert providers.tts == "scripted"
    assert providers.tts_key is None


def test_the_settings_a_work_order_carries_are_all_registered_for_redaction():
    """Every secret in the block, in one place to ask.

    The registry is what keeps a credential out of the log, and it can only
    scrub what it was told about. A fourth key arriving in this block and
    not in this tuple would be a key the filter has never heard of.
    """
    settings = PlatformSettings(
        model=PlatformModel(key="a-model-key"),
        speech=PlatformSpeech(stt_key="a-listening-key", tts_key="a-speaking-key"),
        carrier=PlatformCarrier(trunk_password="a-trunk-password"),
    )

    assert set(settings.secrets) == {
        "a-model-key",
        "a-listening-key",
        "a-speaking-key",
        "a-trunk-password",
    }
    # And a platform holding none of them offers none, rather than a tuple
    # of empties the filter would then try to scrub every line against.
    assert PlatformSettings().secrets == ()


def test_the_media_server_stays_this_containers_and_the_trunk_the_platforms():
    """The split the spec drew, held at the one seam it passes through.

    A third-party binary reads its own key and secret when it is created and
    cannot reach the platform's database, so the bridge is bootstrap
    configuration forever. The trunk is paperwork somebody did once with a
    carrier, so it is the platform's.
    """
    bridge = MediaSettings(
        backend="livekit",
        livekit_url="wss://this-containers-media-server",
        livekit_api_key="this-containers-media-key",
        livekit_api_secret="this-containers-media-secret",
    )

    settled = MediaSettings.for_simulation(
        bridge,
        PlatformCarrier(
            trunk_address="the-platforms-trunk.pstn.twilio.com",
            trunk_number="+15551110000",
        ),
    )

    assert settled is not None
    assert settled.livekit_url == "wss://this-containers-media-server"
    assert settled.livekit_api_secret == "this-containers-media-secret"
    assert settled.trunk_address == "the-platforms-trunk.pstn.twilio.com"


# -- A typo must refuse, never conduct ----------------------------------------
#
# The worst failure this effort could ship: a platform whose provider name
# has one letter wrong, and a simulation that completes green anyway because
# every builder falls through to its scripted stand-in. On a product whose
# whole purpose is trust in the agent somebody ships, a canned robot
# reporting a pass is worse than any refusal — a refusal tells the truth.
#
# The container's own names are refused when it starts, by `_one_of`. These
# are the platform's, and they had no equivalent until now.


def test_a_model_provider_nobody_wrote_refuses_rather_than_conducting(
    a_container, env
):
    from egma_simulator.model import ModelFailure

    env.setenv("EGMA_SIMULATOR_MODEL_PROVIDER", "scripted")
    config = SimulatorConfig.from_env()

    with pytest.raises(ModelFailure) as refusal:
        build_model_client(
            config,
            a_spec_with(
                PlatformSettings(model=PlatformModel(provider="openaii"))
            ),
        )

    told = str(refusal.value)
    assert "persona_model_provider" in told
    assert "openaii" in told
    assert "scripted, openai" in told


@pytest.mark.parametrize(
    ("setting", "block", "wrong"),
    [
        ("speech_to_text_provider", "stt_provider", "deepgramm"),
        ("text_to_speech_provider", "tts_provider", "elevenlabss"),
        ("voice_activity_provider", "vad_provider", "silerro"),
    ],
)
def test_a_speech_provider_nobody_wrote_refuses_rather_than_conducting(
    a_container, setting, block, wrong
):
    from egma_simulator.speech import (
        SpeechFault,
        build_legs,
        build_vad,
        voice_from_traits,
    )

    providers = SpeechProviders.for_simulation(
        SimulatorConfig.from_env(), PlatformSpeech(**{block: wrong})
    )

    # Both entry points, because a voice simulation goes through both and a
    # refusal only one of them held would be a leg silently standing in.
    for build in (
        lambda: build_legs(providers, voice=voice_from_traits({})),
        lambda: build_vad(providers),
    ):
        with pytest.raises(SpeechFault) as refusal:
            build()
        told = str(refusal.value)
        assert setting in told
        assert wrong in told


def test_a_chat_simulation_is_not_broken_by_a_speech_provider_it_never_uses(
    a_container, env
):
    """The refusal is where the leg is *built*, and a chat simulation builds
    none. A platform mid-setup with a typo in its speaking leg still runs
    every chat and text simulation it always did."""
    config = SimulatorConfig.from_env()
    client = build_model_client(
        config,
        a_spec_with(
            PlatformSettings(speech=PlatformSpeech(tts_provider="elevenlabss"))
        ),
    )
    assert client is not None


def test_a_media_backend_nobody_wrote_refuses_at_the_moment_of_dialling():
    settled = MediaSettings.for_simulation(
        None, PlatformCarrier(media_backend="livekitt")
    )
    assert settled is not None

    with pytest.raises(ValueError) as refusal:
        settled.checked()
    assert "livekitt" in str(refusal.value)


def test_the_work_orders_listening_model_replaces_this_containers(
    a_container, env
):
    """The setting that used to have no way down here.

    Every other speech answer was the platform's already; this one lived in
    each simulator's environment alone, so moving the persona's mouth was a
    settings page and moving its ears was editing a container and restarting
    it. It arrives on the work order now, like the rest.
    """
    env.setenv("EGMA_SIMULATOR_STT_MODEL", "this-containers-listening-model")
    config = SimulatorConfig.from_env()

    providers = SpeechProviders.for_simulation(
        config, PlatformSpeech(stt_model="the-platforms-listening-model")
    )

    assert providers.stt_model == "the-platforms-listening-model"


def test_a_platform_silent_about_the_listening_model_leaves_this_containers(
    a_container, env
):
    env.setenv("EGMA_SIMULATOR_STT_MODEL", "this-containers-listening-model")
    config = SimulatorConfig.from_env()

    providers = SpeechProviders.for_simulation(config, PlatformSpeech())

    assert providers.stt_model == "this-containers-listening-model"


def test_nobody_naming_a_model_leaves_it_for_the_built_leg_to_answer(
    a_container, env
):
    """``None`` here is the whole point: a model name belongs to one
    provider, so the leg that is really built is the only thing that can
    say which default applies."""
    config = SimulatorConfig.from_env()

    providers = SpeechProviders.for_simulation(config, PlatformSpeech())

    assert providers.stt_model is None
    assert providers.tts_model is None
    assert providers.tts_voice is None


def test_the_work_orders_reasoning_effort_reaches_the_model_call(
    a_container, env
):
    env.setenv("EGMA_SIMULATOR_MODEL_PROVIDER", "openai")
    env.setenv("EGMA_SIMULATOR_MODEL_NAME", "a-model")
    env.setenv("EGMA_SIMULATOR_MODEL_API_KEY", "a-key")
    config = SimulatorConfig.from_env()

    client = build_model_client(
        config,
        a_spec_with(
            PlatformSettings(model=PlatformModel(reasoning_effort="none"))
        ),
    )

    assert isinstance(client, OpenAICompatibleModel)
    assert client._reasoning_effort == "none"


def test_nobody_asking_for_reasoning_sends_no_such_field(a_container, env):
    """Absent has to stay absent on the wire. A model that has never heard
    of the field refuses a request carrying it, so a default here would
    narrow which models a deployment can run to the ones egma knew about."""
    env.setenv("EGMA_SIMULATOR_MODEL_PROVIDER", "openai")
    env.setenv("EGMA_SIMULATOR_MODEL_NAME", "a-model")
    env.setenv("EGMA_SIMULATOR_MODEL_API_KEY", "a-key")
    config = SimulatorConfig.from_env()

    client = build_model_client(config, a_spec_with(PlatformSettings()))

    assert isinstance(client, OpenAICompatibleModel)
    assert client._reasoning_effort is None
