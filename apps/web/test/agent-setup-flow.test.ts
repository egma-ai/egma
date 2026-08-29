import { describe, expect, it } from "vitest";

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
      writesConnection: true,
      pullWithConnection: false,
      retellModalities: ["chat", "voice"],
    });
    expect(agentSetupPlan("monitoring", "retell")).toMatchObject({
      writesConnection: true,
      pullWithConnection: true,
      retellModalities: ["chat", "voice"],
    });
    expect(agentSetupPlan("both", "retell")).toMatchObject({
      writesConnection: true,
      pullWithConnection: true,
      retellModalities: ["chat", "voice"],
    });
    expect(agentSetupPlan("simulation", "livekit")).toMatchObject({
      writesConnection: true,
      monitoringInstructions: false,
    });
    expect(agentSetupPlan("monitoring", "livekit")).toMatchObject({
      writesConnection: false,
      monitoringInstructions: true,
    });
    expect(agentSetupPlan("both", "livekit")).toMatchObject({
      writesConnection: true,
      monitoringInstructions: true,
    });
  });

  it("keeps every Retell agent visible even when a voice agent has no routed number", () => {
    const plan = agentSetupPlan("simulation", "retell");

    expect(retellAgentsForPlan(plan, [CHAT, VOICE, UNROUTED_VOICE])).toEqual([
      CHAT,
      VOICE,
      UNROUTED_VOICE,
    ]);
  });

  it("keeps both Retell modalities visible so the selected agent decides the branch", () => {
    const simulation = agentSetupPlan("simulation", "retell");
    const both = agentSetupPlan("both", "retell");

    expect(retellAgentsForPlan(simulation, [CHAT, VOICE])).toEqual([
      CHAT,
      VOICE,
    ]);
    expect(retellAgentsForPlan(both, [CHAT, VOICE])).toEqual([CHAT, VOICE]);
    expect(retellCandidatesForPlan(both, VOICE)).toEqual(
      VOICE.connectionCandidates,
    );
    expect(retellCandidateValue(VOICE.connectionCandidates[0]!)).toBe(
      "phone:+14155550100",
    );
  });

  it("buckets a voice agent's routes so the modality question spans chat and voice", () => {
    const simulation = agentSetupPlan("simulation", "retell");
    const routes = retellCandidatesForPlan(simulation, VOICE_WITH_ROUTES);

    // Every route the plan can save is present: the plan admits both modalities,
    // so text mode rides through beside the two voice ways.
    expect(routes.map((one) => one.connectionType)).toEqual([
      "retell_text_mode",
      "retell_web_call",
      "phone_number",
    ]);
    // The chat door is the one chat route; the voice routes are the rest. This
    // is exactly the split the modality step and the phone step read.
    const chatRoute = routes.find((one) => one.modality === "chat");
    const voiceRoutes = routes.filter((one) => one.modality === "voice");
    expect(chatRoute?.connectionType).toBe("retell_text_mode");
    expect(voiceRoutes.map((one) => one.connectionType)).toEqual([
      "retell_web_call",
      "phone_number",
    ]);
  });

  it("defines the approved screen graph without putting screen order in provider payloads", () => {
    expect(stepAfterPlatform("simulation", "retell")).toBe("retell-key");
    expect(stepAfterPlatform("monitoring", "retell")).toBe("retell-key");
    expect(stepAfterPlatform("simulation", "livekit")).toBe("livekit-modality");
    expect(stepAfterPlatform("both", "livekit")).toBe("livekit-modality");
    expect(stepAfterPlatform("monitoring", "livekit")).toBe(
      "livekit-monitoring",
    );
    // A chat agent has one door. A voice agent is asked the modality question
    // first when the goal is a simulation, and goes straight to the voice route
    // for Monitoring and Both, which need the voice connection for pull.
    expect(stepAfterRetellAgent("chat", "simulation")).toBe("retell-chat");
    expect(stepAfterRetellAgent("chat", "both")).toBe("retell-chat");
    expect(stepAfterRetellAgent("voice", "simulation")).toBe("retell-modality");
    expect(stepAfterRetellAgent("voice", "monitoring")).toBe("retell-phone");
    expect(stepAfterRetellAgent("voice", "both")).toBe("retell-phone");

    expect(previousAgentSetupStep({ step: "platform", goal: "both" })).toBe(
      "goal",
    );
    expect(
      previousAgentSetupStep({ step: "retell-agent", goal: "both" }),
    ).toBe("retell-key");
    // The modality question goes back to the agent picker.
    expect(
      previousAgentSetupStep({ step: "retell-modality", goal: "simulation" }),
    ).toBe("retell-agent");
    // The phone step goes back to the modality question for a simulation, and
    // to the agent picker for the goals that skip it.
    expect(
      previousAgentSetupStep({ step: "retell-phone", goal: "simulation" }),
    ).toBe("retell-modality");
    expect(
      previousAgentSetupStep({ step: "retell-phone", goal: "both" }),
    ).toBe("retell-agent");
    expect(
      previousAgentSetupStep({ step: "livekit-monitoring", goal: "both" }),
    ).toBe("livekit-simulation");
    expect(
      previousAgentSetupStep({
        step: "livekit-monitoring",
        goal: "monitoring",
      }),
    ).toBe("platform");
  });

  /**
   * The modality is the first LiveKit screen, and a chat connection has one
   * more screen after the credentials than a voice one — so Back has to walk a
   * chat Both walk through four screens where a voice one has three.
   */
  it("puts the LiveKit modality question first and walks chat back through its instructions", () => {
    const simulation = agentSetupPlan("simulation", "livekit");
    const both = agentSetupPlan("both", "livekit");

    expect(stepAfterLiveKitCredentials(simulation, "voice")).toBeNull();
    expect(stepAfterLiveKitCredentials(simulation, "chat")).toBe("livekit-chat");
    expect(stepAfterLiveKitCredentials(both, "voice")).toBe("livekit-monitoring");
    expect(stepAfterLiveKitCredentials(both, "chat")).toBe("livekit-chat");
    expect(stepAfterLiveKitChat(simulation)).toBeNull();
    expect(stepAfterLiveKitChat(both)).toBe("livekit-monitoring");

    expect(
      previousAgentSetupStep({ step: "livekit-modality", goal: "simulation" }),
    ).toBe("platform");
    expect(
      previousAgentSetupStep({ step: "livekit-simulation", goal: "simulation" }),
    ).toBe("livekit-modality");
    expect(
      previousAgentSetupStep({ step: "livekit-chat", goal: "both" }),
    ).toBe("livekit-simulation");
    expect(
      previousAgentSetupStep({
        step: "livekit-monitoring",
        goal: "both",
        liveKitModality: "chat",
      }),
    ).toBe("livekit-chat");
    expect(
      previousAgentSetupStep({
        step: "livekit-monitoring",
        goal: "both",
        liveKitModality: "voice",
      }),
    ).toBe("livekit-simulation");
  });
});
