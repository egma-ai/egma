import { describe, expect, it } from "vitest";

import {
  connectionIsConductable,
  descriptorOf,
  validConfig,
  validCredentials,
  validModality,
} from "../src/access/connection-registry.ts";

/**
 * Text mode door, by refusal table.
 *
 * Pure functions over a payload, with no database anywhere near them: what is
 * under test is what a person is told when they get it wrong, and what a
 * browser is handed when they get it right.
 */

const KIND = "retell_text_mode";
const VARIANT = "retell_text_mode.api_key";
const AGENT = "agent_b0e2e9cb267c47e7e7026cd8e8";
const A_KEY = "key_e2e9cb267c47e7e7026cd8e8";

describe("text mode door's refusals", () => {
  it("takes the agent id on its own, which is the ordinary case", () => {
    expect(validConfig(KIND, VARIANT, { retellAgentId: AGENT })).toEqual({
      retellAgentId: AGENT,
    });
  });

  it("refuses a stored baseUrl, which would redirect the sealed key", () => {
    // **Where Retell answers is not a stored config key on this door.** Egma's
    // own control plane sends this connection's sealed Retell key to that
    // address at run start, so a customer-writable one would aim a key the
    // writer cannot read at a host the writer chose — a read of a write-only
    // secret by another name, and a DNS-rebinding surface with it. A test that
    // needs to converse with a Retell-shaped server on loopback uses the
    // plug's own seam, exactly as `retell_text_mode` does, and nothing persists
    // it.
    expect(() =>
      validConfig(KIND, VARIANT, {
        retellAgentId: AGENT,
        baseUrl: "https://retell-proxy.acme.example/",
      }),
    ).toThrow('a Retell text mode connection\'s config has no key "baseUrl"');
  });

  it("demands the agent id by name when it is missing", () => {
    expect(() => validConfig(KIND, VARIANT, {})).toThrow(
      "a Retell text mode connection's config needs retellAgentId",
    );
  });

  it("refuses voice by naming what it does speak", () => {
    expect(() => validModality(KIND, VARIANT, "voice")).toThrow(
      "a retell_text_mode connection speaks chat, and this one was asked for voice",
    );
  });

  it("seals the API key and hints at its last four characters", () => {
    const sealed = validCredentials(KIND, VARIANT, { apiKey: A_KEY });
    expect(sealed?.sealed).toEqual({ apiKey: A_KEY });
    expect(sealed?.hint).toBe(A_KEY.slice(-4));
  });

  it("demands a credential, because there is no other way in", () => {
    expect(() => validCredentials(KIND, VARIANT, undefined)).toThrow(
      "a Retell text mode connection needs credentials shaped { apiKey }",
    );
  });

  it("never quotes the key back in a refusal about it", () => {
    const refused = (() => {
      try {
        validCredentials(KIND, VARIANT, { apiKey: "short" });
        return "";
      } catch (error) {
        return String(error);
      }
    })();
    expect(refused).toMatch(/at least 8 characters/u);
    expect(refused).not.toContain("short");
  });
});

describe("what the shipped simulator can conduct over text mode", () => {
  it("conducts it, because the plug ships", () => {
    // The registry may not claim what no code can run, and it does not: the
    // `retell_text_mode` plug is registered in `egma_simulator.plugs`, and
    // this said so in the same change that brought it.
    expect(descriptorOf(KIND).simulatorAdapter).toBe(true);
    expect(connectionIsConductable(KIND, VARIANT, "chat")).toBe(true);
  });

  it("still checks the exact tuple, not just the kind", () => {
    // A shipped adapter is not a licence to conduct anything wearing the name.
    expect(connectionIsConductable(KIND, VARIANT, "voice")).toBe(false);
    expect(
      connectionIsConductable(KIND, "retell_web_call.api_key", "chat"),
    ).toBe(false);
  });
});
