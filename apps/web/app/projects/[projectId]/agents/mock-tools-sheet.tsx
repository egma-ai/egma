"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  addConnection,
  discoverMockTools,
  updateConnection,
} from "@egma/platform-api/client";
import type { DiscoverMockToolsResponse } from "@egma/platform-api/client";

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
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { Refused } from "@/ui/form.tsx";
import { Failure, Loading } from "@/ui/page-state.tsx";

/**
 * Mock tools, one switch per lane: what each lane would cover, and what none of
 * them claims.
 *
 * **The switch is per connection, because the lane is what decides whether a
 * mocked run is a thing Egma can conduct at all.** A text lane can run mocked
 * while the phone connection beside it reaches the customer's real backend. So
 * this surface never says "every simulation against this agent runs in a mocked
 * world" — it says, lane by lane, what that lane does. The phone lane says
 * plainly that it reaches real tools and carries no switch: it is the real
 * telephony lane by design, and it can never hold a mock.
 *
 * **One consent, and only for the web-call lane.** Turning mocks on for a web
 * call is standing permission for Egma to write to the customer's Retell
 * account at the start of every run, so it goes through one screen carrying the
 * four promises and one button. There is **no per-number checkbox**: pinning a
 * `latest`-riding number and putting it back is one of those four promises, so
 * one informed yes is the whole ceremony. **The text lane shows no consent at
 * all** — it writes nothing to the customer's account, and arrives with mocks
 * already on.
 *
 * **The consent flow mints the web-call connection when the agent has none**,
 * so the feature can never refuse a person with a step the product cannot
 * perform. A web-call connection created any other way keeps mocks off until
 * this screen is accepted.
 *
 * **Every tool is shown in its honest class**, never a count of "covered". The
 * three classes are the product's own words and they are read live, stored
 * nowhere: the ones Egma answers, the ones that run inside Retell where no
 * interception reaches, and the ones Egma could reach and does not yet. A
 * person reading this has to be able to see exactly how isolated a mocked run
 * really is.
 *
 * **A transfer and an SMS get a warning of their own**, because they act
 * outside the call: a real leg placed, a real message sent, even in a mocked
 * run. They are named rather than quietly left out of a coverage number.
 *
 * **A refusal is shown as a sentence, never as a disabled control.** Three
 * things stop mocks going on, and each has a different next move, so the panel
 * shows which one it is and what to do about it (`DESIGN.md`: make every state
 * truthful).
 *
 * The surface is the house modal side sheet, and the only motion is the arrival
 * of the discovery result, which is a piece of the panel a person did not put
 * there.
 */

type Discovery = DiscoverMockToolsResponse;
type DiscoveredTool = Discovery["tools"][number];
type DiscoveredNumber = Discovery["numbers"][number];

type Read =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly found: Discovery }
  | { readonly status: "failed"; readonly refusal: Refusal };

/** The three classes, in the order a person reads them. */
const CLASSES = [
  {
    key: "mocked",
    title: "Egma answers these",
    lead: "Every call goes to Egma. Your backend is never reached.",
  },
  {
    key: "notInterceptable",
    title: "Cannot be intercepted",
    lead: "These run inside Retell, where no URL leads. They still run for real.",
  },
  {
    key: "notInThisVersion",
    title: "Not in this version",
    lead: "Egma could stand in front of these and does not yet.",
  },
] as const;

/**
 * The lanes this surface knows, and what each one is.
 *
 * `phone_number` is here on purpose: it carries no switch and it is shown
 * anyway, because a person deciding how isolated their runs are has to see the
 * lane that is never isolated. Leaving it out would be the same over-claim in a
 * quieter form.
 */
