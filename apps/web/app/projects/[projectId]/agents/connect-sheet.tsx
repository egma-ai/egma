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
import { Checkbox } from "@/components/ui/checkbox";
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
  optionsForPlatform,
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
 * Connecting an agent: one panel, over the list, one save.
 *
 * **It used to be two ideas.** Register the agent, then add a connection — and
 * the Retell half asked a person to copy an agent id out of another product by
 * hand, behind a "Load Retell agents" button they had to know to press. The
 * boards of 2026-08-24 (`I79-0`, `ICT-0`, `II3-0`) draw one sheet: the agent
 * at the top, the way in under it, one submit, and no step anywhere that Egma
 * could have taken itself.
 *
 * **The key loads the account the moment it looks like a key.** No button:
 * pasting a key is the person saying "this is my account", and asking them to
 * confirm it by pressing something is asking twice. The agents come back by
 * name and the pick is by name; the id never appears in the flow.
 *
 * **One paste per agent, ever.** The save seals the key on the agent, so a
 * second connection onto the same agent shows no key field at all — the sheet
 * says which key the agent holds and lists the account with it.
 *
 * **"Create a new agent" is last.** Reuse is the ordinary case and creation is
 * the fallback, so the picker reads as a list of agents with a way to make one
 * under it rather than a create form with a list attached.
 *
 * **Modality is a control on Retell and a sentence on LiveKit**, because that
 * is what the catalog says. Retell offers a chat option and a voice option, so
 * the segmented control chooses between two real connection shapes. LiveKit
 * offers voice and nothing else, so a two-way control there would offer a
 * choice that does not exist.
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
 * Shorter than any key Retell issues, so the account is not read for it.
 *
 * It is a floor rather than a format: the server is what decides whether a key
 * works, and a browser inventing a stricter shape would refuse a key that does.
 */
