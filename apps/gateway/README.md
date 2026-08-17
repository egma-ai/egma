# The Egma model gateway

A thin, provider-native relay. It carries model traffic between egma and a
model provider so that an organization using **managed model access** does not
have to hold that provider's credentials.

It is deliberately small. It does not choose a model, translate a protocol,
issue credentials, fall back to another provider, retry after output has
started, cache an answer, balance anything, or keep a payload. It validates the
connection, replaces the authorization, opens the provider's own address, and
streams what crosses.

---

## What it carries

Three routes. Each is a literal path, one method, one transport and one upstream
path — and none of the four is built out of anything a caller sends.

| Route | Method | Transport | Provider | Model job | Reaches |
| --- | --- | --- | --- | --- | --- |
| `/deepgram/v1/listen` | `GET` | WebSocket | Deepgram | `stt` | `wss://api.deepgram.com/v1/listen` |
| `/openai/v1/chat/completions` | `POST` | streaming HTTP | OpenAI | `llm` | `https://api.openai.com/v1/chat/completions` |
| `/cartesia/tts/websocket` | `GET` | WebSocket | Cartesia | `tts` | `wss://api.cartesia.ai/tts/websocket` |

`GET /health` answers `{"status":"ok"}` without a credential and without
reaching a provider, and names the build that answered where the host knows one.
Everything else is refused.

**The public path is the provider's own path under the provider's own name**,
which is what lets a shipped provider adapter reach the gateway by being told a
different base address and nothing else:

| Adapter | Tell it | It builds |
| --- | --- | --- |
| Deepgram STT | base `https://GATEWAY/deepgram` | `wss://GATEWAY/deepgram/v1/listen` |
| OpenAI chat | base `https://GATEWAY/openai/v1` | `https://GATEWAY/openai/v1/chat/completions` |
| Cartesia TTS | url `wss://GATEWAY/cartesia/tts/websocket` | that address |

## How a connection authenticates

The gateway takes one credential per connection and asks one question of it:
does this authorize a connection, and which organization is it. That question is
answered by a **verifier**, which is a replaceable interface
(`src/verify.ts`) — the shipped implementation compares one
organization-scoped secret held in deployment configuration.

The credential may arrive in either of two places:

- `Egma-Inference-Key: <credential>` as a request header, or
  `?egma_inference_key=<credential>` in the query — the gateway's own slot; or
- the provider's own authorization slot, which is `Authorization` for Deepgram
  and OpenAI and the `api_key` query parameter for Cartesia. This is the
  compatibility carrier, so an adapter that offers no header hook can be handed
  the Egma credential where it expects a provider key.

Either way **the caller's value stops at the gateway**, and so does anything
else that reads like a credential.

The rule is a shape rather than a list, applied to every header name and every
query parameter name on every route: a name whose parts include `api-key`,
`apikey`, `key`, `token`, `auth`, `authorization`, `authentication`, `secret`,
`credential`, `password`, `bearer`, `signature`, `sig` or `session` is **not
forwarded**. `Cookie` goes with them. A word has to stand as a whole part of the
name, separated by `-` or `_` or at an end, so Deepgram's `keyterm` and
`keywords` — which carry a customer's own words — are untouched while `key` and
`api_key` are not.

A list of the three providers' own names would have been the wrong shape, and
was: it is exactly the set a well-behaved caller uses, and therefore exactly the
set an ill-behaved one avoids.

**A requested WebSocket subprotocol is refused, not stripped.**
`Sec-WebSocket-Protocol: token, <key>` is Deepgram's own documented carrier for
a client that cannot set a header, so a forwarded subprotocol list is a
forwarded credential. No shipped route negotiates a subprotocol, so there is
nothing a caller can legitimately be asking for; an upgrade that asks anyway is
refused with `subprotocol_not_negotiated` rather than quietly having its
credential dropped. What the provider is offered comes from the route table.

Egma's own provider credential is then put in the provider's native slot.

**The organization comes from the verifier and from nowhere else.** `egma-` is
the gateway's own header namespace and `egma_` its own query namespace; the
authentication name is the only one accepted in either, and anything else in
them is refused rather than ignored. A request body is never read, so a field in
one cannot name anything.

Authentication happens once, when the connection opens — not per audio frame.
A withdrawn credential therefore takes effect on the next connection.

## What crosses unchanged

