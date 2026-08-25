"use client";

import { useState, type ReactNode } from "react";
import { listAgents, startMonitoring } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import type { Refusal } from "../../../../lib/api.ts";
import type { AgentPage, ListedAgentWithConnections } from "../../../../lib/agents.ts";
import {
  notYetMonitored,
  pickerAgentLabel,
  pickerPlatformOf,
  type RefusedWatch,
} from "../../../../lib/monitoring.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { Field, Problem, Refused } from "../../../../ui/form.tsx";
import { Empty, Failure, Loading } from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";

/**
 * **Monitor an agent**: the whole of monitoring's user interface, in one sheet
 * over the screen its results land on (boards `JGS-0`, `JN2-0`, `JTL-0`).
 *
 * There is no monitoring screen and no monitoring fact on an agent any more.
 * What a person does is pick an agent that is not yet monitored and — for the
 * one platform egma has to *ask* — hand over the key and the id it asks with.
 *
 * **Two platforms, two completely different answers, and the difference is
 * pull against push.**
 *
 * - **Retell** is pull: egma polls Retell, on a clock, with a key. So this half
 *   asks for the key and the platform's own id for the agent, and commits. The
 *   first switch-on imports the last thirty days; that behaviour is the
 *   server's and is not repeated here.
 * - **LiveKit** is push: the customer's own process reports to egma with the
 *   project key. There is nothing to switch and nothing to store, so that half
 *   is *instructions*. It reads no server state and writes none — a sheet that
 *   remembered somebody had read them would be a LiveKit monitored-state, which
 *   is exactly what the stores-nothing ruling forbids.
 *
 * **v0 starts pulling and does nothing else.** No stop, no turn-on-again, no
 * last-received: the API keeps `stopMonitoring`, and surfacing it is its own
 * effort. So this sheet has one verb, and the list it offers is the list of
 * agents that verb can still be used on.
 */

const COPY = {
  title: "Monitor an agent",
  agent: "Agent",
  /** Why the list is short, said once, under the control it is about. */
  agentHint: "Only agents not yet monitored are listed.",
  key: "Retell API key*",
  keyHint:
    "The key Egma pulls with. One paste per agent: Egma seals it on the " +
    "agent and never asks again.",
  keyHeld: (hint: string | null) =>
    hint === null || hint === ""
      ? "Egma already holds this agent's Retell key."
      : `Egma already holds this agent's Retell key (…${hint}).`,
  platformAgentId: "Retell agent ID*",
  platformAgentIdHint: "Retell's own id for this agent, from your Retell dashboard.",
  start: "Start pulling",
  starting: "Starting…",
  cancel: "Cancel",
  close: "Close",
  loading: "this project's agents",
  nothingLeft: "Every agent here is already monitored",
  nothingLeftLead:
    "Add another agent, or come back when there is one Egma is not watching.",
  noAgents: "No agents in this project yet",
  noAgentsLead: "Connect the agent you want Egma to watch, then monitor it here.",
  missingKey: "Enter this agent's Retell API key.",
  missingPlatformAgentId: "Enter Retell's own id for this agent.",
  livekit: [
    "Install the Egma SDK.",
    "Call monitor_livekit(ctx) before AgentSession.start.",
    "Set EGMA_URL and EGMA_API_KEY in the agent's environment.",
  ],
  livekitLead:
    "From then on, calls appear in Transcripts as they happen. Nothing is " +
    "stored on the agent, and there is no switch.",
} as const;

export function MonitorAgentSheet({
  projectId,
  askedFor,
  onClose,
  onStarted,
}: {
  readonly projectId: string;
  /** The agent a link named, carried through from the old start address. */
  readonly askedFor: string | null;
  readonly onClose: () => void;
  /** Something started pulling, so the list behind this sheet is now stale. */
  readonly onStarted: () => void;
}) {
  const { answer, reload } = useProjectRead<AgentPage>(
    (projectId) =>
      platformAnswer(
        listAgents({ projectId, pageSize: 200 }, { client: platformClient }),
      ),
    projectId,
  );

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <SheetHeader closeLabel={COPY.close}>
          <SheetTitle>{COPY.title}</SheetTitle>
        </SheetHeader>
        <Picker
          projectId={projectId}
          answer={answer}
          reload={reload}
          askedFor={askedFor}
          onClose={onClose}
          onStarted={onStarted}
        />
      </SheetContent>
    </Sheet>
  );
}

/**
 * The list, and whichever half of the sheet the picked agent opens.
 *
 * The roster read is the only read this sheet makes. `discoverRetellVoiceAgents`
 * is deliberately not called on open: it needs a key nobody has typed yet, and
 * a listing button was the shape the boards retired.
 */
