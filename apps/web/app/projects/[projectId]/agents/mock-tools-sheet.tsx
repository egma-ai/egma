"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { discoverMockTools, updateAgent } from "@egma/platform-api/client";
import type { DiscoverMockToolsResponse } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
 * Mock tools during simulations: the tick, what it would cover, and what it
 * refuses to promise.
 *
 * **The consent is explained before it is accepted.** Ticking this box is
 * standing permission for Egma to write to the customer's Retell account at the
 * start of every run — a temporary version of their agent, deleted when the run
 * ends — and, where a telephone number follows Retell's `latest` pointer, to
 * pin that number for the length of the run and put the binding back
 * afterwards. So the panel says all of that in plain words, shows the numbers
 * it is talking about, and asks for the pin separately, before the switch will
 * go on.
 *
 * **Every tool is shown in its honest class**, never a count of "covered". The
 * three classes are the product's own words: the ones Egma answers, the ones
 * that run inside Retell where no interception reaches, and the ones Egma could
 * reach and does not yet. A person reading this has to be able to see exactly
 * how isolated a mocked run really is.
 *
 * **A transfer and an SMS get a warning of their own**, because they act
 * outside the call: a real leg placed, a real message sent, even in a mocked
 * run. They are named rather than quietly left out of a coverage number.
 *
 * **A refusal is shown as a sentence, never as a disabled control.** Four
 * things stop this box going on, and each has a different next move, so the
 * panel shows which one it is and what to do about it (`DESIGN.md`: make every
 * state truthful).
 *
 * The surface is the house modal side sheet — one record read and edited in a
 * side sheet — and the only motion is the arrival of the discovery result,
 * which is a piece of the panel a person did not put there.
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
  const [pinConsent, setPinConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [seeded, setSeeded] = useState<readonly string[] | null>(null);

  const on = agent.mockToolsDuringSimulations;

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
  const numbersToPin = (found?.numbers ?? []).filter((number) => number.pin);
  const needsConsent = numbersToPin.length > 0;
  // The switch cannot go on while Egma has said it cannot keep the promise, and
  // cannot go on without the pin answer where the pin is needed.
  const mayTurnOn =
    mayAuthor &&
    found !== null &&
    found.refusal === null &&
    (!needsConsent || pinConsent);

  async function setTick(next: boolean): Promise<void> {
    if (saving || !mayAuthor) return;
    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      updateAgent(
        {
          agentId: agent.id,
          projectId,
          mockToolsDuringSimulations: next,
          ...(next && needsConsent ? { pinNumbersDuringRuns: true } : {}),
        },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onChanged();
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
            <p className="m-0 text-sm">
              <span className={on ? "text-success" : "text-faint"}>
                {on ? "On" : "Off"}
              </span>
              <span className="text-faint">
                {on
                  ? " · every simulation against this agent runs in a mocked world"
                  : " · simulations reach your real tools"}
              </span>
            </p>
          </section>

          {refused === null ? null : <Refused message={refused.message} />}

          <ConsentExplanation />

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
              {found?.refusal === null ? null : (
                <RefusalNote message={found?.refusal?.message ?? ""} />
              )}

              {found === null || found.numbers.length === 0 ? null : (
                <NumbersSection
                  numbers={found.numbers}
                  on={on}
                  consented={pinConsent}
                  mayConsent={mayAuthor}
                  onConsent={setPinConsent}
                />
              )}

              {found === null || found.warnings.length === 0 ? null : (
                <WarningsSection warnings={found.warnings} />
              )}

              {found === null ? null : (
                <ToolsSection tools={found.tools} seeded={seeded} />
              )}
            </div>
          )}
        </SheetBody>

        <SheetFooter>
          {on ? (
            <Button
              busy={saving}
              disabled={!mayAuthor}
              onClick={() => void setTick(false)}
              size="lg"
              type="button"
              {...(why === undefined ? {} : { why })}
            >
              {saving ? "Turning off…" : "Turn off mock tools"}
            </Button>
          ) : (
            <Button
              busy={saving}
              disabled={!mayTurnOn}
              onClick={() => void setTick(true)}
              size="lg"
              type="button"
              {...(why === undefined ? {} : { why })}
            >
              {saving ? "Turning on…" : "Turn on mock tools"}
            </Button>
          )}
          <Button
            disabled={saving}
            onClick={onClose}
            size="lg"
            type="button"
            variant="secondary"
          >
            Close
          </Button>
          {!on || !mayAuthor ? null : (
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

/**
 * What ticking the box permits, said before it is ticked.
 *
 * Four sentences, and each is a promise this product keeps somewhere in code:
 * the temporary version, its deletion, the untouched serving version, and the
 * pinned-and-restored number. They are here rather than in a help line because
 * a help line says what to write in a field, and this is what Egma will do to
 * somebody's account.
 */
function ConsentExplanation() {
  return (
    <section
      aria-labelledby="mock-tools-consent-heading"
      className="flex min-w-0 flex-col gap-3"
    >
      <h2 className="m-0 text-base font-medium" id="mock-tools-consent-heading">
        What Egma will do
      </h2>
      <ul className="m-0 flex list-none flex-col border border-border p-0">
        {[
          "Create a temporary version of this agent in Retell when a run starts, with every tool it can intercept pointed at Egma.",
          "Delete that temporary version when the run ends.",
          "Never modify the version your agent serves. Egma reads it back during every run to prove it did not move.",
          "Pin a phone number that follows Retell's latest pointer to the version it already reaches, for the length of each run, and put the binding back exactly as it was.",
        ].map((promise) => (
          <li
            className="border-t border-border px-4 py-3 text-sm text-foreground first:border-t-0"
            key={promise}
          >
            {promise}
          </li>
        ))}
      </ul>
      <p className="m-0 text-sm text-faint">
        Your published phone number is never dialled for a mocked run. A real
        caller during a run reaches your real agent with your real tools.
      </p>
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
  on,
  consented,
  mayConsent,
  onConsent,
}: {
  readonly numbers: readonly DiscoveredNumber[];
  /** Whether mock tools is already on for this agent — standing consent given. */
  readonly on: boolean;
  /** This session's own answer to the pin question. Never the tick's state. */
  readonly consented: boolean;
  readonly mayConsent: boolean;
  readonly onConsent: (next: boolean) => void;
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
      {toPin.length === 0 ? null : on ? (
        // Already on, so the tick's standing consent already covers the pin —
        // stated as the fact it is, never a pre-checked box the person is shown
        // as having agreed to when they may never have been asked this session.
        <p className="m-0 border border-border p-4 text-sm text-faint" role="note">
          Mock tools is on, so {toPin.length === 1 ? "this number is" : "these numbers are"}{" "}
          pinned during each run and restored afterwards under that standing
          consent.
        </p>
      ) : (
        // Off, and this is the question that has to be answered to turn it on.
        // The box reflects only this session's own toggle.
        <label className="flex items-start gap-3 border border-border p-4">
          <Checkbox
            checked={consented}
            disabled={!mayConsent}
            onChange={(event) => onConsent(event.target.checked)}
          />
          <span className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="text-foreground">
              Pin {toPin.length === 1 ? "this number" : "these numbers"} during
              runs, and restore {toPin.length === 1 ? "it" : "them"} afterwards
            </span>
            <span className="text-faint">
              Without this, a real caller would reach the temporary version the
              moment it exists — so the box stays off instead.
            </span>
          </span>
        </label>
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
