"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  addConnection,
  discoverAgents,
  getAgent,
  listAgents,
  listConnectionOptions,
  discoverMockTools,
  registerAgent,
  updateConnection,
  startMonitoring,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
  modalityLabel,
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
  retellLaneBranchesDraft,
  retellLaneMocksTools,
  RETELL_LANE_QUESTION,
  stepAfterRetellLanes,
  type RetellLane,
  stepAfterLiveKitTesting,
  stepAfterLiveKitCredentials,
  stepAfterPlatform,
  stepAfterRetellAgent,
  type AgentSetupGoal,
  type AgentSetupPlatform,
  type AgentSetupStep,
  type LiveKitWorkerLanguage,
  type RetellConnectionCandidate,
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

/**
 * What the mock question knows, in the three shapes it can be in.
 *
 * `refused` carries the platform's own sentence rather than a code this screen
 * would have to translate: the same words the agent's own mock-tools read
 * shows, because they are the same fact about the same account.
 */
type MockToolsRead =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly tools: readonly string[] }
  | { readonly status: "refused"; readonly message: string };

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
const PROJECT_CREDENTIALS = "livekit_room.project_credentials";
const TOKEN_ENDPOINT = "livekit_room.customer_token_endpoint";

/**
 * What each modality is, said as the difference a person is choosing between.
 *
 * Which of the two are offered is the catalog's answer and never this file's.
 * What each one means is product language, and it is written once here so the
 * card cannot say one thing while the surface after it says another.
 */
const MODALITY_CHOICES: Readonly<
  Record<"chat" | "voice", { readonly title: string; readonly description: string }>