function Picker({
  projectId,
  answer,
  reload,
  askedFor,
  onClose,
  onStarted,
}: {
  readonly projectId: string;
  readonly answer: ReturnType<typeof useProjectRead<AgentPage>>["answer"];
  readonly reload: () => void;
  readonly askedFor: string | null;
  readonly onClose: () => void;
  readonly onStarted: () => void;
}) {
  /**
   * Which agent is picked, once somebody has said. `null` means nobody has,
   * and the list's own first row answers — seeded rather than kept in step,
   * because a person who then picks another has changed their mind and a later
   * render must not put the link's agent back.
   */
  const [picked, setPicked] = useState<string | null>(null);

  if (answer === null || answer.status === "signed-out") {
    return (
      <SheetBody>
        <Loading what={COPY.loading} />
      </SheetBody>
    );
  }

  if (answer.status !== "ready") {
    return (
      <>
        <SheetBody>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </SheetBody>
        <SheetFooter>
          <Button type="button" size="lg" variant="secondary" onClick={onClose}>
            {COPY.close}
          </Button>
        </SheetFooter>
      </>
    );
  }

  const listed = answer.value.agents.filter(notYetMonitored);

  if (listed.length === 0) {
    const none = answer.value.agents.length === 0;
    return (
      <>
        <SheetBody>
          <Empty
            title={none ? COPY.noAgents : COPY.nothingLeft}
            lead={none ? COPY.noAgentsLead : COPY.nothingLeftLead}
          />
        </SheetBody>
        <SheetFooter>
          <Button type="button" size="lg" variant="secondary" onClick={onClose}>
            {COPY.close}
          </Button>
        </SheetFooter>
      </>
    );
  }

  /*
   * The link's agent wins where this list still holds it. An id from an older
   * page, another project, or an agent already monitored names nothing here —
   * and a control naming an agent it cannot show would be worse than the first
   * row, which is what somebody who named nobody gets.
   */
  const wanted =
    picked ??
    (askedFor !== null && listed.some((one) => one.id === askedFor)
      ? askedFor
      : (listed[0]?.id ?? null));
  const agent = listed.find((one) => one.id === wanted);

  /**
   * The one control both halves stand under, drawn once here.
   *
   * It is handed down rather than drawn twice, because each half owns the
   * whole panel below the head: the form has to wrap the body *and* the
   * footer for Enter to commit it and for the footer to pin to the bottom of
   * the sheet, which is where the boards draw it.
   */
  const chooser = (
    <Field label={COPY.agent} htmlFor="monitor-agent" hint={COPY.agentHint}>
      <Select
        id="monitor-agent"
        value={agent?.id ?? ""}
        onChange={(event) => setPicked(event.target.value)}
      >
        {listed.map((one) => (
          <option key={one.id} value={one.id}>
            {pickerAgentLabel(one)}
          </option>
        ))}
      </Select>
    </Field>
  );

  if (agent === undefined) {
    return (
      <>
        <SheetBody>{chooser}</SheetBody>
        <SheetFooter>
          <Button type="button" size="lg" variant="secondary" onClick={onClose}>
            {COPY.close}
          </Button>
        </SheetFooter>
      </>
    );
  }

  if (pickerPlatformOf(agent) === "livekit") {
    return <LiveKitSteps chooser={chooser} onClose={onClose} />;
  }

  return (
    <RetellStart
      /*
       * Keyed by the agent, so switching agent starts the half below over.
       * Everything in it — a typed key, a typed id, a refusal — was decided
       * about one agent, and carrying it across would commit what somebody
       * typed for another.
       */
      key={agent.id}
      projectId={projectId}
      agent={agent}
      chooser={chooser}
      onClose={onClose}
      onStarted={onStarted}
    />
  );
}

/**
 * The fade the half below the chooser arrives on.
 *
 * `DESIGN.md`'s popover-enter token, not the drawer's: the sheet has already
 * travelled in, so what changes *inside* it is a small anchored surface rather
 * than a second entrance. It stands still under reduced motion, where the
 * change is explained by the words alone.
 */
const ARRIVES =
  "animate-[egma-fade-in_var(--duration-popover-in)_var(--ease-out)] motion-reduce:animate-none";

/**
 * The Retell half: what egma has to ask with, and the one button.
 *
 * **The key is asked for once per agent, ever.** An agent that already holds a
 * sealed one is told so rather than asked again (board `JN2-0` draws the field
 * for an agent with no key). The field comes back only if the server says it
 * needs one — its sentence is the authority on that, not a guess made here.
 *
 * The commit is the existing `startMonitoring` operation, unchanged: one entry,
 * naming this egma agent and the platform's id for it. Its per-entry refusals
 * are the server's own sentences and are relayed word for word — the rule each
 * one explains is the database's, and paraphrasing it here would be this sheet
 * inventing a rule it does not own.
 */
