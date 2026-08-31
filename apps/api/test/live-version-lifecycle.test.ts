import {
  branchAgentVersion,
  canonicalJson,
  deleteAgentVersion,
  LATEST_PUBLISHED,
  listAgentVersions,
  mockedToolsFor,
  mockToolUrl,
  readEngineConfiguration,
  resolveAgentVersion,
  resolveServingAgentVersion,
  writeEngineTools,
  type AgentVersionSummary,
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
 * npx vitest run --project fast apps/api/test/live-version-lifecycle.test.ts
 * ```
 *
 * `EGMA_LIVE_RETELL_AGENT_ID` names a different agent when one is wanted; it
 * defaults to the agent this ticket was proven on.
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
 * It branches exactly one draft from the published version, writes the mocked
 * tool bodies onto **that draft's own engine version**, and deletes the draft.
 * It publishes nothing, binds no telephone number, and **never writes to the
 * version the agent serves** — the write names the branch's own engine version,
 * read from the branch's own response, so a serving version cannot be the
 * target even by accident. The delete runs in an `afterAll`, so it runs on
 * every failure path too, and a crash between the branch and the delete leaves
 * one unpublished draft the developer can remove from the version panel.
 *
 * ## The six steps, which are the acceptance list
 *
 * 1. Capture the agent's version list as found.
 * 2. Resolve `latest_published`, and pin the number.
 * 3. Branch one draft from it; the list grew by exactly that draft.
 * 4. Write the mock tools onto the branch's flow, naming its own version; the
 *    list did **not** grow again — the write edited in place.
 * 5. Delete the draft with the version as a query parameter; confirm the
 *    answer, then prove it with the read-back.
 * 6. Compare the version list against step 1: byte-equal. The account is as it
 *    was found, and that comparison is the whole point.
 *
 * ## What to bank when it passes
 *
 * The two version lists this file prints, and the branch's own flow version.
 * The finding goes, dated, into this effort's research file —
 * `.scratch/retell-lanes-rework/research/retell-version-apis.md` — per the
 * house convention.
 */

const LIVE_KEY_VARIABLE = "EGMA_LIVE_RETELL_API_KEY";

/** The agent this ticket was proven on. Overridable, never guessed. */
const DEFAULT_AGENT = "agent_5b62a7f62293d1dc4ee417cf2a";

const liveKey = (process.env[LIVE_KEY_VARIABLE] ?? "").trim();
const agentId = (process.env["EGMA_LIVE_RETELL_AGENT_ID"] ?? "").trim() || DEFAULT_AGENT;
const live = liveKey === "" ? describe.skip : describe;

const key: RetellCredential = { reveal: () => liveKey };

/**
 * Where the swapped tool URLs point for the length of this proof.
 *
 * Nothing ever calls them: no run exists and no simulation is conducted. The
 * address only has to be a public one Retell will accept on a tool, and the run
 * segment only has to be a run-shaped identifier nothing can collide with.
 */
const TARGET = {
  base: "https://live-version-lifecycle.egma.invalid/mock-tools",
  runId: `run_live_version_lifecycle_${Date.now()}`,
};

/** The one draft this proof made, so the teardown unmakes exactly that. */
const made: { draftVersion: number | null } = { draftVersion: null };

/** A version list in the one spelling two readings are compared in. */
function print(versions: readonly AgentVersionSummary[]): string {
  return canonicalJson(
    [...versions].sort((a, b) => a.version - b.version),
  );
}

afterAll(async () => {
  if (liveKey === "" || made.draftVersion === null) return;
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

    // ── 4. Write the mock tools onto the branch's flow, naming its version. ──
    const draftConfiguration = await readEngineConfiguration(key, draftEngine);
    expect(draftConfiguration.kind, JSON.stringify(draftConfiguration)).toBe(
      "engine",
    );
    if (draftConfiguration.kind !== "engine") return;
    const mocked = mockedToolsFor(draftConfiguration.engine, TARGET);
    const engineVersion = draftEngine.version;
    if (engineVersion === null) return;

    const written = await writeEngineTools(key, {
      reference: draftEngine,
      // The branch's own version, never Retell's default. That default is
      // "latest", which is the exact accident this ticket retires.
      version: engineVersion,
      tools: mocked.tools,
    });
    expect(written, JSON.stringify(written)).toEqual({ kind: "written" });

    // The write edited in place: no second version was minted by it.
    const afterWrite = await listAgentVersions(key, agentId);
    expect(afterWrite.kind).toBe("versions");
    if (afterWrite.kind !== "versions") return;
    expect(
      print(afterWrite.versions),
      "the tool write minted a version instead of editing the branch in place",
    ).toBe(print(afterBranch.versions));

    // And it landed where it was aimed: the draft's tools point at Egma.
    const mockedDraft = await readEngineConfiguration(key, draftEngine);
    expect(mockedDraft.kind).toBe("engine");
    if (mockedDraft.kind !== "engine") return;
    for (const name of mocked.coverage.mocked) {
      expect(canonicalJson(mockedDraft.engine.document)).toContain(
        mockToolUrl(TARGET, name),
      );
    }
    console.log(
      `[live lifecycle] mocked ${String(mocked.coverage.mocked.length)} tools ` +
        `on version ${draft.version} in place`,
    );

    // The version real callers reach, mid-proof: byte-identical to the capture.
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
    made.draftVersion = null;

    const proof = await listAgentVersions(key, agentId);
    expect(proof.kind, JSON.stringify(proof)).toBe("versions");
    if (proof.kind !== "versions") return;
    expect(
      proof.versions.map((one) => one.version),
      "the delete was answered and the version is still there",
    ).not.toContain(draft.version);

    // The agent version took its lockstep flow version with it, so there is no
    // second cleanup and none is needed.
    const strayFlow = await readEngineConfiguration(key, draftEngine);
    expect(
      strayFlow.kind,
      "the branch's engine version outlived the agent version it belonged to",
    ).toBe("gone");

    // ── 6. The account as it was found. ──
    expect(
      print(proof.versions),
      "the version panel is not as this proof found it",
    ).toBe(found);

    const after = await readEngineConfiguration(key, servingEngine);
    expect(after.kind).toBe("engine");
    if (after.kind !== "engine") return;
    expect(
      canonicalJson(after.engine.document),
      "the version this agent serves changed",
    ).toBe(servingToolsBefore);

    console.log(
      `[live lifecycle] finished. Version list byte-equal before and after: ` +
        `${found}`,
    );
  }, 120_000);

  it("refuses a run against an agent with nothing published, and says so once", async () => {
    // The published pointer on an agent that has one. This check exists to
    // prove the resolve reads what Retell answers rather than a status code —
    // the two-door refusal itself is proven against an agent that has published
    // nothing in `packages/retell/test/live-fork.test.ts`, on a scratch agent
    // this suite must never create here.
    const serving = await resolveServingAgentVersion(
      key,
      agentId,
      LATEST_PUBLISHED,
    );
    expect(serving.kind).toBe("version");
    if (serving.kind !== "version") return;

    // And `latest` is a different answer whenever a draft stands: the one word
    // that decided which agent a production run graded.
    const newest = await resolveAgentVersion(key, agentId, "latest");
    expect(newest.kind).toBe("version");
    if (newest.kind !== "version") return;
    console.log(
      `[live lifecycle] latest = ${newest.agentVersion.version} ` +
        `(published: ${String(newest.agentVersion.published)}), ` +
        `latest_published = ${serving.agentVersion.version}`,
    );
    expect(newest.agentVersion.version).toBeGreaterThanOrEqual(
      serving.agentVersion.version,
    );
  }, 60_000);
});

describe("the live lifecycle proof's own gate", () => {
  it("names what it needs, and reaches nothing without it", () => {
    // Runs with or without the key, so a reader of a green CI log can see that
    // the live proof exists and exactly why it did not run.
    expect(LIVE_KEY_VARIABLE).toBe("EGMA_LIVE_RETELL_API_KEY");
    expect(DEFAULT_AGENT).toBe("agent_5b62a7f62293d1dc4ee417cf2a");
    if (liveKey === "") {
      console.log(
        `[live lifecycle] skipped — set ${LIVE_KEY_VARIABLE} to run it. It ` +
          "branches one draft on the live agent and deletes it again; it " +
          "starts no run and publishes nothing.",
      );
    }
  });
});
