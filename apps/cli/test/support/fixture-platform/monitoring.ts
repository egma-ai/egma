/**
 * The monitoring endpoints of the fixture platform.
 *
 * Egma pulls a Retell account itself, from a key the terminal pastes once — so
 * the CLI never speaks to Retell on this path, and there is no fake Retell
 * behind this group. What stands in for the account is seeded here: a key, and
 * the voice agents it opens.
 *
 * Three shapes are the contract's rather than this file's, and each of them is
 * something the CLI would get wrong if the fixture were kinder than the real
 * platform:
 *
 * - **Discovery is the one list that carries registration facts.** It answers
 *   which of the account's agents this project already registers, and which of
 *   those already pull — which is what makes it a picker rather than a
 *   catalogue.
 * - **Start is one commit that registers, seals and switches on.** A platform
 *   agent this project does not register yet is registered by the same request
 *   that starts watching it, because watching one *means* registering it
 *   (ADR-0015).
 * - **A refusal is per tick, never per request.** A tick that loses comes back
 *   in `refused` with a sentence, and the ticks beside it still start. There is
 *   no 404 and no 409 on start: a request naming at least one platform agent is
 *   answered entry by entry.
 *
 * The sealed key never comes back. It is pushed onto `monitoringKeys` so a
 * check can prove it reached the platform without reading it off a recorded
 * request body, and the row answers its last four characters and nothing more.
 */

import { blankAgent, type StoredAgent } from "./agents.ts";
import { given, NOT_AUTHENTICATED, refuse, text } from "./reading.ts";
import type { FixtureAnswer, RouteGroup } from "./server.ts";

/** One voice agent on the Retell account a pasted key opens. */
export type RetellAccountAgent = {
  readonly id: string;
  readonly name: string;
};

/** Why one ticked platform agent did not start. */
export type StartRefusalReason =
  | "contested"
  | "name_taken"
  | "not_found"
  | "archived";

export type MonitoringControls = {
  /**
   * Seed the Retell account one key opens, as Egma's own discovery reads it.
   *
   * The CLI never asks Retell anything on this path, so the account lives here
   * rather than in a fake Retell service.
   */
  account(apiKey: string, agents: readonly RetellAccountAgent[]): void;
  /**
   * Every monitoring key this fixture was handed, in the order it arrived.
   *
   * Kept apart from the connection credentials a registration seals, because
   * the two custodies are separate by design: a check that one paste filled
   * both tables reads one list each.
   */
  readonly monitoringKeys: readonly string[];
  /** Make the next start of one platform agent refuse, for the named reason. */
  refuseStart(
    platformAgentId: string,
    reason: StartRefusalReason,
    message?: string,
  ): void;
};

/** The sentence each seeded refusal says when the test gave none of its own. */
const REFUSAL_SENTENCES: Readonly<Record<StartRefusalReason, string>> = {
  contested:
    "another agent already watches this Retell agent. One Egma agent watches " +
    "one Retell agent, so turn that agent's switch off first, or start " +
    "monitoring from it instead.",
  name_taken:
    "this project already has an agent with that name. Open that agent and " +
    "start monitoring from there, or rename the Retell agent.",
  not_found:
    "there is no agent with that id available in this project. Check the " +
    "link, or choose it from the current project.",
  archived: "that agent is archived. Restore it, then start monitoring it.",
};

/** Shorter than any key a platform issues, and the access layer's own bound. */
const SHORTEST_KEY = 8;

