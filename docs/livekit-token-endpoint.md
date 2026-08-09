# Testing a LiveKit agent without handing egma your API secret

egma tests a LiveKit agent by joining a room in your LiveKit project and holding
a conversation with whatever worker turns up. Something has to mint the token
that opens that room, and there are two answers.

The first is to give egma your project's `apiKey` and `apiSecret`. That is the
shortest path and it is the right one for a laptop and a development server.

This page is the second answer, and it is the one to ship to production: **you
keep the key pair, and egma asks a small endpoint of yours for one scoped token
per simulation.** The secret that signs tokens for your whole LiveKit project
never leaves your side. What egma holds is a token that opens one room, as one
participant, for the length of one conversation — and you decided to mint it.

The trade is real and worth stating up front: egma holds no key pair, so it
cannot dispatch your agent and cannot delete the room afterwards. Both become
your side's job, and both are a few lines. The rest of this page is those lines.

## What egma does, per simulation

1. It invents two names from the simulation's own id:
   `egma-sim-<simulation id>` for the room, and
   `egma-persona-<simulation id>` for itself.
2. It `POST`s both to your endpoint, with whatever auth headers the connection
   carries.
3. It joins the room with the token that comes back, as exactly the
   `participant_name` it asked for.
4. It waits for your agent to join and publish audio.
5. It conducts the conversation.
6. It leaves. It does not delete the room — see
   [What closes the room](#what-closes-the-room).

**Dispatching your agent happens between steps 2 and 4, and it is your
endpoint's job.** Dispatch is an API call signed with the project's key pair,
and egma does not have one on this connection — that is the whole point of the
mode. So the handler that mints the token is also the handler that puts a worker
in the room it just minted a token for. If nothing does, the simulation ends
with `agent_never_joined`, and the reason says so rather than sending you to
look at a worker registration that was never the problem.

If your workers are registered for **automatic dispatch** — no agent name when
the worker starts — there is nothing extra to write: LiveKit hands every new
room in the project to a worker registered that way, and the room comes into
existence as soon as somebody joins it. Create the room in the handler if you
would rather it existed before egma arrives; either way the dispatch follows
from the room, not from you asking for it.

**Explicit dispatch**, where your workers register under a name, is the case
that needs the extra call: create the agent dispatch for that name into
`room_name`, in the same handler, before you answer.

## The endpoint contract

One `POST`, one JSON object each way. This is the whole of it.

### The request

```http
POST /egma/livekit-token HTTP/1.1
content-type: application/json
authorization: Bearer <the header you configured on the connection>

{
  "room_name": "egma-sim-sim_01K5TB2H8Y4P7QCWF9XKMD6RZN",
  "participant_name": "egma-persona-sim_01K5TB2H8Y4P7QCWF9XKMD6RZN"
}
```

Both names are egma's to invent and yours to check. `participant_name` is the
identity egma will join as, so **the token has to be minted for exactly that
identity** — a token for any other identity is a token egma cannot use, and the
join fails.

The room name always begins `egma-sim-`. That prefix is fixed and it is there to
be allowlisted; see the recipe below.

### The response

Any 2xx status, with a JSON object holding the token:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "serverUrl": "wss://acme.livekit.cloud"
}
```

| Field | Required | What egma does with it |
| --- | --- | --- |
| `token` | one of the three | The token it joins with. |
| `participantToken` | one of the three | The same thing under another name. |
| `accessToken` | one of the three | The same thing under a third. |
| `serverUrl` | no | Where to join, instead of the connection's `url`. |

Three names are accepted because all three are already in use out there: if you
have a token endpoint serving your own web client, egma can very likely use the
one you have rather than making you write a second handler. egma takes the first
of the three that carries a non-empty string.

`serverUrl` is for the deployment whose endpoint knows which of several LiveKit
projects a given agent lives in. Leave it out and egma joins the `url` on the
connection.

**Anything else is malformed**, and egma says so with your endpoint's own words
quoted back — a non-2xx status, a body that is not JSON, a JSON body with no
token under any of the three names, a `serverUrl` in a scheme egma cannot join.
The reason names the endpoint it asked and quotes what came back, because the
fix is a line in your own handler and you need to see what came out of it.

## Registering the connection

`tokenEndpoint` goes in the config; the auth headers are a credential and go
where credentials go.

```bash
curl -sX POST http://localhost:3101/api/agents \
  -H 'authorization: Bearer egma_sk_...' \
  -H 'content-type: application/json' \
  -d '{
    "name": "Front desk",
    "connection": {
      "type": "livekit",
      "modality": "voice",
      "config": {
        "url": "wss://acme.livekit.cloud",
        "tokenEndpoint": "https://acme.example/egma/livekit-token"
      },
      "credentials": {
        "headers": "{\"Authorization\":\"Bearer a-long-random-secret\"}"
      }
    }
  }'
