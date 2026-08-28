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
  | "retell-phone"
  | "retell-chat"
  | "livekit-simulation"
  | "livekit-monitoring";

/** Provider capability decides the first provider-specific screen. */
export function stepAfterPlatform(
  goal: AgentSetupGoal,
  platform: AgentSetupPlatform,
): AgentSetupStep {
  if (platform === "retell") return "retell-key";
  return goal === "monitoring" ? "livekit-monitoring" : "livekit-simulation";
}

/** Retell reports modality. The person chooses the agent, not the modality. */
export function stepAfterRetellAgent(
  modality: "chat" | "voice",
): AgentSetupStep {
  return modality === "voice" ? "retell-phone" : "retell-chat";
}

/** The single Back graph shared by every rendering of the setup flow. */
export function previousAgentSetupStep({
  step,
  goal,
}: {
  readonly step: AgentSetupStep;
  readonly goal: AgentSetupGoal | "";
}): AgentSetupStep | null {
  switch (step) {
    case "goal":
      return null;
    case "platform":
      return "goal";
    case "retell-key":
    case "livekit-simulation":
      return "platform";
    case "retell-agent":
      return "retell-key";
    case "retell-phone":
    case "retell-chat":
      return "retell-agent";
    case "livekit-monitoring":
      return goal === "both" ? "livekit-simulation" : "platform";
  }
}
