"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  addConnection,
  discoverAgents,
  getAgent,
  listConnectionOptions,
  registerAgent,
  startMonitoring,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  modalityLabel,
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
  retellLanesInOrder,
  RETELL_LANES,
  RETELL_LANE_HELP,
  RETELL_LANE_LABELS,
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

type ConnectionBody = NonNullable<
  Parameters<typeof registerAgent>[0]["connection"]
>;

type RetellSaveProgress = {
  readonly signature: string;
  readonly completedLanes: number;
  readonly landed: ConnectSheetResult;
};

type ConnectAgentSheetProps = {
  readonly projectId: string;
  readonly agents: readonly ListedAgentWithConnections[];
  readonly agentId?: string;
  readonly goal?: ConnectAgentGoal;
  readonly platform?: ConnectAgentPlatform;
  readonly mayAuthor: boolean;
  readonly role: string | null;
  readonly onClose: () => void;
  readonly onConnected: (result: ConnectSheetResult) => void;
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
      "Egma speaks to the agent in the room, the way a person reaches it. Your Python worker needs the Egma testing hook, which Egma shows you next.",
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
    onClose,
    onConnected,
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
   * The lanes ticked in the one question, in the order they were ticked.
   *
   * Several at once is the point: text and voice land as connections on **one**
   * egma agent in one pass, so the same suite runs over both. Nothing starts
   * ticked — one lane dials a real telephone.
   */
  const [lanes, setLanes] = useState<readonly RetellLane[]>([]);
  const [discovering, setDiscovering] = useState(false);

  const [livekitLanguage, setLivekitLanguage] = useState<
    LiveKitWorkerLanguage | ""
  >("");
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
    setLanes([]);
    setLivekitLanguage("");
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
  /** The lanes picked, in reading order, whatever order they were ticked in. */
  const pickedLanes = retellLanesInOrder(lanes);
  /**
   * Every lane the goal will save, and the candidate that saves it.
   *
   * A monitoring goal skips the question and saves the phone lane alone, which
   * is what production pull needs. A simulation goal saves what was ticked.
   */
  const lanesToSave: readonly RetellLane[] =
    plan?.asksHowToTest === true ? pickedLanes : ["phone"];
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
  useUnsavedChanges(changed && !saving && !discovering, saving || discovering);

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
    setLanes([]);
    setLivekitLanguage("");
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
    setLanes([]);
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
        created: true,
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

  async function resumeRetellMonitoring(): Promise<ConnectSheetResult | null> {
    if (
      agentId === undefined ||
      agentId === NEW_AGENT ||
      known?.platformAgentId === null ||
      known?.platformAgentId === undefined
    ) {
      return null;
    }

    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      startMonitoring(
        {
          projectId,
          agentPlatform: "retell",
          watch: [
            {
              agentId,
              platformAgentId: known.platformAgentId,
            },
          ],
        },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (!finishAnswer(answer)) return null;

    const watching = answer.value.watching.find(
      (one) => one.agentId === agentId,
    );
    if (watching === undefined) {
      const refusal = answer.value.refused.find(
        (one) => one.platformAgentId === known.platformAgentId,
      );
      setRefused({
        error: "monitoring_not_started",
        message:
          refusal?.message ??
          "Egma did not start monitoring this agent. Try again.",
      });
      return null;
    }

    return { agentId, connectionId: null, created: false };
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
    let landed: ConnectSheetResult | null = saved?.landed ?? null;
    const firstUnsavedLane = saved?.completedLanes ?? 0;
    for (const [index, lane] of lanesToSave.entries()) {
      if (index < firstUnsavedLane) continue;
      const candidate = retellCandidateForLane(selectedRoutes, lane, retellRoute);
      if (candidate === undefined) return;
      const option = optionNamed(catalog, candidate);
      if (option === undefined) return;
      const result = await saveConnection(
        selectedRetellAgent.name,
        connectionBody(
          option,
          candidate,
          // Production pull rides on the voice connection, and only once.
          plan?.pullWithConnection === true && lane === "phone",
        ),
        landed?.agentId,
      );
      if (result === null) return;
      landed = {
        ...result,
        agentId: landed === null ? result.agentId : landed.agentId,
        created: landed?.created ?? result.created,
      };
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
        // A goal that skips the question saves the phone lane, so it needs its
        // first routed number chosen for it; the question's own walk waits.
        if (next === "retell-phone") {
          const first = voiceRoutes[0];
          setRetellRoute(first === undefined ? "" : retellCandidateValue(first));
        }
        transition(next);
        return;
      }
      case "retell-lanes": {
        if (pickedLanes.length === 0) return;
        const next = stepAfterRetellLanes(pickedLanes);
        // The phone-number chooser appears only when Phone call is picked.
        // Every other set of picks has nothing left to ask and saves here.
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
      case "livekit-language":
        if (livekitLanguage === "") return;
        if (livekitLanguage === "javascript") {
          leave();
          return;
        }
        transition("livekit-modality");
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
        if (livekitLanguage === "") return;
        // Both starts with Monitoring so the language is known before any
        // simulation connection can be written. JavaScript finishes here;
        // Python continues into the supported, session-isolated test setup.
        if (
          goal === "both" &&
          livekitLanguage === "python" &&
          completed === null
        ) {
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
      // The one question can save on Continue when no phone lane was picked,
      // and that needs the option catalog to name the rows it writes.
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
              <ChoiceCard compact value="retell" title="Retell" />
              <ChoiceCard compact value="livekit" title="LiveKit" />
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
                  setLanes([]);
                }}
              >
                {visibleRetellAgents.map((one) => {
                  const modality = retellModality(one);
                  const phones = one.connectionCandidates.filter(
                    (candidate) => candidate.connectionType === "phone_number",
                  ).length;
                  const description =
                    modality === "voice"
                      ? "Voice agent · " +
                        (phones === 0
                          ? "no phone numbers available"
                          : phones +
                            (phones === 1
                              ? " phone number available"
                              : " phone numbers available"))
                      : "No supported connection available";
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
                : "Egma lists your Retell voice agents. Production monitoring needs one of the phone numbers routed to the agent you pick."}
            </InfoBox>
          </div>
        );
      case "retell-lanes":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title={RETELL_LANE_QUESTION}
              description={
                "Pick as many as you want. Each one is a connection on " +
                String(selectedRetellAgent?.name ?? "this agent") +
                ", and one test suite runs over all of them."
              }
            />
            <fieldset className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
              <legend className="sr-only">{RETELL_LANE_QUESTION}</legend>
              {RETELL_LANES.map((lane) => (
                <div
                  className="flex min-w-0 items-start gap-3 border border-border p-4"
                  key={lane}
                >
                  <Checkbox
                    aria-describedby={`retell-lane-${lane}-help`}
                    checked={lanes.includes(lane)}
                    disabled={retellProgress !== null}
                    id={`retell-lane-${lane}`}
                    onChange={(event) =>
                      setLanes((held) =>
                        event.target.checked
                          ? [...held.filter((one) => one !== lane), lane]
                          : held.filter((one) => one !== lane),
                      )
                    }
                  />
                  <span className="flex min-w-0 flex-col gap-1">
                    {/*
                      The visible copy stays visible and points at the control
                      with `htmlFor`, which makes the whole line a target as
                      well as naming the box.
                    */}
                    <label
                      className="cursor-pointer text-sm font-medium text-foreground"
                      htmlFor={`retell-lane-${lane}`}
                    >
                      {RETELL_LANE_LABELS[lane]}
                    </label>
                    <span
                      className="text-sm text-faint"
                      id={`retell-lane-${lane}-help`}
                    >
                      {RETELL_LANE_HELP[lane]}
                    </span>
                  </span>
                </div>
              ))}
            </fieldset>
            <InfoBox>
              Text and voice land as connections on one agent, so the same tests
              run across all of them. A phone run reaches your real tools.
            </InfoBox>
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
      case "livekit-language":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro title="What language is your LiveKit worker?" />
            <RadioGroup
              className="gap-4"
              aria-label="LiveKit worker language"
              value={livekitLanguage}
              onValueChange={(value) =>
                setLivekitLanguage(value as LiveKitWorkerLanguage)
              }
            >
              <ChoiceCard
                compact
                value="python"
                title="Python"
                description="Simulation testing and production monitoring are supported."
              />
              <ChoiceCard
                compact
                value="javascript"
                title="JavaScript"
                description="Production monitoring is supported. Simulation testing is not supported yet."
              />
            </RadioGroup>
            {livekitLanguage === "javascript" ? (
              <Help>
                Egma cannot set up JavaScript testing yet because it cannot
                isolate each test run from other LiveKit sessions. Use the
                Monitoring goal to add JavaScript monitoring.
              </Help>
            ) : null}
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
          <LiveKitTestingInstructions modality={livekitModality} />
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
          <div className="flex flex-col gap-5">
            <LiveKitMonitoringInstructions
              projectId={projectId}
              language={livekitLanguage}
              onLanguageChange={setLivekitLanguage}
            />
            {goal === "both" && livekitLanguage === "javascript" ? (
              <Help>
                Monitoring is supported for JavaScript and finishes here.
                Testing remains unsupported because Egma cannot isolate each
                JavaScript test run from other LiveKit sessions.
              </Help>
            ) : null}
          </div>
        );
    }
  }

  const primaryLabel =
    step === "goal" ||
    step === "platform" ||
    step === "retell-agent" ||
    step === "livekit-modality"
      ? "Continue"
      : step === "livekit-language"
        ? livekitLanguage === "javascript"
          ? "Return to agents"
          : "Continue"
        : step === "retell-lanes"
          ? // Picking the phone lane carries on to the number chooser; every
            // other set of picks has nothing left to ask and saves here.
            pickedLanes.includes("phone")
            ? "Continue"
            : saving
              ? "Setting up…"
              : "Set up simulation"
          : step === "retell-key"
            ? discovering
              ? "Finding agents…"
              : "Find agents"
            : step === "retell-phone"
              ? saving
                ? "Finishing…"
                : goal === "simulation"
                  ? "Set up simulation"
                  : goal === "monitoring"
                    ? "Start monitoring"
                    : "Set up both"
              : step === "livekit-simulation"
                ? saving
                  ? "Saving…"
                  : completed === null
                    ? "Continue to testing"
                    : "Continue"
                : step === "livekit-monitoring" && goal === "both"
                  ? livekitLanguage === "javascript"
                    ? "Finish monitoring"
                    : "Continue to simulation"
                  : "Return to agents";

  const primaryDisabled =
    saving ||
    discovering ||
    (step === "goal" && goal === "") ||
    (step === "platform" && platform === "") ||
    (step === "retell-key" && !keyReady) ||
    (step === "retell-agent" && selectedRetellAgent === undefined) ||
    // Nothing picked yet, or a set that saves here picked before the catalog
    // it writes from arrived.
    (step === "retell-lanes" &&
      (pickedLanes.length === 0 ||
        (!pickedLanes.includes("phone") && catalog === null))) ||
    (step === "retell-phone" &&
      (selectedVoiceRoute === undefined || catalog === null)) ||
    (step === "livekit-language" && livekitLanguage === "") ||
    (step === "livekit-modality" && livekitModality === "") ||
    (step === "livekit-simulation" && completed === null && !livekitReady) ||
    (step === "livekit-monitoring" && livekitLanguage === "");

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
            ? "Egma requests a short-lived room token from your endpoint for every simulation."
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
        hint={
          endpoint
            ? "This names the agent in Egma. Your token endpoint decides which deployed worker joins the room."
            : "Enter the exact agent name shown in your LiveKit Cloud dashboard."
        }
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
