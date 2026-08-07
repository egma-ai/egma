"""CI's Twilio: a local HTTP server shaped like the two APIs setup speaks.

Elastic SIP Trunking is spread across two Twilio hosts — the trunking API
holds trunks and what is attached to them, and the old account API holds
credential lists and the numbers on the account — and the setup step has
to drive both in the right order. This stub answers both, on one loopback
port, with Twilio's own field names, form encoding, basic auth and status
codes.

Real HTTP again, and for the same reason the Retell stub is: the setup
step's whole job is speaking somebody else's wire protocol, and a mock of
that protocol would prove the mock.

Where the real API is strict, so is this one:

- basic auth with the account SID and token, or 401;
- a trunk domain name is unique across all of Twilio, so a second trunk
  claiming a taken one is refused 400 the way Twilio refuses it;
- a credential password must be at least twelve characters with an
  uppercase, a lowercase and a digit, or 400;
- a credential's password is write-only — it is never returned by a read,
  which is the whole reason a re-run has to rotate it rather than read it
  back;
- attaching a credential list or a number to a trunk twice is refused,
  the way Twilio refuses a duplicate attachment.

Every request is recorded, so a test can assert the whole setup sequence
happened rather than only that a configuration came out the end.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from aiohttp import web

ACCOUNT_SID = "ACstub00000000000000000000000000"
AUTH_TOKEN = "stub-auth-token-not-a-real-secret"

PASSWORD_RULE = re.compile(r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$")
"""Twilio's own rule for a SIP credential password, as documented."""


