import type { DiscoverAgentsResponse } from "@egma/platform-api/client";

import { modalityLabel } from "./agents.ts";

/** The job a person asks the Connect agent flow to complete. */
export type AgentSetupGoal = "simulation" | "monitoring" | "both";

/** The platforms the goal-first flow offers. */
export type AgentSetupPlatform = "retell" | "livekit" | "pipecat";

/**
 * The platforms whose agent carries the Egma SDK: LiveKit and Pipecat.
 *
 * They share one walk — the modality, one connection form, then the source
 * instructions — because Egma reaches both the same way: it starts the agent
 * for a simulation, and the agent reports to Egma through the SDK. Only the
 * fields and the words differ, and those come from the tables below and the
 * connection catalog. Monitoring for them lives in the agent's code too.
 *
 * The registry's `PLATFORMS_PUSHING_TRACES` in `@egma/db`, which the browser
 * cannot import; a web test holds this copy to it.
 */
export const SDK_PLATFORMS = ["livekit", "pipecat"] as const;
export type SdkPlatform = (typeof SDK_PLATFORMS)[number];

export function isSdkPlatform(platform: string): platform is SdkPlatform {
  return (SDK_PLATFORMS as readonly string[]).includes(platform);
}

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
  /**
   * Whether the flow ends by flipping the pull switch, with no connection.
   *
   * Production pull needs the sealed key and the platform agent id — the
   * puller selects calls by agent id alone — so the monitoring goal asks for
   * no phone number and writes no provider route. The switch commit registers
   * an agent this project does not hold yet (ADR-0015: watching one means
   * registering it).
   */
  readonly pullWithoutConnection: boolean;
  /** Whether the UI shows SDK instructions without recording an on/off state. */
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
      pullWithoutConnection: false,
      monitoringInstructions: false,
      asksHowToTest: true,
    },
    monitoring: {
      goal: "monitoring",
      platform: "retell",
      /* Nothing is saved but the pull switch: no route, no phone number. */
      mayWriteConnection: false,
      pullWithConnection: false,
      pullWithoutConnection: true,
      monitoringInstructions: false,
      asksHowToTest: false,
    },
    both: {
      goal: "both",
      platform: "retell",
      mayWriteConnection: true,
      pullWithConnection: true,
      pullWithoutConnection: false,
      monitoringInstructions: false,
      // Both saves the phone lane for simulation, so it takes the number
      // chooser without the question; the same save starts pulling.
      asksHowToTest: false,
    },
  },
  livekit: {
    simulation: {
      goal: "simulation",
      platform: "livekit",
      mayWriteConnection: true,
      pullWithConnection: false,
      pullWithoutConnection: false,
      monitoringInstructions: false,
      asksHowToTest: false,
    },
    monitoring: {
      goal: "monitoring",
      platform: "livekit",
      mayWriteConnection: false,
      pullWithConnection: false,
      pullWithoutConnection: false,
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
      pullWithoutConnection: false,
      monitoringInstructions: true,
      asksHowToTest: false,
    },
  },
  // Pipecat's plans are LiveKit's: monitoring is configured in the bot's code,
  // and a simulation saves one connection after the modality question.
  pipecat: {
    simulation: {
      goal: "simulation",
      platform: "pipecat",
      mayWriteConnection: true,
      pullWithConnection: false,
      pullWithoutConnection: false,
      monitoringInstructions: false,
      asksHowToTest: false,
    },
    monitoring: {
      goal: "monitoring",
      platform: "pipecat",
      mayWriteConnection: false,
      pullWithConnection: false,
      pullWithoutConnection: false,
      monitoringInstructions: true,
      asksHowToTest: false,
    },
    both: {
      goal: "both",
      platform: "pipecat",
      mayWriteConnection: true,
      pullWithConnection: false,
      pullWithoutConnection: false,
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
  if (plan.platform !== "retell") return [];
  if (!plan.mayWriteConnection && !plan.pullWithoutConnection) return [];
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
 * **None of them says anything about mocking any more.** Mock tools belong to
 * the test now, so what a lane can do with them is a fact about the run, said
 * by the run note where a run is being started. A line here would be answering
 * a question this flow no longer asks.
 */
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
  if (plan.platform !== "retell") return false;
  // Pull selects calls by platform agent id, so a monitoring-only plan takes
  // every voice agent — one with no routed number as much as any other.
  if (plan.pullWithoutConnection) return true;
  if (!plan.mayWriteConnection) return false;
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

/**
 * The visible desktop states in the approved setup flow.
 *
 * The four `sdk-` steps serve LiveKit and Pipecat alike (`SdkPlatform`).
 */
export type AgentSetupStep =
  | "goal"
  | "platform"
  | "retell-key"
  | "retell-agent"
  | "retell-lanes"
  | "retell-phone"
  | "sdk-modality"
  | "sdk-connection"
  | "sdk-testing"
  | "sdk-monitoring";

/**
 * Provider capability decides the first provider-specific screen.
 *
 * An SDK platform's Simulation asks only what changes its connection: the
 * modality. Monitoring and Both start with the monitoring instructions, which
 * change the agent's source, not the connection.
 */
export function stepAfterPlatform(
  goal: AgentSetupGoal,
  platform: AgentSetupPlatform,
): AgentSetupStep {
  if (platform === "retell") return "retell-key";
  return goal === "simulation" ? "sdk-modality" : "sdk-monitoring";
}

/**
 * What follows a saved SDK-platform simulation connection.
 *
 * Every agent needs the testing hook; LiveKit chat adds silent room handling.
 * This is a screen and not a recorded state: Egma cannot see the source change
 * from the web application, so the sheet claims no completion for it.
 */
export function stepAfterSdkConnection(
  _plan: AgentSetupPlan,
): AgentSetupStep {
  return "sdk-testing";
}

/** What follows the testing instructions, or `null` when the flow is done. */
export function stepAfterSdkTesting(
  _plan: AgentSetupPlan,
): AgentSetupStep | null {
  // A Both flow completes Monitoring before it starts simulation setup.
  return null;
}

/**
 * Where a chosen Retell agent leads, or `null` when the flow can finish now.
 *
 * Straight to the one question — how should Egma test this agent — because the
 * choice a person understands comes before any plumbing. Both needs the voice
 * connection for the simulation phone lane, so it skips the question and goes
 * to the number chooser. Monitoring needs no connection at all — the pull
 * switch is the whole finish — so the agent choice is its last step.
 */
export function stepAfterRetellAgent(
  plan: AgentSetupPlan,
): AgentSetupStep | null {
  if (plan.asksHowToTest) return "retell-lanes";
  return plan.pullWithoutConnection ? null : "retell-phone";
}

/**
 * Choose the next setup step, or null when ready to save. Only the phone
 * connection flow asks which number to dial.
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
    case "sdk-modality":
      // Both has already shown Monitoring. Simulation entered here directly,
      // because language changes source instructions rather than a connection.
      return goal === "both" ? "sdk-monitoring" : "platform";
    case "retell-agent":
      return "retell-key";
    case "retell-lanes":
      return "retell-agent";
    case "retell-phone":
      // The phone chooser is reached through the one question when the goal is
      // a simulation, and straight from the agent for Both, which skips it.
      // Monitoring never arrives here: it finishes on the agent choice.
      return goal === "simulation" ? "retell-lanes" : "retell-agent";
    case "sdk-connection":
      return "sdk-modality";
    case "sdk-testing":
      // The connection is already persisted before this screen appears. Do
      // not let Back cross that write and change the modality it describes.
      return null;
    case "sdk-monitoring":
      return "platform";
  }
}

/** Each SDK platform's name, as the setup screens say it. */
export const SDK_PLATFORM_LABELS: Readonly<Record<SdkPlatform, string>> = {
  livekit: "LiveKit",
  pipecat: "Pipecat",
};

/** The one connection type each SDK platform's simulation saves. */
export const SDK_CONNECTION_TYPES: Readonly<Record<SdkPlatform, string>> = {
  livekit: "livekit_room",
  pipecat: "daily_room",
};

/** One entry of the connection form's `Connection type` select. */
export type SdkAccessChoice = {
  readonly accessVariant: string;
  readonly label: string;
};

/**
 * The `Connection type` select's entries, first one preselected.
 *
 * Which of them a modality offers is the catalog's answer; these are only the
 * short words the select shows for each access variant.
 */
export const SDK_ACCESS_CHOICES: Readonly<
  Record<SdkPlatform, readonly SdkAccessChoice[]>
> = {
  livekit: [
    { accessVariant: "livekit_room.project_credentials", label: "Project credentials" },
    { accessVariant: "livekit_room.customer_token_endpoint", label: "Token endpoint" },
  ],
  pipecat: [
    { accessVariant: "daily_room.pipecat_cloud", label: "Pipecat Cloud" },
    { accessVariant: "daily_room.self_hosted", label: "Self-hosted" },
  ],
};

/**
 * The access variant a connection form starts on: the first of the select's
 * entries the modality offers, else whichever it offers first.
 */
export function firstSdkAccess(
  platform: SdkPlatform,
  offered: readonly string[],
): string {
  const first = SDK_ACCESS_CHOICES[platform].find((choice) =>
    offered.includes(choice.accessVariant),
  );
  return first?.accessVariant ?? offered[0] ?? "";
}

/** The connection form's title: `Connect Pipecat Voice for simulations`. */
export function sdkConnectionTitle(
  platform: SdkPlatform,
  modality: "chat" | "voice" | "",
): string {
  const label = SDK_PLATFORM_LABELS[platform];
  return modality === ""
    ? `Connect ${label} for simulations`
    : `Connect ${label} ${modalityLabel(modality)} for simulations`;
}

/**
 * What each modality is, said as the difference a person is choosing between.
 *
 * Which of the two are offered is the catalog's answer and never this file's.
 * What each one means is product language, and it is written once here so the
 * card cannot say one thing while the surface after it says another. A
 * Pipecat bot needs nothing for chat beyond the one testing line.
 */
export const SDK_MODALITY_CHOICES: Readonly<
  Record<
    SdkPlatform,
    Readonly<
      Record<
        "chat" | "voice",
        { readonly title: string; readonly description: string }
      >
    >
  >
> = {
  livekit: {
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
  },
  pipecat: {
    voice: {
      title: "Voice",
      description:
        "Egma speaks to the agent in the room, the way a person reaches it. Your bot needs the Egma testing hook, which Egma shows you next.",
    },
    chat: {
      title: "Chat",
      description:
        "Egma types to the agent and reads its words back. Fast, and it spends nothing on speech. The same testing hook covers it.",
    },
  },
};