Everything else. The method, the path mapping, the query, the content type, the
provider-native headers, the request body, the response status, the response
headers, the body chunks, the frame order and the close codes.

Two things do not come back: hop-by-hop headers, which describe one connection
and are meaningless on the next, and `Set-Cookie`.

Streaming is real in both directions. A request body reaches the provider while
the caller is still writing it, and a response reaches the caller while the
provider is still producing it.

## The bounds

| Bound | Default | What it catches |
| --- | --- | --- |
| First output | 30 s | A provider that accepted the work and then went quiet, including a WebSocket handshake it never completes |
| Whole exchange | 10 min | An exchange that says a little, forever |
| Socket idle | 2 min | An abandoned voice socket, where silence in both directions is not a quiet moment |
| Frame size | 1 MiB | One enormous frame, the only thing that has to exist in memory in one piece |
| Buffered per direction, soft | 4 MiB | One peer outrunning the other — a listening leg sending audio continuously into a provider that has slowed down |
| Buffered per direction, hard | 8 MiB (2× the soft bound) | The same, on a host that cannot be asked to stop reading |
| Drain window | 10 s | A peer that crossed the soft bound and never starts keeping up |

**How the buffer bound behaves.** Crossing the soft bound is not a failure: a
provider that hesitated deserves to be waited for. The gateway stops reading the
fast side — real backpressure, so that peer's own socket fills and it discovers
it cannot write — and the exchange carries on as soon as the slow side drains.
**No frame is ever dropped.** A peer still behind when the drain window runs out
ends the exchange, with close code `1013` and a `refused` record.

**The hard bound is what makes that absolute, and it is checked before every
single send.** Stopping the read needs read flow control from the host: the
local host has it, and the Cloudflare runtime delivers frames as events and
offers none. Where it is absent the pause is a no-op and frames keep arriving,
so waiting out the drain window would mean growing the buffer for ten seconds at
whatever rate the sender manages. The hard ceiling ends the exchange at once
instead, however much of the window was left — so **the most any direction can
ever hold is the hard bound plus the one frame that carried it over**, on either
host.

What a host without read flow control loses is the grace, not the guarantee: a
stalled peer there is hung up on after one bound's worth of headroom rather than
waited out. Both hosts report how much is buffered, which is what both bounds
are measured against.

On the HTTP transport the standard streams supply back-pressure of their own, so
a slow caller slows the provider rather than filling the gateway with the
difference, and there is no buffer size to configure.

## What it writes down

One JSON line per exchange, holding only these fields:

`requestId`, `organizationId`, `inferenceKeyId`, `provider`, `job`,
`providerModelId`, `startedAt`, `endedAt`, `statusClass`, `upstreamRequestId`,
`bytesToProvider`, `bytesFromProvider`, `openMs`, `firstOutputMs`, `totalMs`.

No authorization value, no request or response body, no audio, no transcript, no
prompt, no tool definition, no text to be spoken, no voice identifier, and no
upstream address. `providerModelId` is present only where the provider names its
model in the address rather than in a payload, because payloads are not read.

These records support operations. **They count no provider usage unit and no
other customer-billable quantity, and they are not a usage, credit, invoice or
balance ledger.**

## Configuration

Everything arrives as a flat map of names to values: Worker secrets and
variables on Cloudflare, the process environment locally. Nothing has a default
except where a default is written below.

### Required

| Name | Secret | What it is |
| --- | --- | --- |
| `EGMA_GATEWAY_ORGANIZATION_SECRET` | **yes** | The organization-scoped credential the shipped verifier accepts |
| `EGMA_GATEWAY_ORGANIZATION_ID` | no | The organization that credential stands for |
| `EGMA_GATEWAY_INFERENCE_KEY_ID` | no | The identifier recorded against connections it opens |
| `EGMA_GATEWAY_DEEPGRAM_KEY` | **yes** | Egma's Deepgram credential |
| `EGMA_GATEWAY_OPENAI_KEY` | **yes** | Egma's OpenAI credential |
| `EGMA_GATEWAY_CARTESIA_KEY` | **yes** | Egma's Cartesia credential |

### Optional

