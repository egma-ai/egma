import {
  ApplicabilityConflictError,
  archiveTest,
  authorize,
  cloneTest,
  createTest,
  editTest,
  getTest,
  getTestVersion,
  IdentityConflictError,
  listTests,
  listTestVersions,
  NotPermittedError,
  PersonaNameAmbiguousError,
  ProjectOutsideOrganizationError,
  resolvePersonaNames,
  restoreTest,
  setTestAgents,
  TestAgentRefusedError,
  TestDependencyInactiveError,
  TestMovedOnError,
  UnknownCapabilityError,
  UnprocessableInputError,
  type AuthContext,
  type MockOverrideInput,
  type Test,
  type TestAgent,
  type TestPersona,
  type TestVersion,
} from "@egma/db";
import { isId } from "@egma/ids";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, cannotActIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { answerAsSent, describedMockTool } from "../http/mock-tools.ts";
import {
  invalid,
  notFound,
  notPermitted,
  sendRefusal,
  unprocessable,
  REFUSALS,
} from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text, textList } from "../http/reading.ts";

/**
 * The tests of one project: the list a browser filters, one frozen version by
 * its own id, the version history behind a test, the two kinds of write, the
 * agents a test applies to, and the lifecycle.
 *
 * Four things about this group are contract rather than convenience.
 *
 * **Personas cross the wire by name** — as text, never as a structure, so one
 * shape carries them in both directions and a folder a team reads in pull
 * requests stays readable. `resolvePersonaNames` is where that rule and its
 * refusals live.
 *
 * **A test's mock-tool overrides are content, so they travel with it** — and a
 * browser write never mentions them. They ride in `mock_tools`, they version
 * with the test exactly as an expected behavior does, and a body that leaves
 * the field out keeps them. That is the whole of what stops a partial browser
 * form erasing hidden versioned content: the form does not edit them, so it
 * does not send them, so they stay.
 *
 * **Three writes, three expectations, three refusals.** The live half of a test
 * — its name and description — carries `expected_revision`. Its versioned
 * content carries `expected_version_id`. Which agents it applies to carries
 * `expected_applicability_revision`, on a door of its own. They are separate
 * because the losses are separately recoverable: a rename that lost a race is
 * retyped in a second, a scenario edit that lost one may be an afternoon's
 * work, and a link edit is neither. A single token covering all three would
 * refuse the cheap edit because somebody else made the expensive one.
 *
 * **A test always applies to at least one active agent.** Create takes them,
 * the link editor cannot empty the set, and Restore of a test that has none
 * takes one in the same request.
 *
 * **What a test may require of a connection comes from `GET /api/capabilities`,
 * which already exists** — the same catalog the connection forms draw from. A
 * second endpoint answering the same list would be a second opinion about which
 * keys exist, and the whole worth of the catalog is that a requirement and a
 * measurement name the same thing.
 *
 * The addresses follow the standing rule: nothing is rooted at a project, and
 * the organization is never in a path. Both are resolved from the credential. A
 * write may name a project in its body and a read may filter by one.
 */

export type TestRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const TESTS_PATH = "/api/tests";
export const TEST_PATH = "/api/tests/:testId";
export const TEST_VERSIONS_PATH = "/api/tests/:testId/versions";
export const TEST_AGENTS_PATH = "/api/tests/:testId/agents";
export const TEST_CLONE_PATH = "/api/tests/:testId/clone";
export const TEST_ARCHIVE_PATH = "/api/tests/:testId/archive";
export const TEST_RESTORE_PATH = "/api/tests/:testId/restore";
export const TEST_VERSION_PATH = "/api/test-versions/:versionId";

type Body = Record<string, unknown>;

type Query = {
  readonly project?: string;
  readonly cursor?: string;
  readonly archived?: string;
  readonly agent?: string;
  readonly name?: string;
};

/** A persona as a test names them. */
function describedPersona(named: TestPersona): Record<string, unknown> {
  return {
    id: named.id,
    name: named.name,
    archived_at: named.archivedAt === null ? null : named.archivedAt.toISOString(),
  };
}

