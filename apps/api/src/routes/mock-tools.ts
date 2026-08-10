import {
  authorize,
  createMockTool,
  editMockTool,
  listMockTools,
  MockToolTakenError,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  resolveMockToolAgents,
  UnprocessableInputError,
  type MockTool,
  type MockToolAgent,
  type MockToolAnswer,
} from "@egma/db";
import { isId } from "@egma/ids";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, cannotActIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import {
  conflict,
  invalid,
  notFound,
  notPermitted,
  unprocessable,
} from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";

/**
 * The mock tools a project answers with, as a developer's folder syncs against
 * them: the list, a new one, and an edit to one.
 *
 * Three things about this group are contract rather than convenience.
 *
 * **An edit overwrites.** There is no `expected_version_id` here and there is
 * no version to name: a mock tool is the one authored thing egma does not
 * version, decided out loud, and the two mechanisms that carry its history
 * instead are the answers landing on each simulation's record and the world a
 * run freezes when it starts. So a nervous re-push of the same file is a write
 * that changes nothing rather than a conflict, and an edit landing mid-run
 * reaches no run already going.
 *
 * **Unknown keys are refused by name.** A mock tool's body is small and every
 * key in it changes what a simulation is answered, so a typo that was quietly
 * ignored would be a mocked world somebody believes they authored and did not.
 * The agent group's gate, for the agent group's reason.
 *
 * **Agents cross the wire by name or by identifier** — as text either way, so
 * one shape carries them in both directions. A living agent's name is unique
 * inside its project, so there is never one two rows answer to.
 *
 * The addresses follow the standing rule: nothing is rooted at a project, and
 * the organization is never in a path. Both are resolved from the credential. A
 * write may name a project in its body and a read may filter by one; neither
 * has to, and in a single-project organization nothing ever does.
 */

export type MockToolRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const MOCK_TOOLS_PATH = "/api/mock-tools";
export const MOCK_TOOL_PATH = "/api/mock-tools/:mockToolId";

type Body = Record<string, unknown>;

type Query = {
  readonly project?: string;
  readonly cursor?: string;
};

const MOCK_TOOL_KEYS = [
  "tool",
  "answer",
  "error",
  "delay_ms",
  "agents",
  "project",
] as const;

/**
 * The unknown-key gate. Refusing by name rather than ignoring is what turns a
 * typo into an answer a coding agent can act on — and here it also stops a
 * mocked world nobody authored: every key in this body changes what a
 * simulation is answered with.
 */
function unknownKeyIn(body: Body): string | undefined {
  for (const key of Object.keys(body)) {
    if ((MOCK_TOOL_KEYS as readonly string[]).includes(key)) continue;
    return `a mock tool has no key "${key}"; it holds ${MOCK_TOOL_KEYS.join(", ")}`;
  }
  return undefined;
}

/** An agent as a mock tool's scope names it. */
function describedAgent(named: MockToolAgent): Record<string, unknown> {
  return { id: named.id, name: named.name };
}

/**
 * A mock tool as every read of one describes it.
 *
 * The answer's two branches are two keys and never one nullable field, because
 * `null` is a perfectly good thing for a tool to answer and a shape that could
 * not tell it from "no answer" would make an authored `null` unreadable. Only
 * the branch this mock tool is on is written.
 */
function described(one: MockTool): Record<string, unknown> {
  return {
    id: one.id,
    tool: one.toolName,
    ...(one.answer.error === undefined
      ? { answer: one.answer.answer }
      : { error: one.answer.error }),
    delay_ms: one.delayMilliseconds,
    agents: one.agents.map(describedAgent),
    created_at: one.createdAt.toISOString(),
    updated_at: one.updatedAt.toISOString(),
  };
}

/**
 * What the body says this tool answers with, or the refusal for a body that
 * says neither or both.
 *
 * A key that arrived is what counts, not a key that arrived truthy: `answer:
 * null`, `answer: 0` and `answer: false` are all answers a tool can give, and a
 * gate that read them as absent would refuse three perfectly ordinary mocks.
 */