const SHORTEST_KEY = 8;

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
  const [discovering, setDiscovering] = useState(false);
  const [discoverRefused, setDiscoverRefused] = useState<Refusal | null>(null);
  /** Whether this save also starts pulling the agent's production calls. */
  const [pullCalls, setPullCalls] = useState(false);

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
  /**
   * The key this flow will use, and where it came from.
   *
   * An agent that already holds one is never asked again (`ICT-0`): the sheet
   * says which key it holds and every listing spends the sealed copy, which
   * the server reads for itself. Otherwise the paste is the key, and it is the
   * paste that will be sealed by this save.
   */
  const sealedKeyHint = known?.monitoringKeyPresent === true
    ? known.monitoringApiKeyHint
    : null;
  /** The platform agent this egma agent is already bound to, or nothing. */
  const boundPlatformAgentId = known?.platformAgentId ?? null;
  const asksForKey = usesAgentDiscovery && sealedKeyHint === null;
  const pasted = discoveryKey.trim();
  /** Long enough to be a key at all, which is when the account is read. */
  const keyLooksReal = pasted.length >= SHORTEST_KEY;
  /** Which agent this connection will be made on, for the words that name it. */
  const namedAgent = creating
    ? agentName.trim() === ""
      ? "this agent"
      : agentName.trim()
    : (known?.name ?? "this agent");
  const phoneNumber = draft.config["phoneNumber"]?.trim() ?? "";
  const needsPhoneNumber =
    usesAgentDiscovery && option?.connectionType === "phone_number";
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
    setDiscoveredAgents(null);
    setDiscoveredAgentId("");
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
    /*
     * The key belongs to the agent, so changing agent drops the paste and the
     * account it opened. Keeping them would leave one agent's list on screen
     * under another agent's name.
     */
    setDiscoveryKey("");
    setPullCalls(false);
    forgetConnectionDraft();
  }

  function chooseLiveKitDispatch(next: LiveKitDispatch): void {
    setLivekitDispatch(next);
    setDraft((current) => ({
      ...current,
      config: configForLiveKitDispatch(current.config, next),
    }));
  }

  /**
   * Read the Retell account, by itself.
   *
   * **There is no button.** The listing runs when the key looks like a key, or
   * at once for an agent that already holds one — pressing something to
   * confirm a paste is asking the same question twice. It is debounced so that
   * a paste is one request rather than one per keystroke, and every answer
   * that lands after the question changed is dropped.
   */
  useEffect(() => {
    if (!usesAgentDiscovery) return undefined;
    const spending: { readonly credentials: { readonly apiKey: string } } | { readonly agentId: string } | null =
      asksForKey
        ? keyLooksReal
          ? { credentials: { apiKey: pasted } }
          : null
        : chosenAgent === NEW_AGENT
          ? null
          : { agentId: chosenAgent };
    if (spending === null) {
      setDiscoveredAgents(null);
      setDiscoveredAgentId("");
      setDiscoverRefused(null);
      return undefined;
    }

    let current = true;
    setDiscoverRefused(null);
    setDiscovering(true);
    const settle = setTimeout(() => {
      void platformAnswer(
        discoverAgents(
          { projectId, agentPlatform: "retell", ...spending },
          { client: platformClient },
        ),
      ).then((answer) => {
        if (!current) return;
        setDiscovering(false);
        if (answer.status === "signed-out") {
          window.location.replace("/sign-in");
          return;
        }
        if (answer.status !== "ready") {
          setDiscoveredAgents(null);
          setDiscoveredAgentId("");
          setDiscoverRefused(answer.refusal);
          return;
        }
        // Discovery never returns a credential. The paste stays in its field
        // until the save seals it on the agent.
        setDiscoveredAgents(answer.value.agents);
      });
    }, 350);

    return () => {
      current = false;
      clearTimeout(settle);
      setDiscovering(false);
    };
  }, [usesAgentDiscovery, asksForKey, keyLooksReal, pasted, chosenAgent, projectId]);

  /**
   * The picked agent, kept true to the list under it — and pre-selected on the
   * one this egma agent is already bound to.
   *
   * **One egma agent binds to one platform agent.** An agent Egma already
   * knows as `agent_voice_1` is offered that agent, so the ordinary second
   * connection is right without anybody choosing again. Picking another one is
   * still allowed to be attempted: the server holds the rule and answers in
   * place, and a control that refused locally would be a second opinion able
   * to disagree with it.
   *
   * Changing modality changes which of the account's agents can be reached at
   * all, so a pick that is no longer in the list is dropped rather than
   * carried into a save that would be refused.
   */
  useEffect(() => {
    if (matchingAgents.length === 0) {
      if (discoveredAgentId !== "") setDiscoveredAgentId("");
      return;
    }
    if (!matchingAgents.some((one) => one.platformAgentId === discoveredAgentId)) {
      const bound = matchingAgents.find(
        (one) => one.platformAgentId === boundPlatformAgentId,
      );
      setDiscoveredAgentId(
        bound?.platformAgentId ?? matchingAgents[0]?.platformAgentId ?? "",
      );
    }
  }, [matchingAgents, discoveredAgentId, boundPlatformAgentId]);

  /** Everything the connection half of this panel is about to send. */
  function connectionBody(chosen: ConnectionOption): ConnectionBody {
    const common = { ...(name.trim() === "" ? {} : { name: name.trim() }) };
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

    /*
     * **Retell names the picked agent and hands over the paste.** The server
     * confirms the id against the account immediately before the write, seals
     * the key on the agent, and — when the box is ticked — starts the pull in
     * the same save. Nothing here sends an id somebody typed: the id came from
     * the account listing and the person picked a name.
     */
    if (usesAgentDiscovery) {
      return {
        ...common,
        agentPlatform: chosen.agentPlatform,
        connectionType: chosen.connectionType,
        accessVariant: chosen.accessVariant,
        modality: chosen.modality,
        config,
        platformAgentId: discoveredAgentId,
        ...(asksForKey ? { credentials: { apiKey: pasted } } : {}),
        ...(pullCalls ? { pullProductionCalls: true } : {}),
      };
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
    const newAgentPlatform = option.agentPlatform;

    if (creating && agentName.trim() === "") {
      // Checked here so nobody waits for a round trip to learn a field is
      // empty. The server checks it again, and the server is what decides.
      setAgentNameProblem("An agent needs a name, so that a list can tell it apart.");
      return;
    }

    if (creating && newAgentPlatform === null) {
      setRefused({
        error: "unprocessable",
        message: "Choose Retell or LiveKit for the new agent.",
      });
      return;
    }

    if (usesAgentDiscovery && !retellReady) {
      setRefused({ error: "unprocessable", message: whyNotYet ?? "" });
      return;
    }

    const body = connectionBody(option);
    setAgentNameProblem(null);
    setRefused(null);
    setSaving(true);

    if (creating) {
      // Kept beside the typed request as well as the early user-facing guard
      // because `creating` is not a TypeScript discriminant for the platform.
      if (newAgentPlatform === null) {
        setSaving(false);
        return;
      }
      const answer = await platformAnswer(
        registerAgent(
          {
            projectId,
            name: agentName.trim(),
            agentPlatform: newAgentPlatform,
            connection: body,
          },
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

  /**
   * What is still missing, said in one sentence and never in a list.
   *
   * The order is the order of the fields, so the sentence changes as somebody
   * fills them in and always names the next thing rather than the last one.
   */
  const whyNotYet: string | undefined = !usesAgentDiscovery
    ? undefined
    : asksForKey && !keyLooksReal
      ? "Paste your Retell API key."
      : discoveredAgentId === ""
        ? discovering
          ? "Egma is reading your Retell account."
          : `Choose the Retell ${modalityLabel(shownModality ?? "voice").toLowerCase()} agent this connection reaches.`
        : needsPhoneNumber && phoneNumber === ""
          ? "Type the phone number Egma calls in a simulation."
          : undefined;
  const retellReady = !usesAgentDiscovery || whyNotYet === undefined;
  const canSubmit = retellReady && liveKitForm.ready;
  const submitWhy =
    whyNotYet ??
    (liveKitForm.ready
      ? undefined
      : "Enter the exact LiveKit agent name, or choose automatic dispatch.");

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
                : labelFor(known.name, agentPlatformLabel(known.agentPlatform)),
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

          {/*
          * **Creation is last.** Reuse is the ordinary case, so the list reads
          * as the agents this project already has with a way to make one under
          * them (`I79-0`). Putting it first made a new agent the default answer
          * to "which agent is this", which is how one vendor agent ends up
          * registered twice.
          */}
        <Field label="Agent*" htmlFor="agent-choice">
          <Select
            id="agent-choice"
            value={chosenAgent}
            disabled={saving}
            onChange={(event) => chooseAgent(event.target.value)}
          >
            {choices.map((one) => (
              <option key={one.id} value={one.id}>
                {one.label}
              </option>
            ))}
            <option value={NEW_AGENT}>Create a new agent</option>
          </Select>
        </Field>

        {creating ? (
          <SheetGroup eyebrow="New agent">
            <Field label="Name*" htmlFor="agent-name">
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
              <Help>Its name in Egma, and nowhere else.</Help>
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
              disabled={saving}
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
                disabled={saving}
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

          <Field label="Connection name [optional]" htmlFor="connection-name">
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
            <RetellSetup
              apiKey={discoveryKey}
              asksForKey={asksForKey}
              sealedKeyHint={sealedKeyHint}
              agents={matchingAgents}
              loaded={discoveredAgents !== null}
              selectedAgent={discoveredAgentId}
              modality={shownModality ?? "voice"}
              discovering={discovering}
              refusal={discoverRefused}
              phoneNumber={draft.config["phoneNumber"] ?? ""}
              needsPhoneNumber={needsPhoneNumber}
              pullCalls={pullCalls}
              agentName={namedAgent}
              disabled={saving}
              onKeyChange={(value) => {
                setDiscoveryKey(value);
                setDiscoveredAgents(null);
                setDiscoveredAgentId("");
                setDiscoverRefused(null);
              }}
              onAgentChange={setDiscoveredAgentId}
              onPhoneNumberChange={(phoneNumber) =>
                setDraft((current) => ({
                  ...current,
                  config: { ...current.config, phoneNumber },
                }))
              }
              onPullChange={setPullCalls}
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
          disabled={saving}
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
 * **The chosen segment carries a two-pixel Ember line on its top edge**, over
 * a plain fill, plus weight 500 so the state is not colour alone (`DESIGN.md`,
 * developer decision 2026-08-24). The Ember Wash fill it used to wear is the
 * primary action's own surface, and a segment wearing it read as a button to
 * press rather than as the choice already made.
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
              "relative flex min-h-(--control-md) cursor-pointer items-center justify-center px-6",
              "border-0 bg-transparent text-sm",
              "transition-colors duration-(--duration-hover) ease-out",
              "disabled:cursor-not-allowed disabled:opacity-55",
              index > 0 && "border-l border-border",
              /*
               * The line is drawn by the segment rather than added as an
               * element, so switching segments moves one painted edge instead
               * of mounting and unmounting a bar.
               */
              "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:content-['']",
              "before:origin-left before:bg-accent before:transition-[opacity,transform]",
              "before:duration-(--duration-hover) before:ease-out",
              "motion-reduce:before:transition-none",
              one === value
                ? "font-medium text-foreground before:scale-x-100 before:opacity-100"
                : "text-muted-foreground before:scale-x-0 before:opacity-0 pointer-hover:text-foreground",
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
 * The Retell half of the sheet: the key, the account it opens, the number Egma
 * dials, and whether this save also starts pulling production calls.
 *
 * **The key is asked for once per agent, ever.** An agent that already holds
 * one shows a line saying which key it holds and no field at all (`ICT-0`);
 * the account listing spends the sealed copy, which never leaves the server.
 *
 * **The listing is not a step.** It runs from the key, and the person picks
 * their agent by name. The Retell agent id is not typed anywhere and is not
 * shown anywhere: what a person knows their agent by is its name.
 */
function RetellSetup({
  apiKey,
  asksForKey,
  sealedKeyHint,
  agents,
  loaded,
  selectedAgent,
  modality,
  discovering,
  refusal,
  phoneNumber,
  needsPhoneNumber,
  pullCalls,
  agentName,
  disabled,
  onKeyChange,
  onAgentChange,
  onPhoneNumberChange,
  onPullChange,
}: {
  readonly apiKey: string;
  readonly asksForKey: boolean;
  /** The last characters of the key this agent already holds, or null. */
  readonly sealedKeyHint: string | null;
  readonly agents: readonly DiscoveredAgent[];
  readonly loaded: boolean;
  readonly selectedAgent: string;
  readonly modality: Modality;
  readonly discovering: boolean;
  readonly refusal: Refusal | null;
  readonly phoneNumber: string;
  readonly needsPhoneNumber: boolean;
  readonly pullCalls: boolean;
  /** Whose calls the checkbox would pull, named in its own label. */
  readonly agentName: string;
  readonly disabled: boolean;
  readonly onKeyChange: (value: string) => void;
  readonly onAgentChange: (value: string) => void;
  readonly onPhoneNumberChange: (value: string) => void;
  readonly onPullChange: (value: boolean) => void;
}) {
  const pulls = useId();
  const spoken = modalityLabel(modality).toLowerCase();

  return (
    <>
      {asksForKey ? (
        <Field label="Retell API key*" htmlFor="retell-api-key">
          <Input
            id="retell-api-key"
            value={apiKey}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => onKeyChange(event.target.value)}
          />
        </Field>
      ) : sealedKeyHint === null ? null : (
        <p className="m-0 text-sm leading-(--line-normal) text-faint">
          {`This agent already holds its Retell key (…${sealedKeyHint}). No key is asked again.`}
        </p>
      )}
      {refusal === null ? null : <Problem>{refusal.message}</Problem>}

      {/*
       * The account, once it answers — and the panel travels in rather than
       * appearing, so a section that was not there a moment ago explains where
       * it came from. `DESIGN.md`'s popover pair is the shortest one that
       * still explains an arrival.
       */}
      {!loaded ? null : agents.length === 0 ? (
        <Empty
          title={`No Retell ${spoken} agents on this account`}
          lead="Switch the modality above, or use a key for the account that holds the agent you want to test."
        />
      ) : (
        <div
          className="flex flex-col gap-3"
          data-slot="retell-account"
        >
          <Field
            label={`Retell ${spoken} agent*`}
            htmlFor="retell-agent"
            hint={
              asksForKey
                ? "Loaded from your account with the key above."
                : "Loaded from your account with the stored key."
            }
          >
            <Select
              id="retell-agent"
              value={selectedAgent}
              disabled={disabled}
              onChange={(event) => onAgentChange(event.target.value)}
            >
              {agents.map((one) => (
                <option key={one.platformAgentId} value={one.platformAgentId}>
                  {one.name === "" ? one.platformAgentId : one.name}
                </option>
              ))}
            </Select>
          </Field>

          {!needsPhoneNumber ? null : (
            <Field
              label="Phone number*"
              htmlFor="retell-phone-number"
              hint="The number Egma calls in a simulation, like +15551234567."
            >
              <Input
                className="font-mono"
                id="retell-phone-number"
                inputMode="tel"
                value={phoneNumber}
                placeholder="+15551234567"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                onChange={(event) => onPhoneNumberChange(event.target.value)}
              />
            </Field>
          )}

          {/*
           * **Off by default, and it starts on this save.** Monitoring begins
           * where the connection is made rather than on a screen of its own;
           * the first switch-on brings the last 30 days with it.
           */}
          <div className="flex items-center gap-2.5">
            <Checkbox
              checked={pullCalls}
              disabled={disabled}
              id={pulls}
              onChange={(event) => onPullChange(event.target.checked)}
            />
            <label className="cursor-pointer text-sm text-foreground" htmlFor={pulls}>
              {`Pull production calls for ${agentName}`}
            </label>
          </div>
        </div>
      )}
    </>
  );
}
