# egma

The first open-source platform purpose-built to help teams shipping voice agents
gain trust in the agent they ship to production.

## Running it

You need Docker with Compose. Nothing else.

```bash
docker compose up
```

That starts six services and applies both schemas. Nobody runs a migration
step, because there isn't one — the API applies its migrations while it boots.

| Service | URL |
| --- | --- |
| Web application | http://localhost:3101 |
| API | http://localhost:3100 |
| Postgres | `postgres://egma:egma@localhost:5433/egma` |
| ClickHouse | `http://egma:egma@localhost:8124/egma` |
| Simulator | none — it only dials out |
| Grader | none — it only dials out |

Open http://localhost:3101 and sign up. Your organization and your first project
are created together, and you become their admin. On a fresh instance the first
person to sign up claims it, and open signup closes behind them — everybody
after that arrives by invitation.

`GET /health` on the API and `GET /api/health` on the web application are what
the container health checks poll.

Ports, the two stores' credentials and the settings below come from the
environment; see `.env.example` for the names and their defaults.

**`EGMA_AUTH_SECRET` signs session cookies and the API refuses to start without
one.** Compose supplies a development default so that `docker compose up` works
out of the box. Change it before anybody else can reach your instance.

**`EGMA_SIMULATOR_SERVICE_TOKEN` is what the simulator shows the API to claim
work, and the API refuses to start without one.** The answers to a claim carry
your live provider credentials, and port 3100 is published on the host, so the
check is always on. Compose supplies one development default to both
containers so they match out of the box. Change it — one line in `.env` covers
both — before anybody else can reach your instance:
`echo "egma_st_$(openssl rand -hex 32)"` makes one.

