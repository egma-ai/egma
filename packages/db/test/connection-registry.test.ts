import { AgentWriteRefusedError } from "@egma/db";
import { describe, expect, it } from "vitest";

import {
  descriptorOf,
  gatedConfig,
  optional,
  validConfig,
  validCredentials,
  validModality,
} from "../src/access/connection-registry.ts";

/**
 * The registry's gates, tested where they are: pure functions over a payload,
 * with no database anywhere near them.
 *
 * The optional-gate machinery is exercised through a made-up type's gate map
 * rather than through whichever real connection type happens to carry an
 * optional key today. What is under test is the rule — absence admitted,
 * presence still checked, demanded keys still demanded — and a test written
 * against one type's shape would start measuring that type instead the moment
 * its config changed.
 *
 * The real types are here too, and only for the thing a made-up map cannot
 * say: that giving the machinery an optional case did not quietly relax the
 * types that had none.
 */

/**
 * The test's own gate: loud about what it will take, and it changes the value
 * it is given, so a stored value proves the gate actually ran rather than that
 * the payload was copied past it.
 */
function shouted(key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentWriteRefusedError(
      "not_admitted",
      `the config's ${key} must be a non-empty string`,
    );
  }
  return value.trim().toUpperCase();
}

/** One demanded key and one optional one, which is the whole of the rule. */
const GATES = { room: shouted, nickname: optional(shouted) };

/** What the gates are asked about, in the wording a real refusal carries. */
const WHAT = "a made-up connection";

describe("a config gate marked optional", () => {
  it("admits a config that leaves the key out entirely", () => {
    expect(gatedConfig(WHAT, GATES, { room: "lobby" })).toEqual({
      room: "LOBBY",
    });
  });

  it("gates the key exactly as a demanded one when it is there", () => {
    expect(gatedConfig(WHAT, GATES, { room: "lobby", nickname: "front" })).toEqual(
      { room: "LOBBY", nickname: "FRONT" },
    );

    expect(() => gatedConfig(WHAT, GATES, { room: "lobby", nickname: "  " })).toThrow(
      /nickname must be a non-empty string/,
    );
  });

  it("leaves a demanded key demanded, named in the refusal", () => {
    expect(() => gatedConfig(WHAT, GATES, { nickname: "front" })).toThrow(
      "a made-up connection's config needs room",
    );
  });

  it("names an unknown key, and says which of its own are optional", () => {
    expect(() => gatedConfig(WHAT, GATES, { room: "lobby", nickname_: "x" })).toThrow(
      'a made-up connection\'s config has no key "nickname_"; it holds room, ' +
        "nickname (optional)",
    );
  });

  it("refuses a config that is not an object at all, holding the same list", () => {
    for (const notAnObject of [undefined, null, "room=lobby", ["lobby"]]) {
      expect(() => gatedConfig(WHAT, GATES, notAnObject)).toThrow(
        "a made-up connection's config is an object holding room, nickname (optional)",
      );
    }
  });

  /**
   * A key inherited from the object prototype is not a key the registry holds,
   * and it must be refused by name like any other typo — never quietly
   * dropped, which is what an unowned key would be.
   */
  it("refuses a key that only the object prototype has heard of", () => {
    expect(() => gatedConfig(WHAT, GATES, { room: "lobby", constructor: "x" })).toThrow(
      /has no key "constructor"/,
    );
  });
});

describe("the types that carry no optional key", () => {
  it("still demand every key they hold, retell's and phone's alike", () => {
    expect(() => validConfig("retell", {})).toThrow(
      "a retell connection's config needs retellAgentId",
    );
    expect(() => validConfig("phone", {})).toThrow(
      "a phone connection's config needs phoneNumber",
    );
  });

  it("still list their keys without an optional marker anywhere", () => {
    expect(() => validConfig("retell", { retellAgentld: "typo" })).toThrow(
      'a retell connection\'s config has no key "retellAgentld"; it holds retellAgentId',
    );
  });

  it("still answer the stored config for a payload they take", () => {
    expect(validConfig("retell", { retellAgentId: "  agent_abc  " })).toEqual({
      retellAgentId: "agent_abc",
    });
    expect(validConfig("phone", { phoneNumber: "+15551234567" })).toEqual({
      phoneNumber: "+15551234567",
    });
  });
});

describe("what a livekit connection is made of", () => {
  it("speaks voice, dials out, and takes two credential fields", () => {
    const descriptor = descriptorOf("livekit");

    expect(descriptor.modalities).toEqual(["voice"]);
    // Derived from the type: a livekit agent joins the room egma opened, so
    // egma never has to reach a laptop.
    expect(descriptor.topology).toBe("agent-dials-out");
    expect(descriptor.credentials).toMatchObject({
      required: true,
      fields: ["apiKey", "apiSecret"],
      hintField: "apiKey",
    });
  });

  it("has no reuse rule: nothing in the config names one agent", () => {
    expect(descriptorOf("livekit").reuseKey).toBeUndefined();
  });
});