const LANES = {
  retell_text_mode: {
    label: "Text",
    /** Whether this lane's switch can be turned on at all. */
    mockable: true,
    /** Whether turning it on goes through the consent screen. */
    consents: false,
    on: "Runs over this connection are conducted with mocked tools.",
    off: "Runs over this connection reach your real tools.",
  },
  retell_web_call: {
    label: "Web call",
    mockable: true,
    consents: true,
    on: "Runs over this connection are conducted with mocked tools.",
    off: "Runs over this connection reach your real tools.",
  },
  phone_number: {
    label: "Phone call",
    mockable: false,
    consents: false,
    on: "",
    off: "Runs over this connection reach your real tools. A phone call is the real telephony lane and is never mocked.",
  },
} as const;

type LaneType = keyof typeof LANES;

function laneOf(connectionType: string): LaneType | null {
  return connectionType in LANES ? (connectionType as LaneType) : null;
}

/** The four promises, in the words the spec settled. One screen, one button. */
export const CONSENT_PROMISES: readonly string[] = [
  "Create a temporary version of this agent in Retell when a run starts, with every tool it can intercept pointed at Egma, and delete that temporary version when the run ends.",
  "Never modify the version your agent serves. Egma reads it back during every run to prove it did not move.",
  "Pin a phone number that follows Retell's latest pointer to the version it already reaches, for the length of each run, and put the binding back exactly as it was.",
  "Never dial your published number for a mocked run. A real caller during a run reaches your real agent with your real tools.",
];

