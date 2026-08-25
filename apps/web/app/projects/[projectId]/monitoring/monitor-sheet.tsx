"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { listAgents, startMonitoring } from "@egma/platform-api/client";

import { Badge } from "@/components/ui/badge";
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

import type { Answer, Refusal } from "../../../../lib/api.ts";
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
import { projectPath } from "../../../../lib/project-context.ts";
import { Field, Problem, Refused } from "../../../../ui/form.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
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

/**
 * Every word this sheet says out loud, in one place so that one test can hold
 * it against the banned list — the discipline `lib/transcript-copy.ts` keeps
 * for the two transcript pages, applied to the panel that opens over one of
 * them.
 *
 * **The labels carry the fields, and there is no help line under either.** The
 * founder deleted the "One paste, ever…" and "From your Retell…" lines outright
 * on 2026-08-24; a starred label and the one lead under the chooser are the
 * whole of what this sheet explains.
 *
 * `STEPS` is held apart from the prose above it because it is not prose: the
 * two names in it are the SDK's own, and the words `call` and `session` inside
 * `monitor_livekit(ctx)` and `AgentSession.start` are identifiers a person
 * types into their editor rather than product vocabulary.
 */

/**
 * The one line a person adds to their agent, on its own contained surface so
 * that it can be copied whole. It is the SDK's own name and is never reworded.
 */
const SNIPPET = "monitor_livekit(ctx)";

/**
 * The identifier the line has to come before, shown as code inside the
 * sentence for the same reason: it is what a person searches their own file
 * for, not a phrase egma chose.
 */
const BEFORE = "AgentSession.start";

/**
 * The three numbered steps, in the shape the developer asked for on
 * 2026-08-25: a short bold heading and one muted sentence each, the way
 * Langfuse heads its first-trace onboarding.
 *
 * **The technical content is the same three steps it has always been**, folded
 * from three flat sentences into three headed ones: the SDK, the one line with
 * both SDK identifiers verbatim, and the two environment variables — with the
 * last step now the one that says what happens next, because a person who has
 * done the work is owed the answer to "and then?".
 */
const STEPS: readonly {
  readonly title: string;
  readonly body: string;
  /** Whether this is the step the snippet and its Copy button belong to. */
  readonly snippet?: true;
}[] = [
  {
    title: "Install the Egma SDK",
    body: "Add it to the environment your agent runs in, then set EGMA_URL and EGMA_API_KEY there.",
  },
  {
    title: "Add one line to your agent",
    body: "One line, and it goes ahead of",
    snippet: true,
  },
  {
    title: "Run your agent",
    body: "Its traces appear in Traces within seconds of finishing.",
  },
];

const COPY = {
  title: "Monitor an agent",
  agent: "Agent",
  /** Why the list is short, said once, under the control it is about. */
  agentHint: "Only agents not yet monitored are listed.",
  key: "Retell API key*",
  keyHeld: (hint: string | null) =>
    hint === null || hint === ""
      ? "Egma already holds this agent's Retell key."
      : `Egma already holds this agent's Retell key (…${hint}).`,
  platformAgentId: "Retell agent ID*",
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
  /**
   * The one thing left to do when the list is empty, and it is a real move to
   * another screen.
   *
   * Both empty sentences promise it — *add another agent*, *connect the agent
   * you want Egma to watch* — and both used to offer nothing but Close, so the
   * promise was a dead end. The word is the agents screen's own, because it
   * lands on that screen with that screen's sheet already open.
   */
  connect: "Connect an agent",
  missingKey: "Enter this agent's Retell API key.",
  missingPlatformAgentId: "Enter Retell's own id for this agent.",
  notYours: (role: string) =>
    `Your ${role} role cannot start monitoring. Ask an organization admin to ` +
    "change your role, then try again.",
  /**
   * The head of the LiveKit half, in the shape of Langfuse's first-trace
   * onboarding (developer decision, 2026-08-25).
   *
   * **The chip is a fact about this agent rather than decoration, so there are
   * two of them.** Push is ungated, and this half is drawn for every LiveKit
   * agent the picker lists — including one whose evidence has *already*
   * arrived, because there is no pull switch to sort them by. Telling that
   * agent's owner they are waiting for a first trace would be egma being wrong
   * about the one thing this panel exists to report, so `lastReceivedAt`
   * decides which pair of words is said.
   *
   * Waiting is the warning family: nothing is broken and nothing is working
   * yet either. Receiving is the success family. Either way the steps stay
   * below — for the second agent, and for anybody checking what they did.
   */
  livekitWaiting: "Waiting for the first trace",
  livekitTitle: "Time to log the first trace",
  livekitLead:
    "It takes about a minute, and there is nothing to switch on afterwards.",
  livekitReceiving: "Receiving traces",
  livekitReceivingTitle: "Egma is already receiving from this agent",
  livekitReceivingLead:
    "Setup is done, and the steps below stay as reference for the next agent " +
    "you point at Egma.",
  copy: "Copy",
  copied: "Copied",
  copyFailed:
    "Egma could not reach the clipboard. Select the line above and copy it.",
} as const;

