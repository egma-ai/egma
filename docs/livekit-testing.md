# Testing a LiveKit agent: egma makes the room, your agent joins it

A LiveKit agent is a worker waiting to be given a room. So egma makes one — in
**your** LiveKit project, not egma's — joins it as an ordinary participant, asks
for your worker, and holds a conversation with whoever turns up. Your agent does
not know it is being tested. It gets a room and a caller, which is all it ever
gets.

This is the testing path. The [other LiveKit page](livekit.md) walks telemetry —
watching an agent that is already talking to real people. Neither needs the
other, and the two are independent: you can simulate against an agent that
exports nothing.

What egma needs from you is three values you already have, and a fourth only if
your worker registers a name.

## 1. The three values are already in your agent's environment

Every LiveKit agent runs on the same three variables. Open the `.env` your
worker reads — `.env.local` if you started from `lk agent init` — and you will
find them:

```bash
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=API...
LIVEKIT_API_SECRET=...
```

That is the whole recipe. **Cloud and self-hosted are the same three values and
the same URL field** — a `wss://` project address or a `ws://127.0.0.1:7880`
development server both go in the same box, and nothing on egma's side knows the
difference.

## 2. Does your worker register a name?

Look at how your worker starts. In the Python framework it is `agent_name` on
`WorkerOptions`:

```python
agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
                                        # no agent_name → unnamed
```

- **No name** — the worker is on **automatic dispatch**: LiveKit gives it every
  new room in the project, so egma creating the room *is* the request. This is
  the quickstart default. Leave the agent name blank in egma.
- **A name** — the worker only joins rooms whose dispatch asks for it by name.
  Give egma the same string, spelled identically.

Getting this backwards is the one mistake that produces a clean, confusing
failure: the room opens, nobody comes, and egma reports `agent_never_joined`
with a sentence naming what it waited for. It is the correct answer and it is
almost always this.

## 3. Register the agent with egma

One request. `agentName` goes in only if step 2 said so:

```bash
curl -sX POST http://localhost:3101/api/agents \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer egma_sk_...' \
  -d '{
    "name": "Front desk",
    "connection": {
      "type": "livekit",
      "modality": "voice",
      "config": { "url": "wss://your-project.livekit.cloud" },
      "credentials": { "apiKey": "API...", "apiSecret": "..." }
    }
  }'
```

The key pair is sealed on arrival and never comes back out — reading the agent
again returns the last four characters of the key and no line at all for the
secret.

Two optional keys in `config`:

- **`agentName`** — from step 2.
- **`metadata`** — a JSON object *written in a string*, like
  `"{\"tenant\":\"acme\"}"`, passed to your agent as the room's metadata,
  verbatim. Whatever your own deployment needs to read: a tenant, a locale, a
  feature flag.

egma sends nothing about the test itself to your agent. The dispatch carries the
simulation's id and the modality and nothing else — an agent that could read its
script would stop being under test.

## What a simulation actually does

In order, and every step of it against your project:

1. Creates a room named `egma-sim-` and a random hex string, carrying your
   configured metadata.
2. Joins it as `egma-persona`, with a token scoped to that one room.
3. Dispatches your agent — by name, or not at all where automatic dispatch
   already applies.
4. Waits up to **30 seconds** for your worker to join *and* be heard. Both
   halves: a participant that joins and publishes no audio is a worker that
   crashed on its first frame, not an agent that answered.
5. Holds the conversation, reading turn boundaries out of the audio, because a
   room carries no end-of-turn signal.
6. **Deletes the room**, however it ended. Deleting is what ends everything the
   room held, your dispatched worker included.

On a cold worker — one that has just started and has no warmed process ready —
the gap between the dispatch and the agent's first word was about **11 seconds**
in our own runs: a second or so to start the job process, a few for the
framework's warm-up, then the model and the voice. That is well inside the
30-second wait, but it is why the wait is 30 and not 5. Start your worker before
you start the run and give it a moment to register.

## What comes back

The same record any other voice simulation produces:

- **The transcript**, turn by turn, with who spoke and when.
- **Per-turn timings** — time to first word, how long each side spoke, the
  latency around each answer — measured off the audio that really arrived.
- **A dual-channel recording**: the persona on one channel, your agent on the
  other, so either side can be heard alone when a transcript looks wrong.
- **The measured band**, which for a room is **16 kHz** — wideband, where a
  phone call is 8 kHz. It is read off the audio the recorder saw, never copied
  from a setting, so it is a measurement rather than a declaration.
- **The room name as the provider reference** — one room, one simulation, and
  the one join between egma's record and your project's own telemetry. Paste it
  into LiveKit's dashboard and you are looking at the same conversation.

## About that key pair

**An API key and secret are project-admin power in LiveKit** — they create
rooms, dispatch agents and delete rooms, which is exactly what egma does with
them and also more than some teams will hand over. If that ask is too big for
yours, a token-endpoint mode lets your own service mint the room token instead,
and has its own page.

Beyond that, the ordinary care: mint egma its own key pair rather than sharing
the one your agent runs on, so revoking it costs you nothing else. egma never
logs the secret, never puts it in an error message, and scrubs it out of
anything your LiveKit server says back before quoting it into a reason.

## Trying it without your own agent

The repository carries a deliberately boring one to point at:
[`fixtures/livekit-dumb-agent`](../fixtures/livekit-dumb-agent) is a
dental-office receptionist with no tools and one-sentence answers, running on a
single OpenAI key. Its README gets it registered against your project in one
command, and it switches between the two dispatch styles with one environment
variable — useful for proving your credentials and your room path work before
pointing egma at the agent you actually care about.
