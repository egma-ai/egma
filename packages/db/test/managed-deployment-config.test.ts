import { describe, expect, it } from "vitest";

import { managedDeploymentFrom, securely } from "@egma/db";

/**
 * What a deployment is refused for saying, at boot rather than at the first
 * simulation.
 *
 * Two rules, and each exists because the failure it prevents is silent. A
 * hosted deployment with no signing key comes up healthy, puts every new
 * organization on Managed by Egma, and fails every claim — reading downstream
 * as a missing gateway address, which sends an operator to the wrong setting.
 * And a plain-text address for managed traffic puts a credential that
 * authorizes Egma's provider accounts on the wire for anybody on the path.
 */

describe("a hosted deployment", () => {
  it("refuses to start without the key it signs its own credentials with", () => {
    expect(() =>
      managedDeploymentFrom({
        EGMA_HOSTED: "true",
        EGMA_MODEL_GATEWAY_URL: "https://gateway.egma.example",
      }),
    ).toThrow(/EGMA_GATEWAY_INTERNAL_KEY is not set/);
  });

  it("starts when it holds one", () => {
    const deployment = managedDeploymentFrom({
      EGMA_HOSTED: "true",
      EGMA_MODEL_GATEWAY_URL: "https://gateway.egma.example",
      EGMA_GATEWAY_INTERNAL_KEY: "sentinel-signing-A1B2",
    });

    expect(deployment.hosted).toBe(true);
    expect(deployment.gatewayAddress).toBe("https://gateway.egma.example");
  });

  it("is off unless somebody said so plainly, and an empty value is off", () => {
    for (const said of [undefined, "", "false", "no", "0", "maybe"]) {
      const deployment = managedDeploymentFrom(
        said === undefined ? {} : { EGMA_HOSTED: said },
      );
      expect(deployment.hosted, String(said)).toBe(false);
    }
  });

  it("needs no signing key when it is not hosted, which is every self-hoster", () => {
    const deployment = managedDeploymentFrom({
      EGMA_MODEL_GATEWAY_URL: "https://gateway.egma.example",
    });
    expect(deployment.hosted).toBe(false);
    expect(deployment.internalGatewayKey).toBeUndefined();
  });
});

describe("an address managed traffic is sent to", () => {
  it("is https, because it carries a credential for Egma's provider accounts", () => {
    expect(securely("X", "https://gateway.egma.ai")).toBe("https://gateway.egma.ai");
    expect(() => securely("X", "http://gateway.egma.ai")).toThrow(/https address/);
    expect(() => securely("X", "ws://gateway.egma.ai")).toThrow(/https address/);
    expect(() => securely("X", "not-an-address")).toThrow(/absolute address/);
  });

  it("may be http only on loopback, which is what the deterministic suite drives", () => {
    for (const local of [
      "http://127.0.0.1:8787",
      "http://localhost:3000/v1/inference-keys/validation",
      "http://[::1]:8787",
    ]) {
      expect(securely("X", local), local).toBe(local);
    }
    // And a hostname that merely looks local is not.
    expect(() => securely("X", "http://localhost.attacker.example")).toThrow(
      /https address/,
    );
    expect(() => securely("X", "http://127.0.0.1.attacker.example")).toThrow(
      /https address/,
    );
  });

  it("is refused where a deployment names one, rather than at the first claim", () => {
    expect(() =>
      managedDeploymentFrom({ EGMA_MODEL_GATEWAY_URL: "http://gateway.egma.ai" }),
    ).toThrow(/https address/);
  });
});