function RetellStart({
  projectId,
  agent,
  chooser,
  onClose,
  onStarted,
}: {
  readonly projectId: string;
  readonly agent: ListedAgentWithConnections;
  readonly chooser: ReactNode;
  readonly onClose: () => void;
  readonly onStarted: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [platformAgentId, setPlatformAgentId] = useState(
    agent.platformAgentId ?? "",
  );
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [refused, setRefused] = useState<readonly RefusedWatch[]>([]);
  /**
   * Whether the key is asked for after all.
   *
   * An agent that holds a sealed key is not asked for one, which is the
   * ruling — but the operation still takes a key, so a commit for such an
   * agent can come back asking. Revealing the field *then*, under the server's
   * own sentence, keeps the promise in the ordinary case and leaves no dead
   * end in the rare one.
   */
  const [askKey, setAskKey] = useState(!agent.monitoringKeyPresent);

  async function start(): Promise<void> {
    if (starting) return;
    const id = platformAgentId.trim();
    if (id === "") {
      setProblem(COPY.missingPlatformAgentId);
      return;
    }
    if (askKey && apiKey.trim() === "") {
      setProblem(COPY.missingKey);
      return;
    }

    setProblem(null);
    setRefusal(null);
    setRefused([]);
    setStarting(true);

    const answer = await platformAnswer(
      startMonitoring(
        {
          projectId,
          agentPlatform: "retell",
          apiKey: apiKey.trim(),
          watch: [{ platformAgentId: id, agentId: agent.id }],
        },
        { client: platformClient },
      ),
    );

    if (answer.status === "signed-out") {
      globalThis.location.replace("/sign-in");
      return;
    }

    setStarting(false);

    if (answer.status !== "ready") {
      // The whole request was refused. Everything typed stays where it is.
      setRefusal(answer.refusal);
      if (!askKey) setAskKey(true);
      return;
    }

    if (answer.value.watching.length > 0) {
      onStarted();
      onClose();
      return;
    }

    // Nothing started, so the entry's own sentence is the whole answer.
    setRefused(answer.value.refused);
  }

  return (
    <form
      /*
       * The form wraps the body *and* the footer, so Enter in either field
       * commits it and the two buttons pin to the bottom of the panel — which
       * is where the board draws them, a long way under a short form.
       */
      className="flex min-h-0 flex-1 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <SheetBody>
        {chooser}

        <div className={`flex flex-col gap-4 ${ARRIVES}`}>
          {refusal === null ? null : <Refused message={refusal.message} />}

          {askKey ? (
            <Field
              label={COPY.key}
              htmlFor="monitor-retell-key"
              hint={COPY.keyHint}
            >
              <Input
                id="monitor-retell-key"
                type="password"
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                placeholder="key_…"
                onChange={(event) => {
                  setApiKey(event.target.value);
                  if (problem !== null) setProblem(null);
                }}
              />
            </Field>
          ) : (
            <p className="m-0 text-sm leading-(--line-normal) text-faint">
              {COPY.keyHeld(agent.monitoringApiKeyHint)}
            </p>
          )}

          <Field
            label={COPY.platformAgentId}
            htmlFor="monitor-retell-agent-id"
            hint={COPY.platformAgentIdHint}
          >
            <Input
              id="monitor-retell-agent-id"
              value={platformAgentId}
              autoComplete="off"
              spellCheck={false}
              placeholder="agent_…"
              onChange={(event) => {
                setPlatformAgentId(event.target.value);
                if (problem !== null) setProblem(null);
              }}
            />
          </Field>

          {problem === null ? null : <Problem>{problem}</Problem>}

          {refused.map((one) => (
            <Problem key={one.platformAgentId}>{one.message}</Problem>
          ))}
        </div>
      </SheetBody>

      <SheetFooter>
        <Button type="submit" size="lg" busy={starting} disabled={starting}>
          {starting ? COPY.starting : COPY.start}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="secondary"
          disabled={starting}
          onClick={onClose}
        >
          {COPY.cancel}
        </Button>
      </SheetFooter>
    </form>
  );
}

/**
 * The LiveKit half: three steps, and nothing else.
 *
 * **It reads no server state and writes none.** Push is ungated by design —
 * the door authenticates with the project key, tenancy comes from the key, and
 * the stored evidence is the whole record of an agent pushing. So there is no
 * row to write here and no switch to flip, and re-opening these steps for the
 * same agent is idempotent rather than a second act.
 */
function LiveKitSteps({
  chooser,
  onClose,
}: {
  readonly chooser: ReactNode;
  readonly onClose: () => void;
}) {
  return (
    <>
      <SheetBody>
        {chooser}

        <div className={`flex flex-col gap-4 ${ARRIVES}`}>
          <ol className="m-0 flex list-none flex-col gap-4 p-0">
            {COPY.livekit.map((step, at) => (
              <li key={step} className="flex gap-3">
                {/*
                  A fixed-width slot, so the three sentences start on one lane
                  however wide the numbers get. `DESIGN.md` asks for tabular
                  numerals wherever figures line up.
                */}
                <span className="w-4 flex-none text-sm text-faint tabular-nums">
                  {at + 1}
                </span>
                <span className="text-sm leading-(--line-normal) text-foreground">
                  {step}
                </span>
              </li>
            ))}
          </ol>
          <p className="m-0 text-sm leading-(--line-normal) text-faint">
            {COPY.livekitLead}
          </p>
        </div>
      </SheetBody>

      {/* One way out and nothing to start: this half writes nothing. */}
      <SheetFooter>
        <Button type="button" size="lg" variant="secondary" onClick={onClose}>
          {COPY.close}
        </Button>
      </SheetFooter>
    </>
  );
}
