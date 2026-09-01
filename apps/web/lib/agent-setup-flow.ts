import type { DiscoverAgentsResponse } from "@egma/platform-api/client";

/** The job a person asks the Connect agent flow to complete. */
export type AgentSetupGoal = "simulation" | "monitoring" | "both";

/** The two platforms the goal-first flow offers today. */
export type AgentSetupPlatform = "retell" | "livekit";

/** The language of the customer-owned LiveKit worker. */
export type LiveKitWorkerLanguage = "python" | "javascript";

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
  /** Whether any supported branch of this flow can save a provider connection. */
  readonly mayWriteConnection: boolean;
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
      mayWriteConnection: true,
      pullWithConnection: false,
      monitoringInstructions: false,
      asksHowToTest: true,
    },
    monitoring: {
      goal: "monitoring",
      platform: "retell",
      /* The selected voice route is saved, and that same save starts pulling. */
      mayWriteConnection: true,
      pullWithConnection: true,
      monitoringInstructions: false,
      asksHowToTest: false,
    },
    both: {
      goal: "both",
      platform: "retell",
      mayWriteConnection: true,
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
      mayWriteConnection: true,
      pullWithConnection: false,
      monitoringInstructions: false,
      asksHowToTest: false,
    },
    monitoring: {
      goal: "monitoring",
      platform: "livekit",
      mayWriteConnection: false,
      pullWithConnection: false,
      monitoringInstructions: true,
      asksHowToTest: false,
    },
    both: {
      goal: "both",
      platform: "livekit",
      // Both languages continue into simulation setup after the customer has
      // the matching production-monitoring instructions.
      mayWriteConnection: true,
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
  if (plan.platform !== "retell" || !plan.mayWriteConnection) return [];
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
 * lanes. **One is picked, and it is one connection**: a lane decides how Egma
 * reaches the agent, and a connection is that reach — so two lanes at once was
 * two connections dressed as one answer. A second lane on the same agent is
 * added afterwards, through the same flow, from the agent's own screen.
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

/**
 * One help line each, in what the lane tests rather than what it is made of.
 *
 * Two of them end by saying mocking is supported, because that is the next
 * question the flow asks and a person choosing a lane deserves to know it is
 * coming. The phone lane says the opposite in its own words — it reaches the
 * real tools — which is why it is never asked.
 */
export const RETELL_LANE_HELP: Readonly<Record<RetellLane, string>> = {
  text:
    "Egma talks to the agent in text. No call is placed, and a run takes " +
    "seconds. Supports mocking of tools.",
  "web-call":
    "A voice call Egma places over the internet. Supports mocking of tools.",
  phone:
    "Egma dials the real number, so a run has true telephone latency and " +
    "reaches your real tools.",
};

/**
 * Whether this lane can answer the agent's tools with test data.
 *
 * The phone lane cannot and never will: it dials the customer's own published
 * number, and what answers is their real agent with their real tools. So it is
 * not asked the mock question at all, rather than asked and refused.
 */
export function retellLaneMocksTools(lane: RetellLane): boolean {
  return lane !== "phone";
}

/**
 * Whether turning mocks on for this lane creates a draft version on the agent.
 *
 * Only the web-call lane. A text run carries its mocked answers on each
 * request, so nothing is written to the customer's Retell account and there is
 * no draft for a phone number or a tag to reach. A web call is placed by Retell
 * against a version, so Egma branches one — and that draft **is** the latest
 * created version, which is the fact the note beside the switch exists to say.
 */
export function retellLaneBranchesDraft(lane: RetellLane): boolean {
  return lane === "web-call";
}

/** The connection type each lane is saved as. */
export const RETELL_LANE_CONNECTION_TYPES: Readonly<Record<RetellLane, string>> = {
  text: "retell_text_mode",
  "web-call": "retell_web_call",
  phone: "phone_number",
};

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

/** Whether this agent has the provider route the selected goal needs. */
export function retellAgentCanEnterPlan(
  plan: AgentSetupPlan,
  agent: RetellDiscoveredAgent,
): boolean {
  if (plan.platform !== "retell" || !plan.mayWriteConnection) return false;
  if (!plan.asksHowToTest) {
    return agent.connectionCandidates.some(
      (candidate) => candidate.connectionType === "phone_number",
    );
  }
  return RETELL_LANES.some(
    (lane) => retellCandidateForLane(agent.connectionCandidates, lane) !== undefined,
  );
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
  | "retell-mocks"
  | "retell-phone"
  | "livekit-modality"
  | "livekit-simulation"
  | "livekit-testing"
  | "livekit-monitoring";

/**
 * Provider capability decides the first provider-specific screen.
 *
 * LiveKit Simulation asks only what changes its connection: the modality.
 * Monitoring and Both start with instructions whose language toggle changes
 * the source hook, not the room connection.
 */
export function stepAfterPlatform(
  goal: AgentSetupGoal,
  platform: AgentSetupPlatform,
): AgentSetupStep {
  if (platform === "retell") return "retell-key";
  return goal === "simulation" ? "livekit-modality" : "livekit-monitoring";
}

/**
 * What follows a saved LiveKit simulation connection.
 *
 * Every worker needs the testing hook. Chat adds silent room handling.
 * This is a screen and not a recorded state: Egma cannot see the source change
 * from the web application, so the sheet claims no completion for it.
 */
export function stepAfterLiveKitCredentials(
  _plan: AgentSetupPlan,
): AgentSetupStep {
  return "livekit-testing";
}

/** What follows the testing instructions, or `null` when the flow is done. */
export function stepAfterLiveKitTesting(
  _plan: AgentSetupPlan,
): AgentSetupStep | null {
  // A Both flow completes Monitoring before it starts simulation setup.
  return null;
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
 * **The phone-number chooser appears only when Phone call is picked**, because
 * a voice agent can answer several routed numbers and the flow has to be told
 * which one to dial. A developer who picked Text is never asked for a phone
 * number: the fast lane has no needless steps, and there is nothing honest to
 * ask about a number nothing will dial.
 */
export function stepAfterRetellLanes(lane: RetellLane): AgentSetupStep | null {
  return lane === "phone" ? "retell-phone" : null;
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
      return "platform";
    case "livekit-modality":
      // Both has already shown Monitoring. Simulation entered here directly,
      // because language changes source instructions rather than a connection.
      return goal === "both" ? "livekit-monitoring" : "platform";
    case "retell-agent":
      return "retell-key";
    case "retell-lanes":
      return "retell-agent";
    case "retell-mocks":
      // The connection is already written before this screen appears, and its
      // tools are read against it. Do not let Back cross that write.
      return null;
    case "retell-phone":
      // The phone chooser is reached through the one question when the goal is
      // a simulation, and straight from the agent for the goals that skip it.
      return goal === "simulation" ? "retell-lanes" : "retell-agent";
    case "livekit-simulation":
      return "livekit-modality";
    case "livekit-testing":
      // The connection is already persisted before this screen appears. Do
      // not let Back cross that write and change the modality it describes.
      return null;
    case "livekit-monitoring":
      return "platform";
  }
}