```

Three things about that body:

- **`headers` is a JSON object written inside a string**, so it survives the
  JSON around it. Put as many headers in it as your endpoint wants —
  `Authorization` and a tenant header, say. Every value is treated as a secret.
- **The headers are sealed and never come back.** Reading the connection shows
  you the header *names* — `"credentials_hint": "Authorization"` — and no part
  of any value. A bearer token has no public half whose tail would be safe to
  print, so egma prints none of it.
- **This shape takes no `agentName` and no `metadata`.** Both are things egma
  would need the key pair to do — dispatch a named worker, create the room that
  carries the metadata — and a connection that named them would be asking for
  something egma will not do. They are refused when you register, by name,
  rather than accepted and quietly ignored.

Sending an `apiKey` and `apiSecret` alongside a `tokenEndpoint` is refused for
the same reason: it is two whole ways of working at once, and egma would have to
ignore one of them.

## The hardening recipe

Your endpoint mints tokens into your LiveKit project. Treat it as what it is.
None of the six below is optional in practice, and the first is the one that
matters most.

### 1. Require an auth header

Put a long random secret behind an `Authorization` header, check it on every
request in constant time, and configure it on the egma connection as shown
above. Rotate it by updating the connection.

> **An unauthenticated endpoint lets anyone who learns the URL mint tokens into
> your LiveKit project.** A URL is not a secret: it ends up in logs, in proxy
> access records, in a screenshot, in a browser history, in a config file
> somebody pastes into a chat. If the endpoint is open, the only thing standing
> between a stranger and a room in your project is that they have not guessed
> the address yet.

An endpoint reachable only from inside a private network, where egma runs on
that network too, is the one case where an open endpoint is defensible. Even
there, an auth header costs you one `if` and removes the whole class of problem.

### 2. Mint for exactly the identity and room that were asked for

Read `participant_name` and `room_name` out of the request body and put those
exact strings in the token. Do not substitute your own, do not append anything,
and do not mint a wildcard.

A token minted for a different identity is one egma cannot join with, so the
simulation fails immediately — that part is self-correcting. The part that is
not self-correcting is a token minted for a *broader* room grant than the one
asked for, which is a token that opens more of your project than the request
needed.

### 3. Allowlist the `egma-sim-` prefix

Refuse any `room_name` that does not begin `egma-sim-`. This is what stops your
endpoint from being a way to mint a token into a production room. The prefix is
fixed and egma always sends it, so the check never gets in your way.

Refuse with a 4xx and a sentence saying which name was rejected; egma quotes it
back, and the record then says exactly what your endpoint said.

### 4. Give the token a short TTL

A few minutes is plenty. The token is used once, seconds after it is minted, to
open one websocket. A long-lived token is only useful to somebody who took a
copy of it.

### 5. Grant join, and nothing else

The token needs to join one room, publish audio and subscribe to audio. It does
not need to create rooms it was not asked about, list rooms, administer the
project, or update anybody's metadata.

In LiveKit's own terms, that is a video grant with `room_join`, the `room` set
to the requested name, `can_publish` and `can_subscribe` — and none of the admin
grants.

### 6. Set a short empty timeout on `egma-sim-` rooms

A minute or two. This is what closes the room after egma leaves, and the next
section is why it has to be your side that does it.

Create the room in your handler with a short empty timeout, which is the direct
way and lets you set it for `egma-sim-` rooms only. If you let the room come
into existence when egma joins it instead, the room takes your project's default
empty timeout, so check what that default is.

## What closes the room

egma leaves the room when the conversation ends. It does not delete it, on any
path — not after a normal ending, not after a limit, not after a cancellation,
not after a fault.

That is not an oversight and it is not tidiness deferred. Deleting a room is an
administrative call signed with the project's key pair, and on this connection
egma does not have one. It could try and be refused; it would gain nothing and
would write a line in your record about a failure that was never a failure. So
it does the honest thing and leaves.

**A short empty timeout on the room is what closes it**, moments after egma's
participant goes. Your side is what sets it — on the room your handler creates,
or as your project's default — because your side is the side with the key pair.
No orphaned rooms, no lingering cost, and no pretending egma has a power it
deliberately was not given.

## When it does not work

Every one of these is a sentence egma puts on the simulation, so the failure
tells you which line to go and look at.

- **"the token endpoint at … could not be reached"** — egma could not open a
  connection at all. Check that the address is reachable *from where egma runs*:
  an egma in a container and an endpoint on your laptop are not on the same
  network by default.
- **"the token endpoint at … answered 401"**, or any other non-2xx — your
  handler refused, and what it said is quoted. Usually the auth header on the
  connection and the one your handler checks have drifted apart.
- **"the token endpoint at … answered no token"** — the request worked and the
  body was JSON, but nothing in it was a token under `token`,
  `participantToken` or `accessToken`. Check the key your handler serialises it
  under.
- **"answered something that is not a JSON object"** — usually a framework error
  page or a proxy's HTML, which means the request never reached your handler, or
  reached it and threw. The first line of what came back is quoted.
- **"would not let the simulator into a room"** — the token was minted and the
  LiveKit server refused it. Check the identity in the token against the
  `participant_name` that was asked for, the room in the grant against
  `room_name`, and the token's expiry.
- **"no agent joined … the token endpoint minted a token and egma joined the
  room with it, but nothing dispatched the agent"** — the whole path worked and
  the room stayed empty. Either dispatch your worker from the same handler, or
  register your workers for automatic dispatch.

The auth headers you configure appear in none of these. They are sealed on the
connection, they go out on the one request they exist for, and they are scrubbed
out of anything egma quotes — including out of an endpoint that echoes them back
into its own error page.