/**
 * An agent a test applies to, **with its archive state said out loud**.
 *
 * A page has to be able to render a test that is active and unavailable — every
 * agent it applies to archived — because that is a real state and the fix is to
 * restore an agent rather than to re-author the test. A read that dropped the
 * archived links would show a test with fewer targets than it has.
 */
function describedAgent(applies: TestAgent): Record<string, unknown> {
  return {
    id: applies.id,
    name: applies.name,
    archived_at:
      applies.archivedAt === null ? null : applies.archivedAt.toISOString(),
  };
}

/** The behaviors a body carries, or the reason it carries none egma can read. */
type WrittenBehaviors =
  | { readonly entries: readonly string[] }
  | { readonly refusal: string };

/** The keys one entry of `mock_tools` holds, and no others. */
const OVERRIDE_KEYS = ["tool", "answer", "error", "delay_ms"] as const;

/**
 * The overrides a body carries, as the factory takes them.
 *
 * Almost nothing is judged here: how long a delay may be, how large an answer
 * may be, what a tool name has to say, and whether the two answer keys add up
 * to one branch are all the factory's rules, held in one place for a project's
 * mock tools and a test's overrides alike — a second opinion here could come to
 * disagree with the one that matters. What this owns is the shape of the
 * envelope, and that a wrong shape is refused rather than dropped: a dropped
 * override is a branch somebody believes their test forces and it does not.
 */
type WrittenOverrides =
  | { readonly entries: readonly MockOverrideInput[] }
  | { readonly refusal: string };

function overrideEntries(value: unknown): WrittenOverrides {
  if (!Array.isArray(value)) {
    return {
      refusal:
        "mock_tools is the list of tools this test answers for itself. Send " +
        'it as a list of objects, like [{"tool": "check_availability", ' +
        '"answer": {"slots": []}}], or leave it out and the project\'s mock ' +
        "tools are the whole world.",
    };
  }

  const entries: MockOverrideInput[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return {
        refusal:
          "each entry in mock_tools names one tool and what it answers with. " +
          'Send objects, like {"tool": "check_availability", "error": "the ' +
          'calendar is unreachable"}.',
      };
    }
    const written = entry as Record<string, unknown>;
    for (const key of Object.keys(written)) {
      if ((OVERRIDE_KEYS as readonly string[]).includes(key)) continue;
      return {
        refusal:
          `a mock tool a test overrides has no key "${key}"; it holds ` +
          OVERRIDE_KEYS.join(", "),
      };
    }
    if ("delay_ms" in written && typeof written.delay_ms !== "number") {
      return {
        refusal:
          "delay_ms is how long egma holds an answer back, as a whole number " +
          `of milliseconds, and one entry in mock_tools sent ${typeof written.delay_ms}.`,
      };
    }

    entries.push({
      toolName: written.tool,
      answer: answerAsSent(written),
      ...(typeof written.delay_ms === "number"
        ? { delayMilliseconds: written.delay_ms }
        : {}),
    });
  }
  return { entries };
}

/**
 * A test as it currently stands. One shape for the list, the detail and every
 * write, with the three halves named apart on the wire.
 *
 * A page has to be able to say which of a person's edits will mint history and
 * which will not, and a flat object of fields cannot say it. So the shape says
 * it: `revision` covers the name and description, `version_id` covers
 * everything a run is judged by, and `applicability_revision` covers which
 * agents it applies to. Each write sends back the one it is about.
 */
