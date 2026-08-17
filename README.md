# Egma

The first open-source platform purpose-built to help teams shipping voice agents
gain trust in the agent they ship to production.

Understand the repo with Deepwiki - [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/egma-ai/egma)

## Running it

You need Docker with Compose. Nothing else.

This is the **platform workspace** — the directory your deployment lives in. It
is deliberately not your agent repository: the platform's carrier and provider
credentials belong to whoever runs the platform, and an agent repository holds
only tests and the address of the platform that owns their identifiers. On one
laptop that is often the same person, and the two directories are still
separate, because one platform serves many repositories.

```bash
cp .env.example .env      # then fill in the seven this command cannot make for you
npx @egma/cli self-host up
```

That starts the whole platform and prints the address an agent repository
points at. Nobody runs a migration step, because there isn't one — the API
applies its migrations while it boots.

**The first step is not optional, and the deployment says so rather than
guessing.** Ten values have no default anywhere, and `.env.example` marks every
one REQUIRED. Three of them you never type — `egma self-host up` generates the
media server's key and secret, and sets `EGMA_BASE_URL` to the address it
prints. The other seven are yours: the key that seals every credential and
setting you store, the secret that signs your sessions, the token a simulator
claims work with, and the object store's two credential pairs. `openssl` makes
each in a line, and `.env.example` gives the line.

They lost their defaults because a default was the wrong answer. Each used to
fall back to a value written in this repository, which every reader of it
holds — so a deployment could seal its provider keys with a published key, sign
its sessions with a published secret, and answer a claim for anybody who had
read the source, and nothing anywhere said so. A start missing one now stops
with that variable's name and how to make one, before a single container is
created.

The first `up` in a workspace also **generates the credential Egma's media
server, its simulator and its SIP gateway authenticate each other with**, and
writes it to `.egma-platform/platform.env`. You never choose it and never type
it: it is a password between Egma's own parts, in the same class as the
Postgres password. A pair that is already there is left exactly as it is, so
starting the platform again never locks a running deployment out of itself.
There is deliberately no default for it anywhere in this repository — a
deployment must not run on a credential every reader of this repository holds.

`docker compose up` starts the same containers, and is not the same thing.

**Your settings survive either way**, and that is the difference this release
made. The carrier, the persona's model and the speech providers live in the
platform's own database rather than in a file beside it, so a plain
`docker compose up`, a machine restart in another directory or a colleague's
clone all bring the platform back configured. Nothing has to be set up again.

**What a bare `docker compose up` does still lose is the media server's key and
secret, and the address this platform answers as.** The first two are in
`.egma-platform/platform.env`, nothing points compose at that file, and a
container reads that pair when it is *created* — so it cannot come from the
platform's database. The pair has no default anywhere, deliberately, so a
deployment never runs on a credential published in this repository. `Egma
self-host up` reads the file, hands the pair over, and sets `EGMA_BASE_URL` to
the address it prints, which is why it is the way to start this platform.

Drive compose yourself and you supply those three, in `.env` like the rest.
**Compose refuses and names the one it is missing** — it does not start a media
server with no password and leave you with a simulator that waits for ever on a
health check nothing will pass, which is what an empty value used to do.

There is a second, smaller difference. `egma self-host up` waits for the
platform to answer for itself, tells you what to type next, and tries once more
if the first attempt fails — which on a workspace that has never been started
it can, because ClickHouse's first boot creates its database and restarts
itself, and its health check answers during the server that is on its way down.
Nothing restarts the API when that happens, so the bare compose path needs the
second `up` typed by hand.

| Service | URL |
| --- | --- |
| Web application | http://localhost:3101 |
| API | http://localhost:3100 |
| Postgres | `postgres://egma:egma@localhost:5433/egma` |
| ClickHouse | `http://egma:egma@localhost:8124/egma` |
| Object store | none — reached on the deployment's own network |
| Simulator | none — it only dials out |
| Grader | none — it only dials out |
| LiveKit server | 127.0.0.1:7880, for this machine only |
| LiveKit SIP gateway | its SIP port and RTP range, for your carrier |
| LiveKit Redis | none |

Open http://localhost:3101 and sign up. Your organization and your first project
are created together, and you become their admin. On a fresh instance the first
person to sign up claims it, and open signup closes behind them — everybody
after that arrives by invitation.

### Configuring it

A started platform is not yet a configured one. It says so: `self-host up`
reports `setup: setup_required` and names what is absent. One command in this
directory asks for all of it, in one sitting:

```bash
npx @egma/cli login --url http://localhost:3101   # once, as the owner
npx @egma/cli self-host setup
```