describe("a livekit connection's url", () => {
  it("takes ws, wss, http and https alike, stored as it was written", () => {
    for (const url of [
      "wss://acme.livekit.cloud",
      "ws://127.0.0.1:7880",
      "https://acme.livekit.cloud",
      "http://localhost:7880",
    ]) {
      expect(validConfig("livekit", { url })).toEqual({ url });
    }
  });

  it("is stored trimmed, so a padded paste still reaches the server", () => {
    expect(validConfig("livekit", { url: "  wss://acme.livekit.cloud  " })).toEqual(
      { url: "wss://acme.livekit.cloud" },
    );
  });

  it("refuses anything that is not one of those four, naming the key", () => {
    for (const url of [
      "sip:acme.livekit.cloud",
      "acme.livekit.cloud",
      // Parses, because a special scheme takes the rest as a host — and then
      // reaches nothing, so it dies here rather than at dial time.
      "wss:acme.livekit.cloud",
      "wss://",
      "",
      42,
    ]) {
      expect(() => validConfig("livekit", { url })).toThrow(/config's url/);
    }
  });

  it("is demanded: a livekit connection with no url is refused by name", () => {
    expect(() => validConfig("livekit", {})).toThrow(
      "a livekit connection's config needs url",
    );
  });
});

describe("a livekit connection's agent name", () => {
  /**
   * Absent is not a gap to be filled in later — it is the setting every
   * quickstart agent on a laptop runs under, where LiveKit dispatches whoever
   * is listening rather than a named worker.
   */
  it("may be left out, which is what automatic dispatch is", () => {
    expect(validConfig("livekit", { url: "wss://acme.livekit.cloud" })).toEqual({
      url: "wss://acme.livekit.cloud",
    });
  });

  it("is still gated when it is there", () => {
    expect(
      validConfig("livekit", {
        url: "wss://acme.livekit.cloud",
        agentName: "  front-desk  ",
      }),
    ).toEqual({ url: "wss://acme.livekit.cloud", agentName: "front-desk" });

    expect(() =>
      validConfig("livekit", {
        url: "wss://acme.livekit.cloud",
        agentName: "   ",
      }),
    ).toThrow("the config's agentName must be a non-empty string");
  });
});

describe("a livekit connection's metadata", () => {
  /**
   * It rides to the agent verbatim as the room's metadata, so a typo has to
   * die here. Refused at create, a person is looking at the mistake; refused
   * at dispatch, a run has already started and the agent is the one confused.
   */
  it("may be left out, and is kept exactly as written when it is there", () => {
    const url = "wss://acme.livekit.cloud";
    expect(validConfig("livekit", { url })).toEqual({ url });
    expect(
      validConfig("livekit", { url, metadata: '{"tenant":"acme","tier":2}' }),
    ).toEqual({ url, metadata: '{"tenant":"acme","tier":2}' });
  });

  it("refuses anything that is not a JSON object in a string", () => {
    const url = "wss://acme.livekit.cloud";
    for (const metadata of [
      "tenant=acme",
      '{"tenant":"acme"',
      "[1,2,3]",
      '"acme"',
      "null",
      "7",
      { tenant: "acme" },
      "",
    ]) {
      expect(() => validConfig("livekit", { url, metadata })).toThrow(
        /config's metadata/,
      );
    }
  });
});

describe("a livekit connection's modality", () => {
  it("takes voice, and refuses chat by naming what it speaks", () => {
    expect(validModality("livekit", "voice")).toBe("voice");
    expect(() => validModality("livekit", "chat")).toThrow(
      "a livekit connection speaks voice, and this one was asked for chat",
    );
  });

  it("refuses a word that is not a modality at all as exactly that", () => {
    expect(() => validModality("livekit", "telepathy")).toThrow(
      '"telepathy" is not a modality; a livekit connection speaks voice',
    );
  });
});

describe("a livekit connection's credentials", () => {
  const KEYS = { apiKey: "APIhx4bmvHnLcWXYZ", apiSecret: "livekit-secret-9f2c1d" };

  it("seal both fields, and the hint is the last four of the key", () => {
    expect(validCredentials("livekit", KEYS)).toEqual({
      sealed: KEYS,
      hint: "WXYZ",
    });
  });

  it("refuses a pair with either half missing, naming the shape", () => {
    expect(() => validCredentials("livekit", undefined)).toThrow(
      "a livekit connection needs credentials shaped { apiKey, apiSecret }",
    );
    expect(() => validCredentials("livekit", { apiKey: KEYS.apiKey })).toThrow(
      "a livekit connection's credentials need apiSecret to be a non-empty string",
    );
    expect(() =>
      validCredentials("livekit", { apiSecret: KEYS.apiSecret }),
    ).toThrow(
      "a livekit connection's credentials need apiKey to be a non-empty string",
    );
  });

  it("refuses a key that does not belong, naming it and the shape", () => {
    expect(() =>
      validCredentials("livekit", { ...KEYS, apiToken: "extra" }),
    ).toThrow(
      'a livekit connection\'s credentials have no key "apiToken"; they are ' +
        "shaped { apiKey, apiSecret }",
    );
  });

  it("refuses either half so short its last-4 hint would give it away", () => {
    expect(() =>
      validCredentials("livekit", { ...KEYS, apiSecret: "abcd" }),
    ).toThrow(
      "a livekit connection's credentials need apiSecret to be at least 8 characters",
    );
  });
});
