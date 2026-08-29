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
  /**
   * Whether this plan asks the one question — how should Egma test this agent.
   *
   * A monitoring goal does not: it needs the voice connection for production
   * pull and nothing else, so it walks straight to the number chooser exactly
   * as it does today. Asking it "text, web call or phone?" would be a question
   * whose answer it cannot use.
   */
  readonly asksHowToTest: boolean;
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
      asksHowToTest: true,
    },
    monitoring: {
      goal: "monitoring",
      platform: "retell",
      /* The selected voice route is saved, and that same save starts pulling. */
      writesConnection: true,
      pullWithConnection: true,
      monitoringInstructions: false,
      asksHowToTest: false,
    },
    both: {
      goal: "both",
      platform: "retell",
      writesConnection: true,
      pullWithConnection: true,
      monitoringInstructions: false,
      // Both needs the voice connection for production pull, so it takes the
      // number chooser without the question, exactly as Monitoring does.
      asksHowToTest: false,
    },
  },
  livekit: {
    simulation: {
      goal: "simulation",
      platform: "livekit",
      writesConnection: true,
      pullWithConnection: false,
      monitoringInstructions: false,
      asksHowToTest: false,
    },
    monitoring: {
      goal: "monitoring",
      platform: "livekit",
      writesConnection: false,
      pullWithConnection: false,
      monitoringInstructions: true,
      asksHowToTest: false,
    },
    both: {
      goal: "both",
      platform: "livekit",
      writesConnection: true,
      pullWithConnection: false,
      monitoringInstructions: true,
      asksHowToTest: false,
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
 * **Voice agents only.** Egma registers Retell voice agents, so discovery
 * answers with those and this keeps the guarantee at the surface too: a
 * chat-native agent is never offered, because no lane reaches one and the
 * product would have nothing to ask about it.
 */
export function retellAgentsForPlan(
  plan: AgentSetupPlan,
  agents: readonly RetellDiscoveredAgent[] | null,
): readonly RetellDiscoveredAgent[] {
  if (plan.platform !== "retell" || !plan.writesConnection) return [];
  return agents?.filter((agent) => agent.modality === "voice") ?? [];
}

/** The selected agent's connection candidates that this plan can save. */
export function retellCandidatesForPlan(
  plan: AgentSetupPlan,
  agent: RetellDiscoveredAgent | undefined,
): readonly RetellConnectionCandidate[] {
  if (plan.platform !== "retell" || agent === undefined) return [];
  return agent.connectionCandidates;
}

/**
 * The three lanes, and the one question that leads.
 *
 * They are the same three words the CLI says, because they are the same three
 * lanes: each one is a connection, several may be picked, and every pick lands
 * on **one** egma agent in one pass.
 */
export const RETELL_LANES = ["text", "web-call", "phone"] as const;
export type RetellLane = (typeof RETELL_LANES)[number];

export const RETELL_LANE_QUESTION = "How should Egma test this agent?";

/** The word on screen for each lane. */
export const RETELL_LANE_LABELS: Readonly<Record<RetellLane, string>> = {
  text: "Text",
  "web-call": "Web call",
  phone: "Phone call",
};

/** One help line each, in what the lane tests rather than what it is made of. */
export const RETELL_LANE_HELP: Readonly<Record<RetellLane, string>> = {
  text: "Egma talks to the agent in text. No call is placed, and a run takes seconds.",
  "web-call": "A voice call Egma places over the internet.",
  phone:
    "Egma dials the real number, so a run has true telephone latency and " +
    "reaches your real tools.",
};

/** The connection type each lane is saved as. */
export const RETELL_LANE_CONNECTION_TYPES: Readonly<Record<RetellLane, string>> = {
  text: "retell_text_mode",
  "web-call": "retell_web_call",
  phone: "phone_number",
};

/**
 * The picked lanes, in reading order, out of whatever order they were ticked
 * in.
 *
 * Two people ticking the same three boxes in different orders must write the
 * same three connections in the same order, or one project's connection names
 * would depend on the order somebody clicked.
 */
export function retellLanesInOrder(
  picked: readonly string[],
): readonly RetellLane[] {
  return RETELL_LANES.filter((lane) => picked.includes(lane));
}

/**
 * The candidate that saves one lane, out of the ones discovery answered with.
 *
 * The phone lane is the one that needs saying which: a voice agent can have
 * several routed numbers, and the chooser is where the person says which one.
 * The other two lanes carry the vendor agent id and have exactly one candidate
 * each.
 */
export function retellCandidateForLane(
  candidates: readonly RetellConnectionCandidate[],
  lane: RetellLane,
  phoneNumberValue = "",
): RetellConnectionCandidate | undefined {
  const type = RETELL_LANE_CONNECTION_TYPES[lane];
  if (lane !== "phone") {
    return candidates.find((one) => one.connectionType === type);
  }
  const phones = candidates.filter((one) => one.connectionType === type);
  if (phoneNumberValue === "") return phones[0];
  return phones.find((one) => retellCandidateValue(one) === phoneNumberValue);
}

/** A stable form value for one discovered candidate. */
export function retellCandidateValue(candidate: RetellConnectionCandidate): string {
  if (candidate.connectionType === "phone_number") {
    return `phone:${candidate.config.phoneNumber ?? ""}`;
  }
  return `${candidate.connectionType}:${candidate.config.retellAgentId ?? ""}`;
}

/** The visible desktop states in the approved setup flow. */
export type AgentSetupStep =
  | "goal"
  | "platform"
  | "retell-key"
  | "retell-agent"
  | "retell-lanes"
  | "retell-phone"
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
 * Straight to the one question — how should Egma test this agent — because the
 * choice a person understands comes before any plumbing. Monitoring and Both
 * need the voice connection for production pull, so they skip the question and
 * go to the number chooser exactly as they do today.
 */
export function stepAfterRetellAgent(plan: AgentSetupPlan): AgentSetupStep {
  return plan.asksHowToTest ? "retell-lanes" : "retell-phone";
}

/**
 * Where the answer to the one question leads, or `null` when the flow can save
 * now.
 *
 * **The phone-number chooser appears only when Phone call is picked.** A
 * developer who picked only Text is never asked for a phone number: the fast
 * lane has no needless steps, and there is nothing honest to ask about a number
 * nothing will dial.
 */
export function stepAfterRetellLanes(
  lanes: readonly RetellLane[],
): AgentSetupStep | null {
  return lanes.includes("phone") ? "retell-phone" : null;
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
    case "retell-lanes":
      return "retell-agent";
    case "retell-phone":
      // The phone chooser is reached through the one question when the goal is
      // a simulation, and straight from the agent for the goals that skip it.
      return goal === "simulation" ? "retell-lanes" : "retell-agent";
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