Email is optional, and this is load-bearing rather than a convenience. See
[Adding a second person](#adding-a-second-person).

**If a busy instance logs `Cannot open epoll descriptor … Too many open
files`**, ClickHouse has run out of file descriptors rather than egma having a
bug: it keeps one per open part and per connection, and its documented
requirement is far above what a login shell hands a container. Copy
`docker-compose.override.yml.example` to `docker-compose.override.yml` and
bring the services back up — Compose reads it on top with no further arguments.
It is an override rather than the default because a container may not raise its
limit past the daemon's own, so a host with a low hard `nofile` would not start
at all.

## Your first run, from a terminal

With an instance up and an account on it, the walk is one command. That command
is not on npm yet, so it comes from this checkout:

```bash
pnpm install                    # once
pnpm --filter egma-cli build    # builds it into apps/cli/dist
```

Then run it in the repository that holds your voice agent, naming the instance
you signed up on:

```bash
cd ~/your-voice-agent
EGMA_URL=http://localhost:3101 node ~/egma/apps/cli/dist/bin.js
```

`~/egma` is this checkout; when the package ships, that line becomes `npx egma`.

It signs that machine in — a short code, approved in the browser you signed up
in — registers your voice agent together with the way egma reaches it, writes a
first suite of tests with the coding agent you already have, puts them on your
instance, and starts a run over the exact versions it pushed. Every step is also
a verb (`egma login`, `egma connect`, `egma push`, `egma run`) that prints one
fact per line and answers with a number, for a coding agent driving it with
nobody watching. `apps/cli/README.md` is the whole of it.

**Where it stops today, said plainly.** The run is created and followed live,
and no verdict arrives: nothing claims a simulation yet, so the run stays
pending and every simulation stays queued. Both services below are real — the
simulator conducts a conversation and the grader judges one — and what is
missing between them and your run is the seam a simulator claims its work
through. Everything before that is real, and the run you started is yours — at
the address the terminal printed, with no token on it.

The same walk runs as a check. On a checkout that has had `pnpm install`, and on
a machine with a Chrome — or with `PLAYWRIGHT_BROWSERS_PATH` pointing at a
Playwright Chromium, since the approval really happens in a browser — it is two
commands:

```bash
pnpm db:up
pnpm --filter egma-cli smoke:walk
```

They start a whole egma of its own, sign in through a real browser, register,
push, run and follow — then print what was proved and what waits.

## The two services that publish nothing

The simulator conducts simulations: it takes a persona and a scenario and
holds a real conversation with the agent under test. It streams the
conversation — every turn, tool call and measurement — as OpenTelemetry spans
to the same ingest a customer's own agent exports to, and reports the
lifecycle and how it ended to the control plane.

**It claims its work rather than being sent it.** It asks the control plane for
what it has room for, keeps a heartbeat going while it conducts, and posts what
happened as it happens. Every arrow points out, so there is no `ports:` on that
service and no inbound network surface to think about — adding a second
simulator is copying the entry, and the two distribute work between themselves
with nothing in front of them.

**One volume, `simulator-data`, holds what a report can only point at.**
Recordings of voice simulations land there, and so does the write-ahead log,
which is the only record of a report that never got through. Both survive the
container being restarted, replaced or rebuilt; only `docker compose down -v`
removes them, and that is what it is for.

Everything else is environment, and `.env.example` names each one with its
default. Three are worth knowing about before anything else:

- **`EGMA_SIMULATOR_MODEL_PROVIDER` decides where the persona's words come
  from.** The default, `scripted`, walks the scenario deterministically and
  needs no account at all. Set it to `openai` — with `EGMA_SIMULATOR_MODEL_NAME`
  and `EGMA_SIMULATOR_MODEL_API_KEY`, and `EGMA_SIMULATOR_MODEL_BASE_URL` for
  anything OpenAI-compatible — and the persona improvises instead.
- **`EGMA_SIMULATOR_TTS_PROVIDER` and `EGMA_SIMULATOR_STT_PROVIDER` decide
  whether a voice simulation is really spoken.** Both default to `scripted`,
  which carries a deterministic test tone and needs no account, so a first
  voice simulation costs nothing. Set them to `elevenlabs` and `deepgram` —
  with `EGMA_SIMULATOR_ELEVENLABS_API_KEY` and
  `EGMA_SIMULATOR_DEEPGRAM_API_KEY` — and the persona speaks with a human
  voice and hears real words. Each leg is chosen on its own.
- **`EGMA_SIMULATOR_CAPACITY` is how many conversations happen at once.** The
  simulator claims only what it can hold, so a big run degrades into a queue
  rather than into overload.

Anything set to something it cannot use stops the container on its first line,
naming the variable. A wrongly mounted volume is caught the same way, rather
than by losing the first recording.

### The grader

The other one judges conversations — the ones the simulator conducted and the
ones a real caller had, with the same graders. A simulation reaching its end
becomes claimable work in the same commit that ends it; a production
conversation becomes claimable when its telemetry says it is over. The grader
takes the work, reads the conversation, resolves the graders that apply to it,
and writes one verdict row per judged dimension.

**It claims its work too**, on the same terms and for the same reasons: no
`ports:`, no inbound surface, and more throughput is more copies —
`docker compose up --scale grader=3` needs nothing in front of them. It reads
the two stores directly rather than through the API, so grading existing costs
the request path nothing at all.

**A conversation ending wakes it**, rather than an interval catching it later,
so nothing here promises a latency and nothing here waits for one. For a
production conversation that ending is the root span reaching the OTLP door: an
exporter sends a span when the span *ends*, so the one span the whole
conversation happened inside arriving is the conversation being over.
`EGMA_GRADER_TRACE_IDLE_SECONDS` is the fallback for an exporter that never
closes one, and `EGMA_GRADER_SWEEP_SECONDS` is the backstop under all of it, for
the notification raised while every copy happened to be restarting.

It is handed the deployment's encryption key, because a judged grader runs on
the project's own judge model and the sealed key has to be replayed to that
provider — and never a model key of its own, because the judge is always the
customer's choice, not egma's. `apps/grader/README.md` is the whole table.

### Watching a simulator without a control plane

The endpoints the simulator dials are still being built, so there is nothing to
trigger a run with yet. To see the machinery work anyway, start it against the
**workbench** — a fake control plane that speaks the same contract from spec
fixtures, with no database anywhere:

```bash
docker compose -f docker-compose.yml -f docker-compose.workbench.yml \
  up --build simulator workbench
```

The workbench prints one JSON line per observation — queued, the claim, each
heartbeat, each reported event — which is a simulation going queued → claimed →
running → completed in front of you. Chat exchanges finish in seconds; the
voice fixture leaves a real `.wav` on the volume with one speaker per channel.
`http://localhost:8085/workbench/records` is the same thing as JSON, and is
published to this machine only — the workbench asks nobody who they are, so
handing it to a network would hand over queueing and cancelling work too.

`docker compose up` starts no workbench. This is a dev and demo affair, which
is why it lives in a file you have to ask for by name.

## Calling a real phone number

A simulation whose connection names a phone number places a real call to it.
What answers does not matter — the telephone network neither knows nor cares —
so an agent behind a number is tested over the exact path its customers dial.

Two things have to be true for that. The simulator needs a **media bridge**
that turns a phone call into a room it can join, and it needs a **SIP trunk**
that carries the call to the phone network. The trunk is yours, from whatever
carrier you already pay; egma is never in that relationship. The bridge is
LiveKit, and you have two ways to get one.

**LiveKit Cloud is one variable.** Point `EGMA_SIMULATOR_LIVEKIT_URL` at it
with its key and secret, set your trunk, and stop reading this section — there
is nothing to host and nothing to open.

**Hosting it yourself is an overlay you ask for by name:**

```bash
docker compose -f docker-compose.yml -f docker-compose.phone.yml up
```

That adds three containers — the LiveKit server, its SIP gateway, and the
Redis they find each other through — and points the simulator at them. A plain
`docker compose up` starts none of it, and nothing about the default first-run
story changes. Every setting is an environment variable; there is no
configuration file to write.

### What has to be reachable, and what never is

| Container | Reachable from the internet? |
| --- | --- |
| simulator | **Never.** It publishes nothing, in this configuration or any other. |
| grader | **Never.** The same, for the same reason. |
| LiveKit server | No — its clients are the containers beside it. |
| Redis | No. |
| **SIP gateway** | **Yes.** Its SIP port and its RTP range have to be reachable from your carrier. |

The gateway is the one honest exception in the whole deployment, and it is not
ours to remove: it is the piece your carrier sends a call's audio *to*. It
writes an address and a port into the SDP it sends, and the carrier sends RTP
there.

**On a server with a public IP, or behind a 1:1 NAT with those ports forwarded,
that is routine.** Set `EGMA_LIVEKIT_SIP_EXTERNAL_IP` to the address and open
UDP 5060 plus the RTP range to your carrier's published ranges.

**On a laptop behind an ordinary router it does not work, and "required" is
measured rather than assumed.** The gateway discovers its public address by
asking a STUN server, which answers with the address only — and pairs it with
its own *local* RTP port. On a consumer router that pairing names nothing. Here
is the measurement, from a MacBook behind a home router: a UDP socket bound to
port 10019 is seen by the outside world as port 41110, another on 10105 as
39306, another on 10106 as 64104 — a different arbitrary port every time, and
no inbound mapping for any of them. So audio addressed to the advertised
`public-address:10019` arrives nowhere. Signalling is only luckier, not
reliable: of four INVITEs sent through that router, two brought the carrier's
own answer back and two timed out having heard nothing.

The one thing that could rescue a NATed gateway is the carrier ignoring the
address in the SDP and replying to wherever our audio came from — symmetric
RTP latching, which many carriers do. We could not settle whether ours does,
because the account we tested with refused every call before it was answered
and latching only happens after. So: **a public IP or a 1:1 NAT is required.**
If your carrier latches you may get away with less, but do not plan a
deployment on it. Use LiveKit Cloud instead — same API, same trunk, same code,
one URL.

The RTP range is 21 ports by default, not LiveKit's own 10000-20000: that is
about ten calls at once, more than the simulator's default capacity of four can
use, and a range published to the internet is a range to justify. Widen both
ends together if you raise capacity, and widen your firewall by the same
amount.

### Turning a carrier account into a trunk

You should not have to hand-build SIP paperwork in somebody's console. One
command takes a Twilio account and one of its numbers and makes the trunk:

```bash
TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... \
  uv run --directory apps/simulator egma-trunk-setup --number +15551234567
```

It creates the trunk, its termination URI, a credential list and the
credential, attaches the credential list and the number to the trunk, and
prints the five variables the simulator reads. It names what it made with each identifier, and it is safe to
run again — a second run finds what the first made and rotates only the
password, because Twilio hands a password out once and never again.

**The account token is used by that command and by nothing else.** What a
running deployment keeps is a SIP credential that can do exactly one thing:
authenticate a call over one trunk. Keep the printed lines wherever the rest of
your secrets live, and in no repository.

### The whole thing, end to end

One command, with your own number and your own credentials in the environment:

```bash
EGMA_WORKBENCH_PHONE_NUMBER=+15551234567 \
docker compose -f docker-compose.yml -f docker-compose.workbench.yml \
  -f docker-compose.phone.yml up --build simulator workbench
```

The overlays go in that order — the phone one last, because it adds to what
the workbench one replaces. Naming the two services is what keeps the API and
the two databases out of it; the phone stack comes along because the simulator
depends on it. What starts is a workbench holding one spec, pointed at your
number instead of the fixture's placeholder, and a simulator that can dial it.
Then watch the workbench's log: the claim, the call, each turn of the
conversation as it is spoken, the timings measured off the audio, and the
recording's reference. The `.wav` is on the `simulator-data` volume with the
persona on one channel and the agent on the other —
`docker compose cp simulator:/var/lib/egma-simulator/blobs/<reference> ./call.wav`
brings it out to listen to.

The persona speaks in a deterministic test tone unless you name real speech
providers, and a real agent hears that as noise. Set
`EGMA_SIMULATOR_TTS_PROVIDER`, `EGMA_SIMULATOR_STT_PROVIDER` and their keys
before you expect a conversation.

Every variable this section mentions is in `.env.example` with its default and
whether it is required. Anything set to something unusable stops the simulator
on its first line naming the variable — including a trunk given only half a
credential, which a carrier would otherwise refuse once per call in a way that
reads exactly like a wrong one.

## Testing a LiveKit agent in its own room

A phone number is one way to reach an agent. A LiveKit agent has a shorter one:
it is a worker waiting to be given a room, so egma makes a room in **your**
LiveKit project, joins it, asks for your worker, and holds the conversation
there. No trunk, no carrier, no number — and no bridge to host, because the room
*is* the meeting place.

What that takes is the three variables already in your agent's own environment:
its LiveKit URL, API key and API secret, plus the agent's name if your worker
registers one. They go on the connection rather than into this deployment's
environment, because the project is yours and not egma's.

**[Testing a LiveKit agent](docs/livekit-testing.md)** is the whole recipe —
where to copy the three values from, how to tell which dispatch style your
worker uses, the one request that registers it, and what the record carries
afterwards. [`fixtures/livekit-dumb-agent`](fixtures/livekit-dumb-agent) is a
deliberately boring agent to try it against before you point egma at a real one.
For teams that won't hand a testing tool their project's key pair, **[the
token-endpoint mode](docs/livekit-token-endpoint.md)** keeps the secret on your
side: your service mints each room's token, and the page carries the hardening
recipe to run it safely.

## Working on it

Node 24 and pnpm 10. The simulator is Python, managed by
[uv](https://docs.astral.sh/uv/) — install it too, and `pnpm test` covers
both worlds.

```bash
pnpm install
pnpm db:up        # Postgres on 5433 and ClickHouse on 8124, which the tests need
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Tests run against a real Postgres and a real ClickHouse — never a substitute,
because every guarantee under test is one of theirs. Each test file creates a
database of its own in whichever store it uses and drops it afterwards, so
`pnpm test` needs credentials that may create databases. `pnpm db:up` starts
both; point `TEST_DATABASE_URL` and `TEST_CLICKHOUSE_URL` somewhere else if you
would rather use your own.

One test drives a real browser: `apps/api/test/browser.test.ts` starts the API
and the web application on ports of their own and clicks through the paths a
person actually walks — logging in from a terminal, inviting a colleague on an
instance with no mail configured, and reading what an agent did. It uses the
Chrome already on your machine, and failing that any Chromium under
`PLAYWRIGHT_BROWSERS_PATH`; this repository depends on `playwright-core` and
downloads no browser of its own, so **install Google Chrome or point that
variable at one** if you have neither. Every branch of those flows other than
the happy one is covered against the API instead, where it costs milliseconds.

## Layout

```
apps/api        Fastify API. Applies migrations on boot, then serves.
apps/grader     The service that judges finished conversations: claims a
                conversation the moment it ends, resolves the graders that
                apply to it, executes them and writes verdict rows. Claims
                its work, so it publishes nothing; scaled by running more
                copies. See its README.
apps/simulator  The Python service that conducts simulations: claims specs
                from the control plane, conducts each as a persona
                conversing with the agent under test through a platform
                plug, reports what happened. Ships with the workbench,
                a dev-only fake control plane. Own toolchain (uv); see its
                README.
apps/web        Next.js web application: signup, sign-in, invitations, and
                where you are.
docs            Guides that are longer than a section of this file.
fixtures        Checked-in captures used as test inputs. The LiveKit one is
                replayed at the ingest door on every test run.
packages/db     The data-access module: schema, migrations, and every read
                and write there is.
packages/ids    The identifier generator.
packages/lint   Build-time rules that hold the boundaries in place.
packages/simulation-contract
                The versioned JSON contract between the control plane and the
                simulator: a schema per direction, golden fixtures beside
                them, and the suite that holds both to the fixtures.
```

The two processes answer on **one origin**. The web application proxies the
API's paths to it, so the session cookie is valid for both and there is no
cross-origin cookie handling anywhere. Everything the browser talks to is the
instance it loaded the page from, which is what makes logging in depend on
nothing a self-hoster does not run.

## Authentication

An auth provider answers one question: who is this person, and are they logged
in. Everything past the front door is egma's — organizations, projects,
membership, invitations, API keys and every permission check are egma's own
tables with egma's own foreign keys.

That line is held by two build rules on top of the ones above:

- **Only `apps/api/src/auth/better-auth.ts` and `packages/db/src/identity-store.ts`
  may import the provider's package.** Everything else sees the four-call seam
  in `apps/api/src/auth/seam.ts`. A third file naming the provider is porting
  cost paid later by somebody who did not choose it.
- **egma writes the DDL for the provider's tables** and its migrator is not
  wired up. It reads and writes `user`, `session`, `account`, `verification` and
  `device_code`; it cannot alter them.

The provider is on the request path for browser sessions, because turning a
session cookie into an identity is exactly what it is for. It is absent from the
API-key path entirely.

## Logging in from a terminal

A terminal asks for a pair of codes, shows the short one, and opens a browser on
this instance with that code already in the field. The person approves it, says
which project the terminal is for, and the terminal exchanges its code for an
API key. The key is handed over once and never stored anywhere it could be read
again.

```bash
# 1. the terminal asks to be let in
curl -sX POST http://localhost:3101/api/device/code \
  -H 'content-type: application/json' -d '{"client_id":"egma-cli"}'

# 2. open verification_uri_complete in a browser and approve it

# 3. the terminal collects its key
curl -sX POST http://localhost:3101/api/device/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
  -d device_code=... -d client_id=egma-cli
```

The key that comes back is `egma_sk_` and 32 random bytes, stored as a single
SHA-256 alongside a prefix and the last four characters. It carries no role of
its own: every request re-reads the membership of whoever minted it, so demoting
somebody reaches every key they ever made on their next request, and revoking a
key stops it on the very next one. Keys never expire; rotation is mint, deploy,
revoke.

Both credentials work on the same routes:

```bash
curl -H "authorization: Bearer egma_sk_..." http://localhost:3101/api/keys
```

An `admin` sees every key in their organization; everybody else sees the ones
they minted. Every role may mint a key for themselves, including `viewer` —
logging in mints one as its last step, so an admin-only rule would close the
product to most of an instance.

## Sending an agent's traces

egma listens on the OpenTelemetry endpoint your agent already knows how to
export to. Point it at this instance with an egma key and write no integration
code:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3100
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer%20egma_sk_..."
```

The `%20` is not a typo: the OpenTelemetry specification says this variable is a
list of `key=value` pairs whose values are percent-encoded, and a literal space
is not one of the characters a value may contain. Several SDKs pass an
unencoded space straight through and the header arrives fine; others refuse the
whole variable, and the failure looks like an agent that exports nothing.

That is the API directly rather than the web application: the one-origin rule
above exists so a browser's session cookie is valid for both, and telemetry
carries no cookie. An exporter has no reason to be routed through a page server.

`POST /v1/traces` accepts OTLP/HTTP in both encodings the specification defines
— `application/x-protobuf` and `application/json`, gzipped or not — and answers
with the specification's own `ExportTraceServiceResponse`. There is no gRPC
endpoint.

A few things worth knowing about what happens next:

- **Which organization and project the spans land in comes from the key**, never
  from the payload. An attribute naming an account is stored with everything
  else and consulted by nothing, so a leaked key cannot be pointed somewhere
  else. A key minted for a whole organization files its spans under no project —
  and **those spans do not appear in the dashboard**, because a browser session
  reads the project it is acting in. Mint the exporter's key against a project
  and the two agree.
- **The ids are yours.** egma stores the trace and span ids that arrived and
  mints neither; a span carrying no usable id is reported back as rejected
  rather than given one.
- **Nothing is invented and nothing is dropped.** One span in is one row; what
  the columns have no place for — every attribute, event and resource field —
  is kept verbatim on the row it came on.
- **A retry is free.** An exporter re-sending a batch it never heard back about
  sends identical bytes, and identical bytes are stored once.
- **Sending traces is a write**, so a key acts at the role of whoever minted it:
  a `member` or an `admin` exports, and a key held by a `viewer` is refused.
  Demoting somebody stops their exporters on the next request, with no key
  touched.
- **Which environment a span belongs to is discovered**, from
  `deployment.environment.name` if your telemetry sets it and `default` if it
  does not. There is nothing to declare first. Names beginning `egma` are
  reserved and are refused with a reason.

**[Sending a LiveKit agent's telemetry](docs/livekit.md)** walks the whole path
end to end — which example agent, where its model keys come from, a development
server on your machine or LiveKit Cloud, and the exchange on screen with its
timings.

Spans egma will not store are reported in the response's partial-success field
rather than as a failure, because the specification is explicit that rejected
data must not be retried — the rest of the batch is stored. That is also the
answer when an export asks for more than one request stores: a body stops at
20 MiB, which is what the OpenTelemetry Collector accepts by default, and one
export becomes at most 10,000 spans and 64 MiB of rows. What did not fit comes
back as a count and a reason, so the fix is a smaller batch rather than a
mystery.

## Reading traces back

Two endpoints, and both take either credential — a browser session or a key.
Reading is permitted to every role, a `viewer` included: seeing what an agent did
is the point of the product.

```bash
curl -H "authorization: Bearer egma_sk_..." \
  "http://localhost:3100/v1/traces?from=2026-08-02T00:00:00Z&to=2026-08-03T00:00:00Z"

curl -H "authorization: Bearer egma_sk_..." \
  "http://localhost:3100/v1/traces/<trace_id>?from=2026-08-02T00:00:00Z&to=2026-08-03T00:00:00Z"
```

**`GET /v1/traces`** lists a customer's traces, newest first.

| Parameter | | |
|---|---|---|
| `from`, `to` | **required** | RFC 3339, honoured to the microsecond. The window is closed at `from` and open at `to`. |
| `project_id` | optional | Narrows to one project. Absent — or empty — means the whole organization. |
| `limit` | optional | 50 by default. Above the maximum of 200 it is clamped; zero, negative or not a count at all is refused. Empty is absent. |
| `cursor` | optional | `next_cursor` from the previous page. |

**`GET /v1/traces/:traceId`** returns one trace as a transcript: `turns` in the
order they were taken, each carrying the spans that happened inside it, and
`spans` for everything top-level that is not a turn — the root span above all.
It takes `from`, `to` and `project_id` on the same terms.

Five things about the contract are worth knowing before you build on it:

- **The window is required, and wider than 31 days is refused rather than
  narrowed.** There is no default, on either endpoint, including the one that
  names a trace by id: this store is filed by time, so a query that named none
  would be a query for everything. A window that was silently narrowed for you
  would answer a different question than the one you asked while saying nothing
  about having done so, so it is refused with the cap in the message.
- **Both bounds mean what they say, to the microsecond.** Fractional seconds are
  read to six digits, which is the precision the store keeps, so you can paste a
  trace's own `started_at` or `ended_at` straight back in as a bound. A seventh
  digit is refused rather than rounded: `to` is exclusive, so rounding it would
  move the edge of your window and take spans out of the answer without
  mentioning it.
- **Paging is by token, and a token is a position rather than an offset.** It
  encodes where the last page stopped — when that trace started, and its id to
  break the tie — so no trace is skipped and none is repeated however much
  telemetry arrives while you walk. Treat it as opaque; nothing is promised about
  its contents.
- **The organization comes from the credential.** There is no parameter that
  could name another one, and a trace id belonging to somebody else answers
  exactly as an id nobody ever minted does.
- **The verbatim payload is not in either response.** It is by a wide margin the
  largest thing on a span, and a transcript carrying it would be megabytes of
  JSON nobody asked to render. It is still stored in full on the row.
- **A transcript of more than 10,000 spans is a prefix, and says so.**
  `spans_truncated` is then `true`, and it means exactly one thing: `turns` and
  `spans` hold the first 10,000 spans in time order, while `span_count` and every
  count beside it are still the whole trace inside your window. So the two
  together tell you how much of the trace you are looking at, rather than leaving
  you to guess.

Times come back as RFC 3339 to the microsecond, and durations as decimal strings
of nanoseconds — a nanosecond count passes what a JSON number holds exactly
within a few months, and a silently rounded latency is worse than no latency.

## Reading one in the dashboard

Sign in and open **Transcripts**. You get the recent transcripts of the project
your session is acting in, newest first, defaulting to the last twenty-four
hours — when each one started, how long it ran, how many turns each speaker
took, how many steps and tools and failures are in it, and the first thing the
human said. Pick a different window from the control beside the heading and the
address carries it, so a refresh and a link both stay on the window you chose;
**Show more** walks the pages.

Open one and you read it as a transcript: alternating `human:` and `agent:`
turns in the order they were taken, each with how far into the exchange it
happened and how long it took. **Expand a turn** for the timed steps inside it —
the model, the speech synthesis, the tool, the turn detection, the speaking —
and expand a step again for exactly what was recorded about it. Anything that
failed is marked on the turn before you open it.

Two things about this are worth knowing:

- **The window rides in the address.** A transcript's link carries the window
  the exchange happened in, because the endpoint under it needs one; that is why
  the link works when you send it to somebody, and why opening
  `/traces/<id>` with no window asks you to come in from the list.
- **The dashboard reads what a browser session can read, which is the project
  the session is acting in.** A key minted for a whole organization files its
  spans under no project at all (see above), and those do not appear here.
  **Mint the exporter's key against a project** and its telemetry lands where
  the dashboard looks.

The pages are drawn from the two v1 endpoints above and nothing else — the same
contract you would integrate against, on the same origin, authenticated by the
same session that signed you in.

## Adding a second person

Open `/members`, type an address, pick a role, and send. **If no mail transport
is configured, the link comes straight back to you** and you pass it on however
you like — Slack, a text message, reading it out. The colleague follows it,
chooses a password, and lands in your organization at the role you picked.

Nothing about this needs SMTP. That is deliberate: the pleasant part of a local
install is solo, and requiring a mail server before a second person can join is
where every comparable product stops being pleasant.

- The link works **once**, expires after seven days, and is stored as a single
  SHA-256 — so a copy of the database is not a pile of working invitations.
- It lets in **the address it was sent to** and no other.
- An expired invitation and an already-accepted one say **which of the two** they
  are, because one means ask for another and the other means you are already in.
- One person belongs to one organization in this version, so inviting somebody
  who already belongs to one is refused with a reason rather than silently.
- On a self-hosted instance, an invitation is what gets somebody past the door
  that closed when the first person claimed it.

Only an `admin` may invite, change a role, remove somebody, or deactivate an
account. **Removing somebody revokes every key they minted and leaves everything
they authored exactly where it is, with their name still on it** — a
deprovisioning script must not be able to delete a team's work. An organization
always keeps at least one admin: the last one cannot be demoted, removed or
deactivated, because nobody could put one back.

### Sending it by email instead

Optional, and one variable:

```bash
EGMA_SMTP_URL=smtp://user:password@smtp.example.com:587
EGMA_MAIL_FROM='egma <egma@example.com>'   # optional
```

Setting it changes two things at once, by itself: invitations are emailed rather
than handed back, and signup asks for email verification. There is no second
setting to keep in step, because there is no configuration in which egma should
wait for a message it never sent.

## Reading and writing data

`packages/db` owns both stores' connections — the Postgres pool and the
ClickHouse client — and it is the only way anything reads or writes. One policed
boundary, not one per store. Two rules follow from that, and both fail the build
rather than a review:

- **No file outside `packages/db/src` imports a database driver.** If you have
  just written `import pg from "pg"` somewhere and the build is refusing it,
  this is why. Add what you need to `packages/db/src/access` instead.
- **Every exported function that touches a customer's data takes an
  `AuthContext` first**, and builds the organization and project filters from
  it. Nothing exported accepts a filter of its own, so there is no way to widen
  one and no way to leave one out.

Both processes hold a connection — the API and the web application — and both go
through the same functions. The point is not which process talks to Postgres, it
is that nobody hand-writes the tenancy filter.

Every test that touches this uses **two** organizations. A test with one
organization passes whether or not the filter is there.

## Changing the schema

Edit the Drizzle schema under `packages/db/src/schema`, then:

```bash
pnpm db:generate
```

That writes a new numbered `.sql` file into `packages/db/migrations`. Those files
are what actually runs, so read the generated SQL before committing it. An
applied migration is immutable — the migration runner refuses to boot against a
file that changed after it was applied, so corrections go in a new file.

ClickHouse's schema lives beside it in `packages/db/clickhouse-migrations`,
numbered the same way, applied on the same boot by the same mechanism, and
hand-written rather than generated. Two things it asks for that Postgres does
not: statements are separated by `--> statement-breakpoint`, because ClickHouse
runs one per request, and every statement must say `IF NOT EXISTS`, because there
is no transaction to roll a half-applied file back with.