> = {
  voice: {
    title: "Voice",
    description:
      "Egma speaks to the agent in the room, the way a person reaches it. Your worker needs the Egma testing hook, which Egma shows you next.",
  },
  chat: {
    title: "Chat",
    description:
      "Egma types to the agent and reads its words back. Fast, and it spends nothing on speech. Your worker needs a short setup, which Egma shows you next.",
  },
};

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
  /**
   * Whether runs over the new connection answer the agent's tools themselves.
   *
   * **Off unless it is turned on.** Mocking changes what a run is: the agent
   * reaches Egma's test data instead of the customer's own backend, and for a
   * web call it also means a temporary version on their Retell account. That is
   * an explicit yes, never a default somebody meets afterwards — so the
   * connection is written `false` and this switch is what changes it.
   */
  const [mockTools, setMockTools] = useState(false);
  const [mockRead, setMockRead] = useState<MockToolsRead>({ status: "loading" });
  /** The connection the mock question is about, once it has been written. */
  const [mockTarget, setMockTarget] = useState<ConnectSheetResult | null>(null);
  const [discovering, setDiscovering] = useState(false);

  // This chooses which source instructions are visible. It is never written
  // to the connection, and Python is the first documentation view rather than
  // an unanswered setup question.
  const [livekitLanguage, setLivekitLanguage] =
    useState<LiveKitWorkerLanguage>("python");
  const [livekitModality, setLivekitModality] = useState<"chat" | "voice" | "">(
    "",
  );
  const [livekitAccess, setLivekitAccess] = useState(PROJECT_CREDENTIALS);
  const [livekitAgentName, setLivekitAgentName] = useState("");
  const [livekitConfig, setLivekitConfig] = useState<
    Readonly<Record<string, string>>
  >({});
  const [livekitCredentials, setLivekitCredentials] = useState<
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
    setLivekitModality("");
    setLivekitAccess(PROJECT_CREDENTIALS);
    setLivekitAgentName("");
    setLivekitConfig({});
    setLivekitCredentials({});
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

  /**
   * The agent's tools, read once the mock question has something to read.
   *
   * **The same discovery the agent's own mock-tools read uses.** A second path
   * here would be a second opinion about one account, and the two would drift
   * the first time one of them learned something. It runs after the connection
   * is written because that is what gives Egma the agent, its sealed key and
   * its platform identity to read with.
   */
  useEffect(() => {
    const target = mockTarget;
    if (step !== "retell-mocks" || target === null) return;
    let alive = true;
    setMockRead({ status: "loading" });
    void platformAnswer(
      discoverMockTools(
        { agentId: target.agentId, projectId },
        { client: platformClient },
      ),
    ).then((answer) => {
      if (!alive) return;
      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (answer.status !== "ready") {
        setMockRead({ status: "refused", message: answer.refusal.message });
        return;
      }
      const found = answer.value;
      if (found.refusal !== null) {
        setMockRead({ status: "refused", message: found.refusal.message });
        return;
      }
      setMockRead({
        status: "ready",
        tools: found.tools.map((tool) => tool.name),
      });
    });
    return () => {
      alive = false;
    };
  }, [mockTarget, projectId, step]);

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

  const livekitOptions =
    platform === "livekit"
      ? optionsForPlatform(catalog, "livekit").filter(
          (one) => one.connectionType === "livekit_room",
        )
      : [];
  /** The modalities this Egma offers on a LiveKit room, in the catalog's order. */
  const livekitModalities = [
    ...new Set(livekitOptions.map((one) => one.modality)),
  ];
  /** The access variants that speak the chosen modality — chat has exactly one. */
  const livekitAccessOptions = livekitOptions.filter(
    (one) => one.modality === livekitModality,
  );
  /*
   * The pair decides the row, never the access variant alone.
   *
   * Chat and voice share `livekit_room.project_credentials`, so matching the
   * variant would answer with whichever row the server listed first — and a
   * chat walk would save a voice connection with nothing anywhere saying so.
   */
  const livekitOption = livekitAccessOptions.find(
    (one) => one.accessVariant === livekitAccess,
  );
  const livekitFieldValue = (key: string): string =>
    key === "agentName"
      ? livekitAgentName
      : (livekitConfig[key] ?? "");
  const storedRetellKey =
    agentId !== undefined &&
    known?.monitoringKeyPresent === true;
  const keyReady = storedRetellKey || apiKey.trim().length >= SHORTEST_KEY;
  const livekitReady =
    livekitOption !== undefined &&
    livekitOption.fields
      .filter((field) => field.required)
      .every((field) => livekitFieldValue(field.key).trim() !== "") &&
    livekitOption.credentialFields
      .filter((field) => field.required)
      .every(
        (field) => (livekitCredentials[field.field]?.trim() ?? "") !== "",
      ) &&
    livekitAgentName.trim() !== "";

  const changed =
    apiKey !== "" ||
    retellAgents !== null ||
    livekitAgentName !== "" ||
    Object.values(livekitConfig).some((value) => value !== "") ||
    Object.values(livekitCredentials).some((value) => value !== "");
  const savedLiveKitConnection = platform === "livekit" && completed !== null;
  useUnsavedChanges(
    !savedLiveKitConnection && changed && !saving && !discovering,
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
    setLivekitModality("");
    setLivekitAccess(PROJECT_CREDENTIALS);
    setLivekitAgentName("");
    setLivekitConfig({});
    setLivekitCredentials({});
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
   * Chat is offered on project credentials and nowhere else, because that is
   * the access variant where Egma dispatches the worker and can tell it this
   * simulation is typed. Choosing chat therefore settles the way in as well,
   * and the screen that would have asked is not drawn.
   */
  function chooseLiveKitModality(next: "chat" | "voice"): void {
    if (next !== livekitModality) {
      setLivekitConfig({});
      setLivekitCredentials({});
    }
    if (next === "chat") setLivekitAccess(PROJECT_CREDENTIALS);
    setLivekitModality(next);
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
        // Written off, whatever the lane's own default is, so mocking is only
        // ever the explicit yes given on the step after this write.
        mockToolsEnabled: false,
      };
    }

    const config: Record<string, string> = {};
    for (const field of option.fields) {
      const value = livekitFieldValue(field.key).trim();
      if (value !== "") config[field.key] = value;
    }
    const credentials: Record<string, string> = {};
    for (const field of option.credentialFields) {
      const value = livekitCredentials[field.field]?.trim() ?? "";
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
          {
            projectId,
            name,
            agentPlatform:
              body.agentPlatform === "retell" ? "retell" : "livekit",
            connection: body,
          },
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
   * Flip the pull switch through the one commit `startMonitoring` is.
   *
   * `agentId` is the egma agent the flow started from, when there is one.
   * Without it the server resolves the platform agent by (project, platform,
   * platform agent id) and registers one under `name` when nothing answers —
   * watching an unregistered agent means registering it (ADR-0015). The
   * stored key is spent only when an egma agent is named, because that is the
   * only entry shape the omitted-key preflight accepts.
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

  async function resumeRetellMonitoring(): Promise<ConnectSheetResult | null> {
    if (
      agentId === undefined ||
      agentId === NEW_AGENT ||
      known?.platformAgentId === null ||
      known?.platformAgentId === undefined
    ) {
      return null;
    }

    const watched = await startRetellMonitoringWatch({
      agentId,
      platformAgentId: known.platformAgentId,
      name: known.name,
    });
    if (watched === null) return null;

    return { agentId, connectionId: null, created: false };
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
   * Every picked lane, written onto **one** egma agent, in one pass.
   *
   * The first lane registers the agent (or finds the one that is already
   * there); every lane after it is an addition to *that* agent. Two egma agents
   * for one Retell voice agent would split a team's results history in half,
   * which is the failure this loop exists to prevent.
   *
   * A lane that will not save stops the pass and says so, rather than carrying
   * on and leaving a half-connected agent nobody asked for.
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

    const resumesStoredMonitoring =
      goal !== "simulation" &&
      storedRetellKey &&
      agentId !== undefined &&
      agentId !== NEW_AGENT &&
      known?.platformAgentId === selectedRetellAgent.platformAgentId;
    if (resumesStoredMonitoring) {
      const resumed = await resumeRetellMonitoring();
      if (resumed !== null) onConnected(resumed);
      return;
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
      // **The mock question comes after the write, because it is about the
      // agent's own tools** and Egma reads those through the agent it has just
      // made. The connection is already `false`, so a person who closes the
      // sheet here leaves with mocks off — the answer this flow defaults to.
      if (laneToSave !== "" && retellLaneMocksTools(laneToSave)) {
        setMockTarget(landed);
        transition("retell-mocks");
        return;
      }
      onConnected(landed);
    }
  }

  /** Turn the switch's answer into the connection, then leave. */
  async function finishMockQuestion(): Promise<void> {
    const target = mockTarget;
    if (target === null) return;
    // Nothing to write when the answer is the one the connection already
    // holds, which is the ordinary path: the switch starts off.
    if (!mockTools || target.connectionId === null) {
      onConnected(target);
      return;
    }
    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      updateConnection(
        {
          agentId: target.agentId,
          connectionId: target.connectionId,
          projectId,
          mockToolsEnabled: true,
        },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (!finishAnswer(answer)) {
      // **The control goes back to what the server holds.** The refusal is
      // rendered above, and a switch left reading ON over a connection that is
      // still off would be the screen disagreeing with the account — the one
      // thing a state this file draws must never do.
      setMockTools(false);
      return;
    }
    onConnected(target);
  }

  async function finishLiveKit(): Promise<void> {
    if (goal === "" || plan === null || livekitOption === undefined) return;
    // Saved already, and this press is the way on: a Both walk that came back
    // to this screen must not save a second connection to move forward.
    if (completed !== null) {
      const next = stepAfterLiveKitCredentials(plan);
      if (next === null) onConnected(completed);
      else transition(next);
      return;
    }
    if (!livekitReady) return;
    const result = await saveConnection(
      livekitAgentName.trim(),
      connectionBody(livekitOption),
    );
    if (result === null) return;
    const next = stepAfterLiveKitCredentials(plan);
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
      case "retell-mocks":
        await finishMockQuestion();
        return;
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
      case "livekit-modality":
        if (livekitModality !== "") transition("livekit-simulation");
        return;
      case "livekit-simulation":
        await finishLiveKit();
        return;
      case "livekit-testing": {
        const next = plan === null ? null : stepAfterLiveKitTesting(plan);
        if (next !== null) {
          transition(next);
        } else if (completed === null) {
          onClose();
        } else {
          onConnected(completed);
        }
        return;
      }
      case "livekit-monitoring":
        // Monitoring needs a language-specific source hook. Both carries that
        // instruction choice forward; it is never part of the room connection.
        if (goal === "both" && completed === null) {
          transition("livekit-modality");
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
      step === "livekit-modality" ||
      step === "livekit-simulation" ||
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
            </RadioGroup>
          </div>
        );
      case "retell-key":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title="Connect your Retell account"
              description="Enter your Retell API key. Egma uses it to find the agents in this account."
            />
            {storedRetellKey ? (
              <InfoBox>
                {"This agent already holds its Retell key (ending " +
                  String(known?.monitoringApiKeyHint ?? "") +
                  "). Egma will use it to find the account's agents."}
              </InfoBox>
            ) : (
              <Field label="Retell API key*" htmlFor="retell-api-key">
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
      case "retell-mocks":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title="Mock this agent's tools?"
              description="Egma read these off the agent. With mocks on, runs answer them with your test data instead of your real backend."
            />
            <MockToolsStep
              branchesDraft={laneToSave !== "" && retellLaneBranchesDraft(laneToSave)}
              on={mockTools}
              onChange={setMockTools}
              read={mockRead}
            />
          </div>
        );
      case "retell-phone":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title="Choose a phone number"
              description={
                "Retell already routes these numbers to " +
                String(selectedRetellAgent?.name ?? "this agent") +
                ". Choose the one Egma should use."
              }
            />
            <Field label="Phone number*" htmlFor="retell-phone-number">
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
            <Help>
              Egma reads this number from Retell. It does not change your Retell
              routing.
            </Help>
          </div>
        );
      case "livekit-modality":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title="How do you want to test this agent?"
              description="Choose one way to test this agent in this setup."
            />
            <RadioGroup
              className="gap-6"
              aria-label="Simulation modality"
              value={livekitModality}
              onValueChange={(value) =>
                chooseLiveKitModality(value as "chat" | "voice")
              }
            >
              {livekitModalities.map((one) => (
                <ChoiceCard
                  key={one}
                  value={one}
                  title={MODALITY_CHOICES[one].title}
                  description={MODALITY_CHOICES[one].description}
                />
              ))}
            </RadioGroup>
          </div>
        );
      case "livekit-testing":
        return livekitModality === "" ? null : (
          <LiveKitTestingInstructions
            language={livekitLanguage}
            modality={livekitModality}
            onLanguageChange={setLivekitLanguage}
          />
        );
      case "livekit-simulation":
        return (
          <LiveKitSimulationStep
            option={livekitOption}
            access={livekitAccess}
            chooseAccess={livekitAccessOptions.length > 1}
            agentName={livekitAgentName}
            draft={{
              config: livekitConfig,
              credentials: livekitCredentials,
            }}
            disabled={completed !== null}
            onAccessChange={(value) => {
              setLivekitAccess(value);
              setLivekitConfig({});
              setLivekitCredentials({});
            }}
            onAgentNameChange={setLivekitAgentName}
            onDraftChange={(next) => {
              setLivekitConfig(next.config);
              setLivekitCredentials(next.credentials);
            }}
          />
        );
      case "livekit-monitoring":
        return (
          <LiveKitMonitoringInstructions
            projectId={projectId}
            language={livekitLanguage}
            onLanguageChange={setLivekitLanguage}
          />
        );
    }
  }

  const primaryLabel =
    step === "goal" || step === "platform" || step === "livekit-modality"
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
          : step === "retell-mocks"
            ? saving
              ? "Finishing…"
              : "Set up simulation"
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
                : step === "livekit-simulation"
                  ? saving
                    ? "Saving…"
                    : completed === null
                      ? "Continue to testing"
                      : "Continue"
                  : step === "livekit-monitoring" && goal === "both"
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
    (step === "livekit-modality" && livekitModality === "") ||
    (step === "livekit-simulation" && completed === null && !livekitReady);

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
          <SheetFooter className="border-t border-border pt-5 [&>div:first-child]:w-full [&>div:first-child]:justify-between">
            {usable ? (
              <>
                {step === "livekit-testing" ? null : (
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
                )}
                <Button
                  type="submit"
                  size="lg"
                  disabled={primaryDisabled}
                  busy={saving || discovering}
                >
                  {primaryLabel}
                </Button>
              </>
            ) : (
              <Button type="button" size="lg" variant="secondary" onClick={leave}>
                Close
              </Button>
            )}
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

