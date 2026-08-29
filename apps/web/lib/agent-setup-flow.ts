import type { DiscoverAgentsResponse } from "@egma/platform-api/client";

/** The job a person asks the Connect agent flow to complete. */
export type AgentSetupGoal = "simulation" | "monitoring" | "both";

/** The two platforms the goal-first flow offers today. */
export type AgentSetupPlatform = "retell" | "livekit";

/**
 * One provider-specific execution plan behind the goal and platform questions.
 *
 * The sheet renders this answer. It does not decide provider capability in its
 * branches. This is the state-machine seam: six inputs, six honest plans, and
 * no generic "configured" state that means a different thing per provider.
 */
export type AgentSetupPlan = {
  readonly goal: AgentSetupGoal;
  readonly platform: AgentSetupPlatform;
  /** Whether this flow saves a provider connection. */
  readonly writesConnection: boolean;
  /** Whether the Retell connection save also turns on production pulling. */
  readonly pullWithConnection: boolean;
  /** Whether the UI shows LiveKit instructions without recording an on/off state. */
  readonly monitoringInstructions: boolean;
  /** Retell modalities that the agent picker may show for this plan. */
  readonly retellModalities: readonly ("chat" | "voice")[];
};

const PLANS: Readonly<
  Record<AgentSetupPlatform, Readonly<Record<AgentSetupGoal, AgentSetupPlan>>>
> = {
  retell: {
    simulation: {
      goal: "simulation",
      platform: "retell",
      writesConnection: true,
      pullWithConnection: false,
      monitoringInstructions: false,
      retellModalities: ["chat", "voice"],
    },
    monitoring: {
      goal: "monitoring",
      platform: "retell",
      /* The selected voice route is saved, and that same save starts pulling. */
      writesConnection: true,
      pullWithConnection: true,
      monitoringInstructions: false,
      retellModalities: ["chat", "voice"],
    },
    both: {
      goal: "both",
      platform: "retell",
      writesConnection: true,
      pullWithConnection: true,
      monitoringInstructions: false,
      // Discovery must keep Chat visible. The selected agent decides the last
      // screen: Voice can finish both jobs, while Chat can finish Simulation
      // and must explain why Monitoring still needs a Voice agent.
      retellModalities: ["chat", "voice"],
    },
  },
  livekit: {
    simulation: {
      goal: "simulation",
      platform: "livekit",
      writesConnection: true,
      pullWithConnection: false,
      monitoringInstructions: false,
      retellModalities: [],
    },
    monitoring: {
      goal: "monitoring",
      platform: "livekit",
      writesConnection: false,
      pullWithConnection: false,
      monitoringInstructions: true,
      retellModalities: [],
    },
    both: {
      goal: "both",
      platform: "livekit",
      writesConnection: true,
      pullWithConnection: false,
      monitoringInstructions: true,
      retellModalities: [],
    },
  },
};

export function agentSetupPlan(
  goal: AgentSetupGoal,
  platform: AgentSetupPlatform,
): AgentSetupPlan {
  return PLANS[platform][goal];
}

export type RetellDiscoveredAgent = DiscoverAgentsResponse["agents"][number];
export type RetellConnectionCandidate =
  RetellDiscoveredAgent["connectionCandidates"][number];

/**
 * Retell agents that can enter the selected plan.
 *
 * Modality comes from Retell's discovery answer. The UI never asks the person
 * to restate it. Chat remains visible for Both and Monitoring so the next
 * screen can explain that production monitoring needs a voice agent.
 */
export function retellAgentsForPlan(
  plan: AgentSetupPlan,
  agents: readonly RetellDiscoveredAgent[] | null,
): readonly RetellDiscoveredAgent[] {
  if (plan.platform !== "retell" || !plan.writesConnection) return [];
  return (
    agents?.filter((agent) => plan.retellModalities.includes(agent.modality)) ??
    []
  );
}

/** The selected agent's connection candidates that this plan can save. */
export function retellCandidatesForPlan(
  plan: AgentSetupPlan,
  agent: RetellDiscoveredAgent | undefined,
): readonly RetellConnectionCandidate[] {
  if (plan.platform !== "retell" || agent === undefined) return [];
  return agent.connectionCandidates.filter((candidate) =>
    plan.retellModalities.includes(candidate.modality),
  );
}