function described(test: Test): Record<string, unknown> {
  return {
    id: test.id,
    project_id: test.projectId,
    name: test.name,
    description: test.description,
    version: test.version,
    version_id: test.versionId,
    scenario: test.scenario,
    expected_behaviors: [...test.expectedBehaviors],
    personas: test.personas.map(describedPersona),
    required_capabilities: test.requiredCapabilities,
    mock_tools: test.mockOverrides.map(describedMockTool),
    // What a browser shows instead of the overrides themselves: it does not
    // edit them, so it is told only that they are there.
    override_count: test.mockOverrides.length,
    agents: test.agents.map(describedAgent),
    revision: test.revision,
    applicability_revision: test.applicabilityRevision,
    archived_at: test.archivedAt === null ? null : test.archivedAt.toISOString(),
    archive_reason: test.archiveReason,
    created_at: test.createdAt.toISOString(),
    updated_at: test.updatedAt.toISOString(),
  };
}

/** One frozen version, and enough about its test to act on it. */
function describedVersion(version: TestVersion): Record<string, unknown> {
  return {
    id: version.id,
    test_id: version.testId,
    test_name: version.testName,
    version: version.version,
    current: version.current,
    scenario: version.scenario,
    expected_behaviors: [...version.expectedBehaviors],
    personas: version.personas.map(describedPersona),
    required_capabilities: version.requiredCapabilities,
    mock_tools: version.mockOverrides.map(describedMockTool),
    override_count: version.mockOverrides.length,
    created_at: version.createdAt.toISOString(),
  };
}

/**
 * The personas a body names, in the order it named them.
 *
 * **Text, and only text** — a name, or a persona identifier. A file in a
 * repository writes `personas: [impatient-caller]`, and that one shape is what
 * crosses the wire in both directions; a second form accepting the structure a
 * read answers with would be two dialects for one field, and every client would
 * then have to know which one this instance prefers. An entry that is not text
 * is refused rather than dropped, because dropping it would quietly hand the
 * test to the project's default persona instead.
 */
type NamedPersonas =
  | { readonly entries: readonly string[] }
  | { readonly refusal: string };

function personaEntries(value: unknown): NamedPersonas {
  if (!Array.isArray(value)) {
    return {
      refusal:
        "personas is the list of people who call about this test, by name. " +
        'Send it as a list of text, like ["impatient-caller"], or leave it ' +
        "out and egma takes the project's default persona.",
    };
  }

  const entries: string[] = [];
  for (const entry of value) {
    const named = text(entry);
    if (typeof entry !== "string" || named === "") {
      return {
        refusal:
          "a test names each persona as text — their name, or their prs_ " +
          "identifier — and one entry in personas is neither. Send it as a " +
          'list of text, like ["impatient-caller"].',
      };
    }
    entries.push(named);
  }
  return { entries };
}

/** A list of identifiers a body sent, or a sentence saying why it is not one. */
type NamedIds =
  | { readonly entries: readonly string[] }
  | { readonly refusal: string };

function idEntries(value: unknown, field: string, shape: string): NamedIds {
  if (!Array.isArray(value)) {
    return {
      refusal: `${field} is a list of ${shape} identifiers, and this request sent ${typeof value}.`,
    };
  }
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return {
        refusal: `every entry in ${field} is a ${shape} identifier, and one of them is not.`,
      };
    }
    entries.push(entry.trim());
  }
  return { entries };
}

/**
 * The keys that are a test's version content, so an edit carrying any of them
 * has to say which version it was written against.
 *
 * Written out here rather than inferred, because the list *is* the contract:
 * what versions and what does not is the distinction the whole editor is built
 * around, and a key added to the body without being added here would be a
 * content change nothing guarded.
 */
const VERSIONED_KEYS = [
  "scenario",
  "expected_behaviors",
  "personas",
  "mock_tools",
  "required_capabilities",
] as const;

/** The one sentence a test nobody can see gets, whichever way it is absent. */
function noSuchTest(reply: FastifyReply, testId: string): FastifyReply {
  return sendRefusal(reply, "not_found", REFUSALS.notFound("test", testId));
}

function refuseRole(
  reply: FastifyReply,
  auth: AuthContext,
  action: string,
): FastifyReply {
  return sendRefusal(
    reply,
    "not_permitted",
    REFUSALS.notPermitted(auth.role, action),
  );
}