It asks the platform what it is missing and then asks you for exactly that, in a
fixed order — who the persona thinks with, what it speaks and hears with, and
how a call reaches the telephone network — so you can gather one provider's
paperwork at a time rather than discovering a missing key one setting at a time.
**A setting the platform already holds is never asked for again**, so running it
after supplying one more key is a single question, and running it on a
configured platform changes nothing and says so. `--plan` prints the list of
what it would ask for and stops.

For the phone half it asks for a Twilio account, a voice number that account
**already owns**, and the account's Auth Token; shows you a plan before it
writes anything to your carrier; and on approval does the paperwork. It never
buys, ports or registers a number. Press Enter at the Twilio question to leave
the phone for later. `--apply --yes --json` is the same work with nobody
watching, for a coding agent driving it — every answer can arrive in the
environment variable named for it in `.env.example`.

**Every answer is written through the platform's own API, and the platform is
the only thing that seals.** The settings live in Postgres, sealed with
`EGMA_ENCRYPTION_KEY`, so they survive a restart, an upgrade and a move to
another machine — and every simulator is handed them on the work order it
claims, so a second simulator on another host needs nothing copied to it. The
CLI keeps none of them.

**Phone readiness is reported separately from platform readiness, and that is
honest rather than fussy.** A platform with no carrier runs text simulations
perfectly well, so it is reported as its own fact beside the whole-platform one.

**The Twilio Auth Token is used by that command and never kept.** What a running
Egma holds is a SIP credential that can authenticate one trunk and do nothing
else on the account.

*Upgrading from a release that used `egma self-host phone setup`:* your settings
were in `.egma-platform/platform.env`, and **nothing reads them there any
more** — there is no import path and no compatibility reader. Your platform will
report `setup required` after the upgrade. Run `egma self-host setup` once and
answer it again. The file itself stays, because it also holds the media server's
key and secret, which a container reads when it is created; the settings lines
left in it are inert, and you can delete them once setup has run.

Two of those lines are **not** settings and want different treatment.
`EGMA_BASE_URL` stays where it is and is still read from that file. The three
`EGMA_JUDGE_*` variables are not read from it any more, and setup does not ask
for them either — a judge belongs to the project that chose it rather than to
the deployment, so it was never among the platform's settings. Move them to
`.env`, which is the file Compose reads on its own.

`GET /health` on the API and `GET /api/health` on the web application are what
the container health checks poll.

Ports, the two stores' credentials and the settings below come from the
environment; see `.env.example` for the names and their defaults.

**The division there is worth knowing.** What the deployment creates for itself
— the two stores' own users and databases, every port, every bind — has a
working default, so a self-hoster who sets none of them gets exactly the
deployment this page documents. What the deployment *cannot* invent has no
default at all: its own secrets, and its own address. Those are the ten marked
REQUIRED in `.env.example`, and a start missing one of them is refused by name.
Per-container tuning keeps its defaults too, because how many simulations one
simulator takes at once is a property of your machine rather than of Egma.

**`EGMA_AUTH_SECRET` signs session cookies and the API refuses to start without
one.** It has no default: one written into this repository is one every reader
of it can mint a session with. `openssl rand -base64 32` makes one.

**`EGMA_BASE_URL` is the whole address people reach this instance at, and
nothing more than that** — scheme, host and port. It is what the pages, the
login flow and an agent repository all use, and an agent repository will not
follow an instance to an address the developer did not type: if others reach
yours at `http://192.168.1.10:3101` while this says `http://localhost:3101`,
their first command stops and names both addresses instead of quietly talking
to their own machine.

*Upgrading:* a value carrying a path, query, fragment or credentials is now
refused when the API starts, where it used to have its trailing slashes trimmed
and the rest kept. Serving Egma under a subpath such as
`https://egma.example/egma` never worked — the API answers at the root of this
address — so the fix is to drop everything after the port. The startup message
names the part to remove.

**`EGMA_BLOB_PUBLIC_URL` is the address *a browser* reaches the recording store
at, and it is set at the same moment as the one above.** A voice simulation's
recording is played by the browser fetching it from the object store directly,
using a short-lived link the API signs; the audio never travels through Egma,
which is what makes dragging the scrubber cost nothing. A signature covers the
host it was made for — so if this names the address the API uses
(`http://minio:9000`, inside the compose network) rather than the one a browser
uses, every recording comes back `SignatureDoesNotMatch` and the error names
neither address. The default assumes a browser on this machine; an instance
others reach at `http://192.168.1.10:3101` has to say `http://192.168.1.10:9000`
here, exactly as it has to say the first address in `EGMA_BASE_URL`.

*The two settings must agree about `http:` and `https:`.* They are one browser's
two addresses, and a page served over `https:` may not fetch audio over `http:` —
every browser blocks that as mixed content before the request is sent, so the
store is never asked and a perfect signature is never checked. The API refuses to
start on that pair and names both variables, because the alternative is a player
that fails with the reason only in the browser's console. An `http:` Egma reading
an `https:` store is fine, and both on `http:` is the default deployment.

