"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  addConnection,
  discoverAgents,
  getAgent,
  listAgents,
  listConnectionOptions,
  registerAgent,
  updateConnection,
  startMonitoring,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  RadioCardIndicator,
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Answer, Refusal } from "@/lib/api.ts";
import {
  type ListedConnection,
  type ListedAgentWithConnections,
} from "@/lib/agents.ts";
import {
  optionNamed,
  optionsForPlatform,
  type ConnectionOption,
  type ConnectionOptionCatalog,
  type DiscoveredAgent,
} from "@/lib/connection-options.ts";
import {
  agentSetupPlan,
  previousAgentSetupStep,
  retellAgentCanEnterPlan,
  retellAgentsForPlan,
  retellCandidateForLane,
  retellCandidateValue,
  retellCandidatesForPlan,
  RETELL_LANES,
  RETELL_LANE_HELP,
  RETELL_LANE_LABELS,
  RETELL_LANE_QUESTION,
  stepAfterRetellLanes,
  type RetellLane,
  isSdkPlatform,
  SDK_ACCESS_CHOICES,
  SDK_CONNECTION_TYPES,
  SDK_MODALITY_CHOICES,
  SDK_PLATFORM_LABELS,
  sdkConnectionTitle,
  stepAfterSdkConnection,
  stepAfterSdkTesting,
  stepAfterPlatform,
  stepAfterRetellAgent,
  type AgentSetupGoal,
  type AgentSetupPlatform,
  type AgentSetupStep,
  type LiveKitWorkerLanguage,
  type RetellConnectionCandidate,
  type SdkAccessChoice,
  type SdkPlatform,
} from "@/lib/agent-setup-flow.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { cn } from "@/lib/utils";
import {
  Field,
  Help,
  Problem,
  Refused as FormRefused,
} from "@/ui/form.tsx";
import { useDraftNavigation } from "@/ui/draft-navigation.tsx";
import { Empty, Failure, Loading, NotFound } from "@/ui/page-state.tsx";
import { useUnsavedChanges } from "@/ui/settings-read.ts";

import { LiveKitTestingInstructions } from "./livekit-testing-instructions.tsx";
import { LiveKitMonitoringInstructions } from "./livekit-monitoring-instructions.tsx";
import { PipecatMonitoringInstructions } from "./pipecat-monitoring-instructions.tsx";
import { PipecatTestingInstructions } from "./pipecat-testing-instructions.tsx";
import {
  ConnectionFields,
  type Draft,
} from "./[agentId]/connections/fields.tsx";

export type ConnectSheetResult = {
  readonly agentId: string;
  readonly connectionId: string | null;
  readonly created: boolean;
};

export type ConnectAgentGoal = AgentSetupGoal;
export type ConnectAgentPlatform = AgentSetupPlatform;
export type RetellRecovery = {
  readonly agentId: string | null;
  readonly platformAgentId: string;
};

type ConnectionBody = NonNullable<
  Parameters<typeof registerAgent>[0]["connection"]
>;

type RetellSaveProgress = {
  readonly signature: string;
  readonly completedLanes: number;
  readonly landed: ConnectSheetResult;
};

/** Whether a read-back connection is the exact lane this setup tried to save. */
function sameConnection(
  stored: ListedConnection,
  requested: ConnectionBody,
): boolean {
  const requestedConfig = requested.config ?? {};
  const storedEntries = Object.entries(stored.config);
  const requestedEntries = Object.entries(requestedConfig);
  return (
    stored.agentPlatform === requested.agentPlatform &&
    stored.connectionType === requested.connectionType &&
    stored.accessVariant === requested.accessVariant &&
    stored.modality === requested.modality &&
    storedEntries.length === requestedEntries.length &&
    requestedEntries.every(
      ([key, value]) =>
        typeof value === "string" && stored.config[key] === value,
    )
  );
}

type ConnectAgentSheetProps = {
  readonly projectId: string;
  readonly agents: readonly ListedAgentWithConnections[];
  readonly agentId?: string;
  readonly goal?: ConnectAgentGoal;
  readonly platform?: ConnectAgentPlatform;
  readonly mayAuthor: boolean;
  readonly role: string | null;
  readonly retellRecovery: RetellRecovery | null;
  readonly onClose: () => void;
  readonly onConnected: (result: ConnectSheetResult) => void;
  readonly onRecoveryNeeded: (recovery: RetellRecovery) => void;
};

const NEW_AGENT = "";
const SHORTEST_KEY = 8;
const SELF_HOSTED = "daily_room.self_hosted";

function firstStep(
  goal: AgentSetupGoal | undefined,
  platform: AgentSetupPlatform | undefined,
): AgentSetupStep {
  if (goal !== undefined && platform !== undefined) {
    return stepAfterPlatform(goal, platform);
  }
  return "goal";
}

function retellModality(
  agent: DiscoveredAgent | undefined,
): "chat" | "voice" | null {
  return agent?.modality ?? null;
}

