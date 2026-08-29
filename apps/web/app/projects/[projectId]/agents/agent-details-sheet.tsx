"use client";

import Link from "next/link";
import { useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Refusal } from "@/lib/api.ts";
import type { ListedAgentWithConnections } from "@/lib/agents.ts";
import { cn } from "@/lib/utils";
import { Failure, Loading, NotFound } from "@/ui/page-state.tsx";
import { RelativeInstant } from "@/ui/relative-time.tsx";

import { RowMenu, RowMenuDestructive, RowMenuItem } from "./row-menu.tsx";

export type AgentProvider = "retell" | "livekit";
export type SimulationCapability = "Configured" | "Not configured";
export type MonitoringCapability =
  | "Active"
  | "Stopped"
  | "Not configured"
  | "Configured via code";
/**
 * Whether any of this agent's lanes runs its simulations with mocked tools.
 *
 * **Never "every simulation": the switch is per connection.** A text lane can
 * be mocked while the phone lane beside it reaches the customer's real backend,
 * so an agent-wide claim would be false for the phone lane every time. This
 * word summarises the lanes; the mock-tools surface shows each one.
 *
 * `Not available` is the honest third state rather than a fourth word for off:
 * mocking is a Retell seam, and a LiveKit agent's tools already run in the
 * customer's own process where the Egma SDK stands in front of them. Saying
 * "Off" there would offer a switch that has nothing to switch.
 */
export type MockToolsCapability = "On" | "Off" | "Not available";

/**
 * The provider that owns this agent's setup flow.
 *
 * A live connection is stronger evidence than an older declaration on the
 * agent. When both providers are present, the declaration decides which
 * provider-specific monitoring model the details sheet must explain.
 */
export function providerOf(agent: ListedAgentWithConnections): AgentProvider {
  const retell = agent.connections.some(
    (connection) => connection.agentPlatform === "retell",
  );
  const livekit = agent.connections.some(
    (connection) => connection.agentPlatform === "livekit",
  );
  if (retell && !livekit) return "retell";
  if (livekit && !retell) return "livekit";
  return agent.agentPlatform;
}

/** A saved simulation connection is the whole configured state. */
export function simulationCapabilityOf(
  agent: ListedAgentWithConnections,
): SimulationCapability {
  const configured = agent.connections.some(
    (connection) =>
      connection.connectionType === "livekit_room" ||
      connection.connectionType === "retell_text_mode" ||
      connection.connectionType === "retell_web_call" ||
      (connection.connectionType === "phone_number" &&
        connection.agentPlatform === "retell"),
  );
  return configured ? "Configured" : "Not configured";
}

/**
 * Retell has a durable pull switch. LiveKit does not, so its one truthful UI
 * state says that monitoring is configured in the customer's code.
 */
export function monitoringCapabilityOf(
  agent: ListedAgentWithConnections,
): MonitoringCapability {
  if (providerOf(agent) === "livekit") {
    return "Configured via code";
  }
  if (agent.pullProductionCalls) return "Active";
  if (agent.monitoringConfigured) return "Stopped";
  return "Not configured";
}

/** Whether this agent can have a mocked world at all, and whether it has one. */
export function mockToolsCapabilityOf(
  agent: ListedAgentWithConnections,
): MockToolsCapability {
  if (providerOf(agent) !== "retell") return "Not available";
  // The switch is per connection now, so the agent's summary word is "any of
  // its lanes has it on".
  return agent.connections.some((connection) => connection.mockToolsEnabled)
    ? "On"
    : "Off";
}

function stateClass(
  state: SimulationCapability | MonitoringCapability | MockToolsCapability,
): string {
  if (state === "Configured" || state === "Active" || state === "On") {
    return "text-success";
  }
  if (state === "Stopped" || state === "Configured via code") return "text-warning";
  return "text-faint";
}

export function CapabilityState({
  state,
}: {
  readonly state: SimulationCapability | MonitoringCapability | MockToolsCapability;
}) {
  return <span className={stateClass(state)}>{state}</span>;
}

/** The evidence or next fact that sits under the monitoring state. */
export function MonitoringEvidence({
  agent,
  now,
}: {
  readonly agent: ListedAgentWithConnections;
  readonly now: number;
}) {
  const provider = providerOf(agent);
  const state = monitoringCapabilityOf(agent);

  if (provider === "livekit") return null;

  if (state === "Active" && agent.lastReceivedAt !== null) {
    return (
      <>
        Last call received <RelativeInstant instant={agent.lastReceivedAt} now={now} />
      </>
    );
  }
  if (state === "Active") return <>Retell account is connected</>;
  if (state === "Stopped") return <>Production monitoring is stopped</>;
  if (agent.retellModality === "chat") {
    return <>Production monitoring needs a Retell voice agent</>;
  }
  return <>Set up monitoring to receive production calls</>;
}

/**
 * The read view opened by selecting an agent row.
 *
 * It shows only facts the list response can prove. Provider secrets are not
 * shown in this read view.
 */