*A plaintext address here is allowed and is not free.* `http://192.168.1.10:9000`
works, and it also means the recording — a customer's call audio — and the
fifteen-minute link that replays it travel readable by anybody who can watch that
network. `http://localhost:9000`, the default, shows that to nobody. Egma does not
refuse it, because an Egma on `http:` is already handing that same network the
session cookie that opens every recording; on a network you do not trust, put the
store behind the same certificate as Egma and set both addresses to `https:`.

Leaving it unset is allowed and breaks nothing else: the platform runs, runs run,
and asking for a recording answers with the name of this variable rather than
with a player that does nothing.

**The store is published to this machine and no further**, and opening it is a
decision rather than a default. What answers on that port is not only the
recordings: it is the store's admin surface and its root credential, which can
list, replace and delete every recording you hold — so on `0.0.0.0` a
`docker compose up` on shared wifi hands every recording to the room, to read
and to overwrite. A recording is evidence, and evidence somebody else can
replace is not evidence. This repository used to ship a development default for
that credential, which made the same sentence true on the machine's own network
too; it has none now, and a deployment that states no credential of its own is
refused at start.
Loopback costs the default deployment nothing, because the default assumes the
browser is on this machine. When it is not — a server, a colleague — set
`EGMA_S3_BIND=0.0.0.0` and point `EGMA_BLOB_PUBLIC_URL` at the address those
browsers use, and **change `EGMA_S3_SECRET_ACCESS_KEY` first**.

**The API's store credential is read-only**, created by the deployment on first
start and separate from the one the simulator writes with. A leaked read
credential must not be usable to overwrite a recording, so it can fetch one
object at a time and cannot write, delete or list.

**`EGMA_S3_REGION` is set once and both halves read it.** The simulator signs
its uploads with a region and the API signs playback links with one, and two
halves of one store signing for two different regions is every upload working
and every playback failing with — again — `SignatureDoesNotMatch`. Empty is
right for the MinIO this file runs, which ignores regions entirely; a bucket on
Amazon's own S3 needs its real region, and the API refuses to start pointed at
an `amazonaws.com` address without one rather than signing everything for
`us-east-1` and letting you discover it one recording at a time.

**`EGMA_SIMULATOR_SERVICE_TOKEN` is what the simulator shows the API to claim
work, and the API refuses to start without one.** The answers to a claim carry
your live provider credentials, and port 3100 is published on the host, so the
check is always on and there is no default. Both containers read the same
variable, so one line in `.env` covers both and the two halves always match:
`echo "egma_st_$(openssl rand -hex 32)"` makes one.

