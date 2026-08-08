import { AgentWriteRefusedError } from "@egma/db";
import { describe, expect, it } from "vitest";

import {
  gatedConfig,
  optional,
  validConfig,
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