export function monitoringRoutes(options: {
  readonly holdsKey: (key: string) => boolean;
  readonly projectId: string;
  /** The agent rows this fixture holds — written to, not copied. */
  readonly roster: readonly StoredAgent[];
}): { readonly group: RouteGroup; readonly controls: MonitoringControls } {
  const accounts = new Map<string, readonly RetellAccountAgent[]>();
  const monitoringKeys: string[] = [];
  const seededRefusals = new Map<
    string,
    { readonly reason: StartRefusalReason; readonly message: string }
  >();

  const agents = options.roster as StoredAgent[];

  const authorized = (headers: Record<string, string | undefined>): boolean => {
    const offered = (headers["authorization"] ?? "").replace(/^Bearer\s+/iu, "");
    return offered !== "" && options.holdsKey(offered);
  };

  const notAuthenticated: FixtureAnswer = {
    status: 401,
    body: NOT_AUTHENTICATED,
  };

  const unprocessable = (message: string): FixtureAnswer =>
    refuse(422, "unprocessable", message);

  /**
   * What this project already registers, keyed by the platform's own id.
   *
   * Two switched-off agents may lawfully name one platform agent, so the one
   * actually watching wins the slot — it is the one worth naming on a screen.
   */
  const registeredByPlatformAgent = (): ReadonlyMap<string, StoredAgent> => {
    const known = new Map<string, StoredAgent>();
    for (const one of agents) {
      if (one.projectId !== options.projectId) continue;
      if (one.agentPlatform !== "retell" || one.platformAgentId === null) continue;
      const held = known.get(one.platformAgentId);
      if (
        held === undefined ||
        (!held.pullProductionCalls && one.pullProductionCalls)
      ) {
        known.set(one.platformAgentId, one);
      }
    }
    return known;
  };

  const seal = (one: StoredAgent, apiKey: string): void => {
    monitoringKeys.push(apiKey);
    one.monitoringApiKey = apiKey;
    one.monitoringApiKeyHint = apiKey.slice(-4);
    one.updatedAt = new Date().toISOString();
  };

  const group: RouteGroup = {
    name: "monitoring",
    routes: [
      {
        /** Validate a key and answer only the account's voice agents. */
        method: "POST",
        path: "/v1/monitoring/retell/discover",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          const body = request.body ?? {};
          const apiKey = given(text(body["apiKey"]));
          if (apiKey === undefined) {
            return unprocessable("Enter a Retell API key.");
          }
          const account = accounts.get(apiKey);
          if (account === undefined) {
            return unprocessable(
              "Retell rejected this API key. Check the key and its Agent Read permission.",
            );
          }
          const known = registeredByPlatformAgent();
          return {
            status: 200,
            body: {
              agents: [...account]
                .map((one) => {
                  const held = known.get(one.id);
                  return {
                    id: one.id,
                    name: one.name || one.id,
                    registeredAgentId: held?.id ?? null,
                    registeredAgentName: held?.name ?? null,
                    pullProductionCalls: held?.pullProductionCalls ?? false,
                  };
                })
                .sort((left, right) => left.name.localeCompare(right.name)),
            },
          };
        },
      },
      {
        /**
         * Start pulling: seal the key onto every agent this names, flip each
         * switch, and register a platform agent this project does not know yet.
         */
        method: "POST",
        path: "/v1/monitoring/start",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          const body = request.body ?? {};

          if (text(body["agentPlatform"]) !== "retell") {
            return unprocessable(
              "Egma pulls production calls from Retell. A LiveKit Agents agent " +
                "pushes its own spans and needs no setup here.",
            );
          }
          const apiKey = given(text(body["apiKey"]));
          if (apiKey === undefined || apiKey.length < SHORTEST_KEY) {
            return unprocessable("Enter a Retell API key.");
          }
          const asked = body["watch"];
          if (!Array.isArray(asked) || asked.length === 0) {
            return unprocessable("Choose at least one agent to watch, then try again.");
          }

          const known = registeredByPlatformAgent();
          const watching: Record<string, unknown>[] = [];
          const refused: Record<string, unknown>[] = [];

          for (const entry of asked) {
            const one = (entry ?? {}) as Record<string, unknown>;
            const platformAgentId = text(one["platformAgentId"]);
            if (platformAgentId === "") {
              return unprocessable(
                "Each agent to watch needs the platform's own id for it.",
              );
            }
            const seeded = seededRefusals.get(platformAgentId);
            if (seeded !== undefined) {
              seededRefusals.delete(platformAgentId);
              refused.push({
                platformAgentId,
                reason: seeded.reason,
                message: seeded.message,
              });
              continue;
            }

            const namedAgentId = given(text(one["agentId"]));
            let held =
              namedAgentId === undefined
                ? known.get(platformAgentId)
                : agents.find((row) => row.id === namedAgentId);
            if (namedAgentId !== undefined && held === undefined) {
              refused.push({
                platformAgentId,
                reason: "not_found",
                message:
                  `There is no agent ${namedAgentId} available in this project. ` +
                  "Check the link, or choose it from the current project.",
              });
              continue;
            }

            let created = false;
            if (held === undefined) {
              const name = given(text(one["name"])) ?? platformAgentId;
              if (
                agents.some(
                  (row) => row.projectId === options.projectId && row.name === name,
                )
              ) {
                refused.push({
                  platformAgentId,
                  reason: "name_taken",
                  message:
                    `This project already has an agent called “${name}”. ` +
                    "Open that agent and start monitoring from there, or rename " +
                    "the Retell agent.",
                });
                continue;
              }
              held = blankAgent(options.projectId, name, "retell");
              agents.push(held);
              created = true;
            }

            // Two switched-on agents may not name one platform agent. The
            // database is what decides this on the real platform; here it is
            // the same rule, said in the same words.
            const contesting = agents.find(
              (row) =>
                row !== held &&
                row.projectId === options.projectId &&
                row.agentPlatform === "retell" &&
                row.platformAgentId === platformAgentId &&
                row.pullProductionCalls,
            );
            if (contesting !== undefined) {
              if (created) agents.splice(agents.indexOf(held), 1);
              refused.push({
                platformAgentId,
                reason: "contested",
                message:
                  `${platformAgentId} is already watched by ` +
                  `“${contesting.name}”. One Egma agent watches one Retell ` +
                  "agent, so turn that agent's switch off first, or start " +
                  "monitoring from it instead.",
              });
              continue;
            }

            held.agentPlatform = "retell";
            held.platformAgentId = platformAgentId;
            held.pullProductionCalls = true;
            seal(held, apiKey);

            watching.push({
              agentId: held.id,
              agentName: held.name,
              platformAgentId,
              created,
              pullProductionCalls: true,
            });
          }

          return { status: 200, body: { watching, refused } };
        },
      },
      {
        /** Stop pulling. Everything stored stays stored, key included. */
        method: "POST",
        path: "/v1/monitoring/agents/:agentId/stop",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          const held = agents.find((one) => one.id === request.params["agentId"]);
          if (held === undefined) {
            return refuse(
              404,
              "not_found",
              `There is no agent ${request.params["agentId"] ?? ""} available in ` +
                "this project. Check the link, or choose it from the current project.",
            );
          }
          held.pullProductionCalls = false;
          held.updatedAt = new Date().toISOString();
          return {
            status: 200,
            body: {
              monitoring: {
                agentId: held.id,
                pullProductionCalls: held.pullProductionCalls,
                agentPlatform: held.agentPlatform,
                platformAgentId: held.platformAgentId,
                monitoringApiKeyHint: held.monitoringApiKeyHint,
                lastReceivedAt: held.lastReceivedAt,
              },
            },
          };
        },
      },
    ],
  };

  return {
    group,
    controls: {
      account(apiKey, seeded) {
        accounts.set(apiKey, seeded);
      },
      monitoringKeys,
      refuseStart(platformAgentId, reason, message) {
        seededRefusals.set(platformAgentId, {
          reason,
          message: message ?? REFUSAL_SENTENCES[reason],
        });
      },
    },
  };
}
