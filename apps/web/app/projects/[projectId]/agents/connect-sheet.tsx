"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import {
  addConnection,
  discoverAgents,
  getAgent,
  listConnectionOptions,
  registerAgent,
} from "@egma/platform-api/client";

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
import { cn } from "@/lib/utils";
import type { Answer, Refusal } from "@/lib/api.ts";
import type { ListedAgent, ListedAgentWithConnections } from "@/lib/agents.ts";
import { agentPlatformText } from "@/lib/agents.ts";
import {
  agentPlatformChoices,
  agentsForOption,
  candidatesForOption,
  optionNamed,
  optionsForPlatform,
  type ConnectionCandidate,
  type ConnectionOption,
  type ConnectionOptionCatalog,
  type DiscoveredAgent,
} from "@/lib/connection-options.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { agentPlatformLabel } from "@/lib/transcripts.ts";
import { Field, Help, Problem } from "@/ui/form.tsx";
import { Empty, Failure, Loading, NotFound } from "@/ui/page-state.tsx";
import { useUnsavedChanges } from "@/ui/settings-read.ts";

import { modalityLabel } from "./connection-facts.tsx";
import { ConnectionFields, type Draft } from "./[agentId]/connections/fields.tsx";
import {
  configForLiveKitDispatch,
  liveKitDispatchForm,
  LiveKitDispatchSetup,
  newLiveKitDispatch,
  type LiveKitDispatch,
} from "./[agentId]/connections/livekit-dispatch.tsx";
import { AgentOnboardingProgress } from "./onboarding-progress.tsx";

/**
 * Connecting an agent: one panel, over the list, that does both halves.
 *
 * **It used to be two pages.** Register the agent on one, then be forwarded to
 * a second for its first connection — and an agent that got no further sat in
 * the list with nothing behind it. The boards put both in one side sheet
 * (`7E0-0` … `7TU-0`): the agent at the top, the way in under it, one submit.
 * `DESIGN.md` records the side sheet as where an agent or a connection is
 * created, read and edited.
 *
 * **The "Platform" select addresses the connection, not the agent, and that is
 * the one place this panel and the boards genuinely disagree.** The board draws
 * Platform inside the NEW AGENT block, which reads as a column on the agent.
 * `registerAgent` has no such field — `additionalProperties: false` — and an
 * agent's own `agentPlatform` is written only when Start monitoring binds it.
 * So the value is sent as `connection.agentPlatform`, which is where the
 * contract keeps it, and it is drawn where the board draws it while a new agent
 * is being made. Choosing a platform for an agent egma will never write one to
 * would be a control that lies.
 *
 * **Modality is a control on Retell and a sentence on LiveKit**, because that
 * is what the catalog says. Retell offers a chat option and a voice option, so
 * the segmented control chooses between two real connection shapes. LiveKit
 * offers voice and nothing else, so a two-way control there would offer a
 * choice that does not exist; the board draws a line of text and so does this.
 *
 * **Retell keeps its discovery block, which the board does not draw.** The
 * board shows one "Retell API key" box. That box cannot make either Retell
 * connection: a Retell phone connection *requires* `agentPlatformSelection`,
 * and a Retell chat connection has no other supplier of `retellAgentId`. The
 * key box is the first field of the block, so the board's first step is still
 * the first step.
 */

export type ConnectSheetResult = {
  readonly agentId: string;
  readonly connectionId: string | null;
  /** Whether this registration made the agent, rather than only a way in. */
  readonly created: boolean;
};

/** What "create a new agent" is, as a value the select can hold. */
const NEW_AGENT = "";

/**
 * The connection half of the write, typed from the operation that carries it.
 *
 * Both writes take the same object — `registerAgent` nests it under
 * `connection`, `addConnection` sends it as the whole body — so it is built
 * once and named from the generated client rather than re-declared here, where
 * it could fall out of step with the contract without anything failing.
 */
