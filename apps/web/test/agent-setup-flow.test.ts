import { describe, expect, it } from "vitest";

import {
  agentSetupPlan,
  previousAgentSetupStep,
  retellCandidateForLane,
  retellCandidatesForPlan,
  stepAfterLiveKitCredentials,
  stepAfterLiveKitTesting,
  type RetellDiscoveredAgent,
} from "../lib/agent-setup-flow.ts";

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
