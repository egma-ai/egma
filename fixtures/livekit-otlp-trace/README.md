# A captured LiveKit agent trace, in OTLP wire format

This directory holds the raw OpenTelemetry export of one real trace — a person
talking to a LiveKit voice agent, end to end: fourteen `POST /v1/traces` request
bodies, byte for byte as an OTLP/HTTP exporter sent them, plus a manifest of the
headers that came with each one.

It exists so that egma's trace handling is built and tested against telemetry a
voice agent actually emits, rather than against payloads invented to fit egma's
own schema. Replaying these files needs no LiveKit server, no model provider key
and no microphone.

## What is in it

| File | What it is |
| --- | --- |
| `request-000.bin` … `request-013.bin` | The unmodified body of each export request, in order |
| `manifest.json` | Per request: filename, arrival time, path, byte length and headers |
| `capture-server.py` | The sink that wrote the two above. Run it to make a new capture |
| `.gitattributes` | Marks the `.bin` files as binary so nothing normalises the bytes |

**Encoding.** Every body is an uncompressed, binary-serialised
`opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest`, sent with
`Content-Type: application/x-protobuf` and no `Content-Encoding` — the default of
the Python OTLP/HTTP exporter. Nothing here is JSON, and nothing here has been
re-encoded, pretty-printed or edited. Read a file by parsing it with the
`opentelemetry-proto` message of that name, or feed it to an OTLP endpoint as-is.

**Contents.** One trace, 133 spans, five human turns and eight agent turns. The
span names present are:

```
agent_session          start_agent_activity   on_enter        on_exit
agent_turn             user_turn              agent_speaking  user_speaking
eou_detection          function_tool          drain_agent_activity
llm_node               llm_fallback_adapter   llm_request     llm_request_run
tts_node               tts_stream_adapter     tts_fallback_adapter
tts_request            tts_request_run
```

**Time window.** The spans run from `2026-08-02T18:04:40.281990Z` to
`2026-08-02T18:05:53.776866Z` UTC. Timestamps are part of the captured bytes, so
anything that asserts over or replays this capture must supply a query window
containing that interval — or shift the timestamps at replay time. Never edit
the bytes.

A few things worth knowing before you write assertions against it:

- **There is no speech-to-text span.** In this version of the framework, speech
  recognition is not a span of its own: the transcript, its confidence, the
  recognition delay and the provider's request ids are all attributes on the
  `user_turn` span. `eou_detection` is the end-of-turn decision, not the
  transcription.
- **Model calls nest several layers deep.** `llm_node` → `llm_fallback_adapter` →
  `llm_request_run` → `llm_request`, and similarly for TTS. Only the innermost
  `llm_request` / `tts_request` spans name the real model; the outer ones report
  the adapter.
- **Three spans carry `STATUS_CODE_ERROR`** — `llm_request_run` twice and
  `llm_request` once — with five `exception` events between them. The first
  model attempt of the capture raised an `APITimeoutError`; the fallback
  adapter, configured with a single LLM, then gave up with
  `APIConnectionError: all LLMs failed (['livekit.plugins.openai.llm.LLM'])
  after 6.49s`, and the turn succeeded on retry. Ordinary cold-start behaviour,
  and a genuine error shape worth testing against — keep it.
- **Two tool calls happened**, both of the example's `lookup_weather` tool.
- **The room was named `egma-fixture-capture-1`**, chosen for this capture, and
  that name appears as the `session.id` attribute on all 133 spans — the
  obvious key for a test to pick this trace out.
- Span and trace ids, timestamps and the room name are all from the real
  capture. The exchange is scripted small talk about the weather and contains
  nothing sensitive.

The exchange, in order — note the transcript shows seven agent utterances
against eight `agent_turn` spans: the extra span is the turn whose first model
attempt failed and was retried.

```
agent  Hello! How can I assist you today?
human  Hi Kelly, my name is Sam.
agent  Hi Sam! It's nice to meet you. How can I help you today?
human  Can you tell me what the weather is like in Lisbon today?
agent  (calls lookup_weather)
agent  The weather in Lisbon today is sunny with a temperature of 70 degrees.
       Do you need any more information?
human  Thanks, and how about Oslo? Is it colder there right now?
agent  (calls lookup_weather)
agent  Oslo is also sunny, but it has the same temperature of 70 degrees.
       Would you like to know anything else?
human  Great, that is all I needed.
human  Have a good day, and goodbye.
agent  Thank you, Sam! Have a great day, and goodbye!
```

