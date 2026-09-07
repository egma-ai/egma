import {
  branchAgentVersion,
  canonicalJson,
  isIntercepted,
  deleteAgentVersion,
  EGMA_URL_VARIABLE_DEFAULT,
  LATEST_PUBLISHED,
  listAgentVersions,
  mockedToolsFor,
  mockToolUrl,
  mockToolVariable,
  readEngineConfiguration,
  resolveAgentVersion,
  resolveServingAgentVersion,
  RETELL_API,
  toolsOf,
  writeEngineTools,
  type AgentVersionSummary,
  type EngineReference,
  type MockToolVariable,
  type RetellCredential,
} from "@egma/retell";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Developer-run live test; agents use fakes. Requires EGMA_LIVE_RETELL_API_KEY
 * and EGMA_LIVE_RETELL_AGENT_ID for an agent with a published version. Run with:
 *   npx vitest run --project fast apps/api/test/live-version-lifecycle.test.ts
 *
 * Branches a draft, writes its routed tools and single-space defaults, creates
 * two web calls without joining them, and deletes the draft in afterAll. It
 * publishes no version and changes no number bindings. A process crash or failed
 * cleanup can leave a draft. It does not run a simulation or verify audio.
 *
 * Compare agent version numbers, published flags, resolved latest versions, and
 * serving configuration. A conversation-flow version remains after agent-version
 * deletion; the test checks this residue, so the account is not unchanged.
 * Retain the printed version lists and branch flow version as live-test evidence.
 */

/**
 * Require both the live key and explicit target agent ID. Never supply a
 * production target as a fallback; report missing settings as skipped tests.
 */
const NEEDED = [
  "EGMA_LIVE_RETELL_API_KEY",
  "EGMA_LIVE_RETELL_AGENT_ID",
] as const;

const named = (variable: (typeof NEEDED)[number]): string =>
  (process.env[variable] ?? "").trim();

const missing = NEEDED.filter((variable) => named(variable) === "");
const live = missing.length === 0 ? describe : describe.skip;

const agentId = named("EGMA_LIVE_RETELL_AGENT_ID");
const key: RetellCredential = {
  reveal: () => named("EGMA_LIVE_RETELL_API_KEY"),
};

/**
 * Where one mocked call would be routed for the length of this proof.
 *
 * **Nothing on the version points here.** The draft carries only
 * `{{egma_url_<tool>}}` in front of each tool's own URL; this is the value the
 * claim would fill that variable with, and it is used below only to prove that
 * Retell accepts such a value on `create-web-call`. No conversation is
 * conducted, so nothing is ever posted to it.
 */
const TARGET = {
  base: "https://live-version-lifecycle.egma.invalid/mock-tools",
  simulationId: `sim_live_version_lifecycle_${Date.now()}`,
};

/** The one draft this proof made, so the teardown unmakes exactly that. */
const made: { draftVersion: number | null } = { draftVersion: null };

/**
 * Compare sorted version numbers and published flags. Ignore provider-managed
 * timestamps and titles, which may change independently of this lifecycle.
 */
function print(versions: readonly AgentVersionSummary[]): string {
  return canonicalJson([...versions].sort((a, b) => a.version - b.version));
}

/**
 * The version this flow answers for when no version is named — its latest.
 *
 * The only count Retell offers on the flow side: there is no
 * list-conversation-flow-versions in the whole reference, so "did the flow grow
 * by exactly one" is asked as "is its latest exactly the one version this run
 * branched".
 */
async function flowLatest(reference: EngineReference): Promise<number | null> {
  const read = await readEngineConfiguration(key, {
    ...reference,
    version: null,
  });
  if (read.kind !== "engine") return null;
  const named = read.engine.document["version"];
  return typeof named === "number" ? named : null;
}

/**
 * Every routing variable, explicitly empty.
 *
 * The shape a run really sends for a test that mocks nothing: Retell tells a
 * variable it was never given — placeholder left literal, braces and all —
 * from one passed as `""`, which renders to nothing.
 */
function emptyValues(
  variables: readonly MockToolVariable[],
): Record<string, string> {
  return Object.fromEntries(variables.map(({ variable }) => [variable, ""]));
}

