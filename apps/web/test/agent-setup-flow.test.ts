import { describe, expect, it } from "vitest";

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
  stepAfterLiveKitCredentials,
  stepAfterLiveKitTesting,
  stepAfterPlatform,
  stepAfterRetellAgent,
  stepAfterRetellLanes,
  type RetellDiscoveredAgent,
} from "../lib/agent-setup-flow.ts";

const CHAT = {
  platformAgentId: "chat_1",
  name: "Chat support",
  modality: "chat" as const,
  connectionCandidates: [
    {
      agentPlatform: "retell" as const,
      connectionType: "retell_chat_api" as const,
      accessVariant: "retell_chat_api.api_key" as const,
      modality: "chat" as const,
      productLabel: "Retell chat",
      config: { retellAgentId: "chat_1" },
    },
  ],
};

const VOICE = {
  platformAgentId: "voice_1",
  name: "Voice support",
  modality: "voice" as const,
  connectionCandidates: [
    {
      agentPlatform: "retell" as const,
      connectionType: "phone_number" as const,
      accessVariant: "phone_number.public_e164" as const,
      modality: "voice" as const,
      productLabel: "Retell phone",
      config: { phoneNumber: "+14155550100" },
    },
    {
      agentPlatform: "retell" as const,
      connectionType: "phone_number" as const,
      accessVariant: "phone_number.public_e164" as const,
      modality: "voice" as const,
      productLabel: "Retell phone",
      config: { phoneNumber: "+14155550101" },
    },
  ],
};

const UNROUTED_VOICE = {
  platformAgentId: "voice_2",
  name: "Voice without a number",
  modality: "voice" as const,
  connectionCandidates: [],
};

/** A voice agent as discovery now describes one: text mode chat door, the
 * web call, and one routed number — the choice the modality question spans. */
const VOICE_WITH_ROUTES: RetellDiscoveredAgent = {
  platformAgentId: "voice_3",
  name: "Front desk",
  modality: "voice" as const,
  connectionCandidates: [
    {
      agentPlatform: "retell" as const,
      connectionType: "retell_text_mode" as const,
      accessVariant: "retell_text_mode.api_key" as const,
      modality: "chat" as const,
      productLabel: "Retell text mode",
      config: { retellAgentId: "voice_3" },
    },
    {
      agentPlatform: "retell" as const,
      connectionType: "retell_web_call" as const,
      accessVariant: "retell_web_call.api_key" as const,
      modality: "voice" as const,
      productLabel: "Retell web call",
      config: { retellAgentId: "voice_3" },
    },
    {
      agentPlatform: "retell" as const,
      connectionType: "phone_number" as const,
      accessVariant: "phone_number.public_e164" as const,
      modality: "voice" as const,
      productLabel: "Retell phone",
      config: { phoneNumber: "+14155550109" },
    },
  ],
};