## Which agent produced it

LiveKit's own OpenTelemetry example, unmodified apart from which model providers
it is pointed at:

| | |
| --- | --- |
| Example | `examples/voice_agents/otel_trace.py` |
| From | [`livekit/agents`](https://github.com/livekit/agents), tag `livekit-agents@1.6.7`, commit `48c1793` |
| Framework | `livekit-agents` 1.6.7, `livekit-plugins-openai` 1.6.7, Python 3.11 |
| Server | `livekit-server` 1.9.12, run locally with `--dev` |
| Exporter | `opentelemetry-sdk` and `opentelemetry-exporter-otlp-proto-http` 1.39.1 |

The example ships pointed at several hosted model providers. The only change was
to route all three model steps through OpenAI so that one API key is enough:

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

`use_realtime=True` is not a preference: the example wraps its speech-to-text in
a fallback adapter, which only accepts a streaming recogniser. Everything else —
the agent's instructions, its `lookup_weather` tool, its turn handling, its
telemetry setup — is the example as published. Voice activity detection and
end-of-turn detection are the framework's own defaults and run locally.

## Making a new capture

You need a LiveKit server, an OpenAI API key and a way to talk to the agent.

1. **Run a LiveKit server.** `curl -sSL https://get.livekit.io | bash`, then
   `livekit-server --dev`. Development mode listens on `ws://127.0.0.1:7880` and
   accepts the well-known key pair `devkey` / `secret`.

2. **Install the agent.** Check out `livekit/agents` at the tag you want, copy
   `examples/voice_agents/otel_trace.py` to a working directory as `agent.py`,
   and apply the provider change above.

   ```bash
   pip install "livekit-agents[openai,silero,turn-detector]==1.6.7" \
               python-dotenv opentelemetry-exporter-otlp-proto-http
   ```

3. **Start the sink.** `python capture-server.py ./capture-out` listens on
   `http://127.0.0.1:4318`, the OTLP/HTTP default. It writes each request body to
   a numbered `.bin` file and appends its headers to `manifest.json`. Before the
   headers reach disk it keeps only the handful an exporter always sends and
   redacts every other header, so a capture taken against a real backend does
   not smuggle a credential into the repository.

4. **Point the agent at it and run it.**

   ```bash
   export LIVEKIT_URL=ws://127.0.0.1:7880
   export LIVEKIT_API_KEY=devkey
   export LIVEKIT_API_SECRET=secret
   export OPENAI_API_KEY=...
   export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
   export OTEL_SERVICE_NAME=livekit-voice-agent
   python agent.py start
   ```

   The example calls `set_tracer_provider` itself, so the standard
   `OTEL_EXPORTER_OTLP_*` variables are all the configuration the exporter needs.
   Run it with `start` rather than `dev` unless you have LiveKit Cloud
   credentials — development mode resolves end-of-turn detection to the hosted
   model.

5. **Hold the exchange.** Join the room and talk: LiveKit's agents playground
   or the CLI's `console` mode both work if you have a microphone. Without one,
   have a scripted participant join with the `livekit` SDK, publish
   text-to-speech audio of a few utterances, and pause between them long enough
   for the agent to take its turn. Either way, aim for several turns and let the
   agent finish speaking before the next one.

6. **Let the exporter flush.** The batch processor exports every five seconds and
   the example flushes on shutdown, so disconnect and let the agent's job end
   before you stop the sink. Then copy `capture-out/` over this directory.

Afterwards, check the capture before committing it: the bodies contain the
transcript and the agent's system prompt, so make sure nothing you would not
publish was said, and confirm no header or attribute carries a key.

## Refreshing this capture

**Only ever on purpose.** Nothing regenerates these files automatically, and
nothing should. The point of a checked-in capture is that the shape of LiveKit's
telemetry stays fixed until somebody decides to move it — so when the span tree
changes upstream, that change arrives as a reviewable diff somebody chose to
make, not as a test that started failing overnight.

Recapture when there is a reason to: a LiveKit release that changes span names,
attributes or nesting; a new capability worth testing against, such as a
different turn shape; or a gap this capture cannot exercise. Replace the whole
directory rather than editing a body, and update the versions above in the same
commit. A capture that has been edited by hand is no longer evidence of anything.