/**
 * The mock question: what Egma would stand in front of, and one switch.
 *
 * **A refusal replaces the list, and the switch goes with it.** Every reason
 * discovery refuses is a fact about the agent that no answer on this screen can
 * change — a custom-LLM engine, two keys on two accounts, nothing published, or
 * Retell not answering — so offering a switch over it would be offering a
 * choice Egma cannot keep. The connection is already written with mocks off, so
 * a refusal costs a person the feature and never the setup.
 *
 * Names only, no per-tool labels: the question here is whether to mock, not
 * which. Which is what the agent's own mock-tools surface is for.
 */
function MockToolsStep({
  branchesDraft,
  on,
  onChange,
  read,
}: {
  /** Whether turning this on branches a draft version on the agent. */
  readonly branchesDraft: boolean;
  readonly on: boolean;
  readonly onChange: (next: boolean) => void;
  readonly read: MockToolsRead;
}) {
  const askable = read.status === "ready" && read.tools.length > 0;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {read.status === "loading" ? (
        <Loading what="this agent's tools" />
      ) : read.status === "refused" ? (
        <InfoBox title="Egma cannot mock this agent's tools">
          {read.message}
        </InfoBox>
      ) : read.tools.length === 0 ? (
        <InfoBox>
          This agent declares no tools Egma can stand in front of, so a mocked
          run would answer nothing differently.
        </InfoBox>
      ) : (
        <ul
          className="m-0 flex list-none flex-col border border-border p-0"
          data-slot="mock-tools-found"
        >
          {read.tools.map((tool) => (
            <li
              className="border-t border-border px-4 py-3 font-mono text-sm text-foreground first:border-t-0"
              key={tool}
            >
              {tool}
            </li>
          ))}
        </ul>
      )}

      {askable ? (
        <div className="flex min-w-0 items-center justify-between gap-4 border border-border p-4">
          <label
            className="cursor-pointer text-sm text-foreground"
            htmlFor="retell-mock-tools"
          >
            Mock tools on runs
          </label>
          <Switch
            checked={on}
            data-slot="mock-tools-switch"
            id="retell-mock-tools"
            onCheckedChange={onChange}
          />
        </div>
      ) : null}

      {/*
        The web-call lane only, and only while the switch is on. A text run
        carries its mocked answers on each request and writes nothing to the
        Retell account, so there is no draft for a number or a tag to reach and
        nothing here to warn about.
      */}
      {branchesDraft && on ? (
        <p
          className="m-0 border border-border p-4 text-sm text-faint"
          data-slot="mock-tools-latest-created-note"
          role="note"
        >
          Mocked runs create a temporary draft version on this agent and delete
          it after each run. A draft counts as Latest Created — make sure no
          phone number or tag sends real callers to Latest Created. Leaving a
          number's version unset also means Latest Created. Retell keeps an
          unused copy of the conversation flow behind each mocked run — Retell
          has no way to delete one — but nothing can route callers to it.
        </p>
      ) : null}
    </div>
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

function LiveKitSimulationStep({
  option,
  access,
  chooseAccess,
  agentName,
  draft,
  disabled,
  onAccessChange,
  onAgentNameChange,
  onDraftChange,
}: {
  readonly option: ConnectionOption | undefined;
  readonly access: string;
  /**
   * Whether the chosen modality has more than one way in.
   *
   * Voice has two, and which one this is changes what the form asks for. Chat
   * has one — Egma has to dispatch the worker to tell it the simulation is
   * typed — so there is nothing to choose and no control that pretends there
   * is.
   */
  readonly chooseAccess: boolean;
  readonly agentName: string;
  readonly draft: Draft;
  readonly disabled: boolean;
  readonly onAccessChange: (value: string) => void;
  readonly onAgentNameChange: (value: string) => void;
  readonly onDraftChange: (draft: Draft) => void;
}) {
  const endpoint = access === TOKEN_ENDPOINT;
  const presentedOption =
    option === undefined
      ? undefined
      : {
          ...option,
          fields: option.fields
            .filter((field) => field.key !== "agentName")
            .map((field) =>
              field.key === "url"
                ? { ...field, label: "WebSocket URL" }
                : field,
            ),
          credentialFields: option.credentialFields.map((field) => {
            if (field.field === "apiKey") {
              return { ...field, label: "API key" };
            }
            if (field.field === "apiSecret") {
              return { ...field, label: "API secret" };
            }
            if (field.field === "headers") {
              return {
                ...field,
                help:
                  "Enter a non-empty JSON object that maps each header name to a non-empty string value.",
              };
            }
            return field;
          }),
        };
  return (
    <div className="flex flex-col gap-5">
      <StepIntro
        title={
          option === undefined
            ? "Connect LiveKit for simulations"
            : `Connect LiveKit ${modalityLabel(option.modality)} for simulations`
        }
        description={
          endpoint
            ? "For every simulation Egma asks your endpoint for a short-lived room token, your LiveKit server URL, and the dispatch of the worker named below."
            : undefined
        }
      />
      {chooseAccess ? (
        <Field label="Connection type*" htmlFor="livekit-connection-type">
          <Select
            id="livekit-connection-type"
            aria-required="true"
            value={access}
            disabled={disabled}
            onChange={(event) => onAccessChange(event.target.value)}
          >
            <option value={PROJECT_CREDENTIALS}>Project credentials</option>
            <option value={TOKEN_ENDPOINT}>Token endpoint</option>
          </Select>
        </Field>
      ) : null}

      <Field
        label="LiveKit agent name*"
        htmlFor="livekit-agent-name"
        hint="Enter the exact agent name shown in your LiveKit Cloud dashboard."
      >
        <Input
          id="livekit-agent-name"
          aria-required="true"
          value={agentName}
          placeholder="your-livekit-agent-name"
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onAgentNameChange(event.target.value)}
        />
      </Field>
      {presentedOption === undefined ? (
        <Problem>Egma could not find this LiveKit connection method.</Problem>
      ) : (
        <ConnectionFields
          option={presentedOption}
          draft={draft}
          onChange={onDraftChange}
          credentialsEditable
          disabled={disabled}
          configPlaceholders={{
            url: "wss://your-project.livekit.cloud",
            tokenEndpoint: "https://api.example.com/livekit/token",
            metadata: '{"tenant":"acme"}',
          }}
          credentialPlaceholders={{
            headers: '{"Authorization":"Bearer your-token"}',
          }}
        />
      )}
    </div>
  );
}
