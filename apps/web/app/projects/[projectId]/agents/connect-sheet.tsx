"use client";

import { ChevronDownIcon } from "lucide-react";
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
import { Menu, MenuItem } from "@/ui/menu.tsx";
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
 * **"Connect a new agent" is last.** Reuse is the ordinary case and creation is
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

/** What "Connect a new agent" is, as a value the select can hold. */
const NEW_AGENT = "";

/**
 * Shorter than any key Retell issues, so the account is not read for it.
 *
 * It is a floor rather than a format: the server is what decides whether a key
 * works, and a browser inventing a stricter shape would refuse a key that does.
 */
const SHORTEST_KEY = 8;

/**
 * The platforms an agent can be connected on — LiveKit first, then Retell,
 * and no third one (founder ruling, 2026-08-24; the order is the developer's,
 * 2026-08-26). This list is the select's order as well as its filter, so the
 * dropdown reads it top to bottom rather than reading the catalog's own
 * ordering.
 *
 * **The catalog carries one more.** A phone number belongs to no platform in
 * particular, so the registry lists it under a platform-less option labelled
 * "Any or unknown" — which is a true thing about a connection type and a
 * meaningless answer to "what runs your agent". Offering it let somebody
 * register an agent bound to nothing, which nothing downstream can monitor.
 * The catalog is not changed; this sheet chooses what it offers from it.
 */
