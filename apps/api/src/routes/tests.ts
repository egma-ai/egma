import {
  authorize,
  createTest,
  editTest,
  getTestVersion,
  listProjects,
  listTests,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  resolvePersonaNames,
  TestMovedOnError,
  UnprocessableInputError,
  type AuthContext,
  type Test,
  type TestPersona,
  type TestVersion,
} from "@egma/db";
import { isId } from "@egma/ids";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text, textList } from "../http/reading.ts";

/**
 * The tests on the platform, as a developer's folder syncs against them: the
 * list, one frozen version by its own id, a new test, and an edit to one.
 *
 * Two things about this group are contract rather than convenience, and both are
 * here because a folder is reviewed by people and executed by machines.
 *
 * **Personas cross the wire by name** — as text, never as a structure, so one
 * shape carries them in both directions. `resolvePersonaNames` is where that
 * rule and its refusals live.
 *
 * **An edit carries the version it was written against**, and it is required.
 * The platform compares it against what is current and refuses when the two have
 * parted, naming both. Nothing is merged, because there is no merge that could
 * be right: a teammate editing a test in the dashboard and a developer editing
 * the same test in a file are two people saying different things, and a
 * heuristic that picked one would be egma deciding which of them was wrong. The
 * comparison happens inside the write itself rather than as a read before it,
 * which is what stops a second writer walking through the gap between the two.
 *
 * The addresses follow the standing rule: nothing is rooted at a project, and
 * the organization is never in a path. Both are resolved from the credential. A
 * write may name a project in its body and a read may filter by one; neither has
 * to, and in a single-project organization nothing ever does.
 */

export type TestRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const TESTS_PATH = "/api/tests";
export const TEST_PATH = "/api/tests/:testId";
export const TEST_VERSION_PATH = "/api/test-versions/:versionId";

type Body = Record<string, unknown>;

type Query = {
  readonly project?: string;
  readonly cursor?: string;
};

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: "invalid_request", message });
}

function notPermitted(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(403).send({ error: "not_permitted", message });
}

function notFound(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(404).send({ error: "not_found", message });
}

function unprocessable(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(422).send({ error: "unprocessable", message });
}

/** A persona as a test names them. */
function describedPersona(named: TestPersona): Record<string, unknown> {
  return { id: named.id, name: named.name };
}

