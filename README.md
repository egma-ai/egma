# egma

The first open-source platform purpose-built to help teams shipping voice agents
gain trust in the agent they ship to production.

## Running it

You need Docker with Compose. Nothing else.

```bash
docker compose up
```

That starts three services and applies the database schema. Nobody runs a
migration step, because there isn't one — the API applies its migrations while
it boots.

| Service | URL |
| --- | --- |
| Web application | http://localhost:3101 |
| API | http://localhost:3100 |
| Postgres | `postgres://egma:egma@localhost:5433/egma` |

Open http://localhost:3101 and sign up. Your organization and your first project
are created together, and you become their admin. On a fresh instance the first
person to sign up claims it, and open signup closes behind them — everybody
after that arrives by invitation.

`GET /health` on the API and `GET /api/health` on the web application are what
the container health checks poll.

Ports, Postgres credentials and the settings below come from the environment;
see `.env.example` for the names and their defaults.

**`EGMA_AUTH_SECRET` signs session cookies and the API refuses to start without
one.** Compose supplies a development default so that `docker compose up` works
out of the box. Change it before anybody else can reach your instance.

Email is optional. With no transport configured, signup completes and
verification is not a step — every message egma would have sent is written to
the API's log instead.

## Working on it

Node 24 and pnpm 10.

```bash
pnpm install
pnpm db:up        # Postgres on 5433, which the tests need
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Tests run against a real Postgres. Each test file creates a database of its own
and drops it afterwards, so `pnpm test` needs a Postgres it may create databases
on. `pnpm db:up` starts one; point `TEST_DATABASE_URL` somewhere else if you
would rather use your own.

One test drives a real browser: `apps/web/test/login.browser.test.ts` starts the
API and the web application on ports of their own and clicks through logging in
from a terminal, once, end to end. It uses the Chrome already on your machine
and falls back to a Playwright-managed one, so `npx playwright install chromium`
is what to run if you have neither. Every branch of that flow other than the
happy one is covered against the API instead, where it costs milliseconds.

## Layout

```
apps/api        Fastify API. Applies migrations on boot, then serves.
apps/web        Next.js web application: signup, sign-in, and where you are.
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

## Reading and writing data

`packages/db` owns the Postgres connection, and it is the only way anything
reads or writes. Two rules follow from that, and both fail the build rather than
a review:

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
