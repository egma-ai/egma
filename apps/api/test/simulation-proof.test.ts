import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  assertPublicEvidence,
  assertValidGrade,
  namedTunnelSettings,
  safeSimulationDiagnostic,
  startPublicTunnel,
  stopChild,
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

  it("selects distinct named tunnels by configuration prefix", () => {
    const env = {
      SIMULATION_E2E_TUNNEL_TEXT_ID: "text-tunnel-id",
      SIMULATION_E2E_TUNNEL_TEXT_URL: "https://livekit.example.com",
      SIMULATION_E2E_TUNNEL_TEXT_CREDENTIALS_FILE: "/private/text-tunnel.json",
      SIMULATION_E2E_TUNNEL_WEB_ID: "web-tunnel-id",
      SIMULATION_E2E_TUNNEL_WEB_URL: "https://tokens.example.com",
      SIMULATION_E2E_TUNNEL_WEB_CREDENTIALS_FILE: "/private/web-tunnel.json",
    };

    expect(namedTunnelSettings(env, "TEXT")).toEqual({
      id: "text-tunnel-id",
      url: "https://livekit.example.com",
      credentialsFile: "/private/text-tunnel.json",
    });
    expect(namedTunnelSettings(env, "WEB")).toEqual({
      id: "web-tunnel-id",
      url: "https://tokens.example.com",
      credentialsFile: "/private/web-tunnel.json",
    });
  });

  it("rejects a partial prefixed configuration without using another tunnel", () => {
    expect(() => namedTunnelSettings({
      SIMULATION_E2E_TUNNEL_ID: "generic-tunnel-id",
      SIMULATION_E2E_TUNNEL_URL: "https://generic.example.com",
      SIMULATION_E2E_TUNNEL_CREDENTIALS_FILE: "/private/generic-tunnel.json",
      SIMULATION_E2E_TUNNEL_TEXT_ID: "text-tunnel-id",
      SIMULATION_E2E_TUNNEL_WEB_ID: "web-tunnel-id",
      SIMULATION_E2E_TUNNEL_WEB_URL: "https://tokens.example.com",
      SIMULATION_E2E_TUNNEL_WEB_CREDENTIALS_FILE: "/private/web-tunnel.json",
    }, "TEXT")).toThrow(/requires SIMULATION_E2E_TUNNEL_TEXT_ID/u);
  });
});

describe("public tunnel startup", () => {
  it("starts a fresh quick tunnel after two allocation timeouts", async () => {
    let attempts = 0;
    const launch = vi.fn(() => {
      attempts += 1;
      const script = attempts < 3
        ? 'process.stderr.write(\'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded (Client.Timeout exceeded while awaiting headers)\\n\'); process.on("exit", () => process.stderr.write("late diagnostic before stdio close\\n")); process.exitCode = 1'
        : 'process.stderr.write("Your quick Tunnel has been created!\\nhttps://fixture-third.trycloudflare.com\\n"); setInterval(() => {}, 1_000)';
      return spawn(process.execPath, ["-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    });
    const tunnel = await startPublicTunnel("http://127.0.0.1:3100", {
      configurationPrefix: "TEXT",
      env: {},
      launch,
      pause: async () => new Promise((resolve) => setTimeout(resolve, 5)),
    });
    try {
      expect(tunnel.url).toBe("https://fixture-third.trycloudflare.com");
      expect(launch).toHaveBeenCalledTimes(3);
      expect(tunnel.output()).toContain("quick tunnel attempt 1 exited with 1");
      expect(tunnel.output()).toContain("Client.Timeout exceeded while awaiting headers");
      expect(tunnel.output().match(/late diagnostic before stdio close/gu)).toHaveLength(2);
    } finally {
      await stopChild(tunnel.process);
    }
  });

  it("does not launch another quick tunnel after the shared deadline", async () => {
    let now = 0;
    let childClosed = false;
    const launch = vi.fn(() => {
      const child = spawn(process.execPath, ["-e", "process.exit(1)"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.once("close", () => {
        childClosed = true;
        now = 59_900;
      });
      return child;
    });
    const pauses: number[] = [];

    await expect(startPublicTunnel("http://127.0.0.1:3100", {
      env: {},
      launch,
      now: () => now,
      pause: async (milliseconds) => {
        pauses.push(milliseconds);
        if (childClosed) {
          now += milliseconds;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    })).rejects.toThrow(/did not publish a URL within 60s/u);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(pauses.at(-1)).toBe(100);
    expect(now).toBe(60_000);
  });

  it("does not retry a named tunnel that exits", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(1)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launch = vi.fn(() => child);
    const tunnel = await startPublicTunnel("http://127.0.0.1:3100", {
      env: {
        SIMULATION_E2E_TUNNEL_ID: "tunnel-id",
        SIMULATION_E2E_TUNNEL_URL: "https://retell-local.example.com",
        SIMULATION_E2E_TUNNEL_CREDENTIALS_FILE: "/private/tunnel.json",
      },
      launch,
    });
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    expect(tunnel.process.exitCode).toBe(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
