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
import type { ListedAgentWithConnections } from "@/lib/agents.ts";
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
  retellAgentsForPlan,
  retellCandidateValue,
  retellCandidatesForPlan,
  stepAfterLiveKitChat,
  stepAfterLiveKitCredentials,
  stepAfterPlatform,
  stepAfterRetellAgent,
  type AgentSetupGoal,
  type AgentSetupPlatform,
  type AgentSetupStep,
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

import { LiveKitChatInstructions } from "./livekit-chat-instructions.tsx";
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

type ConnectAgentSheetProps = {
  readonly projectId: string;
  readonly agents: readonly ListedAgentWithConnections[];
  readonly agentId?: string;
  readonly goal?: ConnectAgentGoal;
  readonly platform?: ConnectAgentPlatform;
  readonly onboarding?: boolean;
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
      "Egma speaks to the agent in the room, the way a person reaches it. Your worker needs no change.",
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
  const [testModality, setTestModality] = useState<"" | "chat" | "voice">("");
  const [discovering, setDiscovering] = useState(false);

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
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setGoal(initialGoal ?? "");
    setPlatform(initialPlatform ?? "");
    setStep(firstStep(initialGoal, initialPlatform));
    setApiKey("");
    setRetellAgents(null);
    setRetellAgentId("");
    setRetellRoute("");
    setTestModality("");
    setLivekitModality("");
    setLivekitAccess(PROJECT_CREDENTIALS);
    setLivekitAgentName("");
    setLivekitConfig({});
    setLivekitCredentials({});
    setCompleted(null);
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
  const selectedModality = retellModality(selectedRetellAgent);
  const selectedRoutes =
    plan === null ? [] : retellCandidatesForPlan(plan, selectedRetellAgent);
  // The voice connection this flow offers is a phone number Egma dials, the
  // way an agent's own callers reach it. Discovery also returns a web-call
  // candidate for every voice agent, but that lane is Egma placing the call
  // itself for the mocked-run tick, not a connection a person picks here — the
  // CLI's connect offers only text and phone for the same reason. Left in, it
  // would sit in the phone chooser as a blank option (it carries no number) and,
  // being first, become the step's default — saving a web call where the person
  // asked for a phone.
  const voiceRoutes = selectedRoutes.filter(
    (one) => one.modality === "voice" && one.connectionType === "phone_number",
  );
  const chatRoute = selectedRoutes.find((one) => one.modality === "chat");
  const selectedVoiceRoute = voiceRoutes.find(
    (one) => retellCandidateValue(one) === retellRoute,
  );

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
    setTestModality("");
    setLivekitModality("");
    setLivekitAccess(PROJECT_CREDENTIALS);
    setLivekitAgentName("");
    setLivekitConfig({});
    setLivekitCredentials({});
    setCompleted(null);
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
      liveKitModality: livekitModality,
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
    setTestModality("");
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
  ): Promise<ConnectSheetResult | null> {
    setSaving(true);
    setRefused(null);

    if (agentId === undefined || agentId === NEW_AGENT) {
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
        { agentId, projectId, ...body },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (!finishAnswer(answer)) return null;
    return {
      agentId,
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

  async function finishRetellVoice(): Promise<void> {
    if (
      goal === "" ||
      selectedRetellAgent === undefined ||
      selectedVoiceRoute === undefined
    ) {
      return;
    }

    const option = optionNamed(catalog, selectedVoiceRoute);
    if (option === undefined) return;
    const resumesStoredMonitoring =
      goal === "monitoring" &&
      storedRetellKey &&
      agentId !== undefined &&
      agentId !== NEW_AGENT &&
      known?.platformAgentId === selectedRetellAgent.platformAgentId;
    const result = resumesStoredMonitoring
      ? await resumeRetellMonitoring()
      : await saveConnection(
          selectedRetellAgent.name,
          connectionBody(
            option,
            selectedVoiceRoute,
            plan?.pullWithConnection === true,
          ),
        );
    if (result !== null) onConnected(result);
  }

  async function finishRetellChat(): Promise<void> {
    if (
      goal === "" ||
      selectedRetellAgent === undefined ||
      chatRoute === undefined
    ) {
      return;
    }
    const option = optionNamed(catalog, chatRoute);
    if (option === undefined) return;
    const result = await saveConnection(
      selectedRetellAgent.name,
      connectionBody(option, chatRoute, false),
    );
    if (result !== null) onConnected(result);
  }

  async function finishLiveKit(): Promise<void> {
    if (goal === "" || plan === null || livekitOption === undefined) return;
    // Saved already, and this press is the way on: a Both walk that came back
    // to this screen must not save a second connection to move forward.
    if (completed !== null) {
      const next = stepAfterLiveKitCredentials(plan, livekitOption.modality);
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
    const next = stepAfterLiveKitCredentials(plan, livekitOption.modality);
    if (next === null) {
      onConnected(result);
      return;
    }
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
        if (selectedModality === null || goal === "") return;
        const next = stepAfterRetellAgent(selectedModality, goal);
        // A voice agent going straight to the phone step (Monitoring or Both)
        // needs its first voice route chosen for it; a voice agent going to the
        // modality question waits for chat-or-voice first.
        if (next === "retell-phone") {
          const first = voiceRoutes[0];
          setRetellRoute(first === undefined ? "" : retellCandidateValue(first));
        }
        transition(next);
        return;
      }
      case "retell-modality":
        if (testModality === "") return;
        if (testModality === "chat") {
          // Chat over text mode: minted from the one chat route a voice
          // agent carries, the same finish the chat-agent path uses.
          await finishRetellChat();
        } else {
          const first = voiceRoutes[0];
          setRetellRoute(first === undefined ? "" : retellCandidateValue(first));
          transition("retell-phone");
        }
        return;
      case "retell-phone":
        await finishRetellVoice();
        return;
      case "retell-chat":
        if (goal === "monitoring") {
          onClose();
        } else {
          await finishRetellChat();
        }
        return;
      case "livekit-modality":
        if (livekitModality !== "") transition("livekit-simulation");
        return;
      case "livekit-simulation":
        await finishLiveKit();
        return;
      case "livekit-chat": {
        const next = plan === null ? null : stepAfterLiveKitChat(plan);
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
        if (completed === null) onClose();
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
      // The modality step can mint the text-mode connection on Continue, and
      // that needs the option catalog to name the row it writes.
      step === "retell-modality" ||
      (step === "retell-chat" && goal !== "monitoring");
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
                    ? "This Retell account does not contain a voice or chat agent."
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
                  setTestModality("");
                }}
              >
                {visibleRetellAgents.map((one) => {
                  const modality = retellModality(one);
                  const phones = one.connectionCandidates.filter(
                    (candidate) => candidate.modality === "voice",
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
                      : modality === "chat"
                        ? "Chat agent · available for simulations"
                        : "No supported connection available";
                  return (
                    <ChoiceCard
                      key={one.platformAgentId}
                      value={one.platformAgentId}
                      title={one.name || one.platformAgentId}
                      description={description}
                      disabled={one.connectionCandidates.length === 0}
                    />
                  );
                })}
              </RadioGroup>
            )}
            <InfoBox>
              Voice agents use a phone number. Chat agents connect through the
              Retell Chat API.
            </InfoBox>
          </div>
        );
      case "retell-modality":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title="How do you want to test this agent?"
              description={
                "Egma can test " +
                String(selectedRetellAgent?.name ?? "this voice agent") +
                " two ways. Choose the one you want to start with."
              }
            />
            <RadioGroup
              className="gap-4"
              aria-label="How to test"
              value={testModality}
              onValueChange={(value) =>
                setTestModality(value as "chat" | "voice")
              }
            >
              <ChoiceCard
                value="chat"
                title="Chat"
                description="Egma tests the agent in text over Retell's text mode. No call is placed and nothing is dialled, so a whole suite runs in seconds."
              />
              <ChoiceCard
                value="voice"
                title="Voice"
                description="Egma places a call and talks to the agent over the wire, the way its callers do."
              />
            </RadioGroup>
            <InfoBox>
              Chat and voice land as two connections on one agent, so you can
              add the other later and compare the same tests across both.
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
      case "retell-chat":
        if (goal === "simulation") {
          return (
            <div className="flex flex-col gap-5">
              <StepIntro
                title="Connect this chat agent for simulations"
                description={
                  "Egma can run simulations with " +
                  String(selectedRetellAgent?.name ?? "this agent") +
                  " through the Retell Chat API."
                }
              />
              <SummaryRows
                rows={[
                  ["Retell agent", selectedRetellAgent?.name ?? ""],
                  ["Connection", "Chat"],
                ]}
              />
              <InfoBox>This connection is ready for simulation setup.</InfoBox>
            </div>
          );
        }
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title="Production monitoring needs a voice agent"
              description={
                String(selectedRetellAgent?.name ?? "This agent") +
                " is a chat agent. Retell chat agents do not produce calls that Egma can monitor."
              }
            />
            <SummaryRows
              rows={[
                ["Retell agent", selectedRetellAgent?.name ?? ""],
                ["Connection", "Chat"],
              ]}
            />
            <InfoBox title="Production monitoring needs a voice agent.">
              {boundRetellPlatformAgentId !== null
                ? goal === "both"
                  ? "Set up simulations for this chat agent, then return to Agents and connect a Retell voice agent for monitoring."
                  : "Return to Agents and connect a Retell voice agent to monitor production calls."
                : goal === "both"
                  ? "Choose a voice agent to set up monitoring, or continue with simulations only."
                  : "Choose a Retell voice agent to monitor production calls."}
            </InfoBox>
            {boundRetellPlatformAgentId === null ? (
              <Button
                type="button"
                size="lg"
                variant="secondary"
                onClick={() => {
                  setRetellAgentId("");
                  setRetellRoute("");
                  transition("retell-agent");
                }}
              >
                Choose a voice agent
              </Button>
            ) : null}
          </div>
        );
      case "livekit-modality":
        return (
          <div className="flex flex-col gap-5">
            <StepIntro
              title="How do you want to test this agent?"
              description="Run the same tests over both to tell a broken prompt from a broken speech stack."
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
      case "livekit-chat":
        return <LiveKitChatInstructions />;
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
        return <LiveKitMonitoringInstructions projectId={projectId} />;
    }
  }

  const primaryLabel =
    step === "goal" ||
    step === "platform" ||
    step === "retell-agent" ||
    step === "livekit-modality"
      ? "Continue"
      : step === "retell-modality"
        ? // Chat mints here; voice carries on to choose a number.
          testModality === "chat"
          ? saving
            ? "Setting up…"
            : "Set up simulation"
          : "Continue"
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
          : step === "retell-chat"
            ? goal === "monitoring"
              ? "Return to agents"
              : saving
                ? "Setting up…"
                : "Set up simulation"
            : step === "livekit-simulation"
              ? saving
                ? "Saving…"
                : // A chat walk has the setup instructions after this screen,
                  // so this press is the save and nothing further. And a walk
                  // that came back here has already saved, so it is neither.
                  goal === "both" && livekitModality !== "chat"
                  ? "Continue to monitoring"
                  : completed === null
                    ? "Save connection"
                    : "Continue"
              : step === "livekit-chat" && goal === "both"
                ? "Continue to monitoring"
                : "Return to agents";

  const primaryDisabled =
    saving ||
    discovering ||
    (step === "goal" && goal === "") ||
    (step === "platform" && platform === "") ||
    (step === "retell-key" && !keyReady) ||
    (step === "retell-agent" && selectedModality === null) ||
    // Nothing chosen yet, or chat chosen before the catalog it mints from
    // arrived.
    (step === "retell-modality" &&
      (testModality === "" ||
        (testModality === "chat" && catalog === null))) ||
    (step === "retell-phone" &&
      (selectedVoiceRoute === undefined || catalog === null)) ||
    (step === "retell-chat" && goal !== "monitoring" && catalog === null) ||
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
            {body()}
          </SheetBody>
          {usable ? (
            <SheetFooter className="border-t border-border pt-5 [&>div:first-child]:w-full [&>div:first-child]:justify-between">
              <Button
                type="button"
                size="lg"
                variant="secondary"
                disabled={saving || discovering}
                onClick={step === "goal" ? leave : back}
              >
                {step === "goal" ? "Cancel" : "Back"}
              </Button>
              <Button
                type="submit"
                size="lg"
                disabled={primaryDisabled}
                busy={saving || discovering}
              >
                {primaryLabel}
              </Button>
            </SheetFooter>
          ) : null}
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
        title="Connect LiveKit for simulations"
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
