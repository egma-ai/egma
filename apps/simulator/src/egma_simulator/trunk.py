"""``egma-trunk-setup`` — a carrier account becomes a trunk, once.

A phone call leaves the simulator through a **SIP trunk**, and a trunk is
the customer's own: they bring an account from whatever carrier they
already pay, and egma is never in that relationship. What they have on
day one is an account and a number. What the driver reads is a
termination address and a credential that may place calls through it.
Everything between those two is carrier paperwork, and this is the step
that does it for them — through the carrier's own API, in one command,
Twilio first.

It is a *setup* step, apart from the simulator on purpose:

- **The account token is used here and nowhere else.** It opens the whole
  account — every number, every recording, every log, the billing — and
  a running simulator has no business holding it. What it leaves behind
  is a SIP credential that can do one thing: authenticate a call over one
  trunk. That is the whole reason this is a separate command with its own
  credentials rather than nine more variables on a container.
- **It is safe to run again.** Nothing here is created twice: an existing
  trunk, credential list, and attachment are found and reused. The one
  thing a re-run cannot do is read the old password back — Twilio never
  hands one out — so it mints a new one and tells Twilio, which is what
  makes the emitted configuration always usable rather than usable only
  the first time.

What it prints on stdout is the configuration, as ``VARIABLE=value``
lines, and what it prints on stderr is the story of what it did with
every artifact's own SID. That split is the useful one::

    TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... \\
      uv run egma-trunk-setup --number +15551234567 > phone.env

leaves the story on the terminal and the configuration in a file to
source — and the file holds a secret, so it belongs wherever the rest of
that deployment's secrets do and in no repository.

## What it makes, in Twilio's words

1. An **Elastic SIP Trunk**, whose ``DomainName`` is the termination URI
   calls are sent to (``egma-….pstn.twilio.com``). Domain names are unique
   across the whole of Twilio, not just one account, so a minted name can
   collide with a stranger's and the step tries another.
2. A **credential list** holding one username and password. This is the
   least-privilege credential the deployment keeps.
3. The credential list **attached** to the trunk — without which the
   trunk authenticates nobody and every call is a 403.
4. The **number attached** to the trunk, which is what makes it a caller
   id the carrier will accept on an outbound call.

Only the first is Twilio-specific in shape. A second carrier is a second
module here with the same four steps and the same five lines out.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import secrets
import string
import sys
from dataclasses import dataclass, field

import aiohttp

ARTIFACT_NAME = "egma-simulator"
"""What this step calls everything it makes.

One name across the trunk, the credential list and the SIP username, so
that somebody reading a Twilio console a year from now can tell what made
these and delete them together. ``--name`` changes it, for an account
that carries a trunk per deployment."""

API_ROOT = "https://api.twilio.com"
"""Twilio's original API — where credential lists and numbers live."""

TRUNKING_ROOT = "https://trunking.twilio.com"
"""Twilio's trunking API — where trunks and their attachments live."""

TERMINATION_SUFFIX = ".pstn.twilio.com"
"""What every Twilio termination URI ends in; the part before it is ours."""

PASSWORD_LENGTH = 24
"""How long the minted SIP password is. Twilio's own floor is twelve with
an uppercase, a lowercase and a digit; this is twice that and alphanumeric
throughout, so it survives being written into an env file, a URL and a SIP
header without anything having to escape it."""

DOMAIN_ATTEMPTS = 5
"""How many times a taken domain name is tried around before the collision
is somebody's to hear about. Each try is 8 random hex characters, so a
fifth failure is not bad luck."""

REQUEST_TIMEOUT_SECONDS = 30.0

PAGE_SIZE = 100
"""How many of anything to ask for at once. Twilio pages every list, and
its default page is 50 — on an account with more trunks or more credential
lists than that, a step that read only the first page would decide ours
was not there and make a second one. So every list here is read to the
end, and this only decides how many round trips that takes."""

DOMAIN_TAKEN = 21241
"""Twilio's code for a termination URI somebody already holds.

Matched as the number rather than by its sentence: the sentence is theirs
to reword in a release note, and a rewording would turn "try another name"
into an unexplained failure at the one step that has to survive it."""


class TrunkSetupError(Exception):
    """Setup cannot finish, and says what the carrier said."""


@dataclass(frozen=True)
class ReadyTrunk:
    """A trunk that can place calls, and how to tell the simulator so."""

    address: str
    """The termination URI — what ``EGMA_SIMULATOR_SIP_TRUNK_ADDRESS`` is."""

    number: str
    username: str
    password: str = field(repr=False)

    trunk_sid: str = ""
    """The trunk everything else was attached to — the one identifier that
    says whether two runs made one trunk or two."""

    report: tuple[str, ...] = ()
    """What was made and what was already there, one line each, with SIDs.

    Not decoration, and the only place the other identifiers live: a
    customer who has to delete these later, or who wants to find them in
    their own console, needs them, and a command that made five things in
    somebody's paid account without naming them is a command they have to
    go looking for the effects of. They are carried as the sentences a
    person reads rather than as fields, because nothing in this program
    ever does anything with them."""