/** How many agents one roster read asks for. The contract's own ceiling. */
const ROSTER_PAGE = 200;

/**
 * A bound on the paging loop, so a server that answered the same cursor forever
 * could not spin this sheet. Forty thousand agents is far past any project, and
 * a runaway read is worse than a truncated one.
 */
const ROSTER_PAGES = 200;

/**
 * **The whole roster, not the first page of it.**
 *
 * The list read is keyset-paged, and one page is at most `ROSTER_PAGE` agents.
 * Reading only the first page made two silent lies possible in a project bigger
 * than that: an agent that exists would be missing from the picker with nothing
 * on screen saying so, and — worse — a project whose first page happened to be
 * all monitored would be told *every agent here is already monitored* while
 * unmonitored ones sat on page two. So the loop runs to exhaustion before
 * anything decides anything.
 *
 * A refusal on any page is the whole answer: half a roster is exactly the
 * input that produces the second lie, so it is never treated as the roster.
 */
async function everyAgent(projectId: string): Promise<Answer<AgentPage>> {
  const gathered: ListedAgentWithConnections[] = [];
  let after: string | null = null;

  for (let page = 0; page < ROSTER_PAGES; page += 1) {
    const answer: Answer<AgentPage> = await platformAnswer(
      listAgents(
        {
          projectId,
          pageSize: ROSTER_PAGE,
          ...(after === null ? {} : { pageToken: after }),
        },
        { client: platformClient },
      ),
    );
    if (answer.status !== "ready") return answer;

    gathered.push(...answer.value.agents);
    after = answer.value.nextPageToken;
    if (after === null) break;
  }

  return {
    status: "ready",
    value: { agents: gathered, nextPageToken: null },
  };
}