describe("the goal-first agent setup plan", () => {
  it("keeps provider work honest for all six goal and platform pairs", () => {
    expect(agentSetupPlan("simulation", "retell")).toMatchObject({
      mayWriteConnection: true,
      pullWithConnection: false,
      asksHowToTest: true,
    });
    // Monitoring and Both need the voice connection for production pull, so
    // they skip the one question exactly as they do today.
    expect(agentSetupPlan("monitoring", "retell")).toMatchObject({
      mayWriteConnection: true,
      pullWithConnection: true,
      asksHowToTest: false,
    });
    expect(agentSetupPlan("both", "retell")).toMatchObject({
      mayWriteConnection: true,
      pullWithConnection: true,
      asksHowToTest: false,
    });
    expect(agentSetupPlan("simulation", "livekit")).toMatchObject({
      mayWriteConnection: true,
      monitoringInstructions: false,
    });
    expect(agentSetupPlan("monitoring", "livekit")).toMatchObject({
      mayWriteConnection: false,
      monitoringInstructions: true,
    });
    expect(agentSetupPlan("both", "livekit")).toMatchObject({
      mayWriteConnection: true,
      monitoringInstructions: true,
    });
  });

  it("keeps every voice agent visible, including one with no routed number", () => {
    const plan = agentSetupPlan("simulation", "retell");

    expect(retellAgentsForPlan(plan, [VOICE, UNROUTED_VOICE])).toEqual([
      VOICE,
      UNROUTED_VOICE,
    ]);
  });

  it("lets simulations use non-phone routes but requires a phone for production pull", () => {
    const withoutPhone = {
      ...VOICE_WITH_ROUTES,
      connectionCandidates: VOICE_WITH_ROUTES.connectionCandidates.filter(
        (candidate) => candidate.connectionType !== "phone_number",
      ),
    };

    expect(
      retellAgentCanEnterPlan(
        agentSetupPlan("simulation", "retell"),
        withoutPhone,
      ),
    ).toBe(true);
    expect(
      retellAgentCanEnterPlan(
        agentSetupPlan("monitoring", "retell"),
        withoutPhone,
      ),
    ).toBe(false);
    expect(
      retellAgentCanEnterPlan(agentSetupPlan("both", "retell"), withoutPhone),
    ).toBe(false);
    expect(
      retellAgentCanEnterPlan(agentSetupPlan("monitoring", "retell"), VOICE),
    ).toBe(true);
  });

  it("never offers a chat-native Retell agent, because Egma registers voice agents", () => {
    // Egma registers Retell **voice** agents only. A chat-native agent is not
    // a thing any lane reaches, so it is never in the picker.
    const simulation = agentSetupPlan("simulation", "retell");
    const both = agentSetupPlan("both", "retell");

    expect(retellAgentsForPlan(simulation, [CHAT, VOICE])).toEqual([VOICE]);
    expect(retellAgentsForPlan(both, [CHAT, VOICE])).toEqual([VOICE]);
    expect(retellCandidateValue(VOICE.connectionCandidates[0]!)).toBe(
      "phone:+14155550100",
    );
  });

  it("gives the one question three lanes, each with its own help line", () => {
    expect(RETELL_LANE_QUESTION).toBe("How should Egma test this agent?");
    expect(RETELL_LANES).toEqual(["text", "web-call", "phone"]);
    expect(RETELL_LANES.map((lane) => RETELL_LANE_LABELS[lane])).toEqual([
      "Text",
      "Web call",
      "Phone call",
    ]);
    // One line each, and each says what the lane tests rather than what it is
    // made of.
    for (const lane of RETELL_LANES) {
      expect(RETELL_LANE_HELP[lane].length).toBeGreaterThan(0);
    }
    expect(RETELL_LANE_HELP.text).toContain("seconds");
    expect(RETELL_LANE_HELP["web-call"]).toContain("over the internet");
    expect(RETELL_LANE_HELP.phone).toContain("real tools");
  });

  it("saves the picked lanes in reading order, whatever order they were ticked", () => {
    // Two people ticking the same three boxes in different orders must write
    // the same three connections in the same order.
    expect(retellLanesInOrder(["phone", "text"])).toEqual(["text", "phone"]);
    expect(retellLanesInOrder(["web-call", "text", "phone"])).toEqual([
      "text",
      "web-call",
      "phone",
    ]);
    expect(retellLanesInOrder([])).toEqual([]);
  });

  it("maps every lane to the one candidate that saves it", () => {
    const routes = retellCandidatesForPlan(
      agentSetupPlan("simulation", "retell"),
      VOICE_WITH_ROUTES,
    );
    // Every route discovery answered with is available: the lanes decide which
    // ones are saved, not a modality filter.
    expect(routes.map((one) => one.connectionType)).toEqual([
      "retell_text_mode",
      "retell_web_call",
      "phone_number",
    ]);

    expect(retellCandidateForLane(routes, "text")?.connectionType).toBe(
      "retell_text_mode",
    );
    expect(retellCandidateForLane(routes, "web-call")?.connectionType).toBe(
      "retell_web_call",
    );
    expect(retellCandidateForLane(routes, "phone")?.connectionType).toBe(
      "phone_number",
    );
    // The phone lane is the one that needs saying which, because a voice agent
    // can have several routed numbers.
    expect(
      retellCandidateForLane(
        VOICE.connectionCandidates,
        "phone",
        "phone:+14155550101",
      )?.config.phoneNumber,
    ).toBe("+14155550101");
  });

  it("asks for a phone number only when the phone lane is picked", () => {
    // A developer who picked only Text is never asked for a phone number.
    expect(stepAfterRetellLanes(["text"])).toBeNull();
    expect(stepAfterRetellLanes(["web-call"])).toBeNull();
    expect(stepAfterRetellLanes(["text", "web-call"])).toBeNull();
    expect(stepAfterRetellLanes(["phone"])).toBe("retell-phone");
    expect(stepAfterRetellLanes(["text", "web-call", "phone"])).toBe(
      "retell-phone",
    );
  });

  it("defines the approved screen graph without putting screen order in provider payloads", () => {
    expect(stepAfterPlatform("simulation", "retell")).toBe("retell-key");
    expect(stepAfterPlatform("monitoring", "retell")).toBe("retell-key");
    expect(stepAfterPlatform("simulation", "livekit")).toBe(
      "livekit-language",
    );
    expect(stepAfterPlatform("both", "livekit")).toBe(
      "livekit-monitoring",
    );
    expect(stepAfterPlatform("monitoring", "livekit")).toBe(
      "livekit-monitoring",
    );
    // The one question leads for a simulation. Monitoring and Both go straight
    // to the number chooser, which is the connection production pull needs —
    // so a monitoring-goal web user never sees the test question.
    expect(stepAfterRetellAgent(agentSetupPlan("simulation", "retell"))).toBe(
      "retell-lanes",
    );
    expect(stepAfterRetellAgent(agentSetupPlan("monitoring", "retell"))).toBe(
      "retell-phone",
    );
    expect(stepAfterRetellAgent(agentSetupPlan("both", "retell"))).toBe(
      "retell-phone",
    );

    expect(previousAgentSetupStep({ step: "platform", goal: "both" })).toBe(
      "goal",
    );
    expect(
      previousAgentSetupStep({ step: "retell-agent", goal: "both" }),
    ).toBe("retell-key");
    // The one question goes back to the agent picker.
    expect(
      previousAgentSetupStep({ step: "retell-lanes", goal: "simulation" }),
    ).toBe("retell-agent");
    // The phone step goes back to the one question for a simulation, and to
    // the agent picker for the goals that skip it.
    expect(
      previousAgentSetupStep({ step: "retell-phone", goal: "simulation" }),
    ).toBe("retell-lanes");
    expect(
      previousAgentSetupStep({ step: "retell-phone", goal: "both" }),
    ).toBe("retell-agent");
    expect(
      previousAgentSetupStep({ step: "livekit-monitoring", goal: "both" }),
    ).toBe("platform");
    expect(
      previousAgentSetupStep({
        step: "livekit-monitoring",
        goal: "monitoring",
      }),
    ).toBe("platform");
  });

  /**
   * Language is known before any LiveKit simulation connection is written.
   * Both asks on Monitoring first, so one language choice drives the matching
   * monitoring and simulation source contracts.
   */
  it("captures the LiveKit language before simulation and never crosses a saved connection on Back", () => {
    const simulation = agentSetupPlan("simulation", "livekit");
    const both = agentSetupPlan("both", "livekit");

    expect(stepAfterLiveKitCredentials(simulation)).toBe("livekit-testing");
    expect(stepAfterLiveKitCredentials(both)).toBe("livekit-testing");
    expect(stepAfterLiveKitTesting(simulation)).toBeNull();
    expect(stepAfterLiveKitTesting(both)).toBeNull();

    expect(
      previousAgentSetupStep({ step: "livekit-modality", goal: "simulation" }),
    ).toBe("livekit-language");
    expect(
      previousAgentSetupStep({ step: "livekit-language", goal: "simulation" }),
    ).toBe("platform");
    expect(
      previousAgentSetupStep({ step: "livekit-modality", goal: "both" }),
    ).toBe("livekit-monitoring");
    expect(
      previousAgentSetupStep({ step: "livekit-simulation", goal: "simulation" }),
    ).toBe("livekit-modality");
    expect(
      previousAgentSetupStep({ step: "livekit-testing", goal: "both" }),
    ).toBeNull();
    expect(
      previousAgentSetupStep({
        step: "livekit-monitoring",
        goal: "both",
      }),
    ).toBe("platform");
  });
});