type WrittenAnswer =
  | { readonly answer: MockToolAnswer }
  | { readonly refusal: string };

function answerIn(body: Body): WrittenAnswer {
  const gives = "answer" in body;
  const fails = "error" in body;

  if (gives && fails) {
    return {
      refusal:
        "a mock tool answers with one thing: this one sent both answer and " +
        "error. Send whichever branch the test needs.",
    };
  }
  if (!gives && !fails) {
    return {
      refusal:
        "a mock tool answers with something: send answer with what the tool " +
        "returns, or error with the failure it raises. This one sent neither.",
    };
  }
  if (fails) {
    if (typeof body.error !== "string") {
      return {
        refusal:
          "error is the failure this mock tool raises, written as text, and " +
          `this request sent ${typeof body.error}.`,
      };
    }
    return { answer: { error: body.error } };
  }
  return { answer: { answer: body.answer } };
}

/**
 * The delay a body named, in milliseconds.
 *
 * Only the shape is checked here; how long a delay may be is the factory's
 * rule, refused in the factory's own words, because the exchange's budget is
 * what decides it and this door has no business holding a second opinion about
 * that number.
 */
type WrittenDelay =
  | { readonly delayMilliseconds: number | undefined }
  | { readonly refusal: string };

function delayIn(body: Body): WrittenDelay {
  if (!("delay_ms" in body) || body.delay_ms === undefined) {
    return { delayMilliseconds: undefined };
  }
  if (typeof body.delay_ms !== "number") {
    return {
      refusal:
        "delay_ms is how long egma holds this answer back, as a whole number " +
        `of milliseconds, and this request sent ${typeof body.delay_ms}.`,
    };
  }
  return { delayMilliseconds: body.delay_ms };
}

/**
 * The agents a body scoped this mock tool to, in the order it named them.
 *
 * **Text, and only text** — a name, or an agent identifier. A file in a
 * repository writes `agents: [front-desk]`, and that one shape is what crosses
 * the wire in both directions; a second form accepting the structure a read
 * answers with would be two dialects for one field. An entry that is not text
 * is refused rather than dropped, because dropping it would quietly widen the
 * mock tool to every agent in the project.
 */
type NamedAgents =
  | { readonly entries: readonly string[] }
  | { readonly refusal: string };

function agentEntries(value: unknown): NamedAgents {
  if (!Array.isArray(value)) {
    return {
      refusal:
        "agents is the list of agents this mock tool applies to, by name. " +
        'Send it as a list of text, like ["front-desk"], or leave it out and ' +
        "the mock tool applies to every agent in the project.",
    };
  }

  const entries: string[] = [];
  for (const entry of value) {
    const named = text(entry);
    if (typeof entry !== "string" || named === "") {
      return {
        refusal:
          "a mock tool names each agent as text — its name, or its agt_ " +
          "identifier — and one entry in agents is neither. Send it as a " +
          'list of text, like ["front-desk"].',
      };
    }
    entries.push(named);
  }
  return { entries };
}

/**
 * A mock tool nobody can see reads exactly like one nobody wrote. Existence is
 * never confirmed to somebody who could not have seen the thing anyway, so
 * another customer's id and a made-up one get the same sentence.
 */
function noSuchMockTool(mockToolId: string): string {
  return (
    `there is no mock tool ${mockToolId} on this egma. List the mock tools ` +
    `to see what this project answers for.`
  );
}

