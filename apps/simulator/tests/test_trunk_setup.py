"""The one-time setup step, proved against a Twilio-shaped stub.

A customer hands over what they have — an account SID, an auth token and a
number — and gets back the five variables the driver reads. Everything
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

import asyncio

import pytest
from twilio_stub import ACCOUNT_SID, AUTH_TOKEN, TwilioStub, serving

from egma_simulator.trunk import (
    ARTIFACT_NAME,
    TrunkSetupError,
    main,
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

    # Every artifact setup makes: a trunk with a termination URI, a
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


async def test_the_command_itself_prints_the_configuration_and_nothing_else(
    capsys, monkeypatch
):
    """The whole command, driven the way a person drives it.

    Everything above calls :func:`provision` directly, which proves the
    steps and nothing about the thing somebody actually types. This one
    goes in through ``main`` — the arguments, the two credentials read
    from the environment, the two roots that point it at a stub instead of
    Twilio, and the split that makes ``> phone.env`` capture exactly the
    configuration: the five lines on stdout, the story on stderr.
    """
    stub = TwilioStub()
    async with serving(stub) as running:
        monkeypatch.setattr(
            "sys.argv", ["egma-trunk-setup", "--number", A_NUMBER]
        )
        monkeypatch.setenv("TWILIO_ACCOUNT_SID", stub.account_sid)
        monkeypatch.setenv("TWILIO_AUTH_TOKEN", stub.auth_token)
        monkeypatch.setenv("TEST_TWILIO_API_ROOT", running.base_url)
        monkeypatch.setenv("TEST_TWILIO_TRUNKING_ROOT", running.base_url)

        await asyncio.to_thread(main)

    printed = capsys.readouterr()
    assert [line.split("=", 1)[0] for line in printed.out.splitlines()] == [
        "EGMA_SIMULATOR_MEDIA_BACKEND",
        "EGMA_SIMULATOR_SIP_TRUNK_ADDRESS",
        "EGMA_SIMULATOR_SIP_TRUNK_NUMBER",
        "EGMA_SIMULATOR_SIP_TRUNK_USERNAME",
        "EGMA_SIMULATOR_SIP_TRUNK_PASSWORD",
    ]
    # The story is on the other stream, with every identifier in it, so a
    # redirect captures the configuration and leaves the story readable.
    assert next(iter(stub.trunks)) in printed.err
    assert next(iter(stub.credential_lists)) in printed.err
    assert AUTH_TOKEN not in printed.out + printed.err


async def test_the_command_refuses_without_the_account_credentials(
    capsys, monkeypatch
):
    monkeypatch.setattr("sys.argv", ["egma-trunk-setup", "--number", A_NUMBER])
    monkeypatch.delenv("TWILIO_ACCOUNT_SID", raising=False)
    monkeypatch.delenv("TWILIO_AUTH_TOKEN", raising=False)

    with pytest.raises(SystemExit) as stopped:
        main()

    assert stopped.value.code == 2
    said = capsys.readouterr().err
    assert "TWILIO_ACCOUNT_SID" in said
    assert "TWILIO_AUTH_TOKEN" in said


async def test_an_account_too_busy_for_one_page_is_still_read_to_the_end():
    """Twilio pages every list, and a step that read only the first page
    would not find last week's trunk on a busy account — it would make
    another one, on somebody's paid account, every time it ran."""
    stub = TwilioStub(page_size=2)
    stub.trunks = {
        f"TKdecoy{n:026d}": {
            "sid": f"TKdecoy{n:026d}",
            "friendly_name": f"somebody-elses-trunk-{n}",
            "domain_name": f"other-{n}.pstn.twilio.com",
        }
        for n in range(5)
    }
    ours = "TKours00000000000000000000000000"
    stub.trunks[ours] = {
        "sid": ours,
        "friendly_name": ARTIFACT_NAME,
        "domain_name": "egma-simulator-already.pstn.twilio.com",
    }
    stub.credential_lists = {
        f"CLdecoy{n:026d}": {
            "sid": f"CLdecoy{n:026d}",
            "friendly_name": f"somebody-elses-list-{n}",
        }
        for n in range(5)
    }
    mine = "CLours00000000000000000000000000"
    stub.credential_lists[mine] = {"sid": mine, "friendly_name": ARTIFACT_NAME}

    trunk = await setup(stub)

    # Found on a later page, both of them, and nothing new was made.
    assert trunk.trunk_sid == ours
    assert len(stub.trunks) == 6
    assert len(stub.credential_lists) == 6
    assert trunk.address == "egma-simulator-already.pstn.twilio.com"
    # And the paging really happened rather than the page being big enough.
    assert sum(1 for method, path in stub.calls if path == "/v1/Trunks") >= 3


async def test_the_password_turns_only_after_everything_else_stands():
    """Rotation replaces a credential a running deployment may be dialling
    with. If anything after it failed, the command would exit without
    printing the replacement, and that deployment would hold a password
    nobody has anymore — so the credential write must be the last thing
    setup does to the account."""
    stub = TwilioStub()

    await setup(stub)

    mutations = [path for method, path in stub.calls if method == "POST"]
    assert mutations, "setup made nothing at all"
    assert mutations[-1].endswith("/Credentials"), (
        "the credential write must come after every attachment, "
        f"but the last mutation was {mutations[-1]}"
    )
