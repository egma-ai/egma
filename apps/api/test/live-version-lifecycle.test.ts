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
 * The version lifecycle, end to end, against the developer's own live agent —
 * and the proof that the account is byte-identical afterwards.
 *
 * This is the whole-seam half of the live convention: `live-fork.test.ts` in
 * `packages/retell` asks the same questions of a scratch agent it creates and
 * destroys, and this asks them of an agent that is really serving, with real
 * versions on it and a version panel a person looks at.
 *
 * **Nobody but the developer runs this.** Agents test against fakes only
 * (ruling, 2026-08-28); the live account is the developer's to touch. Every
 * check is skipped — visibly, as skipped rather than passed — unless the
 * environment names a real Retell key, and nothing here reaches a network at
 * module load. CI has no key, so CI never touches an account.
 *
 * ## The one command
 *
 * ```sh
 * # EGMA_LIVE_RETELL_API_KEY is already exported in the developer's shell.
 * EGMA_LIVE_RETELL_AGENT_ID=agent_… \
 *   npx vitest run --project fast apps/api/test/live-version-lifecycle.test.ts
 * ```
 *
 * Both are required and neither has a default. The agent must have a published
 * version — this proof branches from it — and whoever runs the proof names it,
 * so no live target is ever spelled in the repository.
 *
 * ## Where it stops, and why
 *
 * **At the version lifecycle.** It creates no agent, no connection and no run
 * in the product, and it starts no simulation. The full mocked web-call run
 * over the deployed fix is the developer's own hand step, because hearing the
 * agent through its ambient background is a different defect with a different
 * proof — see `live-remedy.test.ts` beside this, which does start a run.
 *
 * ## What it does to the account, and what it undoes
 *
 * It branches exactly one draft from the published version, writes the routed
 * tool bodies and their routing defaults onto **that draft's own engine
 * version**, creates two web calls against that draft which nobody joins (a
 * web call nobody joins carries no media and expires within thirty seconds),
 * and deletes the draft. It publishes nothing, binds no telephone number, and
 * **never writes to the version the agent serves** — the write names the branch's own engine version,
 * read from the branch's own response, so a serving version cannot be the
 * target even by accident. The delete runs in an `afterAll`, so it runs on
 * every failure path too, and a crash between the branch and the delete leaves
 * one unpublished draft the developer can remove from the version panel.
 *
 * **One thing is left behind, and it cannot be helped.** Deleting the agent
 * version does not delete the conversation-flow version it ran on, and Retell
 * has no endpoint that removes one — the flow can only be deleted whole. That
 * orphan is invisible in every Retell screen and unroutable, because a binding
 * can only name a live agent version; it exists over the API and it becomes
 * the flow's `latest`. This proof asserts it is there, exactly once, rather
 * than pretending the account is untouched.
 *
 * ## The six steps, which are the acceptance list
 *
 * 1. Capture the agent's version list as found.
 * 2. Resolve `latest_published`, and pin the number.
 * 3. Branch one draft from it; the list grew by exactly that draft.
 * 4. Write the routed tools **and their single-space defaults** onto the
 *    branch's flow in one PATCH, naming its own version; the list did **not**
 *    grow again — the write edited in place. Read it back: each custom tool's
 *    URL is its own `{{egma_url_…}}` in front of the URL the customer wrote,
 *    their headers and query params are untouched, and every routing default
 *    is exactly one space. Then create two web calls against that version —
 *    one with every routing variable `""`, one with a mock address on a single
 *    tool — because Retell validates a rendered tool URL as it creates a call,
 *    so a call it accepts is a call whose variables rendered.
 * 5. Delete the draft with the version as a query parameter; confirm the
 *    answer, then prove it with the read-back. Then read what Retell keeps:
 *    the branch's flow version is still there, and the flow's latest is
 *    exactly that one version — so the run added one and no more.
 * 6. Compare against step 1. Four readings, because no one of them catches
 *    everything: the same agent version numbers with the same published flags;
 *    the same numbers behind `latest` and `latest_published`, which is what
 *    catches a stray draft the list's flags would not; the serving version's
 *    own configuration unchanged; and the flow grown by exactly the one
 *    version this run branched. The agent side is as it was found, the flow
 *    side holds one known orphan, and that comparison is the whole point.
 *
 * ## What to bank when it passes
 *
 * The two version lists this file prints, and the branch's own flow version.
 * The finding goes, dated, into this effort's research file —
 * `.scratch/retell-lanes-rework/research/retell-version-apis.md` — per the
 * house convention.
 */

/**
 * Both are required, and neither has a default.
 *
 * **The agent is named by whoever runs the proof, never by this file.** A real
 * account's agent identifier baked in as a fallback is a live target sitting in
 * the repository waiting for somebody who set only a key — and the account it
 * belongs to is somebody's production. It would also make this file quietly
 * wrong the day that agent is retired. The convention is the one
 * `live-remedy.test.ts` beside it already follows: list what is needed, skip
 * visibly while any of it is missing, and say which is missing.
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
 * A version list in the one spelling two readings are compared in.
 *
 * **The stable fields, not the bytes.** What is compared is the set of version
 * numbers this agent holds and which of them are published — the two things the
 * version panel shows and the two things a run of Egma could have changed. Keys
 * are sorted and the list is ordered by version, so neither Retell's
 * serialization order nor the order it happened to page in can make an
 * unchanged account look changed. Fields Egma never touches and Retell may move
 * on its own — a modification timestamp, a version title — are deliberately
 * outside it: a proof that failed because somebody renamed a version would be a
 * loud failure about nothing.
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

    // ── 4c. **The first owed check: what an explicit `""` renders to.** ──
    //
    // Retell validates a tool's *rendered* URL when the call is created — a
    // variable it was never given stays literal and the call is refused with
    // `Got invalid url` (proven by hand, 2026-09-03). So a call that Retell
    // **accepts** against this version is a call whose tool URLs all rendered,
    // and that is the whole of the question the ADR left owed: whether an
    // explicit empty string renders the prefix to nothing on a voice call.
    //
    // Both shapes are asked, because both are what a run really sends: every
    // routing variable empty, which is a test that mocks nothing, and one of
    // them carrying Egma's address, which is a test that mocks one tool.
    //
    // Nothing joins these calls. A web call nobody joins carries no media and
    // expires on its own within thirty seconds.
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