export async function mockToolRoutes(
  app: FastifyInstance,
  options: MockToolRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * The project's mock tools, newest first, one page at a time.
   *
   * `{ items, next_cursor }` is the envelope every list in this API answers
   * with, and the cursor is the last id of the page rather than a count of rows
   * to skip.
   */
  app.get(MOCK_TOOLS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await actingIn(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cursor = given(query.cursor);
    if (cursor !== undefined && !isId("mck", cursor)) {
      return invalid(
        reply,
        `"${cursor}" is not a cursor this list issued. Send the next_cursor ` +
          `an earlier page answered with, or leave it out to start at the ` +
          `newest mock tool.`,
      );
    }

    const page = await listMockTools(acting.auth, { cursor });

    return reply.send({
      items: page.items.map(described),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this response is an older shape that never had one".
      next_cursor: page.nextCursor ?? null,
    });
  });

  /**
   * A new mock tool.
   *
   * The role is checked before anything is read, which is the stance the
   * factory takes for the same reason: a viewer is refused for being a viewer,
   * rather than after a read that tells them what is there.
   */
  app.post(MOCK_TOOLS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    // Everything answerable without reading anything is answered first, so a
    // body that could never be written is refused before it can learn what
    // this project holds.
    const unknown = unknownKeyIn(body);
    if (unknown !== undefined) return invalid(reply, unknown);

    const answer = answerIn(body);
    if ("refusal" in answer) return unprocessable(reply, answer.refusal);
    const delay = delayIn(body);
    if ("refusal" in delay) return unprocessable(reply, delay.refusal);
    const agents = "agents" in body ? agentEntries(body.agents) : { entries: [] };
    if ("refusal" in agents) return unprocessable(reply, agents.refusal);

    const acting = await actingIn(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const agentIds = await resolveMockToolAgents(acting.auth, agents.entries);

    const created = await createMockTool(acting.auth, {
      toolName: typeof body.tool === "string" ? body.tool : "",
      answer: answer.answer,
      ...(delay.delayMilliseconds === undefined
        ? {}
        : { delayMilliseconds: delay.delayMilliseconds }),
      agentIds,
    });

    return reply.code(201).send(described(created));
  });

  /**
   * An edit, which overwrites.
   *
   * There is no version to name and none is asked for. What the body leaves
   * out, the mock tool keeps — the factory's rule, relayed rather than restated
   * — except `agents`, where an empty list means what it means on a create: the
   * mock tool applies to every agent in the project.
   */
  app.patch(MOCK_TOOL_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { mockToolId } = request.params as { mockToolId: string };
    const body = (request.body ?? {}) as Body;

    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const unknown = unknownKeyIn(body);
    if (unknown !== undefined) return invalid(reply, unknown);

    // Absent from an edit means "keep what is there", so the two-branch gate
    // only applies to a body that mentioned one of them at all.
    const answer =
      "answer" in body || "error" in body ? answerIn(body) : undefined;
    if (answer !== undefined && "refusal" in answer) {
      return unprocessable(reply, answer.refusal);
    }
    const delay = delayIn(body);
    if ("refusal" in delay) return unprocessable(reply, delay.refusal);
    const agents = "agents" in body ? agentEntries(body.agents) : undefined;
    if (agents !== undefined && "refusal" in agents) {
      return unprocessable(reply, agents.refusal);
    }

    const acting = await actingIn(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const agentIds =
      agents === undefined
        ? undefined
        : await resolveMockToolAgents(acting.auth, agents.entries);

    const edited = await editMockTool(acting.auth, mockToolId, {
      ...("tool" in body
        ? { toolName: typeof body.tool === "string" ? body.tool : "" }
        : {}),
      ...(answer === undefined ? {} : { answer: answer.answer }),
      ...(delay.delayMilliseconds === undefined
        ? {}
        : { delayMilliseconds: delay.delayMilliseconds }),
      ...(agentIds === undefined ? {} : { agentIds }),
    });

    // A mock tool this credential cannot see reads exactly as one that is not
    // there, because to this caller those are the same thing.
    if (edited === undefined) {
      return notFound(reply, noSuchMockTool(mockToolId));
    }

    return reply.send(described(edited));
  });

  /**
   * The refusals this group owns, each answered as an answer rather than as a
   * fault, and each carrying the sentence the layer below wrote. The sentences
   * are relayed word for word: a client relays them to a terminal a coding
   * agent is reading, so the wording is the contract.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    // Something is already there, and nothing about the body is wrong — which
    // is a different answer from "what you wrote cannot be acted on".
    if (error instanceof MockToolTakenError) {
      return conflict(reply, error.message);
    }

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