Email is optional, and this is load-bearing rather than a convenience. See
[Adding a second person](#adding-a-second-person).

**If a busy instance logs `Cannot open epoll descriptor … Too many open
files`**, ClickHouse has run out of file descriptors rather than Egma having a
bug: it keeps one per open part and per connection, and its documented
requirement is far above what a login shell hands a container. Copy
`docker-compose.override.yml.example` to `docker-compose.override.yml` and
bring the services back up — Compose reads it on top with no further arguments.
It is an override rather than the default because a container may not raise its
limit past the daemon's own, so a host with a low hard `nofile` would not start
at all.

## Your first run, from a terminal

With an instance up and an account on it, the wizard is one command:

```bash
cd ~/your-voice-agent
npx @egma/cli --url http://localhost:3101
```

To run it from this checkout instead — for development, or ahead of a release:

```bash
pnpm install                    # once
pnpm --filter @egma/cli build    # builds it into apps/cli/dist
```

Then run it in the repository that holds your voice agent, naming the instance
you signed up on:

```bash
cd ~/your-voice-agent
node ~/egma/apps/cli/dist/bin.js --url http://localhost:3101
```

`~/egma` is this checkout. The published package is `@egma/cli`; the command it installs is `egma`.

It lists the installed Claude Code, Codex, Cursor, and OpenCode agents and asks
which one to use. It then signs that machine in — a short code, approved in the
browser you signed up in — registers your voice agent together with the way
Egma reaches it, writes a first suite of tests with that coding agent, puts them on your
instance, and starts a run over the exact versions it pushed. Every step is also
a verb (`egma login`, `egma connect`, `egma push`, `egma run`) that prints one
fact per line and answers with a number, for a coding agent driving it with
nobody watching. `apps/cli/README.md` is the whole of it.

**What happens, said plainly.** The run is created and followed live, the
simulator claims it and conducts the conversation, and the grader judges what
it did. Verdicts arrive after the conversation ends — one per expected
behaviour, each carrying its own rationale, the turns it cites and the judge
that wrote it. Execution and grading are reported separately, because a run
whose calls have all finished is not yet a run whose judgment is in.

Everything before that is real, and the run you started is yours — at
the address the terminal printed, with no token on it.

The same wizard flow runs as a check. On a checkout that has had `pnpm install`, and on
a machine with a Chrome — or with `PLAYWRIGHT_BROWSERS_PATH` pointing at a
Playwright Chromium, since the approval really happens in a browser — it is two
commands:

```bash
pnpm db:up
pnpm --filter @egma/cli smoke:wizard-flow
```

They start a whole Egma of its own, sign in through a real browser, register,
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
  voice and hears real words. Each leg is chosen on its own, and
  `EGMA_SIMULATOR_VAD_PROVIDER=silero` is the third: what hears a real
  agent start and stop speaking, keyless and bundled.
- **`EGMA_SIMULATOR_CAPACITY` is how many simulations happen at once.** The
  default is two. The simulator claims only what it can hold, so a big run
  degrades into a queue rather than into overload. Compose passes this setting
  through without keeping a second default of its own.

Anything set to something it cannot use stops the container on its first line,
naming the variable. A wrongly mounted volume is caught the same way, rather
than by losing the first recording.

### The grader

The other one judges conversations — the ones the simulator conducted and the
ones a real caller had, with the same graders. A simulation reaching its end
becomes claimable work in the same commit that ends it; a production
conversation becomes claimable when its telemetry says it is over. The grader
takes the work, reads the conversation, resolves the graders that apply to it,
and writes one verdict row per judged assertion.

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
customer's choice, not Egma's. `apps/grader/README.md` is the whole table.

### Watching a simulator without a control plane

A real run needs a platform to claim work from. To watch the simulator's own
machinery in isolation instead — no database, no control plane — start it
against the
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
carrier you already pay; Egma is never in that relationship. The bridge is
LiveKit, and it is already running: the LiveKit server, its SIP gateway and the
Redis they find each other through are part of the default deployment. There is
no overlay to ask for by name.

`egma self-host setup` is what turns your carrier account into the trunk. The
rest of this section is what is happening underneath it, and what to do when the
machine you are on cannot host the gateway.

**LiveKit Cloud is one variable.** Point `EGMA_SIMULATOR_LIVEKIT_URL` at it with
its key and secret and stop reading — there is nothing to host and nothing to
open.

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

**On a laptop behind an ordinary router it depends on your carrier, and we have
now measured both answers.** The gateway discovers its public address by asking
a STUN server, which answers with the address only — and pairs it with its own
*local* RTP port. On some consumer routers that pairing names nothing: measured
from a MacBook behind one home router, a UDP socket bound to port 10019 was
seen outside as 41110, another on 10105 as 39306, another on 10106 as 64104 — a
different arbitrary port every time, and no inbound mapping for any of them.

What rescues a NATed gateway is the carrier ignoring the address in the SDP and
replying to wherever our audio came from — **symmetric RTP latching**, which
many carriers do. **Twilio does.** A real outbound call from a MacBook behind an
ordinary home router, with no port forwarding, carried two minutes of two-way
audio and reached the agent under test. A second home router measured
port-preserving and endpoint-independent across three STUN servers, which is
why that call worked.

So: **on a server with a public IP this is routine, and on a laptop it depends
on your carrier latching.** Try it — a failed call costs a few cents and tells
you in under a minute. If yours does not latch, use LiveKit Cloud — same API, same trunk, same code,
one URL.

The RTP range is 21 ports by default, not LiveKit's own 10000-20000: that is
about ten calls at once, more than the simulator's default capacity of two can
use, and a range published to the internet is a range to justify. Widen both
ends together if you raise capacity, and widen your firewall by the same
amount.

### Turning a carrier account into a trunk

You should not have to hand-build SIP paperwork in somebody's console, and you
do not:

```bash
npx @egma/cli self-host setup
```

It reads your account first and shows you a plan — what it would create and what
is already there — and writes nothing to your carrier until you approve it. Then
it creates the trunk, its termination URI, a credential list and the credential,
attaches the credential list and the number to the trunk, and writes the trunk,
the number and the credential **into the platform's own store, sealed**. Nothing
is restarted: the platform reads its settings from that store for each
simulation, so the phone is ready on the next request. It names everything it
made with that thing's own identifier, in the terminal and in a receipt filed in
`.egma-platform/receipts/`, so a year from now you can find all of it in the
Twilio console or delete it.

It is safe to run again, and safe to run again after a run that stopped half
way: every step looks for what it would create before creating it, so a second
run finds what the first made and adds only what is missing. The one thing it
cannot reuse is the password — Twilio hands one out once and never again — so a
re-run mints another and tells Twilio, which is what makes the configuration it
writes always usable rather than usable only the first time.

**The number must already be on your account.** Egma never searches the
catalogue, buys, ports or registers one; if the number you name is not there, it
says so and stops before creating anything at all.

**The account token is used by that command and by nothing else.** What a
running deployment keeps is a SIP credential that can do exactly one thing:
authenticate a call over one trunk. It is sealed in the platform's own store
with the same key a connection's credentials are sealed with, and it reaches a
simulator only on the work order that simulator claims.

### The whole thing, end to end

One command, with your own number and your own credentials in the environment:

```bash
EGMA_WORKBENCH_PHONE_NUMBER=+15551234567 \
docker compose -f docker-compose.yml -f docker-compose.workbench.yml \
  up --build simulator workbench
```

Naming the two services is what keeps the API and the two databases out of it;
the phone stack comes along because the simulator depends on it. What starts is a workbench holding one spec, pointed at your
number instead of the fixture's placeholder, and a simulator that can dial it.
Then watch the workbench's log: the claim, the call, each turn of the
conversation as it is spoken, the timings measured off the audio, and the
recording's reference. The `.wav` is in the object store, with the persona on one
channel and the agent on the other. From a full deployment you press play on the
run's results — or beside the turns of that conversation's transcript, which is
where a turn looks wrong in the first place — and hear it; the workbench overlay
starts no API and no pages, so this brings it out to listen to instead:

```bash
docker compose exec minio sh -c \
  'mc alias set egma http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
   mc cat "egma/egma-recordings/<reference>"' > call.wav
```

The persona speaks in a deterministic test tone unless you name real speech
providers, and a real agent hears that as noise. `egma self-host setup` asks for
all of it — the persona's words, its voice, its ears, and `silero` for hearing a
real agent start and stop speaking — and stores it on the platform, from where
every simulator is handed it. The workbench overlay runs a bare simulator with
no platform to be handed anything by, so there set `EGMA_SIMULATOR_TTS_PROVIDER`,
`EGMA_SIMULATOR_STT_PROVIDER`, their key and `EGMA_SIMULATOR_VAD_PROVIDER=silero`
before you expect a conversation.

Pipecat and the transport own any media conversion. Egma does not force or
report a processing rate. The WAV header is the only sample-rate fact Egma
writes. It tells a player how to play the recording; it does not describe the
connection's codec or acoustic quality.

Every variable this section mentions is in `.env.example` with its default and
whether it is required. Anything set to something unusable stops the simulator
on its first line naming the variable — including a trunk given only half a
credential, which a carrier would otherwise refuse once per call in a way that
reads exactly like a wrong one.

## Testing a LiveKit agent in its own room

A phone number is one way to reach an agent. A LiveKit agent has a shorter one:
it is a worker waiting to be given a room, so Egma makes a room in **your**
LiveKit project, joins it, asks for your worker, and holds the conversation
there. No trunk, no carrier, no number — and no bridge to host, because the room
*is* the meeting place.

What that takes is the three variables already in your agent's own environment:
its LiveKit URL, API key and API secret, plus the agent's name if your worker
registers one. They go on the connection rather than into this deployment's
environment, because the project is yours and not Egma's.

[`fixtures/livekit-dumb-agent`](fixtures/livekit-dumb-agent) is a deliberately
boring agent to try this path against before you point Egma at a real one. For
teams that will not hand a testing tool their project's key pair, the
token-endpoint mode keeps the secret on your side: your service mints each
room's token.

## Agent Skills

The public repository is the source for three Agent Skills:

- `egma` operates the CLI, keeps repository tests in step with Egma, starts a
  run, and reads its verdicts.
- `find-voice-agent` maps a repository's voice-agent framework, prompts, tools,
  deployment path, and provider identifier location. Its provider references
  currently include Retell and LiveKit, and it recognizes Pipecat and Vapi.
- `write-egma-tests` writes and edits the Markdown tests in `egma/tests/`.

Install any skill into a supported coding agent with:

```bash
npx skills add egma-ai/egma --skill egma
npx skills add egma-ai/egma --skill find-voice-agent
npx skills add egma-ai/egma --skill write-egma-tests
```

Leave out `--skill` to choose from all three.

The CLI also carries the exact skill snapshot from its release tag. This lets
the wizard use `find-voice-agent` and `write-egma-tests` without downloading
them, and offer the `egma` skill for direct installation after a run.

## Working on it

Node 24 and pnpm 10. Two things here are Python, managed by
[uv](https://docs.astral.sh/uv/) — the simulator and the SDK a customer
installs — so install uv too, and `pnpm test` covers all three worlds.

```bash
pnpm install
pnpm db:up        # Postgres on 5433 and ClickHouse on 8124, which the tests need
pnpm test         # everything: both lanes, then the three Python suites
pnpm test:fast    # the loop you work in: no Chrome, no web application
pnpm test:browser # the real-browser proof, on its own
pnpm lint
pnpm typecheck
pnpm build
```

**The suite has two lanes, because its two halves cost very different
amounts.** Almost all of it is unit, database, API, grader, CLI and web tests,
measured in milliseconds each; one file drives a real Chrome against a real web
application and costs about a minute before it asserts anything. Paying that
minute after every small edit is how a suite stops being run, so `test:fast`
leaves it out and `test:browser` is the only thing that runs it. Nothing falls
between the two — `pnpm test` runs both, then the simulator, SDK and fixture
suites, and fails if any part failed. Every run prints which lane it chose
before it starts, so a green run can be read back to the proof it stands for.
[`vitest.config.ts`](vitest.config.ts) is where a lane is defined, as two Vitest
projects. A lane is described by what it leaves out rather than by a list of
what it holds: the fast lane declares no `include` at all, so it is Vitest's own
search minus the one real-browser file, and a new test file joins it by
existing.

Tests run against a real Postgres and a real ClickHouse — never a substitute,
because every guarantee under test is one of theirs. Each test file creates a
database of its own in whichever store it uses and drops it afterwards, so
`pnpm test` needs credentials that may create databases. `pnpm db:up` starts
both; point `TEST_DATABASE_URL` and `TEST_CLICKHOUSE_URL` somewhere else if you
would rather use your own.

**Contributing costs you no `.env`.** The stores' own users, databases and
ports keep their defaults, so a fresh checkout runs `pnpm db:up`, then
`pnpm test`, then `pnpm db:down`. The deployment's REQUIRED secrets are a
different matter — running the platform needs them, and operating two stores
does not — so both of those scripts hand Compose a placeholder for each, and
neither container ever reads one. See `packages/db/test/support/compose.ts`,
which explains why the wrapper exists at all.

**Plain `docker compose` in a checkout is a different story, and it should be.**
Compose reads the whole file before it does anything — `ps` and `down` included
— so every subcommand refuses until this deployment's ten REQUIRED values are
set, which is right for a deployment and merely inconvenient in a checkout
nobody runs the platform from. Use the two scripts above, or fill in `.env` and
drive Compose directly the way a self-hoster does.

The object store is real for the same reason and asks you for nothing. The
handful of tests that need one start their own MinIO container, on a port of
its own, and remove it afterwards; where docker cannot start one they say so
and skip rather than pass quietly. Everything else in the simulator's suite
writes its recordings to a directory, so a checkout costs you no object
storage at all.

One test drives a real browser: `apps/api/test/browser.test.ts` starts the API
and the web application on ports of their own and clicks through the paths a
person actually walks — logging in from a terminal, inviting a colleague on an
instance with no mail configured, reading what an agent did, and playing a voice
simulation's recording off a real object store. That last one is here rather than
against the API because the failure it catches *is* a browser using a different
address than the platform, which nothing inside one process can see. It uses the
Chrome already on your machine, and failing that any Chromium under
`PLAYWRIGHT_BROWSERS_PATH`; this repository depends on `playwright-core` and
downloads no browser of its own, so **install Google Chrome or point that
variable at one** if you have neither. Every branch of those flows other than
the happy one is covered against the API instead, where it costs milliseconds.

That test and `pnpm --filter @egma/web build` both write `apps/web/.next`, so
they cannot run at once in one checkout: whichever starts second is refused with
a sentence naming the one already there, rather than each quietly serving half
of the other's build. Two worktrees have two output directories and never
collide.

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
sdks/python     The package a customer installs inside their own LiveKit
                agent, so Egma can answer for the agent's tools while a
                simulation runs and touch nothing anywhere else. Published
                to PyPI as `egma`. Own toolchain (uv); see its README.
```

The two processes answer on **one origin**. The web application proxies the
API's paths to it, so the session cookie is valid for both and there is no
cross-origin cookie handling anywhere. Everything the browser talks to is the
instance it loaded the page from, which is what makes logging in depend on
nothing a self-hoster does not run.

## Authentication

An auth provider answers one question: who is this person, and are they logged
in. Everything past the front door is Egma's — organizations, projects,
membership, invitations, API keys and every permission check are Egma's own
tables with Egma's own foreign keys.

That line is held by two build rules on top of the ones above:

- **Only `apps/api/src/auth/better-auth.ts` and `packages/db/src/identity-store.ts`
  may import the provider's package.** Everything else sees the four-call seam
  in `apps/api/src/auth/seam.ts`. A third file naming the provider is porting
  cost paid later by somebody who did not choose it.
- **Egma writes the DDL for the provider's tables** and its migrator is not
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

Egma listens on the OpenTelemetry endpoint your agent already knows how to
export to. Point it at this instance with an Egma key and write no integration
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

**Point an exporter at the API itself, and not at the pages.** On a self-host
that is the API's own port — `http://localhost:3100` above, or whatever address
you publish it on. On hosted Egma it is `https://api.egma.ai`, not
`https://app.egma.ai`.

The one-origin rule further up is about a browser: the pages proxy the API so
that one session cookie is valid for both, which is what makes signing in depend
on nothing you do not run. **This door is not a browser's.** It is authenticated
by a Bearer key, carries no cookie, and is driven by an agent process — so the
rule that governs the rest of the surface was never about it, and routing an
exporter through a page server buys nothing but a hop and one more thing that
can be down.

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
- **The ids are yours.** Egma stores the trace and span ids that arrived and
  mints neither; a span carrying no usable id is reported back as rejected
  rather than given one.
- **Nothing is invented and nothing is dropped.** One span in is one row; what
  the columns have no place for — every attribute, event and resource field —
  is kept verbatim on the row it came on.
- **A recent exact retry is free.** During the current rolling-deploy bridge,
  Egma keeps the prior release's block token and input shape. ClickHouse can
  therefore suppress a recent retry that moves between old and new API
  replicas. The token is not permanent: a later, regrouped, or reordered repeat
  can append, and there is no read-time per-span deduplication. Removing the
  bridge requires a separate cutover after old writers and pending retries have
  drained and rollback is closed.
- **Sending traces is a write**, so a key acts at the role of whoever minted it:
  a `member` or an `admin` exports, and a key held by a `viewer` is refused.
  Demoting somebody stops their exporters on the next request, with no key
  touched.
- **Which environment a span belongs to is discovered**, from
  `deployment.environment.name` if your telemetry sets it and `default` if it
  does not. There is nothing to declare first. Names beginning `egma` are
  reserved and are refused with a reason.

The same telemetry path works with a development server on your machine or
LiveKit Cloud.

Spans Egma will not store are reported in the response's partial-success field
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
| `source` | optional | `simulation` or `production`. Narrows to one kind of traffic; absent — or empty — means both. Any other word is refused. |
| `limit` | optional | 50 by default. Above the maximum of 200 it is clamped; zero, negative or not a count at all is refused. Empty is absent. |
| `cursor` | optional | `next_cursor` from the previous page. Send `source` again on every page: a token is a position in the ordering it was minted in. |

**`GET /v1/traces/:traceId`** returns one trace as a transcript: `turns` in the
order they were taken, each carrying the spans that happened inside it, and
`spans` for everything top-level that is not a turn — the root span above all.
It takes `from`, `to` and `project_id` on the same terms.

It also carries **`simulation_id`**: which simulation this trace is, when Egma
conducted it, and `null` when your own agent had the exchange in production. A
simulation id and the trace its spans are filed under are the same 128 bits
written two ways, so this is derived rather than stored — and it is sent only
for a trace Egma conducted, because a production trace converts just as neatly
into an id nothing ever minted. It is what lets a reader holding one transcript
ask for that conversation's recording without looking anything else up.

And it carries **`measures`**: what this exchange measured, computed from its
own spans. Each entry is `{measure, unit, samples, span_ids, worst, partial}` —
the measure's name from
[the measure catalog](packages/simulation-contract/measure-catalog.md), the unit
that catalog counts it in, one sample per measurement in the order they were
taken, the span each sample came off, and **`worst`**: the single measurement a
grader holds against a bound, as `{value, span_id}`. A measure this exchange did
not produce is **absent** rather than present with nothing in it, so an empty
list means nothing was measured — which is the ordinary answer for a production
exchange, since Egma files a timing span only for its own simulator's telemetry.

**`worst` is on the wire because the reduction is part of the answer.** A bound
is held against one number, and which number that is — the worst measurement
today, whichever aggregation a grader asks for later — is Egma's decision rather
than yours to reproduce. Reducing the series yourself would be a second
implementation of exactly the figure a verdict rests on: right for as long as
both take the maximum, and wrong with nothing to warn you the day they differ.

**`partial` is true when the reading is a prefix.** A trace over the 10,000-span
limit comes back as its first spans, so a worst measurement taken over it is the
worst of the part Egma holds and not of the exchange — the slowest turn of a
long call is as likely to be past the cut as before it. The grader refuses such a
conversation outright and writes no verdict from it; this endpoint shows what
there is and says what it is.

All of it is computed at read time by the same code a `latency` grader is judged
through, so the number you read here and the number a verdict rests on are one
piece of arithmetic and can never disagree. Nothing stores them: they are the
spans in this response, reduced.

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

Sign in and open **Monitoring**. You get that project's production transcripts,
newest first, defaulting to the last twenty-four hours — when each one started,
how long it ran, how many turns each speaker took, how many steps and tools and
failures are in it, and the first thing the human said. Test traffic is not
here: a simulation is read under the **Simulation run** that produced it, beside
the test it froze and the persona that called. Pick a different window from the
control beside the heading and the address carries it, so a refresh and a link
both stay on the window you chose; **Show more** walks the pages.

Open one and you read it as a transcript: alternating `human:` and `agent:`
turns in the order they were taken, each with how far into the exchange it
happened and how long it took. **Expand a turn** for the timed steps inside it —
the model, the speech synthesis, the tool, the turn detection, the speaking —
and expand a step again for exactly what was recorded about it. Anything that
failed is marked on the turn before you open it.

**If Egma conducted the exchange and it was a voice one, its recording is right
there** — a player above the turns, both channels, the human on the left and the
agent on the right. That is where a turn looks wrong, so that is where you can
settle whether the agent misbehaved or the transcription did. A chat, a call
that never connected, and somebody else's production telemetry are offered
nothing at all rather than a control that does nothing. Do not confuse it with
**Open the audio your agent's telemetry attached**, which appears on a step and
is your framework's own file at your framework's own address; the player says
whose audio it is, and so does the link.

Two things about this are worth knowing:

- **The project and the window both ride in the address.** Every page in this
  section lives under `/projects/<projectId>/monitoring/…`, and a transcript's
  link carries the window the exchange happened in as well, because the endpoint
  under it needs one. That is why the link works when you send it to somebody,
  and why opening a transcript's address with no window asks you to come in from
  the list.
- **A key minted for a whole organization files its spans under no project at
  all** (see above), and those do not appear here. **Mint the exporter's key
  against a project** and its telemetry lands where the page looks — the empty
  page says so, and links to where the key is minted.

The pages are drawn from the two v1 endpoints above — the same contract you
would integrate against, on the same origin, authenticated by the same session
that signed you in — plus one request per transcript that Egma conducted, to
turn its recording into a link the browser fetches from the object store
directly.

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
EGMA_MAIL_FROM='Egma <egma@example.com>'   # optional
```

Setting it changes three things at once, by itself: invitations are emailed
rather than handed back, signup asks for email verification, and a password
reset link is posted to the person who asked for it. There is no second setting
to keep in step, because there is no configuration in which Egma should wait for
a message it never sent.

## Forgetting a password

**Sign in, "Forgot your password?", and name your address.** Egma sends a link
that opens one page asking for a new password, and nothing else. Set it, sign in
with it, and the old password stops working.

Nothing about this needs SMTP either. With no mail transport configured the
whole message — link included — is written to the platform's log, exactly where
an invitation's link comes back to whoever sent it, so a solo install still lets
you back in.

**Know what that means before you run an Egma with no mail and a log other
people can read.** An invitation's link creates an account; a reset link takes
over one that already exists, an admin's included. Whoever can read the
platform's log for the next hour can follow one. On a solo install that is you,
which is the whole point of the arrangement — but a shipped log drain or a
`docker compose logs` a colleague can run is a way into every account on the
instance, so set `EGMA_SMTP_URL` before there is a second person to keep out.

- The link works **once**, and runs out an hour after you asked for it. That
  hour is one number and not two: it is what the link says and what the auth
  provider underneath is configured with, so no door honours it for longer than
  the message promises.
- **A link somebody already used is refused with a message that says so**,
  because "you already did this" and "nothing happened at all" are opposite
  instructions. Once the hour is up Egma can no longer tell which of the two a
  dead link is — the provider forgot the token at the same moment Egma stopped
  honouring it — so it says exactly that, rather than guessing at one of them.
- Asking about an address with no account here is answered exactly as one with
  an account — same status, same words, and the same length of wait — so the
  form never says who holds an account on this Egma instance.

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
runs one per request, and every schema change must carry the safe guard for its
operation — `IF NOT EXISTS` for creates and additions, and `IF EXISTS` for
modifications, renames, and drops. ClickHouse has no transaction that can roll
back a half-applied file, so the next boot must be able to run each statement
again safely.

## License

Egma is licensed under the Apache License, Version 2.0. The full text is in
[`LICENSE`](LICENSE).

One boundary is declared in advance. A directory named `ee`, at any level of
this repository, is commercially licensed and is not covered by the Apache
License. No such directory exists today. If one is added, it will carry its own
`LICENSE` file with its terms.

Parts of the CLI's terminal UI are adapted from the PostHog wizard under the MIT
license. See [`apps/cli/NOTICE`](apps/cli/NOTICE).
