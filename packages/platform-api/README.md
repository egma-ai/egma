# Platform API

This package is the source of truth for Egma's customer-facing `/v1` HTTP
interface.

It owns three parts of the same contract:

- `src/contract/` defines each method, path, request, response, refusal, and
  authentication rule.
- `openapi/platform-api.openapi.json` is generated from those definitions.
- `src/generated/` is the TypeScript client generated from that OpenAPI file.

The API server imports `@egma/platform-api/contract`. The web app and CLI
import `@egma/platform-api/client`. They must not copy paths or wire types.

After a contract change, run:

```bash
pnpm --filter @egma/platform-api generate
```

Commit the contract change, OpenAPI file, and generated client together. The
root build runs `generate:check` and fails if either generated artifact is
stale. Generation uses the exact pinned `@hey-api/openapi-ts` version from this
package.

Account flows, deployment settings, simulator worker traffic, OTLP ingestion,
and health checks are different protocols. They do not belong in this package.
