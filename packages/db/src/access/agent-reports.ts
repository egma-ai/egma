import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "../client.ts";
import { simulation } from "../schema/runs.ts";
import { testVersion } from "../schema/tests.ts";
import { validClaimant } from "./claimants.ts";
import type { AuthContext } from "./context.ts";
import { authorize, here } from "./permissions.ts";
import { mockToolsOfVersion, type TestMockTool } from "./tests.ts";
import { within } from "./within.ts";

/**
 * The egma SDK's hello for a Pipecat bot, which reaches egma's server over
 * HTTPS rather than inside the room. The latest hello is kept on the
 * simulation row, so the simulator — another process — can learn that the
 * agent reported, and which tools it has, while it waits for the bot.
 */

/** One tool of the agent's census, as the SDK reported it. */
export type AgentReportTool = {
  readonly name: string;
  readonly schema?: unknown;
  /** A Pipecat Flows function, which egma cannot mock yet. */
  readonly flows?: true;
};

/** What the latest hello said, as the simulator reads it. */
export type AgentReport =
  | {
      readonly state: "accepted";
      /** When the first accepted hello of this attempt arrived. */
      readonly firstAt: string;
      /** When the latest hello arrived. */
      readonly at: string;
      readonly protocolVersion: 1;
      readonly tools: readonly AgentReportTool[];
      readonly mockedTools: readonly string[];
    }
  | {
      readonly state: "refused";
      readonly at: string;
      readonly code: number;
      readonly message: string;
      readonly tools: readonly AgentReportTool[];
    };

/** A hello's outcome, before the store stamps its times. */
export type NewAgentReport =
  | {
      readonly state: "accepted";
      readonly tools: readonly AgentReportTool[];
      readonly mockedTools: readonly string[];
    }
  | {
      readonly state: "refused";
      readonly code: number;
      readonly message: string;
      readonly tools: readonly AgentReportTool[];
    };

/** A live Daily room simulation, with the answers its pinned test version holds. */
export type LiveDailyRoomSimulation = {
  readonly simulationId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly testVersionId: string;
  /** The pinned test version's mock tools, in authored order. */
  readonly answers: readonly TestMockTool[];
};

/** The statuses in which a simulation can still be conducting. */
const CONDUCTING = ["claimed", "running"] as const;

/**
 * The simulation a provider reference names, when it is a Daily room
 * simulation of the caller's project that is still conducting and whose
 * reference the simulator registered. Anything else answers undefined, which
 * the SDK routes turn into "not a simulation".
 */
export async function resolveLiveDailyRoomSimulation(
  auth: AuthContext,
  providerReference: string,
): Promise<LiveDailyRoomSimulation | undefined> {
  authorize(auth, "ingest_traces", here(auth));
  if (auth.projectId === undefined || providerReference === "") return undefined;

  const [row] = await db()
    .select({
      id: simulation.id,
      runId: simulation.runId,
      agentId: simulation.agentId,
      testVersionId: simulation.testVersionId,
      mockTools: testVersion.mockTools,
    })
    .from(simulation)
    .innerJoin(testVersion, eq(simulation.testVersionId, testVersion.id))
    .where(
      within(
        auth,
        simulation,
        and(
          eq(simulation.projectId, auth.projectId),
          eq(simulation.id, providerReference),
          eq(simulation.providerReference, providerReference),
          eq(simulation.connectionType, "daily_room"),
          inArray(simulation.status, [...CONDUCTING]),
          isNull(simulation.cancelRequestedAt),
        ),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;

  return {
    simulationId: row.id,
    runId: row.runId,
    agentId: row.agentId,
    testVersionId: row.testVersionId,
    answers: mockToolsOfVersion(row.mockTools, row.testVersionId),
  };
}

/** The census as the row stores it: names, schemas where sent, Flows marks. */
function storedTools(tools: readonly AgentReportTool[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.schema === undefined ? {} : { schema: tool.schema }),
    ...(tool.flows === true ? { flows: true } : {}),
  }));
}

