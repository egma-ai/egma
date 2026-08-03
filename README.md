# egma

The first open-source platform purpose-built to help teams shipping voice agents
gain trust in the agent they ship to production.

## Running it

You need Docker with Compose. Nothing else.

```bash
docker compose up
```

That starts four services and applies both schemas. Nobody runs a migration
step, because there isn't one — the API applies its migrations while it boots.

| Service | URL |
| --- | --- |
| Web application | http://localhost:3101 |
| API | http://localhost:3100 |
| Postgres | `postgres://egma:egma@localhost:5433/egma` |
| ClickHouse | `http://egma:egma@localhost:8124/egma` |

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

## Working on it

Node 24 and pnpm 10.

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

One test drives a real browser: `apps/api/test/login.browser.test.ts` starts the
API and the web application on ports of their own and clicks through the two
paths a person actually walks — logging in from a terminal, and inviting a
colleague on an instance with no mail configured. It uses the Chrome already on
your machine and falls back to a Playwright-managed one, so
`npx playwright install chromium` is what to run if you have neither. Every
branch of both flows other than the happy one is covered against the API
instead, where it costs milliseconds.

## Layout

```
apps/api        Fastify API. Applies migrations on boot, then serves.
apps/web        Next.js web application: signup, sign-in, invitations, and
                where you are.
fixtures        Checked-in captures used as test inputs. The LiveKit one is
                replayed at the ingest door on every test run.
packages/db     The data-access module: schema, migrations, and every read
                and write there is.
packages/ids    The identifier generator.
packages/lint   Build-time rules that hold the boundaries in place.
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

Sign in and open **Transcripts**. You get your organization's recent
transcripts, newest first, defaulting to the last twenty-four hours — when each
one started, how long it ran, how many turns each speaker took, how many steps
and tools and failures are in it, and the first thing the human said. Pick a
different window from the control beside the heading; **Show more** walks the
pages.

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