@dataclass
class TwilioStub:
    """One scripted Twilio account: what it holds and what it refuses."""

    account_sid: str = ACCOUNT_SID
    auth_token: str = AUTH_TOKEN

    numbers: dict[str, str] = field(
        default_factory=lambda: {"+15550000001": "PNstub0000000000000000000000000a"}
    )
    """The numbers on this account, by E.164, each with its own SID."""

    domains_already_taken: int = 0
    """How many domain names a stranger holds before one is free.

    A trunk's domain name is unique across the whole of Twilio, so the name
    a setup step mints can already belong to somebody nobody here can see.
    Counting them is how that collision is provoked without inventing a
    second account to hold them."""

    trial: bool = False
    """When true, creating a trunk is refused the way a trial account's is
    — the refusal a setup step has to pass through rather than bury."""

    trunks: dict[str, dict] = field(default_factory=dict)
    credential_lists: dict[str, dict] = field(default_factory=dict)
    credentials: dict[str, dict] = field(default_factory=dict)
    attached_lists: dict[str, list[str]] = field(default_factory=dict)
    attached_numbers: dict[str, list[str]] = field(default_factory=dict)

    calls: list[tuple[str, str]] = field(default_factory=list)
    """Every request served: method and path, in order."""

    _minted: int = 0

    def _sid(self, prefix: str) -> str:
        self._minted += 1
        return f"{prefix}stub{self._minted:028d}"[:34]

    def passwords(self) -> list[str]:
        """Every password this account was ever told, in order — what a
        test needs to prove the emitted one is the one Twilio now holds."""
        return [credential["password"] for credential in self.credentials.values()]

    def _authorized(self, request: web.Request) -> None:
        import base64

        offered = request.headers.get("Authorization", "")
        wanted = base64.b64encode(
            f"{self.account_sid}:{self.auth_token}".encode()
        ).decode()
        if offered != f"Basic {wanted}":
            raise web.HTTPUnauthorized(
                text='{"code": 20003, "message": "Authenticate"}',
                content_type="application/json",
            )

    # -- The trunking API ----------------------------------------------------

    async def list_trunks(self, request: web.Request) -> web.Response:
        self._authorized(request)
        self.calls.append(("GET", "/v1/Trunks"))
        return web.json_response({"trunks": list(self.trunks.values())})

    async def create_trunk(self, request: web.Request) -> web.Response:
        self._authorized(request)
        self.calls.append(("POST", "/v1/Trunks"))
        form = await request.post()
        if self.trial:
            return web.json_response(
                {
                    "code": 20003,
                    "message": (
                        "Elastic SIP Trunking is not available on trial accounts"
                    ),
                },
                status=403,
            )
        domain = str(form.get("DomainName", ""))
        if self.domains_already_taken > 0 or any(
            trunk["domain_name"] == domain for trunk in self.trunks.values()
        ):
            self.domains_already_taken = max(0, self.domains_already_taken - 1)
            return web.json_response(
                {"code": 21241, "message": f"DomainName {domain} is already in use"},
                status=400,
            )
        sid = self._sid("TK")
        self.trunks[sid] = {
            "sid": sid,
            "friendly_name": str(form.get("FriendlyName", "")),
            "domain_name": domain,
        }
        return web.json_response(self.trunks[sid], status=201)

    async def list_trunk_credential_lists(self, request: web.Request) -> web.Response:
        self._authorized(request)
        trunk_sid = request.match_info["trunk_sid"]
        self.calls.append(("GET", f"/v1/Trunks/{trunk_sid}/CredentialLists"))
        attached = self.attached_lists.get(trunk_sid, [])
        return web.json_response(
            {
                "credential_lists": [
                    self.credential_lists[sid] for sid in attached
                ]
            }
        )

    async def attach_credential_list(self, request: web.Request) -> web.Response:
        self._authorized(request)
        trunk_sid = request.match_info["trunk_sid"]
        self.calls.append(("POST", f"/v1/Trunks/{trunk_sid}/CredentialLists"))
        form = await request.post()
        list_sid = str(form.get("CredentialListSid", ""))
        attached = self.attached_lists.setdefault(trunk_sid, [])
        if list_sid in attached:
            return web.json_response(
                {"code": 21243, "message": "CredentialList already attached"},
                status=400,
            )
        attached.append(list_sid)
        return web.json_response(self.credential_lists[list_sid], status=201)

    async def list_trunk_numbers(self, request: web.Request) -> web.Response:
        self._authorized(request)
        trunk_sid = request.match_info["trunk_sid"]
        self.calls.append(("GET", f"/v1/Trunks/{trunk_sid}/PhoneNumbers"))
        return web.json_response(
            {
                "phone_numbers": [
                    {"sid": sid, "trunk_sid": trunk_sid}
                    for sid in self.attached_numbers.get(trunk_sid, [])
                ]
            }
        )

    async def attach_number(self, request: web.Request) -> web.Response:
        self._authorized(request)
        trunk_sid = request.match_info["trunk_sid"]
        self.calls.append(("POST", f"/v1/Trunks/{trunk_sid}/PhoneNumbers"))
        form = await request.post()
        number_sid = str(form.get("PhoneNumberSid", ""))
        for holder, held in self.attached_numbers.items():
            if number_sid in held:
                return web.json_response(
                    {
                        "code": 21242,
                        "message": f"PhoneNumber already on trunk {holder}",
                    },
                    status=400,
                )
        self.attached_numbers.setdefault(trunk_sid, []).append(number_sid)
        return web.json_response(
            {"sid": number_sid, "trunk_sid": trunk_sid}, status=201
        )

    # -- The account API -----------------------------------------------------

    async def list_numbers(self, request: web.Request) -> web.Response:
        self._authorized(request)
        self.calls.append(("GET", "/IncomingPhoneNumbers"))
        wanted = request.query.get("PhoneNumber")
        return web.json_response(
            {
                "incoming_phone_numbers": [
                    {"sid": sid, "phone_number": number}
                    for number, sid in self.numbers.items()
                    if wanted is None or number == wanted
                ]
            }
        )

    async def list_credential_lists(self, request: web.Request) -> web.Response:
        self._authorized(request)
        self.calls.append(("GET", "/SIP/CredentialLists"))
        return web.json_response(
            {"credential_lists": list(self.credential_lists.values())}
        )

    async def create_credential_list(self, request: web.Request) -> web.Response:
        self._authorized(request)
        self.calls.append(("POST", "/SIP/CredentialLists"))
        form = await request.post()
        sid = self._sid("CL")
        self.credential_lists[sid] = {
            "sid": sid,
            "friendly_name": str(form.get("FriendlyName", "")),
        }
        return web.json_response(self.credential_lists[sid], status=201)

    async def list_credentials(self, request: web.Request) -> web.Response:
        self._authorized(request)
        list_sid = request.match_info["list_sid"]
        self.calls.append(("GET", f"/SIP/CredentialLists/{list_sid}/Credentials"))
        return web.json_response(
            {
                # No password: Twilio never hands one back, which is why a
                # re-run rotates rather than reads.
                "credentials": [
                    {"sid": sid, "username": held["username"]}
                    for sid, held in self.credentials.items()
                    if held["list_sid"] == list_sid
                ]
            }
        )

    async def create_credential(self, request: web.Request) -> web.Response:
        self._authorized(request)
        list_sid = request.match_info["list_sid"]
        self.calls.append(("POST", f"/SIP/CredentialLists/{list_sid}/Credentials"))
        form = await request.post()
        password = str(form.get("Password", ""))
        if not PASSWORD_RULE.match(password):
            return web.json_response(
                {"code": 21232, "message": "Password does not meet requirements"},
                status=400,
            )
        sid = self._sid("SC")
        self.credentials[sid] = {
            "sid": sid,
            "list_sid": list_sid,
            "username": str(form.get("Username", "")),
            "password": password,
        }
        return web.json_response(
            {"sid": sid, "username": self.credentials[sid]["username"]}, status=201
        )

    async def update_credential(self, request: web.Request) -> web.Response:
        self._authorized(request)
        list_sid = request.match_info["list_sid"]
        sid = request.match_info["credential_sid"]
        self.calls.append(
            ("POST", f"/SIP/CredentialLists/{list_sid}/Credentials/{sid}")
        )
        form = await request.post()
        password = str(form.get("Password", ""))
        if not PASSWORD_RULE.match(password):
            return web.json_response(
                {"code": 21232, "message": "Password does not meet requirements"},
                status=400,
            )
        self.credentials[sid]["password"] = password
        return web.json_response(
            {"sid": sid, "username": self.credentials[sid]["username"]}
        )

    def application(self) -> web.Application:
        app = web.Application()
        account = f"/2010-04-01/Accounts/{self.account_sid}"
        app.router.add_get("/v1/Trunks", self.list_trunks)
        app.router.add_post("/v1/Trunks", self.create_trunk)
        app.router.add_get(
            "/v1/Trunks/{trunk_sid}/CredentialLists",
            self.list_trunk_credential_lists,
        )
        app.router.add_post(
            "/v1/Trunks/{trunk_sid}/CredentialLists", self.attach_credential_list
        )
        app.router.add_get(
            "/v1/Trunks/{trunk_sid}/PhoneNumbers", self.list_trunk_numbers
        )
        app.router.add_post(
            "/v1/Trunks/{trunk_sid}/PhoneNumbers", self.attach_number
        )
        app.router.add_get(
            f"{account}/IncomingPhoneNumbers.json", self.list_numbers
        )
        app.router.add_get(
            f"{account}/SIP/CredentialLists.json", self.list_credential_lists
        )
        app.router.add_post(
            f"{account}/SIP/CredentialLists.json", self.create_credential_list
        )
        app.router.add_get(
            account + "/SIP/CredentialLists/{list_sid}/Credentials.json",
            self.list_credentials,
        )
        app.router.add_post(
            account + "/SIP/CredentialLists/{list_sid}/Credentials.json",
            self.create_credential,
        )
        app.router.add_post(
            account
            + "/SIP/CredentialLists/{list_sid}/Credentials/{credential_sid}.json",
            self.update_credential,
        )
        return app


@dataclass
class RunningTwilioStub:
    stub: TwilioStub
    base_url: str


@asynccontextmanager
async def serving(stub: TwilioStub) -> AsyncIterator[RunningTwilioStub]:
    """This account, answering on a loopback port, for as long as the block."""
    runner = web.AppRunner(stub.application())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        yield RunningTwilioStub(stub=stub, base_url=f"http://127.0.0.1:{port}")
    finally:
        await runner.cleanup()