def render(trunk: ReadyTrunk) -> str:
    """The configuration a deployment sets, in the shape it sets it.

    The backend line rides with the other four deliberately: a trunk with
    nothing configured to dial through it is half a configuration, and the
    half that is missing refuses every phone simulation at claim time.
    """
    return "\n".join(
        (
            "EGMA_SIMULATOR_MEDIA_BACKEND=livekit",
            f"EGMA_SIMULATOR_SIP_TRUNK_ADDRESS={trunk.address}",
            f"EGMA_SIMULATOR_SIP_TRUNK_NUMBER={trunk.number}",
            f"EGMA_SIMULATOR_SIP_TRUNK_USERNAME={trunk.username}",
            f"EGMA_SIMULATOR_SIP_TRUNK_PASSWORD={trunk.password}",
        )
    )


def _password() -> str:
    """A password Twilio will accept, minted here and known only here.

    Built from the three character classes it insists on and then shuffled,
    so the rule is satisfied by construction rather than by drawing until
    it happens to be — which on a bad draw is a loop, and on a worse one is
    a refusal at the end of a setup that already made three things.
    """
    alphabet = string.ascii_letters + string.digits
    drawn = [
        secrets.choice(string.ascii_lowercase),
        secrets.choice(string.ascii_uppercase),
        secrets.choice(string.digits),
        *(secrets.choice(alphabet) for _ in range(PASSWORD_LENGTH - 3)),
    ]
    # `SystemRandom.shuffle` rather than `random.shuffle`: the ordering
    # carries as much of the entropy as the characters do.
    secrets.SystemRandom().shuffle(drawn)
    return "".join(drawn)