/** A stable form value for one discovered candidate. */
export function retellCandidateValue(candidate: RetellConnectionCandidate): string {
  if (candidate.connectionType === "phone_number") {
    return `phone:${candidate.config.phoneNumber ?? ""}`;
  }
  return `chat:${candidate.config.retellAgentId ?? ""}`;
}

/** The visible desktop states in the approved setup flow. */
export type AgentSetupStep =
  | "goal"
  | "platform"
  | "retell-key"
  | "retell-agent"
  | "retell-modality"
  | "retell-phone"
  | "retell-chat"
  | "livekit-modality"
  | "livekit-simulation"
  | "livekit-chat"
  | "livekit-monitoring";

/**
 * Provider capability decides the first provider-specific screen.
 *
 * On LiveKit that screen is the modality, not the credentials. Chat and voice
 * are two different things to test, and which one this is decides what the
 * credential screen may even offer — so the choice a person understands comes
 * before the plumbing it settles.
 */
export function stepAfterPlatform(
  goal: AgentSetupGoal,
  platform: AgentSetupPlatform,
): AgentSetupStep {
  if (platform === "retell") return "retell-key";
  return goal === "monitoring" ? "livekit-monitoring" : "livekit-modality";
}

/**
 * What follows a saved LiveKit connection, or `null` when the flow is done.
 *
 * A chat connection has one more screen to it, because the worker still needs
 * six lines that Egma cannot write. It is a screen and not a state: nothing
 * here is recorded, and the sheet claims no completion for it.
 */
export function stepAfterLiveKitCredentials(
  plan: AgentSetupPlan,
  modality: "chat" | "voice",
): AgentSetupStep | null {
  if (modality === "chat") return "livekit-chat";
  return plan.monitoringInstructions ? "livekit-monitoring" : null;
}

/** What follows the chat instructions, or `null` when the flow is done. */
export function stepAfterLiveKitChat(plan: AgentSetupPlan): AgentSetupStep | null {
  return plan.monitoringInstructions ? "livekit-monitoring" : null;
}

/**
 * Where a chosen Retell agent leads.
 *
 * A chat agent has one door and goes straight to it. A voice agent has two —
 * chat over text mode, voice over a call — so when the goal is a
 * simulation the flow asks which before any plumbing: that is the modality
 * question, and it leads. Monitoring and Both need the voice connection for
 * production pull, so they keep going to the voice route without the question.
 */
export function stepAfterRetellAgent(
  modality: "chat" | "voice",
  goal: AgentSetupGoal,
): AgentSetupStep {
  if (modality === "chat") return "retell-chat";
  return goal === "simulation" ? "retell-modality" : "retell-phone";
}

/** The single Back graph shared by every rendering of the setup flow. */
export function previousAgentSetupStep({
  step,
  goal,
  liveKitModality = "",
}: {
  readonly step: AgentSetupStep;
  readonly goal: AgentSetupGoal | "";
  /** The LiveKit modality this walk chose, while it has chosen one. */
  readonly liveKitModality?: "chat" | "voice" | "";
}): AgentSetupStep | null {
  switch (step) {
    case "goal":
      return null;
    case "platform":
      return "goal";
    case "retell-key":
    case "livekit-modality":
      return "platform";
    case "retell-agent":
      return "retell-key";
    case "retell-modality":
      return "retell-agent";
    case "retell-phone":
      // A voice agent reaches the phone step through the modality question when
      // the goal is a simulation, and straight from the agent otherwise.
      return goal === "simulation" ? "retell-modality" : "retell-agent";
    case "retell-chat":
      return "retell-agent";
    case "livekit-simulation":
      return "livekit-modality";
    case "livekit-chat":
      return "livekit-simulation";
    case "livekit-monitoring":
      // Both goals walk back the way they came, and a chat walk came through
      // one more screen than a voice one.
      if (goal !== "both") return "platform";
      return liveKitModality === "chat" ? "livekit-chat" : "livekit-simulation";
  }
}