| Name | Default | What it is |
| --- | --- | --- |
| `EGMA_GATEWAY_DEEPGRAM_HOME` | `https://api.deepgram.com` | Where that provider is reached |
| `EGMA_GATEWAY_OPENAI_HOME` | `https://api.openai.com` | Where that provider is reached |
| `EGMA_GATEWAY_CARTESIA_HOME` | `https://api.cartesia.ai` | Where that provider is reached |
| `EGMA_GATEWAY_EXCHANGE_TIMEOUT_MS` | `600000` | The whole-exchange bound |
| `EGMA_GATEWAY_FIRST_OUTPUT_TIMEOUT_MS` | `30000` | The first-output bound |
| `EGMA_GATEWAY_SOCKET_IDLE_TIMEOUT_MS` | `120000` | The socket idle bound |
| `EGMA_GATEWAY_MAX_FRAME_BYTES` | `1048576` | The largest single frame |
| `EGMA_GATEWAY_MAX_BUFFERED_BYTES` | `4194304` | How much one direction may be holding before the gateway stops reading the fast side. Twice this is the hard ceiling, at which the exchange ends at once |
| `EGMA_GATEWAY_BUFFER_DRAIN_MS` | `10000` | How long that peer has to start keeping up before the exchange ends |
| `EGMA_GATEWAY_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN` or `ERROR` |
| `EGMA_GATEWAY_PORT` | an unused port | Local host only |
| `EGMA_GATEWAY_VERSION` | absent | Not written by a deployment: the runtime's read-only name for the build that is answering, bound on Cloudflare and reported by the health check |

The three `_HOME` names are **deployment configuration and never a caller's**.
They exist so the deterministic suite can point a route at a strict local server
standing in for a provider. A deployment reaching the real providers sets none
of them.

A missing required name stops the gateway at startup, in a sentence naming it.

## Running it

### On Cloudflare, which is where Egma runs it

`wrangler.jsonc` beside this file is the application's own shape: the entry
point, the runtime date, and `observability.enabled: false` together with
`logpush: false`, which is where **payload logging is off** is true.

There is one binding and it stores nothing: `version_metadata`, the runtime's
own name for the build that is answering, which the health check reports so that
a gradual rollout is observable from outside and a rollback is checkable rather
than claimed. There is no KV, no D1, no R2, no Durable Object, no queue and no
cache, because each of those would be a place a payload could come to rest.

Because the deployed host is one Worker script, a rollout is Cloudflare's own
versions and gradual deployments: upload a version, put a small share of traffic
on it, watch the health check say which build answered, and roll back by
deploying the previous version at 100%.

```sh
# from the repository root
pnpm --filter @egma/gateway build          # typecheck; wrangler bundles the entry itself
npx wrangler deploy --config apps/gateway/wrangler.jsonc --name <your-worker-name>
npx wrangler secret put EGMA_GATEWAY_OPENAI_KEY --name <your-worker-name>
```

Which account, which name, which addresses and every secret value belong to
whoever operates a deployment, and none of them is in this repository.

### Locally

The local host is the same application with a Node adapter in front of it, for
reading a log line, pointing a simulator at it, and running the deterministic
suite against strict local provider servers. It is **not** a supported
production deployment.

```sh
pnpm --filter @egma/gateway build
EGMA_GATEWAY_ORGANIZATION_SECRET=… \
EGMA_GATEWAY_ORGANIZATION_ID=org_… \
EGMA_GATEWAY_INFERENCE_KEY_ID=… \
EGMA_GATEWAY_DEEPGRAM_KEY=… EGMA_GATEWAY_OPENAI_KEY=… EGMA_GATEWAY_CARTESIA_KEY=… \
EGMA_GATEWAY_PORT=8787 \
pnpm --filter @egma/gateway start
```

## How it is put together

| File | What it holds |
| --- | --- |
| `src/routes.ts` | The fixed table, and nothing built from a request |
| `src/verify.ts` | The one replaceable thing: does this credential authorize a connection, and which organization is it |
| `src/wire.ts` | What crosses, what is taken out, what is put in |
| `src/relay-http.ts` | The streaming HTTP relay |
| `src/relay-socket.ts` | The WebSocket relay |
| `src/record.ts` | The allowed fields, and the log |
| `src/gateway.ts` | The order those happen in |
| `src/worker.ts` | The deployed host: Cloudflare |
| `src/host/node.ts` | The local host |

Everything above the two hosts is written against the web platform, so the two
hosts are twenty adapter lines each rather than two implementations of anything
that matters.