class TwilioAccount:
    """One account's two APIs, and the four refusals worth telling apart."""

    def __init__(
        self,
        *,
        account_sid: str,
        auth_token: str,
        session: aiohttp.ClientSession,
        api_root: str = API_ROOT,
        trunking_root: str = TRUNKING_ROOT,
    ) -> None:
        self._sid = account_sid
        self._session = session
        # Built here rather than with the client's own `auth=` argument,
        # which is deprecated: one header on every request is the same
        # thing and does not move under us.
        encoded = base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode()
        self._headers = {"Authorization": f"Basic {encoded}"}
        self._api = api_root.rstrip("/")
        self._trunking = trunking_root.rstrip("/")

    def _account_path(self, tail: str) -> str:
        return f"{self._api}/2010-04-01/Accounts/{self._sid}/{tail}"

    async def _call(
        self,
        method: str,
        url: str,
        *,
        data: dict[str, str] | None = None,
        params: dict[str, str] | None = None,
        allow: tuple[int, ...] = (),
    ) -> tuple[int, dict]:
        try:
            async with self._session.request(
                method, url, data=data, params=params, headers=self._headers
            ) as answer:
                body = await answer.json(content_type=None)
                if answer.status >= 400 and answer.status not in allow:
                    raise TrunkSetupError(_refusal(answer.status, body))
                return answer.status, body if isinstance(body, dict) else {}
        except aiohttp.ClientError as unreachable:
            # The account token is on the session, so a client error that
            # rendered the request would carry it. Only the URL and the
            # kind of failure are repeated.
            raise TrunkSetupError(
                f"twilio could not be reached at {url}: "
                f"{type(unreachable).__name__}"
            ) from unreachable
        except TimeoutError as slow:
            raise TrunkSetupError(
                f"twilio did not answer {url} within "
                f"{REQUEST_TIMEOUT_SECONDS:.0f}s"
            ) from slow

    async def _every(
        self, url: str, key: str, *, params: dict[str, str] | None = None
    ) -> list[dict]:
        """Everything under ``key``, across as many pages as Twilio hands back.

        Both of Twilio's APIs page, and they say so differently — the
        trunking one puts the next page under ``meta``, the older one puts
        a path in ``next_page_uri``. Reading only the first page is the
        bug that does not look like one: on a busy account the trunk this
        step made last week is on page two, so it makes another.
        """
        gathered: list[dict] = []
        query: dict[str, str] | None = dict(params or {}) | {
            "PageSize": str(PAGE_SIZE)
        }
        following: str | None = url
        while following is not None:
            _status, body = await self._call("GET", following, params=query)
            gathered.extend(body.get(key, []))
            # A next-page URL carries its own paging and its own filter;
            # sending ours again alongside is how a page repeats forever.
            query = None
            following = self._next_page(body)
        return gathered

    def _next_page(self, body: dict) -> str | None:
        onward = (body.get("meta") or {}).get("next_page_url")
        if onward:
            return str(onward)
        onward = body.get("next_page_uri")
        # The older API answers with a path rather than a URL.
        return f"{self._api}{onward}" if onward else None

    # -- The four things setup needs to know or make ------------------------

    async def number_sid(self, number: str) -> str:
        held_numbers = await self._every(
            self._account_path("IncomingPhoneNumbers.json"),
            "incoming_phone_numbers",
            params={"PhoneNumber": number},
        )
        for held in held_numbers:
            if held.get("phone_number") == number:
                return held["sid"]
        raise TrunkSetupError(
            f"this Twilio account holds no number {number}: --number has to be "
            "one of the account's own, in E.164 (+15551234567), because a "
            "carrier will not place a call from a number somebody else owns"
        )

    async def trunk(self, name: str) -> tuple[dict, bool]:
        """The trunk this step made before, or a new one. True if new."""
        for existing in await self._every(f"{self._trunking}/v1/Trunks", "trunks"):
            if existing.get("friendly_name") == name:
                return existing, False

        refusals: list[str] = []
        for _attempt in range(DOMAIN_ATTEMPTS):
            domain = f"{name}-{secrets.token_hex(4)}{TERMINATION_SUFFIX}"
            status, made = await self._call(
                "POST",
                f"{self._trunking}/v1/Trunks",
                data={"FriendlyName": name, "DomainName": domain},
                allow=(400,),
            )
            if status < 400:
                return made, True
            if made.get("code") != DOMAIN_TAKEN:
                raise TrunkSetupError(_refusal(status, made))
            refusals.append(str(made.get("message", "")))
        raise TrunkSetupError(
            f"no termination URI could be claimed in {DOMAIN_ATTEMPTS} tries — "
            f"twilio said: {refusals[-1]}"
        )

    async def credential_list(self, name: str) -> tuple[dict, bool]:
        held_lists = await self._every(
            self._account_path("SIP/CredentialLists.json"), "credential_lists"
        )
        for existing in held_lists:
            if existing.get("friendly_name") == name:
                return existing, False
        _status, made = await self._call(
            "POST",
            self._account_path("SIP/CredentialLists.json"),
            data={"FriendlyName": name},
        )
        return made, True

    async def set_password(
        self, list_sid: str, username: str, password: str
    ) -> tuple[str, bool]:
        """This username's password, made or rotated. True if made.

        Rotating rather than reading is not a choice: Twilio hands a
        password back exactly once, when it is set, and never again. A
        second run that wanted to emit the old one would have to have kept
        it somewhere, and the only place to keep it is the file this step
        is trying not to need.
        """
        held_credentials = await self._every(
            self._account_path(f"SIP/CredentialLists/{list_sid}/Credentials.json"),
            "credentials",
        )
        for held in held_credentials:
            if held.get("username") == username:
                await self._call(
                    "POST",
                    self._account_path(
                        f"SIP/CredentialLists/{list_sid}/Credentials/"
                        f"{held['sid']}.json"
                    ),
                    data={"Password": password},
                )
                return held["sid"], False
        _status, made = await self._call(
            "POST",
            self._account_path(f"SIP/CredentialLists/{list_sid}/Credentials.json"),
            data={"Username": username, "Password": password},
        )
        return made["sid"], True

    async def attach_credential_list(self, trunk_sid: str, list_sid: str) -> bool:
        """Put the credential list on the trunk. True if it was not already.

        Without this the trunk authenticates nobody and every call it is
        offered comes back 403 — the single most common way a hand-built
        trunk is wrong.
        """
        attached = await self._every(
            f"{self._trunking}/v1/Trunks/{trunk_sid}/CredentialLists",
            "credential_lists",
        )
        if any(held.get("sid") == list_sid for held in attached):
            return False
        await self._call(
            "POST",
            f"{self._trunking}/v1/Trunks/{trunk_sid}/CredentialLists",
            data={"CredentialListSid": list_sid},
        )
        return True

    async def attach_number(self, trunk_sid: str, number_sid: str) -> bool:
        """Put the number on the trunk. True if it was not already."""
        attached = await self._every(
            f"{self._trunking}/v1/Trunks/{trunk_sid}/PhoneNumbers", "phone_numbers"
        )
        if any(held.get("sid") == number_sid for held in attached):
            return False
        await self._call(
            "POST",
            f"{self._trunking}/v1/Trunks/{trunk_sid}/PhoneNumbers",
            data={"PhoneNumberSid": number_sid},
        )
        return True


