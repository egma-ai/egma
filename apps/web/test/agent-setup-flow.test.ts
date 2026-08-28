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

  it("defines the approved screen graph without putting screen order in provider payloads", () => {
    expect(stepAfterPlatform("simulation", "retell")).toBe("retell-key");
    expect(stepAfterPlatform("monitoring", "retell")).toBe("retell-key");
    expect(stepAfterPlatform("simulation", "livekit")).toBe("livekit-modality");
    expect(stepAfterPlatform("both", "livekit")).toBe("livekit-modality");
    expect(stepAfterPlatform("monitoring", "livekit")).toBe(
      "livekit-monitoring",
    );
    expect(stepAfterRetellAgent("chat")).toBe("retell-chat");
    expect(stepAfterRetellAgent("voice")).toBe("retell-phone");

    expect(previousAgentSetupStep({ step: "platform", goal: "both" })).toBe(
      "goal",
    );
    expect(
      previousAgentSetupStep({ step: "retell-agent", goal: "both" }),
    ).toBe("retell-key");
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