/** A test as it currently stands. One shape for the list and for both writes. */
function described(test: Test): Record<string, unknown> {
  return {
    id: test.id,
    name: test.name,
    version: test.version,
    version_id: test.versionId,
    scenario: test.scenario,
    expected_behaviors: [...test.expectedBehaviors],
    personas: test.personas.map(describedPersona),
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

function cannotActIn(projectId: string): string {
  return (
    `this credential may not act in project ${projectId}. A credential ` +
    `authorized for one project acts in that one, and a key for the whole ` +
    `organization acts in any project of that organization. Leave project out ` +
    `to use the project this credential already acts in.`
  );
}

/**
 * What a credential for the whole organization is told when the organization
 * turns out to hold more than one project.
 *
 * v1 gives an organization one project, and a credential naming none resolves to
 * it. Picking the oldest of several instead would read as harmless and would be
 * the same silent narrowing this codebase has already had to find once: the
 * request would be answered about one product area, correctly and completely,
 * with nothing in the answer to say which.
 */
const NAME_THE_PROJECT =
  "this organization holds more than one project and this credential names " +
  "none, so egma cannot tell which project this is about. Send project with " +
  "the one you mean, or use a key minted for that project.";

type Acting =
  | { readonly auth: AuthContext }
  | { readonly refusal: string; readonly code: "not_permitted" | "invalid_request" };

/**
 * Which project this request acts in, as a context to hand the data-access
 * module.
 *
 * A test belongs to a project, and there is no project in any of these paths —
 * so one has to be resolved before anything can be read or written. Absent, it
 * is the project the credential is authorized for, or the organization's single
 * project for a key minted for the whole customer. Named, it has to be one this
 * credential may act in.
 *
 * **The context is narrowed and never widened.** The only project it can come to
 * name is one `listProjects` answered with, and that read is scoped to the
 * caller's organization by the module itself — so a request cannot argue its way
 * into somebody else's project, and a credential authorized for one project
 * cannot argue its way out of it. The write verbs check the project against the
 * organization again before they insert anything.
 *
 * A project-scoped credential naming a *sibling* project of its own organization
 * is refused rather than quietly narrowed back. The narrowing would be safe and
 * the silence would not: a caller whose filter was dropped reads the answer as
 * though the filter had applied.
 */
async function actingIn(
  auth: AuthContext,
  named: string | undefined,
): Promise<Acting> {
  if (auth.projectId !== undefined) {
    if (named !== undefined && named !== auth.projectId) {
      return { refusal: cannotActIn(named), code: "not_permitted" };
    }
    return { auth };
  }

  const projects = await listProjects(auth);
  if (named !== undefined) {
    return projects.some((project) => project.id === named)
      ? { auth: { ...auth, projectId: named } }
      : { refusal: cannotActIn(named), code: "not_permitted" };
  }

  const [only] = projects;
  if (only === undefined) {
    throw new Error(
      "this organization holds no project, which signup makes impossible",
    );
  }
  if (projects.length > 1) {
    return { refusal: NAME_THE_PROJECT, code: "invalid_request" };
  }
  return { auth: { ...auth, projectId: only.id } };
}

/** The two ways a project can fail to resolve, each answered as what it is. */
function refuse(
  reply: FastifyReply,
  acting: {
    readonly refusal: string;
    readonly code: "not_permitted" | "invalid_request";
  },
): FastifyReply {
  return acting.code === "not_permitted"
    ? notPermitted(reply, acting.refusal)
    : invalid(reply, acting.refusal);
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
   */
  app.get(TESTS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await actingIn(auth, given(query.project));
    if ("refusal" in acting) return refuse(reply, acting);

    const cursor = given(query.cursor);
    if (cursor !== undefined && !isId("tst", cursor)) {
      return invalid(
        reply,
        `"${cursor}" is not a cursor this list issued. Send the next_cursor ` +
          `an earlier page answered with, or leave it out to start at the ` +
          `newest test.`,
      );
    }

    const page = await listTests(acting.auth, { cursor });

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
   * outlives its test's deletion, so both stay answerable afterwards.
   */
  app.get(TEST_VERSION_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { versionId } = request.params as { versionId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await actingIn(auth, given(query.project));
    if ("refusal" in acting) return refuse(reply, acting);

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

    const personas =
      "personas" in body ? personaEntries(body.personas) : { entries: [] };
    if ("refusal" in personas) return unprocessable(reply, personas.refusal);

    const acting = await actingIn(auth, given(text(body.project)));
    if ("refusal" in acting) return refuse(reply, acting);

    const personaIds = await resolvePersonaNames(acting.auth, personas.entries);

    const created = await createTest(acting.auth, {
      name: text(body.name),
      scenario: text(body.scenario),
      expectedBehaviors: textList(body.expected_behaviors),
      personaIds,
    });

    return reply.code(201).send(described(created));
  });

  /**
   * An edit, carrying the version it was written against.
   *
   * `expected_version_id` is required, and it is required because it is the
   * whole of the refusal rule: an edit that named no version would be accepted
   * over a test somebody else moved in the meantime, and the later write would
   * quietly become what the test says. It is never a cost to the writer — a
   * create and every read answer the version id.
   *
   * What the body leaves out, the test keeps — the factory's rule, and this
   * relays it rather than restating it. An empty persona list is not the same as
   * leaving the field out: it means what it means on a create, which is that the
   * project's default persona is who calls.
   *
   * Content byte-identical to the current version mints nothing and answers the
   * current version, so a nervous re-push leaves no noise behind. A name is
   * identity: it writes in place and versions nothing.
   */
  app.patch(TEST_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { testId } = request.params as { testId: string };
    const body = (request.body ?? {}) as Body;

    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    // Everything answerable without reading anything is answered first, so a
    // body that could never be written is refused before it can learn whether
    // the test it names is there.
    const expectedVersionId = given(text(body.expected_version_id));
    if (expectedVersionId === undefined) {
      return unprocessable(
        reply,
        "an edit says which version it was written against, and this one " +
          "named no expected_version_id. Send the version_id you last read " +
          "for this test, or read the test again and send the version it " +
          "names now.",
      );
    }

    const personas = "personas" in body ? personaEntries(body.personas) : undefined;
    if (personas !== undefined && "refusal" in personas) {
      return unprocessable(reply, personas.refusal);
    }

    const acting = await actingIn(auth, given(text(body.project)));
    if ("refusal" in acting) return refuse(reply, acting);

    const personaIds =
      personas === undefined
        ? undefined
        : await resolvePersonaNames(acting.auth, personas.entries);

    const edited = await editTest(acting.auth, testId, {
      expectedVersionId,
      ...("name" in body ? { name: text(body.name) } : {}),
      ...("scenario" in body ? { scenario: text(body.scenario) } : {}),
      ...("expected_behaviors" in body
        ? { expectedBehaviors: textList(body.expected_behaviors) }
        : {}),
      ...(personaIds === undefined ? {} : { personaIds }),
    });

    // A test this credential cannot see reads exactly as a test that is not
    // there, because to this caller those are the same thing.
    if (edited === undefined) {
      return notFound(
        reply,
        `there is no test ${testId} on this egma. List the tests to see what ` +
          `this project holds, or create this one instead of editing it.`,
      );
    }

    return reply.send(described(edited));
  });

  app.setErrorHandler(async (error, _request, reply) => {
    /**
     * The version conflict. The sentence keeps the factory's own words for what
     * happened and adds what to do about it in the vocabulary of this wire,
     * which is the half the factory has no business knowing.
     */
    if (error instanceof TestMovedOnError) {
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