/**
 * Keep the latest hello on a still-conducting Daily room simulation. An
 * accepted report keeps the time of the first accepted one. Answers false when
 * the row is no longer live, which leaves it untouched.
 */
export async function recordAgentReport(
  auth: AuthContext,
  simulationId: string,
  report: NewAgentReport,
): Promise<boolean> {
  authorize(auth, "ingest_traces", here(auth));
  if (auth.projectId === undefined) return false;

  const at = new Date().toISOString();
  const stored =
    report.state === "accepted"
      ? {
          state: "accepted",
          at,
          protocol_version: 1,
          tools: storedTools(report.tools),
          mocked_tools: [...report.mockedTools],
        }
      : {
          state: "refused",
          at,
          code: report.code,
          message: report.message,
          tools: storedTools(report.tools),
        };
  const written =
    report.state === "accepted"
      ? sql`${JSON.stringify(stored)}::jsonb || jsonb_build_object('first_at',
          case when ${simulation.agentReport}->>'state' = 'accepted'
            then ${simulation.agentReport}->'first_at'
            else to_jsonb(${at}::text) end)`
      : sql`${JSON.stringify(stored)}::jsonb`;

  const [updated] = await db()
    .update(simulation)
    .set({ agentReport: written })
    .where(
      within(
        auth,
        simulation,
        and(
          eq(simulation.projectId, auth.projectId),
          eq(simulation.id, simulationId),
          eq(simulation.connectionType, "daily_room"),
          inArray(simulation.status, [...CONDUCTING]),
          isNull(simulation.cancelRequestedAt),
        ),
      ),
    )
    .returning({ id: simulation.id });
  return updated !== undefined;
}

/** The stored report read back, or null for a row whose value is unreadable. */
function reportFromRow(value: unknown): AgentReport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const held = value as Record<string, unknown>;
  const tools = Array.isArray(held["tools"])
    ? (held["tools"] as unknown[]).flatMap((tool): AgentReportTool[] => {
        if (typeof tool !== "object" || tool === null) return [];
        const entry = tool as Record<string, unknown>;
        if (typeof entry["name"] !== "string") return [];
        return [
          {
            name: entry["name"],
            ...(entry["schema"] === undefined ? {} : { schema: entry["schema"] }),
            ...(entry["flows"] === true ? { flows: true as const } : {}),
          },
        ];
      })
    : [];
  const at = typeof held["at"] === "string" ? held["at"] : "";
  if (held["state"] === "accepted") {
    const mocked = Array.isArray(held["mocked_tools"])
      ? (held["mocked_tools"] as unknown[]).filter(
          (name): name is string => typeof name === "string",
        )
      : [];
    return {
      state: "accepted",
      firstAt: typeof held["first_at"] === "string" ? held["first_at"] : at,
      at,
      protocolVersion: 1,
      tools,
      mockedTools: mocked,
    };
  }
  if (held["state"] === "refused") {
    return {
      state: "refused",
      at,
      code: typeof held["code"] === "number" ? held["code"] : 0,
      message: typeof held["message"] === "string" ? held["message"] : "",
      tools,
    };
  }
  return null;
}

/**
 * The latest hello for the simulator that holds this simulation's claim:
 * the report, null while none has arrived, or undefined when this claimant does
 * not hold a conducting row.
 */
export async function readAgentReport(
  auth: AuthContext,
  input: { readonly simulationId: string; readonly claimant: string },
): Promise<AgentReport | null | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));
  if (auth.via !== "simulator") return undefined;

  const [row] = await db()
    .select({ agentReport: simulation.agentReport })
    .from(simulation)
    .where(
      within(
        auth,
        simulation,
        and(
          eq(simulation.id, input.simulationId),
          eq(simulation.claimedBy, validClaimant(input.claimant)),
          inArray(simulation.status, [...CONDUCTING]),
        ),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
  return row.agentReport === null ? null : reportFromRow(row.agentReport);
}