/**
 * A key that retired with the test-grader junction, named rather than ignored.
 *
 * **This door reads a bare record and takes only the keys it knows**, which is
 * what lets the shape grow without breaking older clients — and is exactly why
 * a retired key has to be refused by name. A body still sending
 * `graders: [...]` would otherwise be written successfully with the graders
 * silently gone: a test somebody believes is judged by two checks they chose,
 * judged by neither, with a `201` saying it went fine. The behavior shape has
 * been named since the ladder retired; this is the other half of the same
 * change, refused in the same voice.
 *
 * It is deliberately not a general unknown-key gate. Adding one here would
 * refuse every client that sends a field this version has not learned yet,
 * which is a different decision and not this one.
 */
function retiredKeyIn(body: Record<string, unknown>): string | undefined {
  if (!("graders" in body)) return undefined;
  return (
    "a test names no graders; the graders key retired with the test-grader " +
    "junction. What judges a simulation is the project's running graders " +
    "and their scope, set on the grader rather than on the test."
  );
}

/**
 * The behaviors a body carries, as the factory takes them: plain sentences, in
 * the order they were written.
 *
 * It exists to name one refusal rather than to add a rule. `textList` turns
 * anything that is not text into an empty string, so a body still sending the
 * retired `{"behavior", "priority"}` shape would otherwise arrive at the factory
 * as a list of blanks and be refused for saying nothing — which sends a writer
 * looking at their sentences for a problem that is in their envelope.
 */
function behaviorEntries(value: unknown): WrittenBehaviors {
  if (!Array.isArray(value)) {
    return {
      refusal:
        "expected_behaviors is what should happen, as a list of sentences, " +
        'like ["confirms the new time back before finishing"].',
    };
  }

  for (const entry of value) {
    if (typeof entry === "object" && entry !== null && "behavior" in entry) {
      return {
        refusal:
          "an expected behavior is a plain sentence now; the " +
          '{"behavior", "priority"} shape retired with the P0/P1/P2 ladder. ' +
          "Send each sentence on its own.",
      };
    }
  }

  return { entries: textList(value) };
}