export function ConnectAgentSheet(props: ConnectAgentSheetProps) {
  const {
    projectId,
    agents,
    agentId,
    goal: initialGoal,
    platform: initialPlatform,
    mayAuthor,
    role,
    retellRecovery,
    onClose,
    onConnected,
    onRecoveryNeeded,
  } = props;
  const draftNavigation = useDraftNavigation();

  const [step, setStep] = useState<AgentSetupStep>(() =>
    firstStep(initialGoal, initialPlatform),
  );
  const [goal, setGoal] = useState<AgentSetupGoal | "">(initialGoal ?? "");
  const [platform, setPlatform] = useState<AgentSetupPlatform | "">(
    initialPlatform ?? "",
  );

  const [catalog, setCatalog] = useState<ConnectionOptionCatalog | null>(null);
  const [catalogRefused, setCatalogRefused] = useState<Refusal | null>(null);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const listedKnown =
    agentId === undefined || agentId === NEW_AGENT
      ? undefined
      : agents.find((one) => one.id === agentId);
  const [known, setKnown] = useState<
    Omit<ListedAgentWithConnections, "connections"> | null
  >(() => listedKnown ?? null);
  const [knownStatus, setKnownStatus] = useState<
    "loading" | "ready" | "missing" | "failed"
  >(() =>
    agentId !== undefined && agentId !== NEW_AGENT && listedKnown === undefined
      ? "loading"
      : "ready",
  );
  const [knownRefused, setKnownRefused] = useState<Refusal | null>(null);
  const [knownAttempt, setKnownAttempt] = useState(0);

  const [apiKey, setApiKey] = useState("");
  const [retellAgents, setRetellAgents] = useState<
    readonly DiscoveredAgent[] | null
  >(null);
  const [retellAgentId, setRetellAgentId] = useState("");
  const [retellRoute, setRetellRoute] = useState("");
  // How the developer wants to test a voice agent: chat over text mode, or
  // voice down a call. The modality question the flow leads with for a voice
  // agent whose goal is a simulation.
  /**
   * The lane picked in the one question. One, because a lane is a connection.
   *
   * Nothing starts picked — one lane dials a real telephone, and a flow that
   * arrived with an answer already in it would be answering for the developer.
   * A second lane on the same agent is added afterwards, through this same
   * flow, from the agent's own screen.
   */
  const [lane, setLane] = useState<RetellLane | "">("");
  const [discovering, setDiscovering] = useState(false);

  // This chooses which source instructions are visible. It is never written
  // to the connection, and Python is the first documentation view rather than
  // an unanswered setup question.
  const [livekitLanguage, setLivekitLanguage] =
    useState<LiveKitWorkerLanguage>("python");
  // The LiveKit and Pipecat walk's answers (`SdkPlatform`). The access
  // variant is chosen with the modality, from what the catalog offers for it.
  const [sdkModality, setSdkModality] = useState<"chat" | "voice" | "">("");
  const [sdkAccess, setSdkAccess] = useState("");
  // LiveKit's worker name, or a new self-hosted Pipecat agent's name.
  const [sdkAgentName, setSdkAgentName] = useState("");
  const [sdkConfig, setSdkConfig] = useState<
    Readonly<Record<string, string>>
  >({});
  const [sdkCredentials, setSdkCredentials] = useState<
    Readonly<Record<string, string>>
  >({});

  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [completed, setCompleted] = useState<ConnectSheetResult | null>(null);
  const [retellProgress, setRetellProgress] =
    useState<RetellSaveProgress | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setGoal(initialGoal ?? "");
    setPlatform(initialPlatform ?? "");
    setStep(firstStep(initialGoal, initialPlatform));
    setApiKey("");
    setRetellAgents(null);
    setRetellAgentId("");
    setRetellRoute("");
    setLane("");
    setLivekitLanguage("python");
    setSdkModality("");
    setSdkAccess("");
    setSdkAgentName("");
    setSdkConfig({});
    setSdkCredentials({});
    setCompleted(null);
    setRetellProgress(null);
    setRefused(null);
  }, [agentId, initialGoal, initialPlatform]);

  useEffect(() => {
    if (agentId === undefined || agentId === NEW_AGENT) {
      setKnown(null);
      setKnownStatus("ready");
      setKnownRefused(null);
      return undefined;
    }
    if (listedKnown !== undefined) {
      setKnown(listedKnown);
      setKnownStatus("ready");
      setKnownRefused(null);
      return undefined;
    }
    let current = true;
    setKnown(null);
    setKnownStatus("loading");
    setKnownRefused(null);
    void platformAnswer(
      getAgent({ agentId, projectId }, { client: platformClient }),
    ).then((answer) => {
      if (!current) return;
      if (answer.status === "signed-out") window.location.replace("/sign-in");
      else if (answer.status === "ready") {
        setKnown(answer.value.agent);
        setKnownStatus("ready");
      } else {
        setKnownStatus(answer.status);
        setKnownRefused(answer.refusal);
      }
    });
    return () => {
      current = false;
    };
  }, [agentId, knownAttempt, listedKnown, projectId]);

  /*
   * An existing agent keeps the provider it was registered on. Capability
   * links carry that provider for a fast path, but the saved agent is the
   * authority when a copied or stale link disagrees.
   */
  useEffect(() => {
    if (
      agentId === undefined ||
      agentId === NEW_AGENT ||
      knownStatus !== "ready" ||
      known === null ||
      platform === known.agentPlatform
    ) {
      return;
    }
    setPlatform(known.agentPlatform);
    setStep(firstStep(initialGoal, known.agentPlatform));
  }, [agentId, initialGoal, known, knownStatus, platform]);

  useEffect(() => {
    let current = true;
    setCatalog(null);
    setCatalogRefused(null);
    void platformAnswer(listConnectionOptions({ client: platformClient })).then(
      (answer) => {
        if (!current) return;
        if (answer.status === "signed-out") {
          window.location.replace("/sign-in");
        } else if (answer.status === "ready") {
          setCatalog(answer.value);
        } else {
          setCatalogRefused(answer.refusal);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [catalogAttempt]);

  useEffect(() => {
    const target =
      bodyRef.current?.querySelector<HTMLElement>("[data-setup-heading]") ??
      bodyRef.current?.querySelector<HTMLElement>(
        "#livekit-monitoring-title",
      );
    target?.focus();
  }, [step]);

  const plan =
    goal === "" || platform === "" ? null : agentSetupPlan(goal, platform);
  const plannedRetellAgents =
    plan === null ? [] : retellAgentsForPlan(plan, retellAgents);
  const boundRetellPlatformAgentId =
    agentId !== undefined && agentId !== NEW_AGENT
      ? (known?.platformAgentId ?? null)
      : null;
  const visibleRetellAgents =
    boundRetellPlatformAgentId === null
      ? plannedRetellAgents
      : plannedRetellAgents.filter(
          (one) => one.platformAgentId === boundRetellPlatformAgentId,
        );
  const selectedRetellAgent = visibleRetellAgents.find(
    (one) => one.platformAgentId === retellAgentId,
  );
  const selectedRoutes =
    plan === null ? [] : retellCandidatesForPlan(plan, selectedRetellAgent);
  // The phone chooser lists numbers and nothing else. The web-call candidate
  // discovery also answers with carries no number, so it would sit here as a
  // blank option and — being first — become the step's default, saving a web
  // call where the person asked for a phone. It is picked by its own tick in
  // the one question instead.
  const voiceRoutes = selectedRoutes.filter(
    (one) => one.connectionType === "phone_number",
  );
  const selectedVoiceRoute = voiceRoutes.find(
    (one) => retellCandidateValue(one) === retellRoute,
  );
  /**
   * The lane this goal will save, and the candidate that saves it.
   *
   * A Both goal skips the question and saves the phone lane, and that save
   * also starts pulling. A simulation goal saves the one that was picked.
   * The monitoring goal saves no lane at all — its finish is the pull
   * switch — so this value never reaches a save on that walk.
   */
  const laneToSave: RetellLane | "" =
    plan?.asksHowToTest === true ? lane : "phone";
  const lanesToSave: readonly RetellLane[] =
    laneToSave === "" ? [] : [laneToSave];
  const retellSaveSignature = JSON.stringify([
    retellAgentId,
    lanesToSave,
    retellRoute,
  ]);

  const sdkPlatform: SdkPlatform | null = isSdkPlatform(platform)
    ? platform
    : null;
  const sdkOptions =
    sdkPlatform === null
      ? []
      : optionsForPlatform(catalog, sdkPlatform).filter(
          (one) => one.connectionType === SDK_CONNECTION_TYPES[sdkPlatform],
        );
  /** The modalities this Egma offers on the platform's room, in the catalog's order. */
  const sdkModalities = [...new Set(sdkOptions.map((one) => one.modality))];
  /** The access variants that speak the chosen modality. */
  const sdkAccessOptions = sdkOptions.filter(
    (one) => one.modality === sdkModality,
  );
  /** The select's entries, in the product's order, as far as the catalog offers them. */
  const sdkAccessChoices =
    sdkPlatform === null
      ? []
      : SDK_ACCESS_CHOICES[sdkPlatform].filter((choice) =>
          sdkAccessOptions.some(
            (one) => one.accessVariant === choice.accessVariant,
          ),
        );
  /*
   * The pair decides the row, never the access variant alone.
   *
   * Chat and voice share one access variant, so matching the variant would
   * answer with whichever row the server listed first — and a chat walk would
   * save a voice connection with nothing anywhere saying so.
   */
  const sdkOption = sdkAccessOptions.find(
    (one) => one.accessVariant === sdkAccess,
  );
  const registeringAgent = agentId === undefined || agentId === NEW_AGENT;
  /*
   * The name the flow asks for beside the connection's own fields: LiveKit's
   * worker name, which is also its config, or — for a new agent reached only
   * by a self-hosted Pipecat starter — the agent's name, which no field of
   * that connection carries. A Pipecat Cloud connection's agent name is its
   * own field and names the agent too.
   */
  const asksAgentName =
    sdkPlatform === "livekit" ||
    (sdkPlatform === "pipecat" && sdkAccess === SELF_HOSTED && registeringAgent);
  const sdkFieldValue = (key: string): string =>
    sdkPlatform === "livekit" && key === "agentName"
      ? sdkAgentName
      : (sdkConfig[key] ?? "");
  /** The name a new agent is registered under. */
  const registrationName = (
    asksAgentName ? sdkAgentName : sdkFieldValue("agentName")
  ).trim();
  const storedRetellKey =
    agentId !== undefined &&
    known?.monitoringKeyPresent === true;
  const keyReady = storedRetellKey || apiKey.trim().length >= SHORTEST_KEY;
  const sdkReady =
    sdkOption !== undefined &&
    sdkOption.fields
      .filter((field) => field.required)
      .every((field) => sdkFieldValue(field.key).trim() !== "") &&
    sdkOption.credentialFields
      .filter((field) => field.required)
      .every((field) => (sdkCredentials[field.field]?.trim() ?? "") !== "") &&
    (!asksAgentName || sdkAgentName.trim() !== "");

  const changed =
    apiKey !== "" ||
    retellAgents !== null ||
    sdkAgentName !== "" ||
    Object.values(sdkConfig).some((value) => value !== "") ||
    Object.values(sdkCredentials).some((value) => value !== "");
  const savedSdkConnection = sdkPlatform !== null && completed !== null;
  useUnsavedChanges(
    !savedSdkConnection && changed && !saving && !discovering,
    saving || discovering,
  );

  function transition(next: AgentSetupStep): void {
    setRefused(null);
    setStep(next);
  }

  function leave(): void {
    if (completed !== null) {
      onConnected(completed);
      return;
    }
    draftNavigation.request(onClose);
  }

  function clearProviderAnswers(): void {
    setApiKey("");
    setRetellAgents(null);
    setRetellAgentId("");
    setRetellRoute("");
    setLane("");
    setLivekitLanguage("python");
    setSdkModality("");
    setSdkAccess("");
    setSdkAgentName("");
    setSdkConfig({});
    setSdkCredentials({});
    setCompleted(null);
    setRetellProgress(null);
    setRefused(null);
  }

  function chooseGoal(next: AgentSetupGoal): void {
    if (next !== goal) clearProviderAnswers();
    setGoal(next);
  }

  function choosePlatform(next: AgentSetupPlatform): void {
    if (known !== null && next !== known.agentPlatform) return;
    if (next !== platform) clearProviderAnswers();
    setPlatform(next);
  }

  /*
   * Each modality offers whichever ways in the catalog lists for it — today
   * every variant speaks both. A way in the new modality does not offer falls
   * back to the first one it does, in the select's order, so the form never
   * draws a connection type the server would refuse.
   */
  function chooseSdkModality(next: "chat" | "voice"): void {
    if (sdkPlatform === null) return;
    if (next !== sdkModality) {
      setSdkConfig({});
      setSdkCredentials({});
    }
    const offered: readonly string[] = sdkOptions
      .filter((one) => one.modality === next)
      .map((one) => one.accessVariant);
    if (!offered.includes(sdkAccess)) {
      const first = SDK_ACCESS_CHOICES[sdkPlatform].find((choice) =>
        offered.includes(choice.accessVariant),
      );
      setSdkAccess(first?.accessVariant ?? offered[0] ?? "");
    }
    setSdkModality(next);
  }

  function back(): void {
    const previous = previousAgentSetupStep({
      step,
      goal,
    });
    if (previous === null) {
      leave();
      return;
    }
    transition(previous);
  }

  function finishAnswer<T>(
    answer: Answer<T>,
  ): answer is Extract<Answer<T>, { status: "ready" }> {
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return false;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return false;
    }
    return true;
  }

  async function findRetellAgents(): Promise<void> {
    if (discovering || !keyReady) return;
    setDiscovering(true);
    setRefused(null);
    const credentials = apiKey.trim();
    const answer = await platformAnswer(
      discoverAgents(
        {
          projectId,
          agentPlatform: "retell",
          ...(storedRetellKey && agentId !== undefined
            ? { agentId }
            : { credentials: { apiKey: credentials } }),
        },
        { client: platformClient },
      ),
    );
    setDiscovering(false);
    if (!finishAnswer(answer)) return;
    setRetellAgents(answer.value.agents);
    setRetellAgentId("");
    setRetellRoute("");
    setLane("");
    transition("retell-agent");
  }

  function connectionBody(
    option: ConnectionOption,
    candidate?: RetellConnectionCandidate,
    pullProductionCalls = false,
  ): ConnectionBody {
    if (candidate !== undefined) {
      return {
        agentPlatform: option.agentPlatform,
        connectionType: option.connectionType,
        accessVariant: option.accessVariant,
        modality: option.modality,
        config: candidate.config,
        platformAgentId: retellAgentId,
        ...(storedRetellKey
          ? {}
          : { credentials: { apiKey: apiKey.trim() } }),
        ...(pullProductionCalls ? { pullProductionCalls: true } : {}),
      };
    }

    const config: Record<string, string> = {};
    for (const field of option.fields) {
      const value = sdkFieldValue(field.key).trim();
      if (value !== "") config[field.key] = value;
    }
    const credentials: Record<string, string> = {};
    for (const field of option.credentialFields) {
      const value = sdkCredentials[field.field]?.trim() ?? "";
      if (value !== "") credentials[field.field] = value;
    }
    return {
      agentPlatform: option.agentPlatform,
      connectionType: option.connectionType,
      accessVariant: option.accessVariant,
      modality: option.modality,
      config,
      ...(Object.keys(credentials).length === 0 ? {} : { credentials }),
    };
  }

  async function saveConnection(
    /** The platform a new agent is registered on: this walk's platform. */
    agentPlatform: AgentSetupPlatform,
    name: string,
    body: ConnectionBody,
    /**
     * The agent an earlier lane in this same pass landed on, when there is one.
     *
     * It is what makes several lanes one agent: the first lane registers, and
     * every lane after it is added to what came back.
     */
    landedOn?: string,
  ): Promise<ConnectSheetResult | null> {
    setSaving(true);
    setRefused(null);

    const onto = landedOn ?? agentId;
    if (onto === undefined || onto === NEW_AGENT) {
      const answer = await platformAnswer(
        registerAgent(
          { projectId, name, agentPlatform, connection: body },
          { client: platformClient },
        ),
      );
      setSaving(false);
      if (!finishAnswer(answer)) return null;
      return {
        agentId: answer.value.agent.id,
        connectionId: answer.value.connection?.id ?? null,
        created: answer.value.result === "created",
      };
    }

    const answer = await platformAnswer(
      addConnection(
        { agentId: onto, projectId, ...body },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (!finishAnswer(answer)) return null;
    return {
      agentId: onto,
      connectionId: answer.value.connection.id,
      created: false,
    };
  }

  /**
   * Start monitoring through the API. With no Egma agent ID, the server finds
   * or registers the platform agent. Reusing a stored credential requires an
   * explicit Egma agent ID.
   */
  async function startRetellMonitoringWatch(target: {
    readonly agentId: string | null;
    readonly platformAgentId: string;
    readonly name: string;
  }): Promise<{ readonly agentId: string; readonly created: boolean } | null> {
    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      startMonitoring(
        {
          projectId,
          agentPlatform: "retell",
          ...(storedRetellKey && target.agentId !== null
            ? {}
            : { apiKey: apiKey.trim() }),
          watch: [
            target.agentId === null
              ? {
                  platformAgentId: target.platformAgentId,
                  name: target.name,
                }
              : {
                  agentId: target.agentId,
                  platformAgentId: target.platformAgentId,
                },
          ],
        },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (!finishAnswer(answer)) return null;

    const watching = answer.value.watching.find(
      (one) => one.platformAgentId === target.platformAgentId,
    );
    if (watching === undefined) {
      const refusal = answer.value.refused.find(
        (one) => one.platformAgentId === target.platformAgentId,
      );
      setRefused({
        error: "monitoring_not_started",
        message:
          refusal?.message ??
          "Egma did not start monitoring this agent. Try again.",
      });
      return null;
    }

    return { agentId: watching.agentId, created: watching.created === true };
  }

  /**
   * The Monitoring goal's whole finish, from the agent choice itself.
   *
   * Production pull needs the sealed key and the platform agent id — the
   * puller selects calls by agent id alone — so no provider connection is
   * written and no phone number is asked for.
   */
  async function finishRetellMonitoring(): Promise<void> {
    if (selectedRetellAgent === undefined) return;
    const startedFrom =
      agentId !== undefined && agentId !== NEW_AGENT ? agentId : null;
    const watched = await startRetellMonitoringWatch({
      agentId: startedFrom,
      platformAgentId: selectedRetellAgent.platformAgentId,
      name: selectedRetellAgent.name || selectedRetellAgent.platformAgentId,
    });
    if (watched === null) return;
    onConnected({
      agentId: watched.agentId,
      connectionId: null,
      created: watched.created,
    });
  }

  /**
   * Save selected connection types under one Egma agent. Stop on refusal and
   * retain progress for retry; earlier successful writes are not rolled back.
   */
  async function finishRetellLanes(): Promise<void> {
    if (goal === "" || selectedRetellAgent === undefined) return;
    if (lanesToSave.length === 0) return;

    const requestedLanes: Array<{
      readonly body: ConnectionBody;
      readonly pullsProduction: boolean;
    }> = [];
    for (const lane of lanesToSave) {
      const candidate = retellCandidateForLane(
        selectedRoutes,
        lane,
        retellRoute,
      );
      if (candidate === undefined) return;
      const option = optionNamed(catalog, candidate);
      if (option === undefined) return;
      const pullsProduction =
        plan?.pullWithConnection === true && lane === "phone";
      requestedLanes.push({
        body: connectionBody(option, candidate, pullsProduction),
        pullsProduction,
      });
    }

    const saved =
      retellProgress?.signature === retellSaveSignature
        ? retellProgress
        : null;
    const explicitLanding =
      agentId === undefined || agentId === NEW_AGENT
        ? null
        : { agentId, connectionId: null, created: false };
    const recoveryLanding =
      retellRecovery !== null &&
      retellRecovery.platformAgentId ===
        selectedRetellAgent.platformAgentId &&
      retellRecovery.agentId !== null
        ? {
            agentId: retellRecovery.agentId,
            connectionId: null,
            created: false,
          }
        : null;
    const exactLandings = (
      listed: readonly ListedAgentWithConnections[],
    ): readonly ListedAgentWithConnections[] =>
      listed.filter(
        (one) =>
          one.agentPlatform === "retell" &&
          one.platformAgentId === selectedRetellAgent.platformAgentId &&
          one.connections.some((stored) =>
            requestedLanes.some(({ body }) => sameConnection(stored, body)),
          ),
      );
    let listedLandings =
      saved !== null || explicitLanding !== null || recoveryLanding !== null
        ? []
        : exactLandings(agents);
    if (
      saved === null &&
      explicitLanding === null &&
      recoveryLanding === null &&
      listedLandings.length === 0 &&
      retellRecovery?.platformAgentId ===
        selectedRetellAgent.platformAgentId
    ) {
      setSaving(true);
      setRefused(null);
      const answer = await platformAnswer(
        listAgents({ projectId }, { client: platformClient }),
      );
      setSaving(false);
      if (!finishAnswer(answer)) return;
      listedLandings = exactLandings(answer.value.agents);
    }
    if (listedLandings.length > 1) {
      setRefused({
        error: "unprocessable",
        message:
          "More than one Egma agent already has this Retell setup. Open the agent you want to finish, then try again.",
      });
      return;
    }
    const listedLanding = listedLandings[0];
    let landed: ConnectSheetResult | null =
      saved?.landed ??
      explicitLanding ??
      recoveryLanding ??
      (listedLanding === undefined
        ? null
        : {
            agentId: listedLanding.id,
            connectionId: null,
            created: false,
          });
    let retryConnections: readonly ListedConnection[] = [];
    let retryPullEnabled = false;
    let readReusedLanding = false;
    if (landed !== null) {
      setSaving(true);
      setRefused(null);
      const answer = await platformAnswer(
        getAgent(
          { agentId: landed.agentId, projectId },
          { client: platformClient },
        ),
      );
      setSaving(false);
      if (!finishAnswer(answer)) return;
      retryConnections = answer.value.connections;
      retryPullEnabled = answer.value.agent.pullProductionCalls;
    }
    // **One lane, walked by a loop that can carry several.** The setup flow
    // picks exactly one lane now, so `requestedLanes` always holds one entry.
    // The loop stays because everything inside it is the recovery path — the
    // committed-connection read-back, the landed-agent carry, the progress
    // record a lost response is resumed from — and that machinery answers the
    // same questions for one lane as for three. Rewriting it into a straight
    // line would be rewriting the part that is hard to get right in order to
    // delete an `index` that costs nothing.
    for (const [index, { body, pullsProduction }] of requestedLanes.entries()) {
      if (readReusedLanding && landed !== null) {
        setSaving(true);
        setRefused(null);
        const answer = await platformAnswer(
          getAgent(
            { agentId: landed.agentId, projectId },
            { client: platformClient },
          ),
        );
        setSaving(false);
        if (!finishAnswer(answer)) return;
        retryConnections = answer.value.connections;
        retryPullEnabled = answer.value.agent.pullProductionCalls;
        readReusedLanding = false;
      }
      /*
       * A provider write can commit while its HTTP response is lost. On a
       * retry or reopen, accept the exact lane already there instead of
       * issuing the non-idempotent POST a second time. `retellProgress` only
       * explains partial work in the UI; the server read decides what exists.
       */
      const committed = retryConnections.find((one) =>
        sameConnection(one, body),
      );
      if (committed !== undefined && landed !== null) {
        onRecoveryNeeded({
          agentId: landed.agentId,
          platformAgentId: selectedRetellAgent.platformAgentId,
        });
        setRetellProgress({
          signature: retellSaveSignature,
          completedLanes: index + 1,
          landed,
        });
      }
      if (
        committed !== undefined &&
        pullsProduction &&
        !retryPullEnabled
      ) {
        const started = await startRetellMonitoringWatch({
          agentId: landed?.agentId ?? committed.agentId,
          platformAgentId: selectedRetellAgent.platformAgentId,
          name: selectedRetellAgent.name || selectedRetellAgent.platformAgentId,
        });
        if (started === null) return;
        retryPullEnabled = true;
      }
      if (committed === undefined && landed !== null) {
        // Preserve the landed agent even when this POST commits but its
        // response is lost, including a one-lane setup on an existing agent.
        setRetellProgress({
          signature: retellSaveSignature,
          completedLanes: index,
          landed,
        });
      }
      let result: ConnectSheetResult | null;
      if (committed !== undefined) {
        result = {
          agentId: landed?.agentId ?? committed.agentId,
          connectionId: committed.id,
          created: landed?.created ?? false,
        };
      } else {
        // The request may commit even when its answer never reaches this tab.
        // Keep the parent screen in recovery mode before the write begins so
        // Close, retry, or a filtered list cannot turn that uncertainty into a
        // second non-idempotent request.
        onRecoveryNeeded({
          agentId: landed?.agentId ?? null,
          platformAgentId: selectedRetellAgent.platformAgentId,
        });
        result = await saveConnection(
          "retell",
          selectedRetellAgent.name,
          body,
          landed?.agentId,
        );
      }
      if (result === null) return;
      const landedBeforeThisLane = landed;
      landed = {
        ...result,
        agentId: landed === null ? result.agentId : landed.agentId,
        created: landed?.created ?? result.created,
      };
      readReusedLanding =
        landedBeforeThisLane === null && result.created === false;
      const progress = {
        signature: retellSaveSignature,
        completedLanes: index + 1,
        landed,
      } satisfies RetellSaveProgress;
      setRetellProgress(progress);
      setCompleted(landed);
    }
    if (landed !== null) {
      setRetellProgress(null);
      onConnected(landed);
    }
  }

  async function finishSdkConnection(): Promise<void> {
    if (
      goal === "" ||
      plan === null ||
      sdkPlatform === null ||
      sdkOption === undefined
    ) {
      return;
    }
    // Saved already, and this press is the way on: a Both walk that came back
    // to this screen must not save a second connection to move forward.
    if (completed !== null) {
      const next = stepAfterSdkConnection(plan);
      if (next === null) onConnected(completed);
      else transition(next);
      return;
    }
    if (!sdkReady) return;
    const result = await saveConnection(
      sdkPlatform,
      registrationName,
      connectionBody(sdkOption),
    );
    if (result === null) return;
    const next = stepAfterSdkConnection(plan);
    setCompleted(result);
    transition(next);
  }

  async function continueFlow(): Promise<void> {
    switch (step) {
      case "goal":
        if (goal !== "") transition("platform");
        return;
      case "platform":
        if (goal !== "" && platform !== "") {
          transition(stepAfterPlatform(goal, platform));
        }
        return;
      case "retell-key":
        await findRetellAgents();
        return;
      case "retell-agent": {
        if (goal === "" || plan === null || selectedRetellAgent === undefined) {
          return;
        }
        const next = stepAfterRetellAgent(plan);
        // The monitoring goal has nothing left to ask: the pull switch needs
        // no provider route, so the agent choice is the whole of it.
        if (next === null) {
          await finishRetellMonitoring();
          return;
        }
        // Both skips the question and saves the phone lane, so it needs its
        // first routed number chosen for it; the question's own walk waits.
        if (next === "retell-phone") {
          const first = voiceRoutes[0];
          setRetellRoute(first === undefined ? "" : retellCandidateValue(first));
        }
        transition(next);
        return;
      }
      case "retell-lanes": {
        if (lane === "") return;
        // The phone lane carries on to the number chooser; the other two have
        // nothing left to ask and save here.
        const next = stepAfterRetellLanes(lane);
        if (next === null) {
          await finishRetellLanes();
          return;
        }
        const first = voiceRoutes[0];
        setRetellRoute(first === undefined ? "" : retellCandidateValue(first));
        transition(next);
        return;
      }
      case "retell-phone":
        await finishRetellLanes();
        return;
      case "sdk-modality":
        if (sdkModality !== "") transition("sdk-connection");
        return;
      case "sdk-connection":
        await finishSdkConnection();
        return;
      case "sdk-testing": {
        const next = plan === null ? null : stepAfterSdkTesting(plan);
        if (next !== null) {
          transition(next);
        } else if (completed === null) {
          onClose();
        } else {
          onConnected(completed);
        }
        return;
      }
      case "sdk-monitoring":
        // Monitoring needs a source hook. Both carries LiveKit's language
        // choice forward; it is never part of the connection.
        if (goal === "both" && completed === null) {
          transition("sdk-modality");
          return;
        }
        if (completed === null) leave();
        else onConnected(completed);
        return;
    }
  }

  function body(): ReactNode {
    if (role === null) return <Loading what="what you can do here" />;
    if (!mayAuthor) {
      return (
        <NotFound
          message={
            "Your " +
            role +
            " role cannot connect agents. Ask an organization admin to change your role, then try again."
          }
        />
      );
    }

    const needsKnown = agentId !== undefined && agentId !== NEW_AGENT;
    if (needsKnown && knownStatus === "loading") {
      return <Loading what="this agent's saved setup" />;
    }
    if (needsKnown && knownStatus === "missing" && knownRefused !== null) {
      return <NotFound message={knownRefused.message} />;
    }
    if (needsKnown && knownStatus === "failed" && knownRefused !== null) {
      return (
        <Failure
          title="Egma could not load this agent's saved setup."
          message={knownRefused.message}
          onRetry={() => setKnownAttempt((current) => current + 1)}
        />
      );
    }

    const needsCatalog =
      step === "sdk-modality" ||
      step === "sdk-connection" ||
      step === "retell-phone" ||
      // The one question can save on Continue when the phone lane was not
      // picked, and that needs the option catalog to name the row it writes.
      step === "retell-lanes";
    if (needsCatalog && catalogRefused !== null) {
      return (
        <Failure
          title="Egma could not describe the connection options."
          message={catalogRefused.message}
          onRetry={() => setCatalogAttempt((current) => current + 1)}
        />
      );
    }
    if (needsCatalog && catalog === null) {
      return <Loading what="the connection options" />;
    }

    switch (step) {
      case "goal":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title="What do you want Egma to do?"
              description={
                initialGoal === "monitoring"
                  ? "Production monitoring is selected because you started from Traces. You can still change the goal."
                  : undefined
              }
            />
            <RadioGroup
              className="gap-6"
              aria-label="Setup goal"
              value={goal}
              onValueChange={(value) =>
                chooseGoal(value as AgentSetupGoal)
              }
            >
              <ChoiceCard
                value="simulation"
                title="Run simulations"
                description="Test how the agent responds before production."
              />
              <ChoiceCard
                value="monitoring"
                title="Monitor production"
                description="Monitor an agent in production"
              />
              <ChoiceCard
                value="both"
                title="Set up both"
                description="Configure an agent for both testing and monitoring"
              />
            </RadioGroup>
          </div>
        );
      case "platform":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro title="Choose your agent platform" />
            <RadioGroup
              className="gap-4"
              aria-label="Agent platform"
              value={platform}
              onValueChange={(value) =>
                choosePlatform(value as AgentSetupPlatform)
              }
            >
              {/*
                LiveKit leads. (Developer decision, 2026-08-31.) The order is
                the only thing that says which platform this product expects
                first, and nothing else on this step ranks them.
              */}
              {known === null || known.agentPlatform === "livekit" ? (
                <ChoiceCard compact value="livekit" title="LiveKit" />
              ) : null}
              {known === null || known.agentPlatform === "retell" ? (
                <ChoiceCard compact value="retell" title="Retell" />
              ) : null}
              {known === null || known.agentPlatform === "pipecat" ? (
                <ChoiceCard compact value="pipecat" title="Pipecat" />
              ) : null}
            </RadioGroup>
          </div>
        );
      case "retell-key":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro title="Connect your Retell account" />
            {storedRetellKey ? (
              <InfoBox>
                {"This agent already holds its Retell key (ending " +
                  String(known?.monitoringApiKeyHint ?? "") +
                  "). Egma will use it to find the account's agents."}
              </InfoBox>
            ) : (
              <Field
                label="Retell API key*"
                htmlFor="retell-api-key"
                hint="Copied from your Retell dashboard."
              >
                <Input
                  id="retell-api-key"
                  aria-required="true"
                  type="password"
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setRefused(null);
                  }}
                />
              </Field>
            )}
          </div>
        );
      case "retell-agent":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title="Choose a Retell agent"
              description="Egma found these agents in your Retell account."
            />
            {retellAgents !== null && visibleRetellAgents.length === 0 ? (
              <Empty
                title={
                  boundRetellPlatformAgentId === null
                    ? "No Retell agents found"
                    : "Connected Retell agent not found"
                }
                lead={
                  boundRetellPlatformAgentId === null
                    ? "This Retell account does not contain a voice agent."
                    : "Egma could not find the Retell agent already connected here in this account."
                }
              />
            ) : (
              <RadioGroup
                aria-label="Retell agent"
                value={retellAgentId}
                onValueChange={(value) => {
                  setRetellAgentId(value);
                  setRetellRoute("");
                  setLane("");
                }}
              >
                {visibleRetellAgents.map((one) => {
                  const modality = retellModality(one);
                  const phones = one.connectionCandidates.filter(
                    (candidate) => candidate.connectionType === "phone_number",
                  ).length;
                  // Pull selects calls by agent id, so a monitoring-only walk
                  // has no use for a phone count and does not show one.
                  const description =
                    modality !== "voice"
                      ? "No supported connection available"
                      : plan?.pullWithoutConnection === true
                        ? "Voice agent"
                        : "Voice agent · " +
                          (phones === 0
                            ? "no phone numbers available"
                            : phones +
                              (phones === 1
                                ? " phone number available"
                                : " phone numbers available"));
                  return (
                    <ChoiceCard
                      key={one.platformAgentId}
                      value={one.platformAgentId}
                      title={one.name || one.platformAgentId}
                      description={description}
                      disabled={
                        plan === null || !retellAgentCanEnterPlan(plan, one)
                      }
                    />
                  );
                })}
              </RadioGroup>
            )}
            <InfoBox>
              {plan?.asksHowToTest === true
                ? "Egma lists your Retell voice agents. You choose how to test the one you pick next."
                : plan?.pullWithoutConnection === true
                  ? "Egma lists your Retell voice agents, and pulls the production calls of the one you pick from your Retell account."
                  : "Egma lists your Retell voice agents. Setting up both needs one of the phone numbers routed to the agent you pick."}
            </InfoBox>
          </div>
        );
      case "retell-lanes":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title={RETELL_LANE_QUESTION}
              description={
                "Pick one. It becomes a connection on " +
                String(selectedRetellAgent?.name ?? "this agent") +
                ", and your test suites run over it. You can add another lane " +
                "to the same agent afterwards."
              }
            />
            <RadioGroup
              className="gap-4"
              aria-label={RETELL_LANE_QUESTION}
              value={lane}
              onValueChange={(value) => setLane(value as RetellLane)}
            >
              {RETELL_LANES.map((one) => (
                <ChoiceCard
                  description={RETELL_LANE_HELP[one]}
                  disabled={retellProgress !== null}
                  key={one}
                  title={RETELL_LANE_LABELS[one]}
                  value={one}
                />
              ))}
            </RadioGroup>
          </div>
        );
      case "retell-phone":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro title="Choose a phone number" />
            <Field
              label="Phone number*"
              htmlFor="retell-phone-number"
              hint={
                "Routed to " +
                String(selectedRetellAgent?.name ?? "this agent") +
                " in Retell."
              }
            >
              <Select
                id="retell-phone-number"
                aria-required="true"
                value={retellRoute}
                disabled={retellProgress !== null}
                onChange={(event) => setRetellRoute(event.target.value)}
              >
                {voiceRoutes.map((candidate) => (
                  <option
                    key={retellCandidateValue(candidate)}
                    value={retellCandidateValue(candidate)}
                  >
                    {candidate.config.phoneNumber}
                  </option>
                ))}
              </Select>
            </Field>
            <SummaryRows
              rows={[
                ["Retell agent", selectedRetellAgent?.name ?? ""],
                [
                  "Phone number",
                  selectedVoiceRoute?.config.phoneNumber ?? "",
                ],
              ]}
            />
          </div>
        );
      case "sdk-modality":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title="How do you want to test this agent?"
              description="Choose one way to test this agent in this setup."
            />
            <RadioGroup
              className="gap-6"
              aria-label="Simulation modality"
              value={sdkModality}
              onValueChange={(value) =>
                chooseSdkModality(value as "chat" | "voice")
              }
            >
              {sdkPlatform === null
                ? null
                : sdkModalities.map((one) => (
                    <ChoiceCard
                      key={one}
                      value={one}
                      title={SDK_MODALITY_CHOICES[sdkPlatform][one].title}
                      description={
                        SDK_MODALITY_CHOICES[sdkPlatform][one].description
                      }
                    />
                  ))}
            </RadioGroup>
          </div>
        );
      case "sdk-testing":
        if (sdkModality === "") return null;
        if (sdkPlatform === "pipecat") {
          return completed === null ? null : (
            <PipecatTestingInstructions
              projectId={projectId}
              agentId={completed.agentId}
              access={
                sdkAccess === SELF_HOSTED ? "self_hosted" : "pipecat_cloud"
              }
            />
          );
        }
        return (
          <LiveKitTestingInstructions
            language={livekitLanguage}
            modality={sdkModality}
            onLanguageChange={setLivekitLanguage}
          />
        );
      case "sdk-connection":
        return sdkPlatform === null ? null : (
          <SdkConnectionStep
            platform={sdkPlatform}
            option={sdkOption}
            modality={sdkModality}
            access={sdkAccess}
            accessChoices={sdkAccessChoices}
            asksAgentName={asksAgentName}
            agentName={sdkAgentName}
            draft={{
              config: sdkConfig,
              credentials: sdkCredentials,
            }}
            disabled={completed !== null}
            onAccessChange={(value) => {
              setSdkAccess(value);
              setSdkConfig({});
              setSdkCredentials({});
            }}
            onAgentNameChange={setSdkAgentName}
            onDraftChange={(next) => {
              setSdkConfig(next.config);
              setSdkCredentials(next.credentials);
            }}
          />
        );
      case "sdk-monitoring":
        return sdkPlatform === "pipecat" ? (
          <PipecatMonitoringInstructions projectId={projectId} />
        ) : (
          <LiveKitMonitoringInstructions
            projectId={projectId}
            language={livekitLanguage}
            onLanguageChange={setLivekitLanguage}
          />
        );
    }
  }

  const primaryLabel =
    step === "goal" || step === "platform" || step === "sdk-modality"
      ? "Continue"
      : step === "retell-agent"
        ? // The monitoring goal finishes on this step: the pull switch needs
          // no provider route, so the agent choice is the whole of it.
          plan?.pullWithoutConnection === true
          ? saving
            ? "Starting…"
            : "Start monitoring"
          : "Continue"
        : step === "retell-lanes"
          ? lane === "phone"
            ? "Continue"
            : saving
              ? "Setting up…"
              : "Continue"
          : step === "retell-key"
            ? discovering
              ? "Finding agents…"
              : "Find agents"
            : step === "retell-phone"
              ? // Monitoring never reaches the number chooser any more: it
                // finishes on the agent choice.
                saving
                ? "Finishing…"
                : goal === "simulation"
                  ? "Set up simulation"
                  : "Set up both"
              : step === "sdk-connection"
                ? saving
                  ? "Saving…"
                  : completed === null
                    ? "Continue to testing"
                    : "Continue"
                : step === "sdk-monitoring" && goal === "both"
                  ? "Continue to simulation"
                  : "Return to agents";

  const primaryDisabled =
    saving ||
    discovering ||
    (step === "goal" && goal === "") ||
    (step === "platform" && platform === "") ||
    (step === "retell-key" && !keyReady) ||
    (step === "retell-agent" && selectedRetellAgent === undefined) ||
    // Nothing picked yet, or a lane that saves here picked before the catalog
    // it writes from arrived.
    (step === "retell-lanes" &&
      (lane === "" || (lane !== "phone" && catalog === null))) ||
    (step === "retell-phone" &&
      (selectedVoiceRoute === undefined || catalog === null)) ||
    (step === "sdk-modality" && sdkModality === "") ||
    (step === "sdk-connection" && completed === null && !sdkReady);

  const needsKnown = agentId !== undefined && agentId !== NEW_AGENT;
  const usable =
    role !== null && mayAuthor && (!needsKnown || knownStatus === "ready");

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (next) return;
        leave();
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void continueFlow();
          }}
        >
          <SheetHeader>
            <SheetTitle>Set up an agent</SheetTitle>
          </SheetHeader>
          <SheetBody ref={bodyRef}>
            {refused === null ? null : (
              <FormRefused message={refused.message} />
            )}
            {retellProgress === null ? null : (
              <div role="status">
                <Help>
                  Egma saved {retellProgress.completedLanes} of{" "}
                  {lanesToSave.length} connections. Retry to continue with the
                  remaining setup, or close to return to the saved agent.
                </Help>
              </div>
            )}
            {body()}
          </SheetBody>
          <SheetFooter
            className="border-t border-border pt-5"
            secondary={
              usable ? (
                step === "sdk-testing" ? undefined : (
                  <Button
                    type="button"
                    size="lg"
                    variant="secondary"
                    disabled={saving || discovering}
                    onClick={
                      step === "goal" || retellProgress !== null
                        ? leave
                        : back
                    }
                  >
                    {step === "goal"
                      ? "Cancel"
                      : retellProgress !== null
                        ? "Close"
                        : "Back"}
                  </Button>
                )
              ) : (
                <Button type="button" size="lg" variant="secondary" onClick={leave}>
                  Close
                </Button>
              )
            }
          >
            {usable ? (
                <Button
                  type="submit"
                  size="lg"
                  disabled={primaryDisabled}
                  busy={saving || discovering}
                >
                  {primaryLabel}
                </Button>
            ) : null}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function StepIntro({
  title,
  description,
}: {
  readonly title: string;
  readonly description?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3
        className="m-0 text-lg leading-(--line-tight) font-medium text-foreground"
        data-setup-heading
        tabIndex={-1}
      >
        {title}
      </h3>
      {description === undefined ? null : (
        <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

function ChoiceCard({
  value,
  title,
  description,
  disabled = false,
  compact = false,
}: {
  readonly value: string;
  readonly title: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly compact?: boolean;
}) {
  return (
    <RadioGroupItem
      className={
        compact
          ? "group min-h-(--control-lg) items-center px-4 py-2"
          : "group"
      }
      shape="card"
      value={value}
      disabled={disabled}
    >
      <RadioCardIndicator className={cn(!compact && "mt-1")} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-base leading-(--line-normal) text-foreground">
          {title}
        </span>
        {description === undefined ? null : (
          <span className="text-sm leading-(--line-normal) text-faint">
            {description}
          </span>
        )}
      </span>
    </RadioGroupItem>
  );
}

function InfoBox({
  title,
  children,
}: {
  readonly title?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-l-(length:--active-edge-width) border-brand bg-surface-soft p-4">
      {title === undefined ? null : (
        <p className="m-0 text-sm font-medium text-foreground">{title}</p>
      )}
      <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

function SummaryRows({
  rows,
}: {
  readonly rows: readonly (readonly [string, string])[];
}) {
  return (
    <dl className="m-0 flex flex-col border border-border">
      {rows.map(([term, detail]) => (
        <div
          className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
          key={term}
        >
          <dt className="text-sm text-faint">{term}</dt>
          <dd className="m-0 text-sm text-foreground">{detail}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * How each SDK platform's connection form draws the registry's fields.
 *
 * LiveKit draws its worker name on its own, above the connection's fields,
 * and shortens three labels; Pipecat draws the registry's fields as they are.
 * Placeholders keep example values only.
 */
const SDK_FORMS: Readonly<
  Record<
    SdkPlatform,
    {
      /** The name field the walk asks for beside the connection's fields. */
      readonly agentName: {
        readonly id: string;
        readonly label: string;
        readonly placeholder: string;
      };
      /** Config keys drawn by the name field rather than with the rest. */
      readonly drawnApart: readonly string[];
      readonly configLabels: Readonly<Record<string, string>>;
      readonly credentialLabels: Readonly<Record<string, string>>;
      readonly configPlaceholders: Readonly<Record<string, string>>;
      readonly credentialPlaceholders: Readonly<Record<string, string>>;
    }
  >
> = {
  livekit: {
    agentName: {
      id: "livekit-agent-name",
      label: "LiveKit agent name*",
      placeholder: "your-livekit-agent-name",
    },
    drawnApart: ["agentName"],
    configLabels: { url: "WebSocket URL" },
    credentialLabels: { apiKey: "API key", apiSecret: "API secret" },
    configPlaceholders: {
      url: "wss://your-project.livekit.cloud",
      tokenEndpoint: "https://api.example.com/livekit/token",
    },
    credentialPlaceholders: {
      headers: '{"Authorization":"Bearer your-token"}',
    },
  },
  pipecat: {
    agentName: {
      id: "pipecat-agent-name",
      label: "Agent name*",
      placeholder: "your-agent-name",
    },
    drawnApart: [],
    configLabels: {},
    credentialLabels: {},
    configPlaceholders: {
      agentName: "your-pipecat-agent-name",
      startUrl: "https://bots.example.com/start",
    },
    credentialPlaceholders: {
      headers: '{"Authorization":"Bearer your-token"}',
    },
  },
};

/**
 * The one connection form of a LiveKit or Pipecat simulation: the connection
 * type, the name where one is asked for, then the chosen variant's fields.
 */
function SdkConnectionStep({
  platform,
  option,
  modality,
  access,
  accessChoices,
  asksAgentName,
  agentName,
  draft,
  disabled,
  onAccessChange,
  onAgentNameChange,
  onDraftChange,
}: {
  readonly platform: SdkPlatform;
  readonly option: ConnectionOption | undefined;
  readonly modality: "chat" | "voice" | "";
  readonly access: string;
  /**
   * The ways in the chosen modality offers.
   *
   * Voice and chat both have two today, and which one this is changes what
   * the form asks for. A deployment whose catalog narrows a modality to one
   * way in gets no control that pretends there is a choice.
   */
  readonly accessChoices: readonly SdkAccessChoice[];
  readonly asksAgentName: boolean;
  readonly agentName: string;
  readonly draft: Draft;
  readonly disabled: boolean;
  readonly onAccessChange: (value: string) => void;
  readonly onAgentNameChange: (value: string) => void;
  readonly onDraftChange: (draft: Draft) => void;
}) {
  const form = SDK_FORMS[platform];
  // LiveKit's worker name is a registry field drawn apart, so it keeps the
  // registry's help line. A new self-hosted Pipecat agent's name has none.
  const agentNameHelp = form.drawnApart.includes("agentName")
    ? option?.fields.find((field) => field.key === "agentName")?.help
    : undefined;
  const presentedOption =
    option === undefined
      ? undefined
      : {
          ...option,
          fields: option.fields
            .filter((field) => !form.drawnApart.includes(field.key))
            .map((field) => ({
              ...field,
              label: form.configLabels[field.key] ?? field.label,
            })),
          credentialFields: option.credentialFields.map((field) => ({
            ...field,
            label: form.credentialLabels[field.field] ?? field.label,
          })),
        };
  return (
    <div className="flex flex-col gap-5">
      <StepIntro title={sdkConnectionTitle(platform, modality)} />
      {accessChoices.length > 1 ? (
        <Field label="Connection type*" htmlFor={`${platform}-connection-type`}>
          <Select
            id={`${platform}-connection-type`}
            aria-required="true"
            value={access}
            disabled={disabled}
            onChange={(event) => onAccessChange(event.target.value)}
          >
            {accessChoices.map((choice) => (
              <option key={choice.accessVariant} value={choice.accessVariant}>
                {choice.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {asksAgentName ? (
        <Field
          label={form.agentName.label}
          htmlFor={form.agentName.id}
          {...(agentNameHelp === undefined || agentNameHelp === ""
            ? {}
            : { hint: agentNameHelp })}
        >
          <Input
            id={form.agentName.id}
            aria-required="true"
            value={agentName}
            placeholder={form.agentName.placeholder}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onAgentNameChange(event.target.value)}
          />
        </Field>
      ) : null}
      {presentedOption === undefined ? (
        <Problem>
          {`Egma could not find this ${SDK_PLATFORM_LABELS[platform]} connection method.`}
        </Problem>
      ) : (
        <ConnectionFields
          option={presentedOption}
          draft={draft}
          onChange={onDraftChange}
          credentialsEditable
          disabled={disabled}
          configPlaceholders={form.configPlaceholders}
          credentialPlaceholders={form.credentialPlaceholders}
        />
      )}
    </div>
  );
}
