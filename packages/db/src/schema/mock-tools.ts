import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { agent } from "./agents.ts";
import { organization, project } from "./tenancy.ts";
import { user } from "./identity.ts";
import { createdAt, idText, moment, prefixCheck, updatedAt } from "./columns.ts";

/**
 * A mock tool answers for one of the agent's tools while a simulation runs, so
 * that the agent's real backend is never touched and a test can order up the
 * branch it needs. The answer may be a failure, which is how a test forces the
 * apology path; it may carry a delay, so a mocked backend takes as long as the
 * real one would.
 *
 * **One table, and deliberately no version table beside it.** Every other
 * authored thing in this schema is a pair — the identity row somebody points
 * at, and the frozen versions a run pins — because editing one must never
 * rewrite what an old result meant. A mock tool is the one exemption, decided
 * out loud: an edit overwrites this row, and history is carried by two
 * mechanisms that exist anyway. Every answer a simulation was served lands on
 * that simulation's record, and a run snapshots the answers it resolved at the
 * moment it was created — so every simulation in one run sees one world, and an
 * edit landing mid-run tears nothing. What is knowingly given up is cross-run
 * change detection: nothing but comparing two runs' snapshots says the world
 * moved between them, and a version chain returns the day that bites.
 *
 * **One answer per tool name, per project.** Matching is by name and nothing
 * else — no arguments are read — so two rows answering for one tool would be
 * two answers with no rule to choose between them. A test that needs a
 * different branch overrides the name in its own versioned content instead,
 * which is where per-scenario answers belong and where they version for free.
 */

/**
 * How long a mock tool may hold its answer back, in milliseconds.
 *
 * The ceiling is arithmetic rather than taste: the exchange that carries an
 * answer is given a 45-second budget, of which 10 seconds is allowed for the
 * round trip and 5 for egma's own serving margin. 30 seconds is what is left,
 * so a delay this side admits can never collide with the transport that has to
 * carry it.
 */
export const LONGEST_MOCK_TOOL_DELAY_MILLISECONDS = 30_000;

/**
 * How large an answer may be once serialized, in bytes.
 *
 * The exchange carrying it holds 15 KiB, so this is the transport's limit
 * written down where an author meets it rather than discovered at call time by
 * a simulation that fails halfway through. An answer that needs more than this
 * is a document rather than a tool answer.
 */
export const LARGEST_MOCK_TOOL_ANSWER_BYTES = 15 * 1024;

export const mockTool = pgTable(
  "mock_tool",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: idText("project_id").notNull(),
    /**
     * The agent's own name for the tool this answers for, verbatim. Matching is
     * by this string and strictly by it, so it is stored exactly as the agent
     * registers it rather than folded or normalised.
     */
    toolName: text("tool_name").notNull(),
    /**
     * What egma serves when the agent calls that tool: `{ answer }` with the
     * value the tool returns, or `{ error }` with the failure it raises.
     *
     * Deliberately jsonb and deliberately one column, for the reason a
     * persona's traits and a test's content are jsonb: a tool answers with
     * whatever shape its own contract has, including `null` and bare scalars,
     * and two columns with a check between them could not tell a tool that
     * answers `null` from a tool with no answer at all. The tagged object can,
     * and it is the shape the run's snapshot and the exchange both carry, so
     * the answer is stored in the form it is served in.
     */
    answer: jsonb("answer").notNull(),
    /** How long egma holds the answer back before serving it. */
    delayMilliseconds: integer("delay_milliseconds").notNull().default(0),
    deletedAt: moment("deleted_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("mock_tool_id_prefix", table.id, "mck"),
    check(
      "mock_tool_delay_within_budget",
      sql`${table.delayMilliseconds} between 0 and ${sql.raw(
        String(LONGEST_MOCK_TOOL_DELAY_MILLISECONDS),
      )}`,
    ),
    // The pairing, not each column on its own: a mock tool cannot name one
    // organization and another organization's project.
    foreignKey({
      name: "mock_tool_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    // One answer per tool name, held by the database rather than by the
    // factory alone: two rows answering for one tool would be two answers with
    // no rule to choose between them. Deleted rows are outside it, so a tool
    // whose mock somebody removed can be answered for again.
    uniqueIndex("mock_tool_project_id_tool_name_unique")
      .on(table.projectId, table.toolName)
      .where(sql`${table.deletedAt} is null`),
    // Looks redundant next to the primary key; it is the composite-foreign-key
    // target that lets the agent junction prove the mock tool it scopes and the
    // agent it names are the same project's.
    unique("mock_tool_id_project_id_unique").on(table.id, table.projectId),
    index("mock_tool_organization_id_project_id_idx")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.deletedAt} is null`),
  ],
);

/**
 * Which agents a mock tool applies to, and in which order it was authored.
 *
 * **No rows means every agent**, which is the ordinary case: one project, one
 * mocked world, so two prompt variants are always tested against the same data
 * and a difference between their verdicts is the prompt's doing. Rows narrow
 * it — affinity, never ownership, so the mock tool still belongs to the project
 * and never to an agent.
 *
 * The junction's shape is the test's persona and grader junctions', verb for
 * verb, because the three ask the same question of the same kind of row and
 * answering them three ways would be three things to learn. The composite key
 * back to the mock tool's own project is what makes scoping to another
 * project's agent unrepresentable rather than merely unwritten.
 */
export const mockToolAgent = pgTable(
  "mock_tool_agent",
  {
    mockToolId: idText("mock_tool_id")
      .notNull()
      .references(() => mockTool.id, { onDelete: "cascade" }),
    /**
     * No `on delete` clause on purpose, exactly as the test junctions have
     * none. Removing the agent outright is refused rather than quietly
     * widening a mock tool to every agent in the project, which is the one
     * change to a mocked world nobody would see happen.
     */
    agentId: idText("agent_id")
      .notNull()
      .references(() => agent.id),
    /** The project both sides belong to, carried so the pairings can be held. */
    projectId: idText("project_id").notNull(),
    /** Where in the authored order this agent sits, counting from one. */
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({
      name: "mock_tool_agent_pk",
      columns: [table.mockToolId, table.agentId],
    }),
    prefixCheck("mock_tool_agent_mock_tool_id_prefix", table.mockToolId, "mck"),
    // Authored order is a fact about the scope, so two agents on one mock tool
    // can never claim the same place in it.
    unique("mock_tool_agent_mock_tool_id_position_unique").on(
      table.mockToolId,
      table.position,
    ),
    // Both edges of the triangle: the mock tool is this project's, and so is
    // the agent — so a scope reaching another project's agent, or another
    // customer's, cannot be written at all.
    foreignKey({
      name: "mock_tool_agent_mock_tool_project_fk",
      columns: [table.mockToolId, table.projectId],
      foreignColumns: [mockTool.id, mockTool.projectId],
    }).onDelete("cascade"),
    foreignKey({
      name: "mock_tool_agent_agent_project_fk",
      columns: [table.agentId, table.projectId],
      foreignColumns: [agent.id, agent.projectId],
    }),
    // What answers "which mock tools name this agent" when deleting one has to
    // say.
    index("mock_tool_agent_agent_id_idx").on(table.agentId),
  ],
);