export async function testRoutes(
  app: FastifyInstance,
  options: TestRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * The project's tests, newest first, one page at a time.
   *
   * `{ items, next_cursor }` is the envelope every list in this API answers
   * with, and the cursor is the last id of the page rather than a count of rows
   * to skip: the ids sort by mint time, so a list changing under a reader never
   * shows them a row twice and never skips one.
   *
   * Three filters, and each narrows within one of the two lists rather than
   * mixing them: `archived` chooses the list, `agent` narrows to the tests that
   * apply to one, and `name` searches.
   */
  app.get(TESTS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await namingAProject(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cursor = given(query.cursor);
    if (cursor !== undefined && !isId("tst", cursor)) {
      return sendRefusal(
        reply,
        "invalid_cursor",
        REFUSALS.invalidCursor(cursor),
      );
    }

    const agent = given(query.agent);
    if (agent !== undefined && !isId("agt", agent)) {
      return invalid(
        reply,
        `"${agent}" is not an agent id. Send the agt_ id of the agent whose ` +
          `tests you want, or leave it out for every test in the project.`,
      );
    }

    const page = await listTests(acting.auth, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(agent === undefined ? {} : { agentId: agent }),
      ...(given(query.name) === undefined ? {} : { name: text(query.name) }),
      archived: given(query.archived) === "true",
    });

    return reply.send({
      items: page.items.map(described),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this response is an older shape that never had one".
      next_cursor: page.nextCursor ?? null,
    });
  });

  /**
   * One frozen version by its own id.
   *
   * This is what a pinned file resolves through, so it says which test the
   * version belongs to and whether the test has moved past it. Both are answers
   * a caller holding only a version id cannot get any other way, and a version
   * outlives its test's archiving, so both stay answerable afterwards.
   */
  app.get(TEST_VERSION_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { versionId } = request.params as { versionId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await actingIn(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const version = await getTestVersion(acting.auth, versionId);
    if (version === undefined) {
      return notFound(
        reply,
        `there is no test version ${versionId} on this egma. List the tests ` +
          `to see the version each of them stands on now.`,
      );
    }

    return reply.send(describedVersion(version));
  });

  app.get(TEST_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { testId } = request.params as { testId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await namingAProject(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    // An archived test stays readable: a run pinned it, its history is evidence,
    // and the detail page is where Restore lives.
    const test = await getTest(acting.auth, testId);
    if (test === undefined) return noSuchTest(reply, testId);

    return reply.send(described(test));
  });

  /**
   * Every version of one test, newest first — the immutable history a detail
   * page shows, and the list an older-version read is chosen from.
   */
  app.get(TEST_VERSIONS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { testId } = request.params as { testId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await namingAProject(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cursor = given(query.cursor);
    const page = await listTestVersions(acting.auth, testId, {
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page === undefined) return noSuchTest(reply, testId);

    return reply.send({
      items: page.items.map(describedVersion),
      next_cursor: page.nextCursor ?? null,
    });
  });

  /**
   * A new test.
   *
   * The role is checked before anything is read, which is the stance the factory
   * takes for the same reason: a viewer is refused for being a viewer, rather
   * than after a read that tells them what is there.
   */
  app.post(TESTS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    // A retired key is refused before anything is read, so a body written
    // against last month's contract is told what changed rather than written
    // successfully with half of it dropped.
    const retired = retiredKeyIn(body);
    if (retired !== undefined) return unprocessable(reply, retired);

    const personas =
      "personas" in body ? personaEntries(body.personas) : { entries: [] };
    if ("refusal" in personas) return unprocessable(reply, personas.refusal);

    const overrides =
      "mock_tools" in body ? overrideEntries(body.mock_tools) : { entries: [] };
    if ("refusal" in overrides) return unprocessable(reply, overrides.refusal);

    const behaviors =
      "expected_behaviors" in body
        ? behaviorEntries(body.expected_behaviors)
        : { entries: textList(body.expected_behaviors) };
    if ("refusal" in behaviors) return unprocessable(reply, behaviors.refusal);

    const agents =
      "agents" in body
        ? idEntries(body.agents, "agents", "agt_")
        : { entries: [] };
    if ("refusal" in agents) return unprocessable(reply, agents.refusal);

    const capabilities =
      "required_capabilities" in body
        ? idEntries(body.required_capabilities, "required_capabilities", "capability")
        : { entries: [] };
    if ("refusal" in capabilities) {
      return unprocessable(reply, capabilities.refusal);
    }

    const acting = await actingIn(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const personaIds = await resolvePersonaNames(acting.auth, personas.entries);

    const created = await createTest(acting.auth, {
      name: text(body.name),
      ...(body.description === undefined
        ? {}
        : { description: text(body.description) }),
      scenario: text(body.scenario),
      expectedBehaviors: behaviors.entries,
      personaIds,
      mockOverrides: overrides.entries,
      requiredCapabilities: capabilities.entries,
      agentIds: agents.entries,
    });

    return reply.code(201).send(described(created));
  });

  /**
   * An edit, carrying whichever expectations it is about.
   *
   * `expected_version_id` is what guards content, and a repository client
   * always sends it: an edit that named no version would be accepted over a
   * test somebody else moved in the meantime, and the later write would quietly
   * become what the test says. `expected_revision` guards the name and the
   * description on the same terms.
   *
   * What the body leaves out, the test keeps — the factory's rule, and this
   * relays it rather than restating it. That is what preserves the hidden
   * mock-tool overrides across every browser write: the form does not edit
   * them, so it does not send them, so they stay. An empty persona list is not
   * the same as leaving the field out: it means what it means on a create,
   * which is that the project's default persona is who calls.
   *
   * Content byte-identical to the current version mints nothing and answers the
   * current version, so a nervous re-save leaves no history behind.
   */
  app.patch(TEST_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { testId } = request.params as { testId: string };
    const body = (request.body ?? {}) as Body;

    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    if ("agents" in body) {
      return unprocessable(
        reply,
        "which agents a test applies to is edited on its own, because it " +
          "mints no version and carries its own revision. Send the set to " +
          `POST /api/tests/${testId}/agents with ` +
          "expected_applicability_revision.",
      );
    }

    const retired = retiredKeyIn(body);
    if (retired !== undefined) return unprocessable(reply, retired);

    const personas = "personas" in body ? personaEntries(body.personas) : undefined;
    if (personas !== undefined && "refusal" in personas) {
      return unprocessable(reply, personas.refusal);
    }

    const overrides =
      "mock_tools" in body ? overrideEntries(body.mock_tools) : undefined;
    if (overrides !== undefined && "refusal" in overrides) {
      return unprocessable(reply, overrides.refusal);
    }

    const behaviors =
      "expected_behaviors" in body
        ? behaviorEntries(body.expected_behaviors)
        : undefined;
    if (behaviors !== undefined && "refusal" in behaviors) {
      return unprocessable(reply, behaviors.refusal);
    }

    const capabilities =
      "required_capabilities" in body
        ? idEntries(body.required_capabilities, "required_capabilities", "capability")
        : undefined;
    if (capabilities !== undefined && "refusal" in capabilities) {
      return unprocessable(reply, capabilities.refusal);
    }

    /**
     * A write that touches content says which version it was written against,
     * and it is required — because it is the whole of the refusal rule: an edit
     * that named no version would be accepted over a test somebody else moved
     * in the meantime, and the later write would quietly become what the test
     * says. It is never a cost to the writer, because a create and every read
     * answer the version id.
     *
     * **Only when the body carries content.** A rename touches nothing a run
     * was judged by, so demanding a version for it would refuse a one-word edit
     * because a colleague sharpened a scenario — which is the conflict the two
     * separate tokens exist to prevent. Its own token guards it instead.
     */
    const touchesContent = VERSIONED_KEYS.some((key) => key in body);
    if (touchesContent && given(text(body.expected_version_id)) === undefined) {
      return unprocessable(
        reply,
        "an edit says which version it was written against, and this one " +
          "named no expected_version_id. Send the version_id you last read " +
          "for this test, or read the test again and send the version it " +
          "names now.",
      );
    }

    /**
     * The agent the repository sending this edit is bound to, when one is.
     *
     * A question and never a change: the platform answers it by refusing when
     * the test no longer applies to that agent. It is separate from `agents`
     * above — which this door refuses outright — because that one would be an
     * instruction, and one file must never become the source of truth for a set
     * of links it cannot see.
     */
    const repositoryAgent = given(text(body.repository_agent));
    if (repositoryAgent !== undefined && !isId("agt", repositoryAgent)) {
      return unprocessable(
        reply,
        `"${repositoryAgent}" is not an agent id. Send the agt_ id of the ` +
          "agent this repository is bound to, or leave it out.",
      );
    }

    const acting = await actingIn(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const personaIds =
      personas === undefined
        ? undefined
        : await resolvePersonaNames(acting.auth, personas.entries);

    const edited = await editTest(acting.auth, testId, {
      ...(repositoryAgent === undefined
        ? {}
        : { repositoryAgentId: repositoryAgent }),
      ...(given(text(body.expected_version_id)) === undefined
        ? {}
        : { expectedVersionId: text(body.expected_version_id) }),
      ...(given(text(body.expected_revision)) === undefined
        ? {}
        : { expectedRevision: text(body.expected_revision) }),
      ...("name" in body ? { name: text(body.name) } : {}),
      ...("description" in body
        ? { description: body.description === null ? null : text(body.description) }
        : {}),
      ...("scenario" in body ? { scenario: text(body.scenario) } : {}),
      ...(behaviors === undefined ? {} : { expectedBehaviors: behaviors.entries }),
      ...(personaIds === undefined ? {} : { personaIds }),
      ...(overrides === undefined ? {} : { mockOverrides: overrides.entries }),
      ...(capabilities === undefined
        ? {}
        : { requiredCapabilities: capabilities.entries }),
    });

    // A test this credential cannot see reads exactly as a test that is not
    // there, because to this caller those are the same thing.
    if (edited === undefined) return noSuchTest(reply, testId);

    return reply.send(described(edited));
  });

  /**
   * Which agents this test applies to, set to exactly what the body says.
   *
   * **Its own door because it is its own kind of change.** It mints no version,
   * it does not move the identity revision, and it makes no repository copy
   * stale — so it carries its own expectation and gets its own refusal. The
   * whole set rather than one add or one remove, because a browser edits a list
   * of checkboxes and sends what it now says.
   */
  app.post(TEST_AGENTS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { testId } = request.params as { testId: string };
    const body = (request.body ?? {}) as Body;

    if (auth.role === "viewer") {
      return refuseRole(reply, auth, "change which agents a test applies to");
    }

    const agents = idEntries(body.agents, "agents", "agt_");
    if ("refusal" in agents) return unprocessable(reply, agents.refusal);

    const acting = await namingAProject(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const changed = await setTestAgents(acting.auth, testId, {
      agentIds: agents.entries,
      ...(given(text(body.expected_applicability_revision)) === undefined
        ? {}
        : {
            expectedApplicabilityRevision: text(
              body.expected_applicability_revision,
            ),
          }),
    });
    if (changed === undefined) return noSuchTest(reply, testId);

    return reply.send(described(changed));
  });

  /**
   * The same test again under a new identity, and **no shared history**.
   *
   * It copies the current content — including the mock-tool overrides no
   * browser form shows, so a copy runs in the same world — and the source's
   * active applicable-agent links. Copying the lineage would make two
   * identities share a past, and the first question anybody asks of a version
   * history would then have two answers.
   */
  app.post(TEST_CLONE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { testId } = request.params as { testId: string };
    const body = (request.body ?? {}) as Body;

    if (auth.role === "viewer") return refuseRole(reply, auth, "clone tests");

    const acting = await namingAProject(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cloned = await cloneTest(acting.auth, testId);
    if (cloned === undefined) return noSuchTest(reply, testId);

    return reply.code(201).send(described(cloned));
  });

  app.post(TEST_ARCHIVE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { testId } = request.params as { testId: string };
    const body = (request.body ?? {}) as Body;

    if (auth.role === "viewer") return refuseRole(reply, auth, "archive tests");

    const acting = await namingAProject(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const archived = await archiveTest(acting.auth, testId, {
      ...(given(text(body.expected_revision)) === undefined
        ? {}
        : { expectedRevision: text(body.expected_revision) }),
    });
    if (archived === undefined) return noSuchTest(reply, testId);

    return reply.send(described(archived));
  });

  app.post(TEST_RESTORE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { testId } = request.params as { testId: string };
    const body = (request.body ?? {}) as Body;

    if (auth.role === "viewer") return refuseRole(reply, auth, "restore tests");

    const agents =
      "agents" in body
        ? idEntries(body.agents, "agents", "agt_")
        : { entries: [] };
    if ("refusal" in agents) return unprocessable(reply, agents.refusal);

    const acting = await namingAProject(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const restored = await restoreTest(acting.auth, testId, {
      agentIds: agents.entries,
      ...(given(text(body.expected_revision)) === undefined
        ? {}
        : { expectedRevision: text(body.expected_revision) }),
    });
    if (restored === undefined) return noSuchTest(reply, testId);

    return reply.send(described(restored));
  });

  /**
   * The refusals this group owns, each carrying the sentence a page shows.
   *
   * The three conflicts are answered apart because a client's next move differs
   * for each: reread the identity and resend with a new revision, reread the
   * content and resend with a new version, or reread the links and resend with
   * a new applicability revision.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof TestMovedOnError) {
      // The one refusal in this group that carries more than
      // `{ error, message }` — the caller's next move is to go and read a
      // specific test — so it writes its own body rather than going through the
      // shared answer.
      return reply.code(409).send({
        error: "conflict",
        message:
          `this edit was written against version ${error.expectedVersionId}, ` +
          `and the test has moved on to ${error.currentVersionId}. Read the ` +
          `test again and send the edit with expected_version_id set to the ` +
          `version it names now.`,
        test: { id: error.testId, name: error.testName },
        expected_version_id: error.expectedVersionId,
        current_version_id: error.currentVersionId,
      });
    }

    if (error instanceof IdentityConflictError) {
      return sendRefusal(
        reply,
        "identity_conflict",
        REFUSALS.identityConflict("Test", error.resourceId),
      );
    }

    if (error instanceof ApplicabilityConflictError) {
      return sendRefusal(
        reply,
        "applicability_conflict",
        REFUSALS.applicabilityConflict(error.testId),
      );
    }

    if (error instanceof TestAgentRefusedError) {
      switch (error.reason) {
        case "repository_agent_not_applicable":
          return sendRefusal(
            reply,
            "repository_agent_not_applicable",
            REFUSALS.repositoryAgentNotApplicable(
              error.testId ?? "",
              error.agentId ?? "",
            ),
          );
        case "test_needs_agent":
          return sendRefusal(
            reply,
            "test_needs_agent",
            REFUSALS.testNeedsAgent,
          );
        case "last_test_agent":
          return sendRefusal(
            reply,
            "last_test_agent",
            REFUSALS.lastTestAgent(
              error.testId ?? "",
              error.agentId ?? "",
            ),
          );
        default:
          return sendRefusal(
            reply,
            "agent_not_available",
            REFUSALS.agentNotAvailable(error.agentId ?? ""),
          );
      }
    }

    if (error instanceof TestDependencyInactiveError) {
      return sendRefusal(
        reply,
        "test_dependency_inactive",
        REFUSALS.testDependencyInactive(
          error.testId,
          error.resources
            .map((one) => `${one.kind} ${one.id} "${one.name}"`)
            .join(", "),
        ),
      );
    }

    // Before the general refusal below, because it is one of those: a subclass
    // with a code of its own, so a form can point at the capability list.
    if (error instanceof UnknownCapabilityError) {
      return sendRefusal(reply, "unknown_capability", error.message);
    }

    // The other subclass, for the same reason and a different reader: a file
    // naming a persona two living personas answer to. The code is what lets a
    // repository client say where the identifier goes.
    if (error instanceof PersonaNameAmbiguousError) {
      return sendRefusal(
        reply,
        "persona_name_ambiguous",
        REFUSALS.personaNameAmbiguous(error.personaName),
      );
    }

    // The factory turned the write away at its door, in its own words. Relayed
    // rather than rewritten: the sentence is written for whoever has to fix the
    // body, and rewriting it here would put it in two places.
    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }

    // Reachable only in a race — the project was checked before the write, and
    // this is what a delete landing in between looks like from inside it.
    if (error instanceof ProjectOutsideOrganizationError) {
      return notPermitted(reply, cannotActIn(error.projectId));
    }

    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }

    throw error;
  });
}

/**
 * The acting project, with the browser's own missing-project refusal.
 *
 * Every product page carries its project in the address and therefore in the
 * request. A session that named none is not a request to be answered about
 * whichever project happens to be oldest — it is a page that lost its context,
 * and the one thing to do about it is the one thing the sentence names.
 *
 * A key is a different matter and keeps the old rule: one minted for a project
 * acts in that project, and one for the whole organization resolves the single
 * project a v1 organization has. The create and the repository-facing writes
 * deliberately go through `actingIn` instead, because a repository client is a
 * key and has no selector to be pointed at.
 */
async function namingAProject(auth: AuthContext, named: string | undefined) {
  if (auth.via === "session" && named === undefined) {
    return { refusal: REFUSALS.projectRequired, code: "project_required" as const };
  }
  return actingIn(auth, named);
}
