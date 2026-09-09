import { describe, expect, it } from "vitest";

import {
  assertPublicEvidence,
  assertValidGrade,
  namedTunnelSettings,
} from "./support/simulation-proof.ts";

function grade(result: "passed" | "failed" | "errored", score: number | null) {
  return {
    result,
    score,
    graderPassThreshold: 0.7,
    details: {},
  } as const;
}

describe("full-path grade proof", () => {
  it.each([
    ["passed", 0.8],
    ["failed", 0.6],
  ] as const)("accepts one valid %s grade stored and returned publicly", (result, score) => {
    expect(assertValidGrade(grade(result, score), {
      grades: [{ result, score, passThreshold: 0.7 }],
    })).toEqual({ result, score });
  });

  it("rejects an errored grader", () => {
    expect(() => assertValidGrade(grade("errored", null), {
      grades: [{ result: "errored", score: null, passThreshold: 0.7 }],
    })).toThrow();
  });

  it("rejects a result that disagrees with its frozen threshold", () => {
    expect(() => assertValidGrade(grade("passed", 0.6), {
      grades: [{ result: "passed", score: 0.6, passThreshold: 0.7 }],
    })).toThrow();
  });
});

describe("full-path transcript proof", () => {
  it("compares transcript excerpts with whitespace normalized", () => {
    expect(() => assertPublicEvidence({
      status: "completed",
      gradingState: "complete",
      hasRecording: false,
      transcript: { turns: [
        { spanId: "human", kind: "turn:human", text: "Tuesday please", pov: "persona", startedAt: "2026-01-01T00:00:00Z" },
        { spanId: "agent", kind: "turn:agent", text: "The slot is\n11:20 AM", pov: "persona", startedAt: "2026-01-01T00:00:01Z" },
      ] },
    }, {
      pov: "persona",
      humanIncludes: "tuesday please",
      agentIncludes: "the slot is 11:20 am",
      tools: [],
      recording: false,
    })).not.toThrow();
  });
});

describe("named simulation tunnel settings", () => {
  it("uses a complete HTTPS named-tunnel configuration", () => {
    expect(namedTunnelSettings({
      SIMULATION_E2E_TUNNEL_ID: "tunnel-id",
      SIMULATION_E2E_TUNNEL_URL: "https://retell-local.example.com",
      SIMULATION_E2E_TUNNEL_CREDENTIALS_FILE: "/private/tunnel.json",
    })).toEqual({
      id: "tunnel-id",
      url: "https://retell-local.example.com",
      credentialsFile: "/private/tunnel.json",
    });
  });

  it("normalizes a trailing slash from the named tunnel origin", () => {
    expect(namedTunnelSettings({
      SIMULATION_E2E_TUNNEL_ID: "tunnel-id",
      SIMULATION_E2E_TUNNEL_URL: "https://retell-local.example.com/",
      SIMULATION_E2E_TUNNEL_CREDENTIALS_FILE: "/private/tunnel.json",
    })?.url).toBe("https://retell-local.example.com");
  });

  it("rejects a partial named-tunnel configuration", () => {
    expect(() => namedTunnelSettings({
      SIMULATION_E2E_TUNNEL_ID: "tunnel-id",
    })).toThrow(/requires SIMULATION_E2E_TUNNEL_ID/u);
  });

  it("rejects credentials in the public tunnel URL", () => {
    expect(() => namedTunnelSettings({
      SIMULATION_E2E_TUNNEL_ID: "tunnel-id",
      SIMULATION_E2E_TUNNEL_URL: "https://user:password@retell-local.example.com",
      SIMULATION_E2E_TUNNEL_CREDENTIALS_FILE: "/private/tunnel.json",
    })).toThrow(/must be an HTTPS origin/u);
  });
});