const OFFERED_PLATFORMS: readonly string[] = ["livekit", "retell"];

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
  /**
   * The Retell agent the person chose themselves, if they have chosen one.
   *
   * **It is the id, not a flag.** The picker's *value* is what the current
   * modality can show, and a modality that cannot reach the chosen agent has
   * to show something else — so the value is not a record of what was chosen.
   * Kept apart, the choice survives the trip through a modality that does not
   * have it, and the way back restores it.
   */
  const [handPicked, setHandPicked] = useState<string | null>(null);

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
          /*
           * **The catalog arrives and no platform is chosen for anybody.**
           * The select opens on "Choose a platform" and the connection's own
           * fields follow the answer (developer decision, 2026-08-26). This
           * used to pre-choose the catalog's first offered platform, which
           * put a Retell form in front of every person — a LiveKit owner had
           * to notice a filled-in answer was wrong before they could give
           * the right one.
           */
          setCatalog(read.value);
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
    : platformValue === ""
      ? null
      : platformValue;

  /*
   * **An unanswered platform offers no options at all.** `null` is also how
   * the catalog spells its platform-less entry — the public phone number —
   * so passing the unanswered state through `optionsForPlatform` would offer
   * exactly the option this sheet exists to keep out: an agent bound to
   * nothing, which nothing downstream can monitor.
   */
  const platformOptions =
    selectedPlatform === null
      ? []
      : optionsForPlatform(catalog, selectedPlatform);
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

  /**
   * Forget what was typed for one connection shape, and keep the account.
   *
   * **The account is not part of the draft.** `discoverAgents` answers the
   * whole Retell account and this sheet filters it by the chosen option, so
   * switching Chat↔Voice is a different view of the same answer rather than a
   * reason to ask again. Clearing it here left the person stranded: the
   * listing's own effect watches the key and the agent, neither of which a
   * modality switch touches, so nothing re-ran and the picker stayed empty
   * with Connect disabled until they retyped the key.
   *
   * The pick is kept too. It survives a switch that has it on both sides, and
   * the effect below corrects it when the new modality cannot reach it — so
   * Voice → Chat → Voice comes back to the agent it started on.
   *
   * The account is dropped where the account genuinely changes: a new key, or
   * a different agent whose sealed key opens a different one.
   */
  function forgetConnectionDraft(): void {
    setDraft({ config: {}, credentials: {} });
    setLivekitDispatch(newLiveKitDispatch());
    setDiscoverRefused(null);
    setRefused(null);
  }

  /** Drop the account listing itself, and everything read out of it. */
  function forgetDiscoveredAccount(): void {
    setDiscoveredAgents(null);
    setDiscoveredAgentId("");
    setHandPicked(null);
  }

  function choosePlatform(next: string): void {
    const forPlatform = optionsForPlatform(catalog, next);
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
    forgetDiscoveredAccount();
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
   * **Changing modality changes what can be reached, not what was chosen.**
   * An account's chat agents and its voice agents are different sets, so a
   * modality that cannot reach the chosen agent shows something else — and the
   * choice is remembered beside the value rather than replacing it, so coming
   * back restores it. A pick is only forgotten when the account itself is.
   */
  useEffect(() => {
    if (matchingAgents.length === 0) {
      if (discoveredAgentId !== "") setDiscoveredAgentId("");
      return;
    }
    /*
     * **Nothing is pre-selected until Egma knows what this agent is bound
     * to.** The account listing and the agent read race, and picking the
     * list's first entry while the read is still in flight would show one
     * agent and then swap it for another under the person's eyes.
     */
    if (chosenAgent !== NEW_AGENT && known === null) return;

    const reachable = (id: string | null): boolean =>
      id !== null && matchingAgents.some((one) => one.platformAgentId === id);

    /*
     * What this modality should show, in the order the answers outrank one
     * another:
     *
     * 1. **The choice, whenever this modality can reach it.** A person who
     *    picked an agent has said which agent this is about, and a switch to
     *    Chat and back is not them changing their mind. The correction below
     *    used to overwrite the pick itself, so the round trip quietly landed
     *    them on the account's first agent — the wrong provider agent, saved
     *    without anything having said so.
     * 2. **The binding, while nobody has chosen.** One egma agent binds to one
     *    platform agent, so the ordinary second connection is right without
     *    anybody choosing again.
     * 3. **What is already showing**, when this modality can still reach it.
     * 4. **The first agent it can reach**, which is the only answer left.
     */
    const wanted = reachable(handPicked)
      ? (handPicked ?? "")
      : handPicked === null && reachable(boundPlatformAgentId)
        ? (boundPlatformAgentId ?? "")
        : reachable(discoveredAgentId)
          ? discoveredAgentId
          : (matchingAgents[0]?.platformAgentId ?? "");

    if (discoveredAgentId !== wanted) setDiscoveredAgentId(wanted);
  }, [
    matchingAgents,
    discoveredAgentId,
    boundPlatformAgentId,
    handPicked,
    chosenAgent,
    known,
  ]);

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

    if (usesAgentDiscovery && !retellReady) {
      setRefused({ error: "unprocessable", message: whyNotYet ?? "" });
      return;
    }

    const body = connectionBody(option);
    setAgentNameProblem(null);
    setRefused(null);
    setSaving(true);

    if (creating) {
      /*
       * The platform-less option is never offered, so this cannot be reached
       * by anything a person can press. It stays because `agentPlatform` is
       * nullable on a connection option and `creating` is not a TypeScript
       * discriminant for it — the narrowing has to happen somewhere, and
       * silently is better than a sentence nobody can produce.
       */
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
  /*
   * **An unanswered platform is the first missing thing.** Without it there
   * is no option, and `liveKitForm.ready` is then vacuously true — a submit
   * gated on readiness alone would sit enabled in front of a form that has
   * not asked its questions yet, and press into a silent return.
   */
  const canSubmit = option !== undefined && retellReady && liveKitForm.ready;
  const submitWhy =
    option === undefined
      ? "Choose the platform this agent runs on."
      : (whyNotYet ??
        (liveKitForm.ready
          ? undefined
          : "Enter the exact LiveKit agent name, or choose automatic dispatch."));

  /**
   * The picker's options: making one, plus every agent this screen has read.
   *
   * The chosen agent is added when the page behind does not hold it, so a deep
   * link into an agent on the fourth page of the list still shows its own name
   * rather than falling back to "Connect a new agent".
   */
  const choices: readonly AgentChoice[] = [
    ...agents.map((one) => ({
      id: one.id,
      name: one.name,
      platform: agentPlatformText(one),
    })),
    ...(chosenAgent !== NEW_AGENT && !agents.some((one) => one.id === chosenAgent)
      ? [
          known === null
            ? { id: chosenAgent, name: "This agent", platform: null }
            : {
                id: chosenAgent,
                name: known.name,
                platform: agentPlatformLabel(known.agentPlatform),
              },
        ]
      : []),
  ];
  const chosen = choices.find((one) => one.id === chosenAgent);

  function body(): ReactNode {
    /*
     * **While the role is unknown there is no form.** A deep link opens this
     * panel before the session read has answered, and a form drawn then is an
     * enabled credential field in front of somebody Egma has not identified —
     * who may turn out to be a viewer, and be told so only after they had
     * pasted a key into it. The list gates its own Connect control the same
     * way, for the same reason.
     */
    if (role === null) return <Loading what="what you can do here" />;
    if (!mayAuthor) {
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
    if (catalog === null) {
      return <Loading what="the connection options" />;
    }
    /*
     * A platform that is decided — bound to the agent, or chosen in the
     * select — names its options. A decided platform whose options have not
     * arrived is the loading state it always was; an undecided one is a form
     * waiting on its first answer, and the sheet below draws that.
     */
    if (
      selectedPlatform !== null &&
      (option === undefined || liveKitForm.option === undefined)
    ) {
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
          <Menu
            label="Agent*"
            triggerId="agent-choice"
            disabled={saving}
            placement="below-start"
            panelClassName="w-(--radix-popover-trigger-width) max-w-none"
            triggerClassName={cn(
              "flex min-h-(--control-lg) w-full min-w-0 cursor-pointer items-center gap-2 px-3",
              "rounded-input border border-input bg-surface text-left text-base text-foreground",
              "pointer-coarse:min-h-(--tap-target)",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
            trigger={
              <>
                {chosen === undefined ? (
                  <span className="min-w-0 flex-1">Connect a new agent</span>
                ) : (
                  <AgentChoiceLabel name={chosen.name} platform={chosen.platform} />
                )}
                <ChevronDownIcon
                  className="size-4 flex-none text-faint"
                  aria-hidden="true"
                  strokeWidth={1.75}
                />
              </>
            }
          >
            {(close) => (
              <>
                {choices.map((one) => (
                  <MenuItem
                    key={one.id}
                    selected={one.id === chosenAgent}
                    onClick={() => {
                      chooseAgent(one.id);
                      close();
                    }}
                  >
                    <AgentChoiceLabel name={one.name} platform={one.platform} />
                  </MenuItem>
                ))}
                <MenuItem
                  selected={chosenAgent === NEW_AGENT}
                  onClick={() => {
                    chooseAgent(NEW_AGENT);
                    close();
                  }}
                >
                  Connect a new agent
                </MenuItem>
              </>
            )}
          </Menu>
        </Field>

        {creating ? (
          <SheetGroup eyebrow="New agent">
            <Field label="Name*" htmlFor="agent-name">
              <Input
                aria-required="true"
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

        {/*
          * **The Connection block exists once there is a platform question to
          * hold.** While a new agent's platform is unanswered, the block would
          * be an eyebrow over nothing — the select lives in the NEW AGENT
          * group, and everything else here follows the answer.
          */}
        {creating && option === undefined ? null : (
          <SheetGroup eyebrow="Connection">
            {creating ? null : platformField()}
            {configuration()}
          </SheetGroup>
        )}

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

  /**
   * Everything under the platform question, drawn once it has an answer.
   *
   * **The fields follow the platform** (developer decision, 2026-08-26):
   * choosing Retell draws the key, the account's agents and the number;
   * choosing LiveKit draws the room, the dispatch contract and the key pair.
   * Before the answer there is nothing here — not a disabled copy of one
   * platform's form, which is a set of questions Egma is not asking.
   */
  function configuration(): ReactNode {
    const chosen = option;
    const shape = liveKitForm.option;
    if (chosen === undefined || shape === undefined) return null;
    return (
      <>
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
                value={chosen.accessVariant}
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
                forgetDiscoveredAccount();
                setDiscoverRefused(null);
              }}
              onAgentChange={(next) => {
                setHandPicked(next);
                setDiscoveredAgentId(next);
              }}
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
              option={shape}
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
      </>
    );
  }

  /**
   * The one select, drawn in whichever block owns the platform question.
   *
   * **Its first item is the question.** The select opens on "Choose a
   * platform" and the connection's fields follow the answer, so nobody is
   * shown one platform's questions before saying which platform they are on.
   * The item is disabled because it is a question rather than an answer:
   * once a platform is chosen, "none" is not a state a connection can hold.
   * The label carries the `*` and the control carries `aria-required`, which
   * is the label grammar every mandatory field in the product uses.
   */
  function platformField(): ReactNode {
    if (platformFixed) return null;
    return (
      <Field label="Platform*" htmlFor="agent-platform">
        <Select
          aria-required="true"
          id="agent-platform"
          value={platformValue}
          disabled={saving}
          onChange={(event) => choosePlatform(event.target.value)}
        >
          <option value="" disabled>
            Choose a platform
          </option>
          {OFFERED_PLATFORMS.flatMap((offered) => {
            const one = agentPlatformChoices(catalog).find(
              (choice) => choice.value === offered,
            );
            return one === undefined ? [] : [one];
          }).map((one) => (
            <option key={one.value} value={one.value}>
              {one.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  /** The submit exists once Egma knows whose it would be, and not before. */
  const usable = role !== null && mayAuthor;

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

/** One agent the picker offers: its name, and where it already lives. */
type AgentChoice = {
  readonly id: string;
  readonly name: string;
  readonly platform: string | null;
};

/**
 * "remedy phase 1" in the product's text colour, then "Retell" faint beside it.
 *
 * The name is the answer to "which agent is this" and the platform is context
 * for it, so they are not drawn at the same weight. The row used to read
 * "remedy phase 1 · Retell" in one colour, where the platform argued with the
 * name for the first read of every option.
 *
 * **The name truncates and the platform does not.** A long name that pushed the
 * platform off the end would leave two agents of the same family looking
 * identical, which is the one thing the platform is there to prevent.
 *
 * The platform arrives already in a person's words, because an agent on two
 * platforms is named with both of them and the list column and this picker
 * must not word that answer differently.
 */
function AgentChoiceLabel({
  name,
  platform,
}: {
  readonly name: string;
  readonly platform: string | null;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
        {name}
      </span>
      {platform === null ? null : (
        <span className="flex-none text-faint">{platform}</span>
      )}
    </span>
  );
}

/**
 * A named group of fields inside the sheet, under a letter-spaced eyebrow.
 *
 * **The grey box is gone.** The NEW AGENT block used to be drawn on the canvas
 * colour inside a hairline; the 2026-08-24 boards put its fields flush with
 * the rest of the panel (`I79-0`), so a group is now an eyebrow and the fields
 * under it, and nothing else.
 */
function SheetGroup({
  eyebrow,
  children,
}: {
  readonly eyebrow: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-2xs tracking-(--tracking-label) text-faint uppercase">
        {eyebrow}
      </p>
      <div className="flex flex-col gap-3">{children}</div>
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
              /*
               * `bg-brand`, which is Ember. `accent` is the neutral quiet
               * surface in this theme, so `bg-accent` drew the founder's
               * two-pixel Ember line in grey — the state was there and the
               * brand signal was not.
               */
              "before:origin-left before:bg-brand before:transition-[opacity,transform]",
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
            aria-required="true"
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
              aria-required="true"
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
                aria-required="true"
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