export function AgentDetailsSheet({
  agent,
  home,
  now,
  mayAuthor,
  whyNotChange,
  stopping,
  stopRefused,
  onStopMonitoring,
  onMockTools,
  onRename,
  onDelete,
  onClose,
  returnFocusTo,
}: {
  readonly agent: ListedAgentWithConnections;
  readonly home: string;
  readonly now: number;
  readonly mayAuthor: boolean;
  readonly whyNotChange?: string;
  readonly stopping: boolean;
  readonly stopRefused: Refusal | null;
  readonly onStopMonitoring: () => void;
  /** Open the panel that explains, discovers and ticks the mocked world. */
  readonly onMockTools: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
  /** The row control that opened this sheet, when there was one. */
  readonly returnFocusTo?: HTMLElement | null;
}) {
  const provider = providerOf(agent);
  const simulation = simulationCapabilityOf(agent);
  const monitoring = monitoringCapabilityOf(agent);
  const mockTools = mockToolsCapabilityOf(agent);
  const setup = (goal: "simulation" | "monitoring") =>
    `${home}?sheet=connect&agent=${encodeURIComponent(agent.id)}&goal=${goal}&platform=${provider}`;
  const restoreFocus = useSheetReturnFocus(returnFocusTo);

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        aria-describedby={undefined}
        onCloseAutoFocus={restoreFocus}
      >
        <SheetHeader
          actions={
            <RowMenu label={`Actions for ${agent.name}`}>
              <RowMenuItem onSelect={onRename} why={whyNotChange}>
                Rename agent
              </RowMenuItem>
              <RowMenuDestructive onSelect={onDelete} why={whyNotChange}>
                Delete agent
              </RowMenuDestructive>
            </RowMenu>
          }
        >
          <SheetTitle>{agent.name}</SheetTitle>
        </SheetHeader>

        <SheetBody className="gap-6">
          <section className="flex min-w-0 flex-col gap-4" aria-label="Agent details">
            <FactList facts={providerFacts(agent, provider)} />
          </section>

          <section className="flex min-w-0 flex-col gap-3" aria-labelledby="agent-connections-heading">
            <div className="flex items-center justify-between gap-3">
              <h2 className="m-0 text-base font-medium" id="agent-connections-heading">
                Connections
              </h2>
              <Link className="text-sm underline decoration-border underline-offset-4 pointer-hover:decoration-foreground" href={setup("simulation")}>
                Add connection
              </Link>
            </div>
            {agent.connections.length === 0 ? (
              <p className="m-0 border border-border p-4 text-sm text-faint">
                No connections yet
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col border border-border p-0">
                {agent.connections.map((connection) => (
                  <li
                    className="flex min-w-0 items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0"
                    key={connection.id}
                  >
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {connection.name}
                    </span>
                    <Link
                      className="flex-none text-sm underline decoration-border underline-offset-4 pointer-hover:decoration-foreground"
                      href={`${home}?sheet=connection&agent=${encodeURIComponent(agent.id)}&connection=${encodeURIComponent(connection.id)}`}
                    >
                      View
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex min-w-0 flex-col gap-3" aria-labelledby="agent-capabilities-heading">
            <h2 className="m-0 text-base font-medium" id="agent-capabilities-heading">
              Capabilities
            </h2>
            <div className="flex min-w-0 flex-col border border-border">
              <CapabilityRow
                label="Simulation"
                state={<CapabilityState state={simulation} />}
                action={
                  simulation === "Configured" ? undefined : (
                    <Link
                      className="text-sm underline decoration-border underline-offset-4 pointer-hover:decoration-foreground"
                      href={setup("simulation")}
                    >
                      Set up simulation
                    </Link>
                  )
                }
              />
              <CapabilityRow
                label="Production monitoring"
                state={<CapabilityState state={monitoring} />}
                detail={
                  provider === "livekit" ? undefined : (
                    <MonitoringEvidence agent={agent} now={now} />
                  )
                }
                action={
                  provider === "livekit" ? (
                    <Link
                      className="text-sm underline decoration-border underline-offset-4 pointer-hover:decoration-foreground"
                      href={setup("monitoring")}
                    >
                      View setup instructions
                    </Link>
                  ) : monitoring === "Active" ? (
                    <Button
                      className="h-auto min-h-0 p-0 text-sm underline decoration-border underline-offset-4 pointer-hover:decoration-foreground"
                      disabled={!mayAuthor || stopping}
                      onClick={onStopMonitoring}
                      type="button"
                      variant="ghost"
                      {...(whyNotChange === undefined ? {} : { why: whyNotChange })}
                    >
                      {stopping ? "Stopping…" : "Stop monitoring"}
                    </Button>
                  ) : (
                    <Link
                      className="text-sm underline decoration-border underline-offset-4 pointer-hover:decoration-foreground"
                      href={setup("monitoring")}
                    >
                      {monitoring === "Stopped" ? "Resume monitoring" : "Set up monitoring"}
                    </Link>
                  )
                }
              />
              {mockTools === "Not available" ? null : (
                <CapabilityRow
                  label="Mock tools during simulations"
                  state={<CapabilityState state={mockTools} />}
                  detail={
                    mockTools === "On"
                      ? "A temporary version per run, deleted after. Your live agent is untouched."
                      : "Simulations reach your real tools."
                  }
                  action={
                    <Button
                      className="h-auto min-h-0 p-0 text-sm underline decoration-border underline-offset-4 pointer-hover:decoration-foreground"
                      disabled={!mayAuthor}
                      onClick={onMockTools}
                      type="button"
                      variant="ghost"
                      {...(whyNotChange === undefined ? {} : { why: whyNotChange })}
                    >
                      {mockTools === "On" ? "Review mock tools" : "Set up mock tools"}
                    </Button>
                  }
                />
              )}
            </div>
            {stopRefused === null ? null : (
              <p className="m-0 text-sm text-failure" role="alert">
                {stopRefused.message}
              </p>
            )}
          </section>
        </SheetBody>

        <SheetFooter>
          <Button onClick={onClose} size="lg" type="button">
            Done
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export type AgentDetailsReadState =
  | { readonly status: "loading" }
  | {
      readonly status: "missing" | "failed";
      readonly refusal: Refusal;
    };

/**
 * What a copied agent link shows while its one agent-specific read is not
 * ready. The sheet stays present for every answer, so a failed or missing
 * link never looks like the query was ignored.
 */
export function AgentDetailsReadStateSheet({
  state,
  onRetry,
  onClose,
  returnFocusTo,
}: {
  readonly state: AgentDetailsReadState;
  readonly onRetry: () => void;
  readonly onClose: () => void;
  readonly returnFocusTo?: HTMLElement | null;
}) {
  const restoreFocus = useSheetReturnFocus(returnFocusTo);

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        aria-describedby={undefined}
        onCloseAutoFocus={restoreFocus}
      >
        <SheetHeader>
          <SheetTitle>Agent details</SheetTitle>
        </SheetHeader>

        <SheetBody>
          {state.status === "loading" ? (
            <Loading what="agent details" />
          ) : state.status === "missing" ? (
            <NotFound message={state.refusal.message} />
          ) : (
            <Failure
              title="Egma could not load this agent."
              message={state.refusal.message}
              onRetry={onRetry}
            />
          )}
        </SheetBody>

        <SheetFooter>
          <Button onClick={onClose} size="lg" type="button">
            Done
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Keep the exact row opener stable until Radix has finished closing. */
function useSheetReturnFocus(returnFocusTo: HTMLElement | null | undefined) {
  const target = useRef<HTMLElement | null>(returnFocusTo ?? null);

  return (event: Event) => {
    const opener = target.current;
    if (opener === null || !opener.isConnected) return;
    event.preventDefault();
    opener.focus();
  };
}

function FactList({ facts }: { readonly facts: readonly Fact[] }) {
  return (
    <dl className="m-0 flex min-w-0 flex-col gap-3">
      {facts.map((fact) => (
        <div className="flex min-w-0 flex-col gap-1" key={fact.label}>
          <dt className="m-0 text-sm text-faint">{fact.label}</dt>
          <dd
            className={cn(
              "m-0 min-w-0 text-sm text-foreground [overflow-wrap:anywhere]",
              fact.mono === true && "font-mono",
            )}
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

type Fact = {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
};

function providerFacts(
  agent: ListedAgentWithConnections,
  provider: AgentProvider,
): readonly Fact[] {
  if (provider === "retell") {
    return [
      {
        label: "Retell agent",
        value: agent.name,
      },
      {
        label: "Modality",
        value:
          agent.retellModality === null
            ? "Not known"
            : agent.retellModality === "voice"
              ? "Voice"
              : "Chat",
      },
    ];
  }

  const room = agent.connections.find(
    (connection) => connection.connectionType === "livekit_room",
  );
  const liveKitAgentName = room?.config["agentName"];
  return [
    {
      label: "LiveKit agent",
      value:
        liveKitAgentName ??
        (room?.accessVariant === "livekit_room.customer_token_endpoint"
          ? "Provided by token endpoint"
          : "Not set"),
      mono: liveKitAgentName !== undefined,
    },
    {
      label: "WebSocket URL",
      value: room?.config["url"] ?? "Not saved",
      mono: room?.config["url"] !== undefined,
    },
    {
      label: "Access",
      value: room?.productLabel ?? "Not configured",
    },
  ];
}

function CapabilityRow({
  label,
  state,
  detail,
  action,
}: {
  readonly label: string;
  readonly state: ReactNode;
  readonly detail?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 border-t border-border p-4 first:border-t-0">
      <div className="flex min-w-0 flex-col gap-1 text-sm">
        <p className="m-0 text-foreground">{label}</p>
        <p className="m-0">{state}</p>
        {detail === undefined ? null : (
          <p className="m-0 text-faint">{detail}</p>
        )}
      </div>
      {action === undefined ? null : <div className="flex-none">{action}</div>}
    </div>
  );
}
