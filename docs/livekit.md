# From a running LiveKit agent to a transcript you can read

A LiveKit agent already emits OpenTelemetry. egma listens on the endpoint that
telemetry is built to reach, so wiring the two together is configuration on the
agent's side and nothing else — no SDK, no callback, no code egma asks you to
write. This page walks the whole path: an agent talking to somebody, and the
exchange on screen in egma with its timings.

It is written against LiveKit's Python agents framework, which is the one that
exports OpenTelemetry today.

You need three things, and egma packages none of them:

- **a LiveKit server** — the development server on your own machine, or LiveKit
  Cloud;
- **model credentials** for whichever speech and language providers the agent
  uses, billed by those providers, not by egma;
- **a running egma**, which is `docker compose up` and covered in the
  [README](../README.md#running-it).

Nothing here is specific to the example below. Any LiveKit agent that sets up an
OTLP exporter reaches egma the same way — the example is just the shortest thing
to point at.

## 1. Get an egma key that a project owns

Open egma, sign up, and you land in an organization with a project in it.

Then mint a key **against that project**. The terminal login flow in the
[README](../README.md#logging-in-from-a-terminal) is the shortest way there and
asks you for nothing you have to go and dig out of a browser: the terminal shows
a short code, you approve it and say which project the terminal is for, and the
key it collects is scoped to that project by construction.

The other route is one request, authenticated by the browser session you signed
in with. egma's session cookie is `egma.session_token` — `__Secure-`-prefixed
when the instance is served over HTTPS — and `curl -b` wants the whole
`name=value` pair, not the value on its own:

```bash
curl -sX POST http://localhost:3101/api/keys \
  -H 'content-type: application/json' \
  -b "egma.session_token=$YOUR_SESSION_TOKEN" \
  -d '{"name":"livekit-agent","project_id":"prj_..."}'
```

`GET /api/me` names the projects you are in and their ids.

**Which project the key names is the one thing on this page you can get wrong
silently.** A key minted for the whole organization files its telemetry under no
project. Everything is stored and the export is accepted; `GET /v1/traces` with
that same organization-wide key hands it all back — and the dashboard shows you
nothing at all, because a signed-in browser reads the project its session is
acting in, and telemetry filed under no project is in no project. There is no
error, because nothing went wrong; the spans simply are not where the page is
looking. Mint the key against a project and the two agree.

Keep the secret. It is shown once.

## 2. Get the agent

LiveKit's own OpenTelemetry example is `examples/voice_agents/otel_trace.py` in
[`livekit/agents`](https://github.com/livekit/agents). It is a small voice agent
called Kelly with one tool, and it already builds a `TracerProvider` and calls
`set_tracer_provider` — so its export destination comes from the standard
OpenTelemetry environment variables and needs no edit.

Check out `livekit/agents` at the tag you want, copy
`examples/voice_agents/otel_trace.py` to a working directory as `agent.py`, and
install what it runs on:

```bash
pip install "livekit-agents[openai,silero,turn-detector]==1.6.7" \
            python-dotenv opentelemetry-exporter-otlp-proto-http
```

**Decide where its models come from before you run it.** As published the
example routes its language, speech-to-text and text-to-speech steps through
LiveKit Inference — `inference.LLM("openai/gpt-4.1-mini")` and its neighbours —
which LiveKit documents as [part of LiveKit
Cloud](https://docs.livekit.io/agents/models/). On a development server on your
own machine, point those three steps at a provider directly instead. LiveKit's
plugins each want your own account with the provider they wrap; routing all three
through one provider keeps it to a single key:

```diff
             llm=FallbackLLMAdapter(
                 llm=[
-                    inference.LLM("openai/gpt-4.1-mini"),
-                    inference.LLM("google/gemini-2.5-flash"),
+                    openai.LLM(model="gpt-4o-mini"),
                 ]
             ),
             stt=FallbackSTTAdapter(
                 stt=[
-                    inference.STT("deepgram/nova-3"),
-                    inference.STT("cartesia/ink-whisper"),
+                    openai.STT(model="gpt-4o-mini-transcribe", use_realtime=True),
                 ]
             ),
             tts=FallbackTTSAdapter(
                 tts=[
-                    inference.TTS("cartesia"),
-                    inference.TTS("rime/arcana"),
+                    openai.TTS(model="gpt-4o-mini-tts", voice="ash"),
                 ]
             ),
```

The import goes with it: `from livekit.plugins import openai`.

`use_realtime=True` is not a preference: the example wraps speech-to-text in a
fallback adapter, and that adapter only accepts a streaming recogniser.

This is the only change to the agent, and it is about who bills you for the
models. **The export configuration in step 4 is environment variables, and
touches no code.**

## 3. Reach a LiveKit server

Two paths. Pick one; the rest of this page is the same either way.

### A development server on your machine

```bash
curl -sSL https://get.livekit.io | bash
livekit-server --dev
```

Development mode listens on `ws://127.0.0.1:7880` and accepts the well-known
development key pair, so the agent's three LiveKit variables are:

```bash
export LIVEKIT_URL=ws://127.0.0.1:7880
export LIVEKIT_API_KEY=devkey
export LIVEKIT_API_SECRET=secret
```

Those credentials are public knowledge and exist to make a first run free. Never
put them in front of anything you care about.

### LiveKit Cloud

The same three variables, with your project's values instead. LiveKit's
documentation is the authority here: the URL is the project URL [shown on your
project's settings page](https://docs.livekit.io/intro/basics/connect/), which in
practice is a `wss://` address, and `lk cloud auth` followed by `lk agent init`
[writes an `.env.local` holding all
three](https://docs.livekit.io/agents/start/voice-ai/). LiveKit Cloud can also
[hold secrets for a deployed
agent](https://docs.livekit.io/agents/ops/deployment/) and inject them into its
containers, which is where egma's key belongs once the agent is not running on
your laptop.

egma is not involved in any of that and does not need to be: the telemetry leaves
the agent process and arrives at whatever OTLP endpoint that process was told
about, wherever the agent happens to be running. What egma does need is to be
reachable *from* the agent — a Cloud-hosted agent cannot post to your
`localhost`, so an egma on your laptop wants a tunnel in front of it, and an egma
on a server wants its own address in `OTEL_EXPORTER_OTLP_ENDPOINT`.

## 4. Point the telemetry at egma

Three variables, and the agent is unchanged:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3100
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer%20egma_sk_..."
export OTEL_SERVICE_NAME=livekit-voice-agent
```

Three things about those, each of which has cost somebody an evening:

- **`%20` where the space goes.** OpenTelemetry defines this variable as a list
  of `key=value` pairs whose values are percent-encoded, and a literal space is
  not a character a value may contain. Some SDKs pass an unencoded space through
  and the header arrives intact; others refuse the whole variable, and the
  symptom is an agent that exports nothing and says nothing about it.
- **The API's port, not the web application's.** egma's pages and its API answer
  on one origin so a browser's cookie is valid for both — but telemetry carries
  no cookie and has no reason to go through a page server. Point the exporter at
  the API.
- **No `/v1/traces` on the end.** The exporter appends the signal's path itself.
  Give it the base and it posts to `POST /v1/traces`, which is the endpoint egma
  serves.

Then run it. Use `start` rather than `dev` unless you are on LiveKit Cloud —
development mode resolves end-of-turn detection to a hosted model.

```bash
export OPENAI_API_KEY=...        # or whichever providers you chose
python agent.py start
```

## 5. Talk to it

### Join the room the worker is serving

With the worker from step 4 running, join a room and speak: LiveKit's agents
playground does it in a browser, and it wants a microphone. Without one, have a
participant join with the `livekit` SDK and publish synthesised audio, leaving a
pause between utterances long enough for the agent to take its turn.

### Or skip the server entirely

`console` is a mode of the agents framework's own CLI — the same `agent.py`, not
`lk` — and it runs the agent locally in your terminal against your microphone
and speakers, with no LiveKit server and no room in the picture at all:

```bash
python agent.py console
```

It replaces `python agent.py start`, so it skips step 3 and the room in this
step, and step 4's three `OTEL_` variables still apply — the telemetry leaves
the same process the same way. It still wants a microphone: it gets you out of
running a server, not out of having something to speak into.

Whichever way, let the agent finish speaking before you start again, and let the
agent's job end when you are done: the batch processor exports every few seconds
and the example flushes what is left on shutdown.

## 6. Read it

Sign in and open **Transcripts**. The exchange is there, newest first, with when
it started, how long it ran, how many turns each speaker took, how many steps and
tools and failures are inside it, and the first thing the human said.

Open it and you get the transcript: alternating `human:` and `agent:` turns in
the order they were taken, each with how far into the exchange it happened and
how long it took. **Expand a turn** and you get the timed steps inside it — the
model, the speech synthesis, the tool, the turn detection, the speaking — and
expanding a step again shows exactly what was recorded about it.

It arrives within seconds. There is no ingestion delay to wait out: the exporter
flushes on its own schedule, and what it has sent is readable as soon as it lands.

The same data is available over HTTP with the same key, which is the
[contract the dashboard itself reads](../README.md#reading-traces-back):

```bash
# from and to are whichever window your own run happened in
curl -H "authorization: Bearer egma_sk_..." \
  "http://localhost:3100/v1/traces?from=2026-08-03T00:00:00Z&to=2026-08-04T00:00:00Z"
```

## What the steps under a turn are

Worth knowing before you go looking for something that is not there.

- **There is no speech-to-text step.** This version of the framework does not
  time recognition as a step of its own — the transcript, its confidence and the
  recognition delay arrive as facts on the human's turn. `eou_detection` is the
  decision that the human stopped talking, not the transcription of what they
  said.
- **Model and speech steps nest several layers deep**, through the adapters that
  wrap them: `llm_node` → `llm_fallback_adapter` → `llm_request_run` →
  `llm_request`. Only the innermost one names the model that actually answered;
  the outer ones name the adapter. The nesting is kept as it arrived rather than
  flattened, so the time attributed to each layer is the layer's own.
- **A turn with no words in it is normal.** An agent turn that ends up calling a
  tool, or that gets interrupted, has steps and timings and nothing to quote.
- **A step whose parent has not arrived yet appears at the top level.** Steps are
  exported as they finish and a parent finishes after its children, so a
  transcript read while the exchange is still running can show a step outside the
  turn it belongs to. It moves under its turn once the turn itself is exported.

Whatever egma's columns have no place for is kept verbatim on the row it arrived
on, so a step egma does not yet understand is stored rather than discarded.

## When nothing shows up

- **The dashboard is empty but `GET /v1/traces` returns rows.** The key names no
  project. Step 1.
- **Nothing arrives at all.** Check the header encoding — `Bearer%20`, not
  `Bearer `. Then check that the endpoint is the API's port and carries no path.
- **`403` on export.** Sending telemetry is a write, so a key acts at the role of
  whoever minted it. A `viewer`'s key is refused; a `member`'s or an `admin`'s
  exports.
- **Signing in is refused with an invalid origin.** egma's auth is configured for
  one origin, `EGMA_BASE_URL`, and `localhost` and `127.0.0.1` are two. Use the
  one you configured.
- **The agent never joins the room.** A LiveKit worker stops accepting work while
  the machine it is on is busy, and says so in its log. Wait for the load to drop,
  or use a machine with more room.

## Without a LiveKit server at all

egma ships a captured export from a real run of this example under
`fixtures/livekit-otlp-trace/`. Replaying those files at `POST /v1/traces` fills
the dashboard with a genuine transcript and needs no LiveKit server, no model
credentials and no microphone — which is the fastest way to see what this page
ends at before setting any of it up.

**Then look in the right window.** The capture keeps the timestamps it was
recorded with — it ran on 2 August 2026, from `18:04:40Z` to `18:05:53Z` — and
replaying does not move them. So the last twenty-four hours the list opens on is
empty, and stays empty however many times you replay. Pick a window containing
that day instead: **Last 30 days** from the control beside the heading, which
the address carries as `window=30d`, and which reaches back that far only until
early September 2026 — or name the interval outright with `from` and `to` on
`GET /v1/traces`. The exact bounds are in the fixture's own
[README](../fixtures/livekit-otlp-trace/README.md), under **Time window**.