def _refusal(status: int, body: dict) -> str:
    """Twilio's own refusal, in Twilio's own words.

    Their message is the diagnosis — "not available on trial accounts",
    "DomainName is already in use", "Authenticate" — and summarising it
    would throw away the only thing that says what to do next. The status
    401 is the one place a name is added: what it means is one variable,
    and saying so saves a search.
    """
    said = str(body.get("message") or body) or "no reason given"
    if status == 401:
        return (
            "twilio refused the account credentials (401): check "
            f"TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN — twilio said: {said}"
        )
    return f"twilio refused with {status}: {said}"


async def provision(
    *,
    account_sid: str,
    auth_token: str,
    number: str,
    name: str = ARTIFACT_NAME,
    api_root: str = API_ROOT,
    trunking_root: str = TRUNKING_ROOT,
) -> ReadyTrunk:
    """One account and one number in; one dialling trunk out."""
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        account = TwilioAccount(
            account_sid=account_sid,
            auth_token=auth_token,
            session=session,
            api_root=api_root,
            trunking_root=trunking_root,
        )
        # The number first, and before anything is created: a number this
        # account does not hold cannot be attached to any trunk, and
        # finding that out after making three things leaves a stranger's
        # account holding three things they did not ask for.
        number_sid = await account.number_sid(number)

        trunk, trunk_is_new = await account.trunk(name)
        credential_list, list_is_new = await account.credential_list(name)
        password = _password()
        credential_sid, credential_is_new = await account.set_password(
            credential_list["sid"], name, password
        )
        list_attached = await account.attach_credential_list(
            trunk["sid"], credential_list["sid"]
        )
        number_attached = await account.attach_number(trunk["sid"], number_sid)

    return ReadyTrunk(
        address=trunk["domain_name"],
        number=number,
        username=name,
        password=password,
        trunk_sid=trunk["sid"],
        report=(
            f"trunk {trunk['sid']} "
            f"({'created' if trunk_is_new else 'already there'}), "
            f"termination URI {trunk['domain_name']}",
            f"credential list {credential_list['sid']} "
            f"({'created' if list_is_new else 'already there'})",
            f"sip credential {credential_sid} for {name!r} "
            f"({'created' if credential_is_new else 'password rotated'})",
            f"credential list on the trunk "
            f"({'attached' if list_attached else 'already attached'})",
            f"number {number} ({number_sid}) on the trunk "
            f"({'attached' if number_attached else 'already attached'})",
        ),
    )


def main() -> None:
    import os

    parser = argparse.ArgumentParser(
        prog="egma-trunk-setup",
        description=(
            "Turn a Twilio account and one of its numbers into a SIP trunk "
            "the simulator can place calls through, and print the "
            "configuration it reads. Safe to run again."
        ),
        epilog=(
            "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are read from the "
            "environment and used only by this command; what it prints is a "
            "credential that can do nothing but place calls."
        ),
    )
    parser.add_argument(
        "--number",
        required=True,
        help="the account's own number, in E.164, that calls come from",
    )
    parser.add_argument(
        "--name",
        default=ARTIFACT_NAME,
        help=(
            "what to call the trunk, the credential list and the SIP user "
            f"(default: {ARTIFACT_NAME})"
        ),
    )
    arguments = parser.parse_args()

    account_sid = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
    auth_token = os.environ.get("TWILIO_AUTH_TOKEN", "").strip()
    if not account_sid or not auth_token:
        print(
            "egma-trunk-setup needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN "
            "in the environment: they are this account's own credentials, "
            "used by this command and never kept by the simulator",
            file=sys.stderr,
        )
        raise SystemExit(2)

    try:
        trunk = asyncio.run(
            provision(
                account_sid=account_sid,
                auth_token=auth_token,
                number=arguments.number,
                # Twilio's own roots, unless something is standing in for
                # them — which is how this step is tested without an
                # account. TEST_, like every stand-in override, because a
                # deployment never sets these.
                api_root=os.environ.get("TEST_TWILIO_API_ROOT", API_ROOT),
                trunking_root=os.environ.get(
                    "TEST_TWILIO_TRUNKING_ROOT", TRUNKING_ROOT
                ),
                name=arguments.name,
            )
        )
    except TrunkSetupError as refused:
        print(f"egma-trunk-setup could not finish: {refused}", file=sys.stderr)
        raise SystemExit(1) from None

    for line in trunk.report:
        print(f"  {line}", file=sys.stderr)
    print(
        "\nThe five lines on stdout are the whole runtime configuration. "
        "The password is printed once and Twilio will never show it again; "
        "run this command a second time to mint another. Nothing here needs "
        "the account token, which is the point.",
        file=sys.stderr,
    )
    print(render(trunk))


if __name__ == "__main__":
    main()