export function MockToolsSheet({
  projectId,
  agent,
  mayAuthor,
  why,
  onClose,
  onChanged,
}: {
  readonly projectId: string;
  readonly agent: ListedAgentWithConnections;
  readonly mayAuthor: boolean;
  /** Why this cannot be changed, when it cannot. Its presence disables the switch. */
  readonly why?: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  /** Which connection is being written to, so only its own switch reads busy. */
  const [saving, setSaving] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [seeded, setSeeded] = useState<readonly string[] | null>(null);
  /**
   * The web-call consent screen, while it is open.
   *
   * `"mint"` is the same screen for an agent that has no web-call connection
   * yet: one yes both creates the lane and turns its switch on, because a
   * person who has read the four promises has answered the only question there
   * is. The feature can never refuse somebody with a step the product cannot
   * perform.
   */
  const [consenting, setConsenting] = useState<string | "mint" | null>(null);

  /**
   * Every lane on this agent, in the order the connections are held.
   *
   * **One switch per connection, and no `find` picking whichever comes first.**
   * Which lane an agent's mocks are on for is a fact about that lane, so the
   * surface shows them all and each one is its own control.
   */
  const lanes = agent.connections.flatMap((connection) => {
    const lane = laneOf(connection.connectionType);
    return lane === null ? [] : [{ connection, lane, of: LANES[lane] }];
  });
  const hasWebCall = lanes.some((one) => one.lane === "retell_web_call");

  const discover = useCallback(
    /**
     * `alive` is what gates every state write, so a slow first read cannot
     * overwrite a newer one. A retry (`attempt++`) mounts a fresh effect whose
     * own `alive` returns false for the previous read, and the answer of the
     * one that has since been superseded is dropped on arrival rather than
     * painted over the newer result.
     */
    async (seed: boolean, alive: () => boolean = () => true): Promise<Discovery | null> => {
      const answer = await platformAnswer(
        discoverMockTools(
          { agentId: agent.id, projectId, ...(seed ? { seed: true } : {}) },
          { client: platformClient },
        ),
      );
      if (!alive()) return null;
      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return null;
      }
      if (answer.status !== "ready") {
        setRead({ status: "failed", refusal: answer.refusal });
        return null;
      }
      setRead({ status: "ready", found: answer.value });
      return answer.value;
    },
    [agent.id, projectId],
  );

  useEffect(() => {
    let current = true;
    setRead({ status: "loading" });
    void discover(false, () => current);
    return () => {
      current = false;
    };
  }, [discover, attempt]);

  const found = read.status === "ready" ? read.found : null;
  /**
   * Whether Egma can keep the promises at all for this agent.
   *
   * A refusal is a fact about the account — a custom-LLM engine, two keys on
   * two accounts, Retell not answering — so no lane's switch may go on while
   * one stands, and the sentence says which it is.
   */
  const mayMock = mayAuthor && found !== null && found.refusal === null;

  /**
   * Write one connection's switch.
   *
   * **Every enable of a web-call lane comes through the consent screen**, which
   * is the only caller that passes `consented`. The text lane needs none: it
   * writes nothing to the customer's Retell account.
   */
  async function setLaneSwitch(
    connectionId: string,
    next: boolean,
  ): Promise<void> {
    if (saving !== null || !mayAuthor) return;
    setSaving(connectionId);
    setRefused(null);
    const answer = await platformAnswer(
      updateConnection(
        {
          agentId: agent.id,
          connectionId,
          projectId,
          mockToolsEnabled: next,
        },
        { client: platformClient },
      ),
    );
    setSaving(null);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    setConsenting(null);
    onChanged();
  }

  /**
   * The one button on the consent screen: mint the lane if it is missing, then
   * turn its switch on.
   *
   * The mint is what makes the old impossible refusal impossible. It carries no
   * credential of its own — the agent's sealed platform key is what a mocked
   * run branches with, and the API refuses the enable where that is missing.
   */
  async function acceptConsent(): Promise<void> {
    if (saving !== null || !mayAuthor || consenting === null) return;
    if (consenting !== "mint") {
      await setLaneSwitch(consenting, true);
      return;
    }

    setSaving("mint");
    setRefused(null);
    const answer = await platformAnswer(
      addConnection(
        {
          agentId: agent.id,
          projectId,
          agentPlatform: "retell",
          connectionType: "retell_web_call",
          accessVariant: "retell_web_call.api_key",
          modality: "voice",
          config: {},
        },
        { client: platformClient },
      ),
    );
    setSaving(null);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    await setLaneSwitch(answer.value.connection.id, true);
  }

  async function rediscover(): Promise<void> {
    if (seeding) return;
    setSeeding(true);
    setRefused(null);
    const again = await discover(true);
    setSeeding(false);
    if (again !== null) setSeeded(again.seeded);
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>Mock tools</SheetTitle>
        </SheetHeader>

        <SheetBody className="gap-6">
          <section className="flex min-w-0 flex-col gap-2">
            <p className="m-0 text-sm text-faint">{agent.name}</p>
            {/*
              **No agent-wide claim.** The switch is per connection, so a
              sentence about "every simulation against this agent" would be
              false for the phone lane every time. Each lane says what it does,
              below, and nothing here says more than the lanes deliver.
            */}
            <p className="m-0 text-sm text-faint">
              Mock tools are a switch on each connection, because each one is a
              different way of running this agent. A phone call reaches your
              real tools and is never mocked.
            </p>
          </section>

          {refused === null ? null : <Refused message={refused.message} />}

          {read.status === "loading" ? (
            <Loading what="this agent's tools" />
          ) : read.status === "failed" ? (
            <Failure
              title="Egma could not read this agent's tools."
              message={read.refusal.message}
              onRetry={() => setAttempt((one) => one + 1)}
            />
          ) : (
            <div className="flex min-w-0 flex-col gap-6" data-slot="mock-tools-arrival">
              {found?.refusal == null ? null : (
                <RefusalNote message={found.refusal.message} />
              )}

              <LanesSection
                lanes={lanes}
                hasWebCall={hasWebCall}
                mayMock={mayMock}
                saving={saving}
                {...(why === undefined ? {} : { why })}
                onToggle={(connectionId, next) => {
                  void setLaneSwitch(connectionId, next);
                }}
                onConsent={(target) => setConsenting(target)}
              />

              {found === null || found.numbers.length === 0 ? null : (
                <NumbersSection numbers={found.numbers} />
              )}

              {found === null || found.warnings.length === 0 ? null : (
                <WarningsSection warnings={found.warnings} />
              )}

              {found === null ? null : (
                <ToolsSection tools={found.tools} seeded={seeded} />
              )}
            </div>
          )}

          {consenting === null ? null : (
            <ConsentScreen
              mints={consenting === "mint"}
              busy={saving !== null}
              onAccept={() => {
                void acceptConsent();
              }}
              onCancel={() => setConsenting(null)}
            />
          )}
        </SheetBody>

        <SheetFooter>
          <Button
            disabled={saving !== null}
            onClick={onClose}
            size="lg"
            type="button"
            variant="secondary"
          >
            Close
          </Button>
          {!mayAuthor ||
          !lanes.some((one) => one.connection.mockToolsEnabled) ? null : (
            <Button
              busy={seeding}
              className="ml-auto h-auto min-h-0 p-0 text-sm underline decoration-border underline-offset-4 pointer-hover:decoration-foreground"
              disabled={seeding}
              onClick={() => void rediscover()}
              type="button"
              variant="ghost"
            >
              {seeding ? "Reading Retell…" : "Read the tools again"}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** One lane on this agent, as the surface shows it. */
type Lane = {
  readonly connection: ListedAgentWithConnections["connections"][number];
  readonly lane: LaneType;
  readonly of: (typeof LANES)[LaneType];
};

/**
 * Every lane, each with its own switch and its own honest sentence.
 *
 * **The web-call switch never writes directly.** Turning it on opens the one
 * consent screen; turning it off is a plain write, because withdrawing
 * permission needs none. The text switch writes either way — it writes nothing
 * to the customer's Retell account, so there is nothing to consent to. The
 * phone lane has no switch at all.
 *
 * When the agent has **no** web-call connection, one row still stands here
 * offering to create it: the consent screen mints the lane and turns it on
 * together, so a person can never be refused with a step the product cannot
 * perform.
 */
function LanesSection({
  lanes,
  hasWebCall,
  mayMock,
  saving,
  why,
  onToggle,
  onConsent,
}: {
  readonly lanes: readonly Lane[];
  readonly hasWebCall: boolean;
  readonly mayMock: boolean;
  /** The connection being written to, or `null` when nothing is. */
  readonly saving: string | null;
  readonly why?: string;
  readonly onToggle: (connectionId: string, next: boolean) => void;
  readonly onConsent: (target: string | "mint") => void;
}) {
  return (
    <section
      aria-labelledby="mock-tools-lanes-heading"
      className="flex min-w-0 flex-col gap-3"
    >
      <h2 className="m-0 text-base font-medium" id="mock-tools-lanes-heading">
        Ways of running this agent
      </h2>
      <ul className="m-0 flex list-none flex-col border border-border p-0">
        {lanes.map(({ connection, lane, of }) => {
          const on = connection.mockToolsEnabled;
          return (
            <li
              className="flex min-w-0 items-start justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0"
              key={connection.id}
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium text-foreground">
                  {of.label}
                </span>
                <span className="text-sm text-faint">
                  {on ? of.on : of.off}
                </span>
              </span>
              {!of.mockable ? (
                <span className="flex-none text-sm text-faint">Never mocked</span>
              ) : (
                <Button
                  busy={saving === connection.id}
                  data-slot={`mock-tools-lane-${lane}`}
                  disabled={saving !== null || (!on && !mayMock)}
                  onClick={() => {
                    // Every enable of a web-call lane goes through the consent
                    // screen, and nothing else can enable one.
                    if (on || !of.consents) onToggle(connection.id, !on);
                    else onConsent(connection.id);
                  }}
                  size="sm"
                  type="button"
                  variant={on ? "secondary" : "default"}
                  {...(why === undefined ? {} : { why })}
                >
                  {on ? "Turn off" : "Turn on"}
                </Button>
              )}
            </li>
          );
        })}
        {hasWebCall ? null : (
          <li className="flex min-w-0 items-start justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0">
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium text-foreground">
                {LANES.retell_web_call.label}
              </span>
              <span className="text-sm text-faint">
                Egma can add this connection and run mocked voice calls over it.
                Your published number is never dialled.
              </span>
            </span>
            <Button
              busy={saving === "mint"}
              data-slot="mock-tools-lane-mint"
              disabled={saving !== null || !mayMock}
              onClick={() => onConsent("mint")}
              size="sm"
              type="button"
              {...(why === undefined ? {} : { why })}
            >
              Turn on
            </Button>
          </li>
        )}
      </ul>
    </section>
  );
}

/**
 * The one consent screen: four promises and one button.
 *
 * Each promise is one this product keeps somewhere in code — the temporary
 * version and its deletion, the serving version proven unmoved, the
 * pin-and-restore, the published number never dialled. They are here rather
 * than in a help line because a help line says what to write in a field, and
 * this is what Egma will do to somebody's Retell account.
 *
 * **There is no second checkbox.** Pinning a `latest`-riding number is one of
 * the four promises, so one informed yes is the whole ceremony.
 */
function ConsentScreen({
  mints,
  busy,
  onAccept,
  onCancel,
}: {
  /** Whether accepting also creates the web-call connection. */
  readonly mints: boolean;
  readonly busy: boolean;
  readonly onAccept: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <section
      aria-labelledby="mock-tools-consent-heading"
      className="flex min-w-0 flex-col gap-3 border border-border p-4"
      data-slot="mock-tools-consent"
      role="group"
    >
      <h2 className="m-0 text-base font-medium" id="mock-tools-consent-heading">
        What Egma will do
      </h2>
      <ul className="m-0 flex list-none flex-col border border-border p-0">
        {CONSENT_PROMISES.map((promise) => (
          <li
            className="border-t border-border px-4 py-3 text-sm text-foreground first:border-t-0"
            key={promise}
          >
            {promise}
          </li>
        ))}
      </ul>
      {!mints ? null : (
        <p className="m-0 text-sm text-faint">
          Egma will add a Retell web-call connection to this agent as part of
          turning this on.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          busy={busy}
          data-slot="mock-tools-consent-accept"
          disabled={busy}
          onClick={onAccept}
          size="lg"
          type="button"
        >
          {busy ? "Turning on…" : "Turn on mock tools"}
        </Button>
        <Button
          disabled={busy}
          onClick={onCancel}
          size="lg"
          type="button"
          variant="secondary"
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}

/** Why the box will not go on, in the words the platform answered with. */
function RefusalNote({ message }: { readonly message: string }) {
  return (
    <section
      aria-labelledby="mock-tools-refusal-heading"
      className="flex min-w-0 flex-col gap-2 border border-failure-border bg-failure-surface p-4"
      role="note"
    >
      <h2
        className="m-0 text-sm font-medium text-failure"
        id="mock-tools-refusal-heading"
      >
        Mock tools cannot be turned on for this agent
      </h2>
      <p className="m-0 text-sm text-foreground">{message}</p>
    </section>
  );
}

/** The transfers and messages that act outside the call, and will really act. */
function WarningsSection({
  warnings,
}: {
  readonly warnings: Discovery["warnings"];
}) {
  return (
    <section
      aria-labelledby="mock-tools-warnings-heading"
      className="flex min-w-0 flex-col gap-2 border border-warning-border bg-warning-surface p-4"
    >
      <h2
        className="m-0 text-sm font-medium text-warning"
        id="mock-tools-warnings-heading"
      >
        These still happen for real
      </h2>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {warnings.map((warning) => (
          <li className="text-sm text-foreground" key={warning.toolName}>
            <span className="font-mono">{warning.toolName}</span>
            <span className="text-faint"> — {warning.effect}</span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-sm text-faint">
        Retell runs these itself, so Egma cannot stand in front of them. Every
        simulation says so on its own record.
      </p>
    </section>
  );
}

/**
 * The numbers routing to this agent, what each one is bound to, and the one
 * question that needs an answer.
 */
function NumbersSection({
  numbers,
}: {
  readonly numbers: readonly DiscoveredNumber[];
}) {
  const toPin = numbers.filter((number) => number.pin);
  return (
    <section
      aria-labelledby="mock-tools-numbers-heading"
      className="flex min-w-0 flex-col gap-3"
    >
      <h2 className="m-0 text-base font-medium" id="mock-tools-numbers-heading">
        Phone numbers on this agent
      </h2>
      <ul className="m-0 flex list-none flex-col border border-border p-0">
        {numbers.map((number) => (
          <li
            className="flex min-w-0 items-start justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0"
            key={number.number}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="font-mono text-sm text-foreground">
                {number.number}
              </span>
              <span className="text-sm text-faint">
                {bindingText(number)}
              </span>
            </span>
            <span
              className={
                number.pin
                  ? "flex-none text-sm text-warning"
                  : "flex-none text-sm text-faint"
              }
            >
              {number.pin ? "Needs a pin" : "Untouched"}
            </span>
          </li>
        ))}
      </ul>
      {toPin.length === 0 ? null : (
        // **No second checkbox.** Pinning a `latest`-riding number and putting
        // it back is one of the four promises the one consent screen makes, so
        // this says which numbers the promise is about and nothing is asked
        // twice.
        <p className="m-0 border border-border p-4 text-sm text-faint" role="note">
          {toPin.length === 1 ? "This number is" : "These numbers are"} pinned
          during each mocked run and restored afterwards, so a real caller
          mid-run always reaches the real agent.
        </p>
      )}
    </section>
  );
}

/** What a number's binding means, in the words a person reads. */
function bindingText(number: DiscoveredNumber): string {
  if (number.verdicts.includes("hijackable")) {
    return "Follows Retell's latest pointer";
  }
  if (number.verdicts.includes("environment-tag")) {
    return "Bound through an environment tag, which Egma never touches";
  }
  if (number.verdicts.includes("latest-published")) {
    return "Follows the published pointer, and Egma never publishes";
  }
  return "Pinned to a version";
}

/** Every tool, grouped by the honest answer to how isolated it is. */
function ToolsSection({
  tools,
  seeded,
}: {
  readonly tools: readonly DiscoveredTool[];
  readonly seeded: readonly string[] | null;
}) {
  return (
    <section
      aria-labelledby="mock-tools-tools-heading"
      className="flex min-w-0 flex-col gap-4"
    >
      <h2 className="m-0 text-base font-medium" id="mock-tools-tools-heading">
        Tools on this agent
      </h2>
      {seeded === null ? null : (
        <p className="m-0 text-sm text-faint" role="status">
          {seeded.length === 0
            ? "Nothing new. Every tool Egma can answer for already has an answer, and none was changed."
            : `Added ${String(seeded.length)} answer${seeded.length === 1 ? "" : "s"}: ${seeded.join(", ")}. Answers you had already written were left alone.`}
        </p>
      )}
      {CLASSES.map((group) => {
        const inClass = tools.filter((tool) => tool.coverage === group.key);
        if (inClass.length === 0) return null;
        return (
          <ToolClass
            key={group.key}
            title={group.title}
            lead={group.lead}
            count={inClass.length}
          >
            {inClass.map((tool) => (
              <li
                className="flex min-w-0 items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0"
                key={`${tool.name}:${tool.type}`}
              >
                <span className="min-w-0 truncate font-mono text-sm text-foreground">
                  {tool.name}
                </span>
                <span className="flex-none text-sm text-faint">
                  {group.key === "mocked"
                    ? tool.answered
                      ? "Answer ready"
                      : "No answer yet"
                    : tool.type}
                </span>
              </li>
            ))}
          </ToolClass>
        );
      })}
    </section>
  );
}

function ToolClass({
  title,
  lead,
  count,
  children,
}: {
  readonly title: string;
  readonly lead: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <h3 className="m-0 text-sm font-medium text-foreground">{title}</h3>
        <span className="flex-none text-sm tabular-nums text-faint">
          {count}
        </span>
      </div>
      <p className="m-0 text-sm text-faint">{lead}</p>
      <ul className="m-0 flex list-none flex-col border border-border p-0">
        {children}
      </ul>
    </div>
  );
}