export function MonitorAgentSheet({
  projectId,
  askedFor,
  role,
  mayAuthor,
  whyNot,
  onClose,
  onStarted,
}: {
  readonly projectId: string;
  /** The agent a link named, carried through from the old start address. */
  readonly askedFor: string | null;
  /** Null until the session read answers, and then this reader's own role. */
  readonly role: string | null;
  readonly mayAuthor: boolean;
  readonly whyNot: string;
  readonly onClose: () => void;
  /** Something started pulling, so the list behind this sheet is now stale. */
  readonly onStarted: () => void;
}) {
  /*
   * **Not read at all for somebody who could not act on it.** A viewer's copied
   * link opens this panel, and the panel's answer is a sentence rather than a
   * form — so asking for the roster would be a request made only to fill in a
   * control nobody here can use.
   */
  const { answer, reload } = useProjectRead<AgentPage>(
    everyAgent,
    mayAuthor ? projectId : null,
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
        {role === null ? (
          <SheetBody>
            <Loading what={COPY.loading} />
          </SheetBody>
        ) : mayAuthor ? (
          <Picker
            projectId={projectId}
            answer={answer}
            reload={reload}
            askedFor={askedFor}
            onClose={onClose}
            onStarted={onStarted}
          />
        ) : (
          <>
            <SheetBody>
              <NotFound message={whyNot} />
            </SheetBody>
            <SheetFooter>
              <Button
                type="button"
                size="lg"
                variant="secondary"
                onClick={onClose}
              >
                {COPY.close}
              </Button>
            </SheetFooter>
          </>
        )}
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
        {/*
          **The verb the sentence promises, and it leaves this screen.** There
          is no agent left to monitor, so the only move is to connect one — and
          connecting is the agents screen's own job. The address carries that
          screen's connect sheet with it, so one press lands on the open panel
          rather than on a list somebody has to find the button on again. This
          is a real navigation, which the no-redirect ruling allows: the ruling
          is about sheets that draw over the screen they belong to.
        */}
        <SheetFooter>
          <Button asChild size="lg">
            <Link href={`${projectPath(projectId, "agents")}?sheet=connect`}>
              {COPY.connect}
            </Link>
          </Button>
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
    return <LiveKitSteps agent={agent} chooser={chooser} onClose={onClose} />;
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

          {/*
            No help line under either field, and no `required` attribute on
            them either: the browser's own validation would fire before this
            form's, and its bubble says none of the sentences below. The star
            in the label is presentation, so the semantics are said out loud
            with `aria-required` — a field announced as optional and then
            refused is the one thing a starred label must not become.
          */}
          {askKey ? (
            <Field label={COPY.key} htmlFor="monitor-retell-key">
              <Input
                id="monitor-retell-key"
                type="password"
                value={apiKey}
                aria-required="true"
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

          <Field label={COPY.platformAgentId} htmlFor="monitor-retell-agent-id">
            <Input
              id="monitor-retell-agent-id"
              value={platformAgentId}
              aria-required="true"
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
 * The one line, on its own surface, with the way to take it.
 *
 * The copy behaviour is the API-keys screen's, kept the same on purpose: try
 * the clipboard, say *Copied* when it worked, and — when the browser refuses
 * or has no clipboard at all — say so and point at the text, which is still on
 * screen and still selectable. A button that silently did nothing is the one
 * outcome a copy control must never have.
 */
function Snippet(): ReactNode {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  /**
   * The receipt's own timer, held rather than derived from the state.
   *
   * **A second press has to start the two seconds over.** Keying the timeout
   * off `state` looked tidier and was wrong: pressing Copy again while the
   * receipt is still up sets `copied` on top of `copied`, which is no change
   * at all — so the first press's timer ran on and took the receipt away part
   * way through the second one. One timer, cleared before the next is started,
   * and cleared again on unmount so a sheet closed straight after a press sets
   * nothing on a gone component.
   */
  const receipt = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopReceipt(): void {
    if (receipt.current === null) return;
    clearTimeout(receipt.current);
    receipt.current = null;
  }

  useEffect(() => stopReceipt, []);

  async function copy(): Promise<void> {
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(SNIPPET);
      stopReceipt();
      setState("copied");
      receipt.current = setTimeout(() => setState("idle"), 2000);
    } catch {
      stopReceipt();
      setState("failed");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/*
        The bordered code surface `DESIGN.md` gives identifiers: the mono
        stack, the quiet neutral fill, and the product's one radius, which is
        none. It scrolls sideways rather than wrapping, because a line broken
        mid-identifier is a line somebody types back wrong.
      */}
      <div className="flex items-start gap-2">
        <pre className="m-0 min-w-0 flex-1 overflow-x-auto rounded-input border border-border bg-surface-soft p-3 font-mono text-xs leading-(--line-normal) text-foreground">
          <code>{SNIPPET}</code>
        </pre>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="flex-none"
          onClick={() => void copy()}
        >
          {state === "copied" ? COPY.copied : COPY.copy}
        </Button>
      </div>
      {/*
        Said out loud when it happens, for a reader who is not watching the
        button — and never as colour alone, which is what `DESIGN.md` asks.
      */}
      <p aria-live="polite" className="sr-only">
        {state === "copied" ? COPY.copied : ""}
      </p>
      {state === "failed" ? (
        <p className="m-0 text-sm leading-(--line-normal) text-faint">
          {COPY.copyFailed}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The LiveKit half: what to do first, in three numbered steps.
 *
 * **It reads no server state and writes none.** Push is ungated by design —
 * the door authenticates with the project key, tenancy comes from the key, and
 * the stored evidence is the whole record of an agent pushing. So there is no
 * row to write here and no switch to flip, and re-opening these steps for the
 * same agent is idempotent rather than a second act. The Copy button touches
 * the clipboard and nothing else.
 *
 * **The shape is Langfuse's first-trace onboarding, in this product's system**
 * (developer decision, 2026-08-25): a state chip, a heading with one sentence
 * under it, and then the steps down a connected spine. What it replaced was
 * three flat sentences with a faint number beside each, which said the same
 * things and gave a person no sense of being partway through anything.
 */
function LiveKitSteps({
  agent,
  chooser,
  onClose,
}: {
  readonly agent: ListedAgentWithConnections;
  readonly chooser: ReactNode;
  readonly onClose: () => void;
}) {
  const last = STEPS.length - 1;
  /*
   * **Read, not stored.** This is the one fact the list read already carries
   * about a pushing agent, and looking at it writes nothing and asks nothing
   * extra — the stores-nothing ruling is about what this half *records*, and
   * it still records nothing. A field that is already in the roster answer is
   * not a LiveKit monitored-state; it is the evidence's own arrival time.
   */
  const receiving = agent.lastReceivedAt !== null;

  return (
    <>
      <SheetBody>
        {chooser}

        <div className={`flex flex-col gap-4 ${ARRIVES}`}>
          <div className="flex flex-col gap-2">
            <Badge variant={receiving ? "success" : "warning"}>
              {receiving ? COPY.livekitReceiving : COPY.livekitWaiting}
            </Badge>
            {/*
              A heading inside the panel rather than a second title bar: the
              sheet's own title says which panel this is, and this says what
              the panel is asking for right now.
            */}
            <h3 className="m-0 text-base leading-(--line-tight) font-medium text-foreground">
              {receiving ? COPY.livekitReceivingTitle : COPY.livekitTitle}
            </h3>
            <p className="m-0 text-sm leading-(--line-normal) text-faint">
              {receiving ? COPY.livekitReceivingLead : COPY.livekitLead}
            </p>
          </div>

          <ol className="m-0 flex list-none flex-col p-0">
            {STEPS.map((step, at) => (
              <li
                key={step.title}
                className={`relative flex gap-3 ${at === last ? "" : "pb-5"}`}
              >
                {/*
                  The spine, which is the thing that makes three steps read as
                  one sequence. It runs from under one number to the next and
                  stops at the last, so the list ends rather than trailing off.
                */}
                {at === last ? null : (
                  <span
                    aria-hidden="true"
                    className="absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 bg-border"
                  />
                )}
                {/*
                  A square, filled with the ink and lettered in the paper —
                  `DESIGN.md` has one radius and it is none, so the number chip
                  is a square like every other mark in the product. Tabular
                  numerals keep the three on one lane.
                */}
                <span className="z-1 flex size-6 flex-none items-center justify-center bg-foreground text-xs font-medium text-background tabular-nums">
                  {at + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="m-0 text-sm leading-(--line-normal) font-medium text-foreground">
                    {step.title}
                  </p>
                  <p className="m-0 text-sm leading-(--line-normal) text-faint">
                    {step.body}
                    {step.snippet === undefined ? null : (
                      <>
                        {" "}
                        <code className="font-mono text-xs text-foreground">
                          {BEFORE}
                        </code>
                        .
                      </>
                    )}
                  </p>
                  {step.snippet === undefined ? null : <Snippet />}
                </div>
              </li>
            ))}
          </ol>
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