type ConnectionBody = NonNullable<Parameters<typeof registerAgent>[0]["connection"]>;

/** Voice or chat, named from the catalog rather than spelled out again here. */
type Modality = ConnectionOption["modality"];

export function ConnectAgentSheet({
  projectId,
  agents,
  agentId,
  onboarding = false,
  mayAuthor,
  role,
  onClose,
  onConnected,
}: {
  readonly projectId: string;
  /** The page of agents already on screen, offered as the picker's options. */
  readonly agents: readonly ListedAgentWithConnections[];
  /** The agent this sheet was opened for, or nothing to make a new one. */
  readonly agentId?: string;
  /** The two-stage deep link, which is the one place a progress bar is true. */
  readonly onboarding?: boolean;
  readonly mayAuthor: boolean;
  /** Null while the session read is in flight, so nothing is claimed yet. */
  readonly role: string | null;
  readonly onClose: () => void;
  readonly onConnected: (result: ConnectSheetResult) => void;
}) {
  const [chosenAgent, setChosenAgent] = useState<string>(agentId ?? NEW_AGENT);

  /* A deep link naming an agent chooses it, and changing deep link re-chooses. */
  useEffect(() => {
    setChosenAgent(agentId ?? NEW_AGENT);
  }, [agentId]);

  const [agentName, setAgentName] = useState("");
  const [agentNameProblem, setAgentNameProblem] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<ConnectionOptionCatalog | null>(null);
  const [catalogRefused, setCatalogRefused] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [platformValue, setPlatformValue] = useState("");
  const [modality, setModality] = useState<Modality | "">("");
  const [accessVariant, setAccessVariant] = useState("");
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<Draft>({ config: {}, credentials: {} });
  const [livekitDispatch, setLivekitDispatch] =
    useState<LiveKitDispatch>(newLiveKitDispatch);

  const [discoveryKey, setDiscoveryKey] = useState("");
  const [discoveredAgents, setDiscoveredAgents] = useState<
    readonly DiscoveredAgent[] | null
  >(null);
  const [discoveredAgentId, setDiscoveredAgentId] = useState("");
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [discovering, setDiscovering] = useState(false);
  const [discoverRefused, setDiscoverRefused] = useState<Refusal | null>(null);

  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  /**
   * Where the reason a submit is not ready is written.
   *
   * **It is a line of the panel, not a line of the footer.** `Button`'s own
   * `why` draws the sentence beside the control, which is right in a toolbar
   * and wrong in a 440px footer: the sentence takes the whole row and pushes
   * the way out onto a third line. Here it belongs under the fields it is
   * about anyway. The control still names it, and still carries it as a
   * `title`, so a pointer, a keyboard and a screen reader all reach it.
   */
  const whySaid = useId();

  /**
   * The chosen agent, read from the server rather than from the page behind.
   *
   * The list on screen is one page of agents. A deep link can name an agent on
   * none of them, and the picker would then show a chosen option that is not
   * in its own list. This read is also the only thing that knows whether the
   * agent already has a platform, which is what decides where the Platform
   * select is drawn — and that is a fact about the agent, not about the row.
   */
  const [known, setKnown] = useState<ListedAgent | null>(null);
  useEffect(() => {
    if (chosenAgent === NEW_AGENT) {
      setKnown(null);
      return undefined;
    }
    let current = true;
    setKnown(null);
    void platformAnswer(
      getAgent({ agentId: chosenAgent, projectId }, { client: platformClient }),
    ).then((read) => {
      if (!current) return;
      if (read.status === "signed-out") window.location.replace("/sign-in");
      else if (read.status === "ready") setKnown(read.value.agent);
    });
    return () => {
      current = false;
    };
  }, [chosenAgent, projectId]);

  useEffect(() => {
    let current = true;
    setCatalog(null);
    setCatalogRefused(null);
    void platformAnswer(listConnectionOptions({ client: platformClient })).then(
      (read) => {
        if (!current) return;
        if (read.status === "signed-out") {
          window.location.replace("/sign-in");
        } else if (read.status === "ready") {
          setCatalog(read.value);
          const first = read.value.items[0];
          if (first !== undefined) {
            setPlatformValue(first.agentPlatform ?? "unknown");
            setModality(first.modality);
            setAccessVariant(first.accessVariant);
          }
        } else {
          setCatalogRefused(read.refusal);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const creating = chosenAgent === NEW_AGENT;
  /*
   * An agent that is already bound to a platform decides the connection's
   * platform; nothing else can. Otherwise the select does, and it is drawn in
   * whichever block the person is working in.
   */
  const boundPlatform = known?.agentPlatform ?? null;
  const platformFixed = !creating && boundPlatform !== null;
  const selectedPlatform = platformFixed
    ? boundPlatform
    : platformValue === "unknown"
      ? null
      : platformValue === ""
        ? null
        : platformValue;

  const platformOptions = optionsForPlatform(catalog, selectedPlatform);
  const modalities = [...new Set(platformOptions.map((one) => one.modality))];
  const chooseableModality = modalities.length > 1;
  const shownModality = modalities.find((one) => one === modality) ?? modalities[0];
  const modalityOptions = platformOptions.filter(
    (one) => one.modality === shownModality,
  );
  const option =
    modalityOptions.find((one) => one.accessVariant === accessVariant) ??
    modalityOptions[0];

  const usesAgentDiscovery = option?.agentPlatform === "retell";
  const matchingAgents = agentsForOption(discoveredAgents, option);
  const chosenDiscoveredAgent = matchingAgents.find(
    (one) => one.platformAgentId === discoveredAgentId,
  );
  const matchingCandidates =
    chosenDiscoveredAgent === undefined
      ? []
      : candidatesForOption(chosenDiscoveredAgent, option);
  const chosenCandidate = matchingCandidates[candidateIndex];
  const chosenCandidateOption =
    chosenCandidate === undefined ? undefined : optionNamed(catalog, chosenCandidate);
  const liveKitForm = liveKitDispatchForm({
    connectionType: option?.connectionType,
    option,
    config: draft.config,
    mode: livekitDispatch,
  });

  const changed =
    agentName !== "" ||
    name !== "" ||
    livekitDispatch !== newLiveKitDispatch() ||
    discoveryKey !== "" ||
    discoveredAgents !== null ||
    Object.values(draft.config).some((value) => value !== "") ||
    Object.values(draft.credentials).some((value) => value !== "");
  useUnsavedChanges(changed && !saving && !discovering, saving || discovering);

  function forgetConnectionDraft(): void {
    setDraft({ config: {}, credentials: {} });
    setLivekitDispatch(newLiveKitDispatch());
    setDiscoveryKey("");
    setDiscoveredAgents(null);
    setDiscoveredAgentId("");
    setCandidateIndex(0);
    setDiscoverRefused(null);
    setRefused(null);
  }

  function choosePlatform(next: string): void {
    const platform = next === "unknown" ? null : next;
    const forPlatform = optionsForPlatform(catalog, platform);
    const first = forPlatform[0];
    setPlatformValue(next);
    setModality(first?.modality ?? "");
    setAccessVariant(first?.accessVariant ?? "");
    forgetConnectionDraft();
  }

  function chooseModality(next: Modality): void {
    const first = platformOptions.find((one) => one.modality === next);
    setModality(next);
    setAccessVariant(first?.accessVariant ?? "");
    forgetConnectionDraft();
  }

  function chooseOption(next: string): void {
    setAccessVariant(next);
    forgetConnectionDraft();
  }

  function chooseAgent(next: string): void {
    setChosenAgent(next);
    setAgentNameProblem(null);
    setRefused(null);
  }

  function chooseLiveKitDispatch(next: LiveKitDispatch): void {
    setLivekitDispatch(next);
    setDraft((current) => ({
      ...current,
      config: configForLiveKitDispatch(current.config, next),
    }));
  }

  function chooseFirstDiscoveredCandidate(
    found: readonly DiscoveredAgent[],
    selectedOption = option,
  ): void {
    const first = found.find(
      (one) => candidatesForOption(one, selectedOption).length > 0,
    );
    setDiscoveredAgentId(first?.platformAgentId ?? "");
    setCandidateIndex(0);
  }

  async function findAgents(): Promise<void> {
    if (
      discovering ||
      discoveryKey.trim() === "" ||
      option?.agentPlatform !== "retell"
    ) {
      return;
    }
    setDiscoverRefused(null);
    setDiscoveredAgents(null);
    setDiscoveredAgentId("");
    setCandidateIndex(0);
    setDiscovering(true);
    const answer = await platformAnswer(
      discoverAgents(
        {
          projectId,
          agentPlatform: option.agentPlatform,
          credentials: { apiKey: discoveryKey },
        },
        { client: platformClient },
      ),
    );
    setDiscovering(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setDiscoverRefused(answer.refusal);
      return;
    }
    // Discovery never returns a credential. The key stays in this password
    // field until the selected candidate is confirmed for the generic write.
    setDiscoveredAgents(answer.value.agents);
    chooseFirstDiscoveredCandidate(answer.value.agents);
  }

  /** Everything the connection half of this panel is about to send. */
  function connectionBody(chosen: ConnectionOption): ConnectionBody {
    const common = { ...(name.trim() === "" ? {} : { name: name.trim() }) };
    if (
      usesAgentDiscovery &&
      chosenCandidate !== undefined &&
      chosenCandidateOption !== undefined
    ) {
      return {
        ...common,
        agentPlatform: chosenCandidate.agentPlatform,
        connectionType: chosenCandidate.connectionType,
        accessVariant: chosenCandidate.accessVariant,
        modality: chosenCandidate.modality,
        config: chosenCandidate.config,
        // The server rechecks this one-time selection immediately before the
        // generic write. It discards the selection itself and retains the key
        // only when the chosen access variant needs it for simulation.
        agentPlatformSelection: {
          platformAgentId: discoveredAgentId,
          credentials: { apiKey: discoveryKey },
        },
      };
    }

    const config: Record<string, string> = {};
    for (const field of chosen.fields) {
      const written = draft.config[field.key]?.trim() ?? "";
      if (written !== "") config[field.key] = written;
    }
    const credentials: Record<string, string> = {};
    for (const field of chosen.credentialFields) {
      const written = draft.credentials[field.field]?.trim() ?? "";
      if (written !== "") credentials[field.field] = written;
    }
    return {
      ...common,
      agentPlatform: chosen.agentPlatform,
      connectionType: chosen.connectionType,
      accessVariant: chosen.accessVariant,
      modality: chosen.modality,
      config,
      ...(chosen.credentialRule === "forbidden" ||
      Object.keys(credentials).length === 0
        ? {}
        : { credentials }),
    };
  }

  /**
   * Whether the write landed, and what happens when it did not.
   *
   * A refusal is kept on screen with everything that was typed still in the
   * fields; an expired session leaves for sign-in rather than showing a panel
   * that can no longer write anything. Both answer `false`, and the caller
   * stops.
   */
  function finished<T>(answer: Answer<T>): answer is Extract<Answer<T>, { status: "ready" }> {
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return false;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return false;
    }
    if (usesAgentDiscovery) setDiscoveryKey("");
    return true;
  }

  async function connect(): Promise<void> {
    if (!mayAuthor || saving || option === undefined) return;

    if (creating && agentName.trim() === "") {
      // Checked here so nobody waits for a round trip to learn a field is
      // empty. The server checks it again, and the server is what decides.
      setAgentNameProblem("An agent needs a name, so that a list can tell it apart.");
      return;
    }

    if (usesAgentDiscovery) {
      if (
        chosenCandidate === undefined ||
        chosenCandidateOption === undefined ||
        discoveryKey.trim() === ""
      ) {
        setRefused({
          error: "unprocessable",
          message: "Load the Retell account, then select an available connection.",
        });
        return;
      }
    }

    const body = connectionBody(option);
    setAgentNameProblem(null);
    setRefused(null);
    setSaving(true);

    if (creating) {
      const answer = await platformAnswer(
        registerAgent(
          { projectId, name: agentName.trim(), connection: body },
          { client: platformClient },
        ),
      );
      setSaving(false);
      if (!finished(answer)) return;
      onConnected({
        agentId: answer.value.agent.id,
        connectionId: answer.value.connection?.id ?? null,
        created: true,
      });
      return;
    }

    const answer = await platformAnswer(
      addConnection(
        { agentId: chosenAgent, projectId, ...body },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (!finished(answer)) return;
    onConnected({
      agentId: chosenAgent,
      connectionId: answer.value.connection.id,
      created: false,
    });
  }

  const discoveryReady =
    !usesAgentDiscovery ||
    (chosenCandidate !== undefined &&
      chosenCandidateOption !== undefined &&
      discoveryKey.trim() !== "");
  const canSubmit = discoveryReady && liveKitForm.ready;
  const submitWhy = !discoveryReady
    ? "Load the Retell account, then select an available connection."
    : !liveKitForm.ready
      ? "Enter the exact LiveKit agent name, or choose automatic dispatch."
      : undefined;

  /**
   * The picker's options: making one, plus every agent this screen has read.
   *
   * The chosen agent is added when the page behind does not hold it, so a deep
   * link into an agent on the fourth page of the list still shows its own name
   * rather than falling back to "Create a new agent".
   */
  const choices: readonly { readonly id: string; readonly label: string }[] = [
    ...agents.map((one) => ({
      id: one.id,
      label: labelFor(one.name, agentPlatformText(one)),
    })),
    ...(chosenAgent !== NEW_AGENT && !agents.some((one) => one.id === chosenAgent)
      ? [
          {
            id: chosenAgent,
            label:
              known === null
                ? "This agent"
                : labelFor(
                    known.name,
                    known.agentPlatform === null
                      ? null
                      : agentPlatformLabel(known.agentPlatform),
                  ),
          },
        ]
      : []),
  ];

  function body(): ReactNode {
    if (role !== null && !mayAuthor) {
      return (
        <NotFound
          message={`Your ${role} role cannot connect agents. Ask an organization admin to change your role, then try again.`}
        />
      );
    }
    if (catalogRefused !== null) {
      return (
        <Failure
          title="Egma could not describe the connection options."
          message={catalogRefused.message}
          onRetry={() => setAttempt((current) => current + 1)}
        />
      );
    }
    if (catalog === null || option === undefined || liveKitForm.option === undefined) {
      return <Loading what="the connection options" />;
    }

    return (
      <>
        {onboarding ? <AgentOnboardingProgress current="connection" /> : null}

        <Field label="Agent" htmlFor="agent-choice">
          <Select
            id="agent-choice"
            value={chosenAgent}
            disabled={discovering || saving}
            onChange={(event) => chooseAgent(event.target.value)}
          >
            <option value={NEW_AGENT}>Create a new agent</option>
            {choices.map((one) => (
              <option key={one.id} value={one.id}>
                {one.label}
              </option>
            ))}
          </Select>
        </Field>

        {creating ? (
          <SheetGroup eyebrow="New agent" contained>
            <Field label="Name" htmlFor="agent-name">
              <Input
                id="agent-name"
                value={agentName}
                placeholder="Front desk"
                aria-invalid={agentNameProblem !== null ? true : undefined}
                aria-describedby={
                  agentNameProblem === null ? undefined : "agent-name-problem"
                }
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setAgentName(event.target.value);
                  if (agentNameProblem !== null) setAgentNameProblem(null);
                }}
              />
              {agentNameProblem === null ? null : (
                <Problem id="agent-name-problem">{agentNameProblem}</Problem>
              )}
              <Help>
                Its name in Egma. Its prompt, model and tools stay where you
                configure them.
              </Help>
            </Field>
            {platformField()}
          </SheetGroup>
        ) : null}

        <SheetGroup eyebrow="Connection">
          {creating ? null : platformField()}
          {chooseableModality ? (
            <ModalityChoice
              value={shownModality}
              modalities={modalities}
              disabled={discovering || saving}
              onChange={chooseModality}
            />
          ) : (
            <ModalityLine
              modality={shownModality}
              platform={selectedPlatform}
            />
          )}

          {modalityOptions.length > 1 ? (
            <Field label="Access" htmlFor="access-variant">
              <Select
                id="access-variant"
                value={option.accessVariant}
                disabled={discovering}
                onChange={(event) => chooseOption(event.target.value)}
              >
                {modalityOptions.map((one) => (
                  <option key={one.accessVariant} value={one.accessVariant}>
                    {one.accessVariantLabel}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <Field label="Connection name (optional)" htmlFor="connection-name">
            <Input
              id="connection-name"
              value={name}
              placeholder="A name for this connection"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
            <Help>The label shown for this connection in Egma.</Help>
          </Field>

          {usesAgentDiscovery ? (
            <AgentDiscoverySetup
              apiKey={discoveryKey}
              loaded={discoveredAgents !== null}
              agents={matchingAgents}
              selectedAgent={discoveredAgentId}
              candidates={matchingCandidates}
              selectedCandidate={candidateIndex}
              discovering={discovering}
              refusal={discoverRefused}
              onKeyChange={(value) => {
                setDiscoveryKey(value);
                setDiscoveredAgents(null);
                setDiscoveredAgentId("");
                setCandidateIndex(0);
                setDiscoverRefused(null);
              }}
              onDiscover={() => void findAgents()}
              onAgentChange={(next) => {
                setDiscoveredAgentId(next);
                setCandidateIndex(0);
              }}
              onCandidateChange={setCandidateIndex}
            />
          ) : (
            <ConnectionFields
              option={liveKitForm.option}
              draft={draft}
              onChange={setDraft}
              credentialsEditable
              beforeCredentialFields={
                !liveKitForm.enabled ? undefined : (
                  <LiveKitDispatchSetup
                    mode={liveKitForm.mode}
                    agentName={liveKitForm.agentName}
                    onModeChange={chooseLiveKitDispatch}
                    onAgentNameChange={(agentName) =>
                      setDraft((current) => ({
                        ...current,
                        config: { ...current.config, agentName },
                      }))
                    }
                  />
                )
              }
            />
          )}
        </SheetGroup>

        {refused === null ? null : <Problem>{refused.message}</Problem>}
        {submitWhy === undefined ? null : <Help id={whySaid}>{submitWhy}</Help>}
        {onboarding ? (
          <Help>
            Without a connection, Egma cannot run a simulation against this
            agent. You can add one later from Configuration.
          </Help>
        ) : null}
      </>
    );
  }

  /** The one select, drawn in whichever block owns the platform question. */
  function platformField(): ReactNode {
    if (platformFixed) return null;
    return (
      <Field label="Platform" htmlFor="agent-platform">
        <Select
          id="agent-platform"
          value={platformValue}
          disabled={discovering || saving}
          onChange={(event) => choosePlatform(event.target.value)}
        >
          {agentPlatformChoices(catalog).map((one) => (
            <option key={one.value} value={one.value}>
              {one.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  const usable = role === null || mayAuthor;

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent aria-describedby={undefined}>
        {/*
         * One `<form>` around the head, the fields and the footer, drawn as
         * `display: contents` so the three keep their places as the panel's own
         * flex children. It has to be one element: the submit is pinned to the
         * bottom and the fields scroll above it, and a button outside the form
         * is not the form's submit — Enter in a field would then do nothing.
         */}
        <form
          className="contents"
          data-slot="form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <SheetHeader>
            <SheetTitle>Connect an agent</SheetTitle>
          </SheetHeader>
          <SheetBody>{body()}</SheetBody>
          {usable ? (
            <SheetFooter>
              <Button
                type="submit"
                size="lg"
                disabled={saving || !canSubmit || catalog === null}
                title={submitWhy}
                aria-describedby={submitWhy === undefined ? undefined : whySaid}
              >
                {saving ? "Connecting…" : "Connect agent"}
              </Button>
              <Button type="button" size="lg" variant="secondary" onClick={onClose}>
                {onboarding ? "Finish without a connection" : "Cancel"}
              </Button>
            </SheetFooter>
          ) : null}
        </form>
      </SheetContent>
    </Sheet>
  );
}

/**
 * "remedy phase 1 · Retell", the way the board writes an agent in the picker.
 *
 * The platform arrives already in a person's words, because an agent on two
 * platforms is named with both of them and the list column and this picker
 * must not word that answer differently.
 */
function labelFor(name: string, platforms: string | null): string {
  return platforms === null ? name : `${name} · ${platforms}`;
}

/**
 * A named group of fields inside the sheet, under a letter-spaced eyebrow.
 *
 * `contained` is the NEW AGENT block, which the board draws on the canvas
 * colour inside a hairline (`7E0-0`) — the one block in the panel that is about
 * a different record from the rest of it.
 */
function SheetGroup({
  eyebrow,
  contained = false,
  children,
}: {
  readonly eyebrow: string;
  readonly contained?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-2xs tracking-(--tracking-label) text-faint uppercase">
        {eyebrow}
      </p>
      <div
        className={cn(
          "flex flex-col gap-3",
          contained && "border border-border bg-background p-4",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Chat or Voice, when the platform genuinely offers both.
 *
 * **It is a radio group, not two buttons.** One of these is true and the other
 * is not, which is what a radio group means and what a screen reader announces;
 * two toggle buttons would let a reader believe both could be pressed. The
 * arrow keys move between the segments and only the chosen one is a tab stop,
 * which is the behaviour every operating system gives a radio group.
 *
 * The chosen segment carries the Ember Wash fill *and* the heavier weight, so
 * the state is not colour alone.
 */
function ModalityChoice({
  value,
  modalities,
  disabled,
  onChange,
}: {
  readonly value: Modality | undefined;
  readonly modalities: readonly Modality[];
  readonly disabled: boolean;
  readonly onChange: (next: Modality) => void;
}) {
  function step(by: number): void {
    const here = value === undefined ? 0 : modalities.indexOf(value);
    const next = modalities[(here + by + modalities.length) % modalities.length];
    if (next !== undefined) onChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-sm text-faint" id="modality-label">
        Modality
      </p>
      <div
        aria-labelledby="modality-label"
        className="flex w-fit border border-border"
        role="radiogroup"
      >
        {modalities.map((one, index) => (
          <button
            aria-checked={one === value}
            className={cn(
              "flex min-h-(--control-md) cursor-pointer items-center justify-center px-6",
              "border-0 bg-transparent text-sm",
              "transition-[color,background-color] duration-(--duration-hover) ease-out",
              "disabled:cursor-not-allowed disabled:opacity-55",
              index > 0 && "border-l border-border",
              one === value
                ? "bg-surface-active font-medium text-foreground"
                : "text-muted-foreground pointer-hover:text-foreground",
            )}
            disabled={disabled}
            key={one}
            onClick={() => onChange(one)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                step(1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                step(-1);
              }
            }}
            role="radio"
            tabIndex={one === value ? 0 : -1}
            type="button"
          >
            {modalityLabel(one)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The modality, said rather than offered, where the platform has only one.
 *
 * LiveKit is voice and nothing else. A two-way control there would offer a
 * choice the catalog does not hold, and a person who pressed the other half
 * would be told afterwards that it does not exist.
 */
function ModalityLine({
  modality,
  platform,
}: {
  readonly modality: Modality | undefined;
  readonly platform: string | null;
}) {
  if (modality === undefined) return null;
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-2 text-sm">
      <span className="text-faint">Modality</span>
      <span className="text-foreground">{modalityLabel(modality)}</span>
      {platform === null ? null : (
        <span className="text-muted-foreground">
          {`— ${modalityLabel(modality).toLowerCase()} by default on ${agentPlatformLabel(platform)}`}
        </span>
      )}
    </p>
  );
}

/**
 * The Retell account, its agents, and the route this connection will take.
 *
 * The key loads the account and is kept in the field until the chosen candidate
 * is confirmed for the write. Egma stores it only when the chosen access
 * variant needs it for a simulation.
 */
function AgentDiscoverySetup({
  apiKey,
  loaded,
  agents,
  selectedAgent,
  candidates,
  selectedCandidate,
  discovering,
  refusal,
  onKeyChange,
  onDiscover,
  onAgentChange,
  onCandidateChange,
}: {
  readonly apiKey: string;
  readonly loaded: boolean;
  readonly agents: readonly DiscoveredAgent[];
  readonly selectedAgent: string;
  readonly candidates: readonly ConnectionCandidate[];
  readonly selectedCandidate: number;
  readonly discovering: boolean;
  readonly refusal: Refusal | null;
  readonly onKeyChange: (value: string) => void;
  readonly onDiscover: () => void;
  readonly onAgentChange: (value: string) => void;
  readonly onCandidateChange: (value: number) => void;
}) {
  return (
    <>
      <Field label="Retell API key" htmlFor="retell-api-key">
        <Input
          id="retell-api-key"
          value={apiKey}
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={discovering}
          onChange={(event) => onKeyChange(event.target.value)}
        />
        <Help>
          Egma uses this key to load your Retell agents and their available
          connections. Egma stores it only when the selected access method
          needs it.
        </Help>
      </Field>
      <Button
        type="button"
        variant="secondary"
        disabled={apiKey.trim() === ""}
        busy={discovering}
        onClick={onDiscover}
      >
        {discovering ? "Loading agents…" : "Load Retell agents"}
      </Button>
      {refusal === null ? null : <Problem>{refusal.message}</Problem>}

      {!loaded ? null : agents.length === 0 ? (
        <Empty
          title="No Retell agents support this access"
          lead="Select another access method, or use a key for the account that holds the agent you want to test."
        />
      ) : (
        <>
          <Field label="Retell agent" htmlFor="retell-agent">
            <Select
              id="retell-agent"
              value={selectedAgent}
              onChange={(event) => onAgentChange(event.target.value)}
            >
              {agents.map((one) => (
                <option key={one.platformAgentId} value={one.platformAgentId}>
                  {one.name === "" ? one.platformAgentId : one.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Connection" htmlFor="discovered-connection">
            <Select
              id="discovered-connection"
              value={String(selectedCandidate)}
              onChange={(event) =>
                onCandidateChange(Number.parseInt(event.target.value, 10))
              }
            >
              {candidates.map((candidate, index) => (
                <option
                  key={`${candidate.accessVariant}:${String(index)}`}
                  value={String(index)}
                >
                  {candidateLabel(candidate)}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}
    </>
  );
}

function candidateLabel(candidate: ConnectionCandidate): string {
  const phoneNumber = candidate.config.phoneNumber;
  return phoneNumber === undefined
    ? candidate.productLabel
    : `${candidate.productLabel} · ${phoneNumber}`;
}
