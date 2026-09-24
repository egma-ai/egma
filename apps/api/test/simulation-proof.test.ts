import { describe, expect, it } from "vitest";

import { safeSimulationDiagnostic } from "./support/simulation-proof.ts";

describe("safe simulation diagnostics", () => {
  it("records lifecycle facts and POV counts without sensitive evidence", () => {
    const diagnostic = safeSimulationDiagnostic({
      id: "sim_participant-id",
      status: "failed",
      reason: "simulator_error",
      executionFailure: "The agent session stopped before completion.",
      agentPovComplete: false,
      hasRecording: true,
      providerReference: "provider-payload-id",
      participantId: "participant-id",
      transcript: {
        turns: [
          { pov: "agent", text: "secret agent transcript" },
          { pov: "agent", text: "more secret transcript" },
          { pov: "persona", text: "secret persona transcript" },
          { pov: "participant-id", text: "provider payload" },
        ],
        spans: [{ payload: { apiKey: "secret-key" } }],
      },
    });

    expect(diagnostic).toEqual({
      status: "failed",
      reason: "simulator_error",
      executionFailure: "The agent session stopped before completion.",
      transcriptTurnCounts: { agent: 2, persona: 1 },
      agentPovComplete: false,
      hasRecording: true,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /secret|participant-id|provider-payload/u,
    );
  });
});
