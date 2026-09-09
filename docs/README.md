# Egma documentation

This is the source for [docs.egma.ai](https://docs.egma.ai). Mintlify reads the
`docs` directory in this repository.

## Edit a guide

- `guides/`: get started, integrations, testing, monitoring, and grading.
- `tools/`: one page each for Skills, CLI, LiveKit Python, and LiveKit JavaScript.
- `self-hosting/`: Get started and Configuration.
- `api/overview.mdx`: authentication, requests, pagination, and errors.

Write short instructions with a complete example. Check each command and field
against its implementation. Add the page to `docs.json`, update its links, and
keep a redirect when you move a published page.

Describe how the product works today. Check changes merged to `main` while a
docs pull request is open and update the affected instructions. Explain the
current setup and behavior without comparisons to earlier implementations or
lists of renamed or removed features.

## Update the API reference

Do not edit the generated endpoint pages or `openapi.json` by hand.

1. Change the operation, schema, description, or example in
   `packages/platform-api/src/contract/`.
2. Run `pnpm docs:generate` from the repository root.
3. Commit the contract and generated files together.

The command regenerates the platform OpenAPI file and client, copies the exact
specification into this site, and generates one MDX reference per operation.
The API navigation comes from operation IDs and resource tags. New operations
are included automatically.

The specification uses a relative server URL. A Mintlify deployment overlay
sets the hosted example URL from the CLI's `DEFAULT_PLATFORM_URL`; it changes no
endpoint definition. The generated theme and short marks also come from the
application's canonical assets. Edit Mintlify-specific CSS in
`scripts/docs/style.css`.

## Preview and check

From the repository root, with Node.js 24 and pnpm installed:

```bash
pnpm install --frozen-lockfile
pnpm docs:dev --port 8847
```

Open `http://localhost:8847/guides/overview`. The command installs a pinned
Mintlify CLI into the ignored `.cache/mintlify` directory on first use.

```bash
pnpm docs:check
pnpm docs:build
```

The first command checks contract generation, endpoint coverage, navigation,
links, redirects, and theme drift. The second runs Mintlify's strict build
validation. CI runs both.

### Local renderer repair

Mintlify CLI 4.2.876 mutates recursive OpenAPI schemas during validation, then
fails to serialize them. Our local launcher validates a clone in two pinned
`@mintlify/prebuild` call sites. It preserves the complete source specification,
including recursive trace spans. The launcher refuses an unexpected upstream
version or code shape.

This repair applies to the local CLI. Check Mintlify's hosted pull-request build
before publishing; the local repair does not change their hosted renderer.

## Publish

Open a pull request and check the hosted Mintlify preview. Merge only after the
content and build checks pass. Mintlify publishes from the default branch.
