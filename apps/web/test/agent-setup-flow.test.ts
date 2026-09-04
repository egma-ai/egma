import { describe, expect, it } from "vitest";

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
      pullWithoutConnection: false,
      asksHowToTest: true,
    });
    // Monitoring saves nothing but the pull switch — no route and no phone
    // number — so it skips the one question and every connection write.
    expect(agentSetupPlan("monitoring", "retell")).toMatchObject({
      mayWriteConnection: false,
      pullWithConnection: false,
      pullWithoutConnection: true,
      asksHowToTest: false,
    });
    // Both saves the phone lane for simulation and starts pulling on that
    // same save, so it skips the question and keeps the number chooser.
    expect(agentSetupPlan("both", "retell")).toMatchObject({
      mayWriteConnection: true,
      pullWithConnection: true,
      pullWithoutConnection: false,
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
    expect(
      retellAgentsForPlan(agentSetupPlan("simulation", "retell"), [
        VOICE,
        UNROUTED_VOICE,
      ]),
    ).toEqual([VOICE, UNROUTED_VOICE]);
    // Monitoring writes no connection, and its picker still lists every
    // voice agent: the pull switch is what it is there to flip.
    expect(
      retellAgentsForPlan(agentSetupPlan("monitoring", "retell"), [
        VOICE,
        UNROUTED_VOICE,
      ]),
    ).toEqual([VOICE, UNROUTED_VOICE]);
  });

  it("requires a phone only for Both, which saves the lane — never for Monitoring", () => {
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
    // Pull selects calls by platform agent id, so a monitoring-only plan
    // takes a voice agent with no routed number as it takes any other.
    expect(
      retellAgentCanEnterPlan(
        agentSetupPlan("monitoring", "retell"),
        withoutPhone,
      ),
    ).toBe(true);
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

  it("says nothing about mocking, because mock tools belong to the test", () => {
    // What a lane does with a test's mock tools is a fact about a run, said by
    // the run note where a run is started. A lane's help line answering it
    // would be answering a question this flow no longer asks.
    for (const lane of RETELL_LANES) {
      expect(RETELL_LANE_HELP[lane]).not.toContain("mock");
    }
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
    // A developer who picked Text is never asked for a phone number nothing
    // will dial; the two lanes that save here have nothing left to ask.
    expect(stepAfterRetellLanes("text")).toBeNull();
    expect(stepAfterRetellLanes("web-call")).toBeNull();
    expect(stepAfterRetellLanes("phone")).toBe("retell-phone");
  });

  it("defines the approved screen graph without putting screen order in provider payloads", () => {
    expect(stepAfterPlatform("simulation", "retell")).toBe("retell-key");
    expect(stepAfterPlatform("monitoring", "retell")).toBe("retell-key");
    expect(stepAfterPlatform("simulation", "livekit")).toBe(
      "livekit-modality",
    );
    expect(stepAfterPlatform("both", "livekit")).toBe(
      "livekit-monitoring",
    );
    expect(stepAfterPlatform("monitoring", "livekit")).toBe(
      "livekit-monitoring",
    );
    // The one question leads for a simulation. Both goes straight to the
    // number chooser its phone lane needs. Monitoring finishes on the agent
    // choice itself: the pull switch needs no provider route, so there is
    // nothing after the pick but the switch.
    expect(stepAfterRetellAgent(agentSetupPlan("simulation", "retell"))).toBe(
      "retell-lanes",
    );
    expect(
      stepAfterRetellAgent(agentSetupPlan("monitoring", "retell")),
    ).toBeNull();
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
   * A room connection has no worker-language field. Both learns the language
   * on Monitoring; Simulation waits until the source-instruction screen.
   */
  it("keeps language out of the room connection steps and never crosses a saved connection on Back", () => {
    const simulation = agentSetupPlan("simulation", "livekit");
    const both = agentSetupPlan("both", "livekit");

    expect(stepAfterLiveKitCredentials(simulation)).toBe("livekit-testing");
    expect(stepAfterLiveKitCredentials(both)).toBe("livekit-testing");
    expect(stepAfterLiveKitTesting(simulation)).toBeNull();
    expect(stepAfterLiveKitTesting(both)).toBeNull();

    expect(
      previousAgentSetupStep({ step: "livekit-modality", goal: "simulation" }),
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