/**
 * One web call against a named version, with the variables a run would send.
 *
 * Written here rather than in the shared client because Egma's own web-call
 * lane lives in the simulator, and this proof needs only the one request:
 * Retell validates each tool's rendered URL as it creates the call, so the
 * status code is the answer.
 */
async function webCall(
  agentVersion: number,
  variables: Record<string, string>,
): Promise<{ status: number; document: Record<string, unknown> }> {
  const response = await fetch(`${RETELL_API}/v2/create-web-call`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${named("EGMA_LIVE_RETELL_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      agent_id: agentId,
      agent_version: agentVersion,
      retell_llm_dynamic_variables: variables,
    }),
  });
  const text = await response.text();
  let document: Record<string, unknown> = {};
  try {
    const held: unknown = JSON.parse(text);
    if (typeof held === "object" && held !== null) {
      document = held as Record<string, unknown>;
    }
  } catch {
    document = { raw: text };
  }
  return { status: response.status, document };
}

afterAll(async () => {
  if (missing.length > 0 || made.draftVersion === null) return;
  // Runs on every failure path, so a check that threw halfway through still
  // gives the account back.
  await deleteAgentVersion(key, agentId, made.draftVersion).catch(
    () => undefined,
  );
});

live("the corrected version lifecycle, on the live agent", () => {
  it("branches one draft, mocks it in place, deletes it, and leaves the panel as found", async () => {
    // ── 1. Capture the version list as found. ──
    const before = await listAgentVersions(key, agentId);
    expect(before.kind, JSON.stringify(before)).toBe("versions");
    if (before.kind !== "versions") return;
    const found = print(before.versions);
    console.log(`[live lifecycle] agent ${agentId} versions as found: ${found}`);

    // What both version references resolve to before anything is made. The
    // research file's own criterion for "the panel is as it was found" is that
    // these two answer the same numbers afterwards — a stray draft would move
    // `latest` without moving the list's published flags, so the list alone
    // does not catch it.
    const latestBefore = await resolveAgentVersion(key, agentId, "latest");
    expect(latestBefore.kind, JSON.stringify(latestBefore)).toBe("version");
    if (latestBefore.kind !== "version") return;

    // ── 2. Resolve the published pointer, and pin the number. ──
    const serving = await resolveServingAgentVersion(
      key,
      agentId,
      LATEST_PUBLISHED,
    );
    expect(
      serving.kind,
      "this agent must have a published version for this proof; publish one, " +
        "or point EGMA_LIVE_RETELL_AGENT_ID at an agent that has",
    ).toBe("version");
    if (serving.kind !== "version") return;
    const servingVersion = serving.agentVersion.version;
    const servingEngine = serving.agentVersion.engine;
    // The published pointer never resolves a draft. That is the whole reason it
    // is what a run asks for.
    expect(serving.agentVersion.published).toBe(true);
    expect(before.versions).toContainEqual({
      version: servingVersion,
      published: true,
    });
    console.log(
      `[live lifecycle] latest_published = ${servingVersion}, engine ` +
        `${servingEngine.type} ${servingEngine.engineId} ` +
        `v${String(servingEngine.version)}`,
    );

    // The serving version's tools, captured so the proof can say the version
    // real callers reach never moved.
    const captured = await readEngineConfiguration(key, servingEngine);
    expect(captured.kind, JSON.stringify(captured)).toBe("engine");
    if (captured.kind !== "engine") return;

    // **The flow's own newest version, before anything is branched.** There is
    // no list-conversation-flow-versions anywhere in Retell's API, so the only
    // way to count what a run adds on the flow side is what the flow answers
    // for with no version named — which is its latest. A branch mints one flow
    // version, and after the run that number is the one thing left behind.
    const flowLatestBefore = await flowLatest(servingEngine);
    expect(
      flowLatestBefore,
      "Retell answered no version for this flow's latest",
    ).not.toBeNull();
    const servingToolsBefore = canonicalJson(captured.engine.document);

    // ── 3. Branch one draft, and confirm the list grew by exactly it. ──
    const branched = await branchAgentVersion(key, agentId, servingVersion);
    expect(branched.kind, JSON.stringify(branched)).toBe("branched");
    if (branched.kind !== "branched") return;
    const draft = branched.agentVersion;
    made.draftVersion = draft.version;
    expect(draft.published).toBe(false);

    const afterBranch = await listAgentVersions(key, agentId);
    expect(afterBranch.kind).toBe("versions");
    if (afterBranch.kind !== "versions") return;
    expect(print(afterBranch.versions)).toBe(
      print([...before.versions, { version: draft.version, published: false }]),
    );

    // The branch's own engine version, read from the branch's own response. The
    // agent-to-flow lockstep is observed and undocumented, so it is never
    // derived arithmetically, and it must differ from the serving version's —
    // writing onto a shared engine version would be writing onto production.
    const draftEngine = draft.engine;
    expect(draftEngine.version).not.toBeNull();
    expect(
      draftEngine.engineId !== servingEngine.engineId ||
        draftEngine.version !== servingEngine.version,
      "Retell branched a version that still points at the serving engine " +
        "version; nothing may be written onto it",
    ).toBe(true);
    console.log(
      `[live lifecycle] branched version ${draft.version}, engine ` +
        `${draftEngine.type} ${draftEngine.engineId} ` +
        `v${String(draftEngine.version)}`,
    );

    // **The one word this ticket turned on, read off a real account while the
    // draft stands.** `latest` means the newest version *created*, so it now
    // reaches this proof's own draft — strictly above the published version it
    // was branched from — while `latest_published` cannot reach it at all.
    // Equal would mean the published pointer had found a draft, which is the
    // accident that pointer exists to make impossible.
    const whileStanding = await resolveAgentVersion(key, agentId, "latest");
    expect(whileStanding.kind).toBe("version");
    if (whileStanding.kind !== "version") return;
    expect(whileStanding.agentVersion.version).toBe(draft.version);
    expect(whileStanding.agentVersion.version).toBeGreaterThan(servingVersion);
    expect(whileStanding.agentVersion.published).toBe(false);

    const publishedStanding = await resolveServingAgentVersion(
      key,
      agentId,
      LATEST_PUBLISHED,
    );
    expect(publishedStanding.kind).toBe("version");
    expect(
      publishedStanding.kind === "version"
        ? publishedStanding.agentVersion.version
        : null,
      "latest_published reached a draft",
    ).toBe(servingVersion);

    // ── 4. Write the mock tools onto the branch's flow, naming its version. ──
    const draftConfiguration = await readEngineConfiguration(key, draftEngine);
    expect(draftConfiguration.kind, JSON.stringify(draftConfiguration)).toBe(
      "engine",
    );
    if (draftConfiguration.kind !== "engine") return;
    const draftTransform = mockedToolsFor(draftConfiguration.engine);
    expect(
      draftTransform.kind,
      draftTransform.kind === "refused" ? draftTransform.reason : "",
    ).toBe("mocked");
    if (draftTransform.kind !== "mocked") return;
    const mocked = draftTransform;
    const engineVersion = draftEngine.version;
    if (engineVersion === null) return;

    const written = await writeEngineTools(key, {
      reference: draftEngine,
      // The branch's own version, never Retell's default. That default is
      // "latest", which is the exact accident this ticket retires.
      version: engineVersion,
      tools: mocked.tools,
      // In the same PATCH as the tools: a version whose tools name a routing
      // variable it has no default for is a call with nowhere to go.
      defaults: mocked.defaults,
    });
    // **Retell says which version it wrote, and it is the one asked for.** The
    // reference documents neither in-place editing nor minting, and a PATCH
    // that forked the flow would leave an engine version no endpoint can
    // delete — there is no delete-conversation-flow-version. The product
    // compares the same two numbers and fails the run on a mismatch; this is
    // the live half of that check.
    expect(written, JSON.stringify(written)).toEqual({
      kind: "written",
      version: engineVersion,
    });

    // The write edited in place: no second version was minted by it.
    const afterWrite = await listAgentVersions(key, agentId);
    expect(afterWrite.kind).toBe("versions");
    if (afterWrite.kind !== "versions") return;
    expect(
      print(afterWrite.versions),
      "the tool write minted a version instead of editing the branch in place",
    ).toBe(print(afterBranch.versions));

    // ── 4b. **The read-back guard, against Retell's own answer.** ──
    //
    // Every custom tool carries its own routing variable in front of the URL
    // the customer wrote, byte for byte, with their headers and query params
    // untouched — and every one of those variables is declared with a default
    // of exactly one space. Retell stores an *empty* default as absent, and an
    // absent variable leaves the braces literal, which is not a URL: this read
    // is what proves Retell kept the space.
    const mockedDraft = await readEngineConfiguration(key, draftEngine);
    expect(mockedDraft.kind).toBe("engine");
    if (mockedDraft.kind !== "engine") return;

    const capturedTools = new Map(
      toolsOf(draftConfiguration.engine).map((tool) => [
        tool.name,
        tool.verbatim,
      ]),
    );
    for (const tool of toolsOf(mockedDraft.engine)) {
      if (!isIntercepted(tool)) continue;
      const captured = capturedTools.get(tool.name);
      expect(String(tool.verbatim["url"]), `${tool.name}'s URL`).toBe(
        `{{${mockToolVariable(tool.name)}}}${String(captured?.["url"] ?? "")}`,
      );
      expect(
        canonicalJson(tool.verbatim["headers"]),
        `${tool.name}'s headers were changed`,
      ).toBe(canonicalJson(captured?.["headers"]));
      expect(
        canonicalJson(tool.verbatim["query_params"]),
        `${tool.name}'s query params were changed`,
      ).toBe(canonicalJson(captured?.["query_params"]));
    }

    const storedDefaults = (mockedDraft.engine.document[
      "default_dynamic_variables"
    ] ?? {}) as Record<string, unknown>;
    for (const { variable } of mocked.variables) {
      expect(
        storedDefaults[variable],
        `Retell did not keep ${variable}'s default as a single space`,
      ).toBe(EGMA_URL_VARIABLE_DEFAULT);
    }
    console.log(
      `[live lifecycle] routed ${String(mocked.variables.length)} tools on ` +
        `version ${draft.version} in place, each defaulted to one space`,
    );

    // Create calls with empty routing prefixes and with one mock address to
    // test provider URL validation. Nothing joins these calls, so this does not
    // prove media playback or actual tool delivery.
    if (mocked.variables.length > 0) {
      const everythingReal = await webCall(draft.version, emptyValues(mocked.variables));
      expect(
        everythingReal.status,
        `Retell refused a call whose routing variables were all "": ` +
          JSON.stringify(everythingReal.document),
      ).toBeLessThan(300);

      const one = mocked.variables[0];
      if (one !== undefined) {
        const mockedCall = await webCall(draft.version, {
          ...emptyValues(mocked.variables),
          [one.variable]: mockToolUrl(TARGET, one.tool),
        });
        expect(
          mockedCall.status,
          "Retell refused a call routing one tool at Egma: " +
            JSON.stringify(mockedCall.document),
        ).toBeLessThan(300);
        console.log(
          `[live lifecycle] create-web-call accepted version ${draft.version} ` +
            `with every routing variable "" (call ` +
            `${String(everythingReal.document["call_id"])}) and with ` +
            `${one.variable} = the mock address (call ` +
            `${String(mockedCall.document["call_id"])}). Retell validates a ` +
            "rendered tool URL at call creation, so both rendered.",
        );
      }
    }

    // The version real callers reach, mid-proof: the same configuration this
    // proof captured, compared key-order-insensitively.
    const during = await readEngineConfiguration(key, servingEngine);
    expect(during.kind).toBe("engine");
    if (during.kind !== "engine") return;
    expect(
      canonicalJson(during.engine.document),
      "the version this agent serves changed while the proof ran",
    ).toBe(servingToolsBefore);

    // ── 5. Delete the draft, and prove it. ──
    const removed = await deleteAgentVersion(key, agentId, draft.version);
    // The query form. The path form is not a route on Retell's router: it
    // answers 404 "Cannot DELETE", and Egma read that as "already deleted" for
    // a week while every draft survived.
    expect(removed, JSON.stringify(removed)).toEqual({ kind: "deleted" });

    const proof = await listAgentVersions(key, agentId);
    expect(proof.kind, JSON.stringify(proof)).toBe("versions");
    if (proof.kind !== "versions") return;
    expect(
      proof.versions.map((one) => one.version),
      "the delete was answered and the version is still there",
    ).not.toContain(draft.version);

    // **Released only once the read-back agreed**, and never on the delete's own
    // answer — which is the whole lesson this proof exists to hold. Clearing it
    // above would have meant that the one outcome that matters, a delete Retell
    // accepted while the version survived, is the outcome whose draft the
    // teardown then walks away from.
    made.draftVersion = null;

    // ── 5b. What Retell keeps, said plainly. ──
    //
    // **Deleting the agent version does not delete its flow version.** Retell
    // keeps it, offers no endpoint that removes one — `delete-conversation-flow`
    // takes the whole flow, and a `?version` on it answers 400 "Unknown query
    // parameter" — and shows it in none of its own screens. Nothing can route
    // to it either: a binding names a live agent version, and this one's is
    // gone. So the orphan is the expected residue of a mocked run, and this
    // proof asserts it is there rather than pretending it is not.
    const strayFlow = await readEngineConfiguration(key, draftEngine);
    expect(
      strayFlow.kind,
      "Retell no longer holds the flow version the branch ran on; the residue " +
        "this proof expects has changed",
    ).toBe("engine");

    // **Exactly one, and no more.** The flow's latest is now the version this
    // run branched — so the run added that one flow version and nothing else.
    // A second orphan, from this run or from a write that minted one, would
    // push the latest past it and fail here.
    const flowLatestAfter = await flowLatest(draftEngine);
    expect(
      flowLatestAfter,
      "the flow grew by more than the one version this run branched",
    ).toBe(draftEngine.version);
    expect(
      flowLatestAfter === null || flowLatestBefore === null
        ? null
        : flowLatestAfter > flowLatestBefore,
      "the flow's latest did not move at all, so nothing was branched",
    ).toBe(true);

    console.log(
      `[live lifecycle] Retell keeps flow version ` +
        `${String(draftEngine.version)} behind — no API removes one. The ` +
        `flow's latest was ${String(flowLatestBefore)} before this run and is ` +
        `${String(flowLatestAfter)} now: exactly the one version it branched.`,
    );

    // ── 6. The account as it was found. ──
    //
    // Four readings, because no one of them catches everything. The version
    // list says which agent versions exist and which are published. The two
    // references say what each of them resolves to — a stray draft moves
    // `latest` without moving any published flag, so the list alone would miss
    // it. The serving engine's own configuration says the tools a real caller
    // reaches are untouched. And the flow's latest, checked above, says the
    // one thing this run leaves behind is the one version it branched.
    expect(
      print(proof.versions),
      "the version panel is not as this proof found it",
    ).toBe(found);

    const latestAfter = await resolveAgentVersion(key, agentId, "latest");
    expect(latestAfter.kind).toBe("version");
    if (latestAfter.kind !== "version") return;
    expect(
      latestAfter.agentVersion.version,
      "`latest` resolves somewhere else than it did before this proof ran",
    ).toBe(latestBefore.agentVersion.version);

    const publishedAfter = await resolveServingAgentVersion(
      key,
      agentId,
      LATEST_PUBLISHED,
    );
    expect(publishedAfter.kind).toBe("version");
    if (publishedAfter.kind !== "version") return;
    expect(
      publishedAfter.agentVersion.version,
      "`latest_published` resolves somewhere else than it did before",
    ).toBe(servingVersion);

    const after = await readEngineConfiguration(key, servingEngine);
    expect(after.kind).toBe("engine");
    if (after.kind !== "engine") return;
    expect(
      canonicalJson(after.engine.document),
      "the version this agent serves changed",
    ).toBe(servingToolsBefore);

    console.log(
      "[live lifecycle] finished. Version numbers and published flags equal " +
        `before and after (${found}); latest and latest_published resolve to ` +
        `${latestAfter.agentVersion.version} and ${servingVersion}, as they ` +
        "did at the start.",
    );
  }, 120_000);

});

describe("the live lifecycle proof's own gate", () => {
  it("holds every check until the environment names a key and an agent", () => {
    // Runs with or without the environment, so a reader of a green CI log can
    // see that the live proof exists and exactly why it did not run.
    expect(NEEDED).toContain("EGMA_LIVE_RETELL_API_KEY");
    // No agent is a default: without one named, nothing here runs at all.
    expect(NEEDED).toContain("EGMA_LIVE_RETELL_AGENT_ID");
    expect(missing.length === 0).toBe(agentId !== "");
    if (missing.length > 0) {
      console.log(
        `[live lifecycle] skipped — set ${missing.join(", ")} to run it. It ` +
          "branches one draft on the agent named, and deletes it again; it " +
          "starts no run and publishes nothing.",
      );
    }
  });
});
