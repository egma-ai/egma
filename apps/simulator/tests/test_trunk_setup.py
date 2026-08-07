"""The one-time setup step, proved against a Twilio-shaped stub.

A customer hands over what they have — an account SID, an auth token and a
number — and gets back the four variables the driver reads. Everything
between those two is Twilio's own API, so it is proved the way the Retell
plug is: against a local server that speaks the same protocol, with no
account, no key and no network.

What matters and is asserted here: the artifacts really get made and
really get attached, a second run does not make a second trunk, the
emitted password is one the carrier will accept, a number the account does
not hold is refused before anything is created, and the account token — the
one credential that outlives nothing — never reaches the output.
"""

from __future__ import annotations

import pytest
from twilio_stub import ACCOUNT_SID, AUTH_TOKEN, TwilioStub, serving

from egma_simulator.trunk import (
    ARTIFACT_NAME,
    TrunkSetupError,
    provision,
    render,
)

A_NUMBER = "+15550000001"


async def setup(stub: TwilioStub, **overrides):
    """One run of the setup step against this account."""
    async with serving(stub) as running:
        return await provision(
            account_sid=stub.account_sid,
            auth_token=stub.auth_token,
            number=overrides.pop("number", A_NUMBER),
            api_root=running.base_url,
            trunking_root=running.base_url,
            **overrides,
        )


async def test_an_account_and_a_number_become_a_trunk_the_driver_can_dial():
    stub = TwilioStub()

    trunk = await setup(stub)

    # Every artifact the ticket names: a trunk with a termination URI, a
    # credential list with a credential in it, and both attached.
    assert stub.trunks, "no trunk was created"
    made = next(iter(stub.trunks.values()))
    assert made["friendly_name"] == ARTIFACT_NAME
    assert made["domain_name"].endswith(".pstn.twilio.com")
    assert made["domain_name"].startswith("egma-")
    assert trunk.address == made["domain_name"]
    assert trunk.trunk_sid == made["sid"]

    assert stub.credential_lists, "no credential list was created"
    credential_list = next(iter(stub.credential_lists.values()))
    assert stub.attached_lists[made["sid"]] == [credential_list["sid"]]
    assert stub.attached_numbers[made["sid"]] == [stub.numbers[A_NUMBER]]
    assert stub.passwords() == [trunk.password]

    # And what comes out is exactly the shape a deployment sets. The
    # backend line is there too: a trunk with nothing dialling through it
    # is half a configuration.
    emitted = dict(
        line.split("=", 1) for line in render(trunk).splitlines() if "=" in line
    )
    assert emitted == {
        "EGMA_SIMULATOR_MEDIA_BACKEND": "livekit",
        "EGMA_SIMULATOR_SIP_TRUNK_ADDRESS": made["domain_name"],
        "EGMA_SIMULATOR_SIP_TRUNK_NUMBER": A_NUMBER,
        "EGMA_SIMULATOR_SIP_TRUNK_USERNAME": trunk.username,
        "EGMA_SIMULATOR_SIP_TRUNK_PASSWORD": trunk.password,
    }


async def test_the_emitted_credential_can_do_nothing_but_place_calls():
    """Least privilege, stated as what the output holds.

    The account token opens the whole account; the SIP credential opens one
    trunk. The step exists so that only the second one has to live on a
    deployment, and the proof is that the first appears nowhere in what
    comes out of it.
    """
    stub = TwilioStub()

    trunk = await setup(stub)

    emitted = render(trunk) + "\n" + "\n".join(trunk.report)
    assert AUTH_TOKEN not in emitted
    assert trunk.password != AUTH_TOKEN
    assert trunk.username.startswith("egma-")


async def test_a_second_run_finds_what_the_first_made_and_rotates_the_password():
    """Re-running is the ordinary case, not the exceptional one.

    A setup step somebody is afraid to run twice is a step they will run
    once and then hand-edit. Twilio never hands a password back, so the one
    thing a re-run cannot do is read the old one — it mints a new one and
    tells Twilio, which is why the emitted configuration is always usable.
    """
    stub = TwilioStub()

    first = await setup(stub)
    second = await setup(stub)

    assert len(stub.trunks) == 1, "a second run made a second trunk"
    assert len(stub.credential_lists) == 1
    assert len(stub.credentials) == 1
    assert second.trunk_sid == first.trunk_sid
    assert second.address == first.address
    assert second.username == first.username
    assert second.password != first.password
    assert stub.passwords() == [second.password]
    assert any("already" in line for line in second.report), second.report


async def test_a_number_the_account_does_not_hold_is_refused_before_anything_is_made():
    stub = TwilioStub()

    with pytest.raises(TrunkSetupError) as refused:
        await setup(stub, number="+15559999999")

    assert "+15559999999" in str(refused.value)
    assert not stub.trunks, "a trunk was created for a number that cannot use it"
    assert not stub.credential_lists


async def test_a_wrong_token_is_refused_in_twilios_own_words_without_quoting_it():
    stub = TwilioStub()

    async with serving(stub) as running:
        with pytest.raises(TrunkSetupError) as refused:
            await provision(
                account_sid=ACCOUNT_SID,
                auth_token="wrong-token-entirely",
                number=A_NUMBER,
                api_root=running.base_url,
                trunking_root=running.base_url,
            )

    said = str(refused.value)
    assert "401" in said
    assert "TWILIO_AUTH_TOKEN" in said, "the refusal does not say which to fix"
    assert "wrong-token-entirely" not in said


async def test_a_carrier_that_refuses_the_trunk_outright_is_carried_up_whole():
    """A trial account cannot have a trunk, and that is Twilio's sentence to
    say. Burying it under our own would cost the one diagnosis there is."""
    stub = TwilioStub(trial=True)

    with pytest.raises(TrunkSetupError) as refused:
        await setup(stub)

    assert "trial accounts" in str(refused.value)


async def test_a_domain_name_somebody_else_holds_is_tried_around():
    """Trunk domain names are unique across all of Twilio, so the name this
    step mints can already belong to a stranger. It mints another rather
    than handing the collision to whoever ran it."""
    stub = TwilioStub(domains_already_taken=2)

    trunk = await setup(stub)

    assert stub.domains_already_taken == 0, "the collisions were not all met"
    assert len(stub.trunks) == 1
    assert trunk.address.endswith(".pstn.twilio.com")


async def test_a_run_that_cannot_get_a_domain_name_says_so_rather_than_looping():
    stub = TwilioStub(domains_already_taken=99)

    with pytest.raises(TrunkSetupError) as refused:
        await setup(stub)

    assert "already in use" in str(refused.value)
    assert not stub.trunks
