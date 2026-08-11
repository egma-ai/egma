import { AgentWriteRefusedError } from "@egma/db";
import { describe, expect, it } from "vitest";

import {
  conductableConnectionTypes,
  descriptorOf,
  gatedConfig,
  noSimulatorAdapterMessage,
  optional,
  shapeChosen,
  shapeOf,
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

/** One livekit connection's two config keys, in each of its two shapes. */
const A_URL = "wss://acme.livekit.cloud";
const AN_ENDPOINT = "https://acme.example/egma/livekit-token";

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

/**
 * The shapes machinery, exercised through made-up shapes for the same reason
 * the optional-gate machinery is: what is under test is the rule — one config
 * key tells the shapes apart, and a config naming none of them lands on the
 * first — and a test written against whichever real type happens to carry two
 * shapes today would start measuring that type instead.
 */
describe("choosing which shape a connection is in", () => {
  const PLAIN = {
    named: "a made-up connection",
    config: { room: shouted },
    credentials: { required: false, refusal: "no" },
  } as const;

  const BY_ENDPOINT = {
    named: "a made-up connection with an endpoint",
    chosenBy: "endpoint",
    config: { room: shouted, endpoint: shouted },
    credentials: { required: false, refusal: "no" },
  } as const;

  const SHAPES = [PLAIN, BY_ENDPOINT] as const;

  it("takes the shape whose key the config names", () => {
    expect(shapeChosen(SHAPES, { room: "lobby", endpoint: "https://x" })).toBe(
      BY_ENDPOINT,
    );
  });

  it("falls to the first shape when the config names none of the keys", () => {
    expect(shapeChosen(SHAPES, { room: "lobby" })).toBe(PLAIN);
  });

  /**
   * A key written out as `undefined` is a key the caller left out — the same
   * reading the config gates take — so it must not choose a shape whose whole
   * point is that the key is there.
   */
  it("reads a key written as undefined as a key that was left out", () => {
    expect(shapeChosen(SHAPES, { room: "lobby", endpoint: undefined })).toBe(
      PLAIN,
    );
  });

  it("falls to the first shape for a config that is not an object at all", () => {
    for (const notAnObject of [undefined, null, "room=lobby", ["lobby"]]) {
      expect(shapeChosen(SHAPES, notAnObject)).toBe(PLAIN);
    }
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
    expect(shapeOf("livekit", { url: A_URL }).credentials).toMatchObject({
      required: true,
      fields: ["apiKey", "apiSecret"],
    });
  });

  /**
   * The two shapes are two answers to one question — who mints the token that
   * opens the room — and the config key that names an endpoint is the whole of
   * what tells them apart.
   */
  it("comes in two shapes, told apart by a tokenEndpoint in the config", () => {
    expect(shapeOf("livekit", { url: A_URL }).named).toBeUndefined();
    expect(
      shapeOf("livekit", { url: A_URL, tokenEndpoint: AN_ENDPOINT }).named,
    ).toBe("a token-endpoint livekit connection");
  });

  it("holds no key pair on the shape that asks an endpoint for tokens", () => {
    expect(
      shapeOf("livekit", { url: A_URL, tokenEndpoint: AN_ENDPOINT })
        .credentials,
    ).toMatchObject({ required: "if-sent", fields: ["headers"] });
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
  const MINTING = { url: A_URL };

  it("seal both fields, and the hint is the last four of the key", () => {
    expect(validCredentials("livekit", MINTING, KEYS)).toEqual({
      sealed: KEYS,
      hint: "WXYZ",
    });
  });

  it("refuses a pair with either half missing, naming the shape", () => {
    expect(() =>
      validCredentials("livekit", MINTING, { apiKey: KEYS.apiKey }),
    ).toThrow(
      "a livekit connection's credentials need apiSecret to be a non-empty string",
    );
    expect(() =>
      validCredentials("livekit", MINTING, { apiSecret: KEYS.apiSecret }),
    ).toThrow(
      "a livekit connection's credentials need apiKey to be a non-empty string",
    );
  });

  it("refuses a key that does not belong, naming it and the shape", () => {
    expect(() =>
      validCredentials("livekit", MINTING, { ...KEYS, apiToken: "extra" }),
    ).toThrow(
      'a livekit connection\'s credentials have no key "apiToken"; they are ' +
        "shaped { apiKey, apiSecret }",
    );
  });

  it("refuses either half so short its last-4 hint would give it away", () => {
    expect(() =>
      validCredentials("livekit", MINTING, { ...KEYS, apiSecret: "abcd" }),
    ).toThrow(
      "a livekit connection's credentials need apiSecret to be at least 8 characters",
    );
  });
});

/**
 * The second shape, whole: what its config holds, what its credentials hold,
 * and what it will not hold because it has no power to use it.
 */
describe("a livekit connection that names a token endpoint", () => {
  const AT = { url: A_URL, tokenEndpoint: AN_ENDPOINT };
  const HEADERS = { headers: '{"Authorization":"Bearer sentinel-not-real"}' };

  it("holds a url and an endpoint, both stored as they were written", () => {
    expect(validConfig("livekit", AT)).toEqual(AT);
    expect(
      validConfig("livekit", { url: A_URL, tokenEndpoint: `  ${AN_ENDPOINT}  ` }),
    ).toEqual(AT);
  });

  it("takes an endpoint over http or https and nothing else", () => {
    expect(
      validConfig("livekit", { url: A_URL, tokenEndpoint: "http://10.0.0.4/t" }),
    ).toEqual({ url: A_URL, tokenEndpoint: "http://10.0.0.4/t" });

    for (const tokenEndpoint of [
      // The server URL's own schemes: egma POSTs to this one, so a websocket
      // address here is the two keys pasted the wrong way round.
      "wss://acme.livekit.cloud",
      "ws://127.0.0.1:7880",
      "acme.example/token",
      "https:acme.example",
      "",
    ]) {
      expect(() => validConfig("livekit", { url: A_URL, tokenEndpoint })).toThrow(
        "the config's tokenEndpoint must be an http or https URL, which " +
          "looks like https://example.com/egma/livekit-token",
      );
    }
  });

  /**
   * Both are powers a key pair buys, and this shape has no key pair: it cannot
   * create the room that would carry the metadata, and cannot dispatch the
   * agent that would be named. A key egma would silently ignore is worse than
   * one it refuses by name.
   */
  it("has no place for an agent name or metadata, and says which keys it holds", () => {
    for (const key of ["agentName", "metadata"]) {
      expect(() => validConfig("livekit", { ...AT, [key]: "front-desk" })).toThrow(
        `a token-endpoint livekit connection's config has no key "${key}"; ` +
          "it holds url, tokenEndpoint",
      );
    }
  });

  it("seals the headers, and hints at their names and never their values", () => {
    expect(validCredentials("livekit", AT, HEADERS)).toEqual({
      sealed: HEADERS,
      hint: "Authorization",
    });
    expect(
      validCredentials("livekit", AT, {
        headers: '{"Authorization":"Bearer x0","X-Tenant":"acme"}',
      })?.hint,
    ).toBe("Authorization, X-Tenant");
  });

  it("never lets a value into the hint, however short the header is", () => {
    const hint = validCredentials("livekit", AT, {
      headers: '{"X-Key":"abcdefgh"}',
    })?.hint;
    expect(hint).toBe("X-Key");
    expect(hint).not.toContain("abcd");
  });

  it("takes no credentials at all, because an open endpoint is a deployment", () => {
    expect(validCredentials("livekit", AT, undefined)).toBeNull();
  });

  it("refuses headers that are not a JSON object of name to value", () => {
    for (const headers of [
      "Authorization: Bearer x",
      '{"Authorization":"Bearer x"',
      '{"Authorization":7}',
      '{"Authorization":""}',
      '{"":"Bearer x"}',
      "{}",
      "[1,2]",
      "",
      7,
    ]) {
      expect(() => validCredentials("livekit", AT, { headers })).toThrow(
        "a token-endpoint livekit connection's credentials need headers to " +
          "be a JSON object of header name to header value, written in a " +
          'string, which looks like {"Authorization":"Bearer …"}',
      );
    }
  });

  it("never quotes a header value back in the refusal about it", () => {
    const secret = "SENTINEL-header-value-9f2c";
    let told = "";
    try {
      validCredentials("livekit", AT, {
        headers: `Authorization: ${secret}`,
      });
    } catch (refusal) {
      told = String(refusal);
    }
    expect(told).toContain("headers");
    expect(told).not.toContain(secret);
  });
});

/**
 * The incoherent mixes, each refused at create by a sentence that names both
 * doors. A caller who pastes a key pair under a token endpoint has mixed up
 * two whole ways of working; telling them `"apiKey"` is not a field would send
 * them looking for a typo that is not there.
 */
describe("a livekit connection that is half of each shape", () => {
  const AT = { url: A_URL, tokenEndpoint: AN_ENDPOINT };
  const KEYS = { apiKey: "APIhx4bmvHnLcWXYZ", apiSecret: "livekit-secret-9f2c1d" };
  const HEADERS = { headers: '{"Authorization":"Bearer sentinel-not-real"}' };

  it("refuses a key pair sent alongside a token endpoint", () => {
    expect(() => validCredentials("livekit", AT, KEYS)).toThrow(
      "a livekit connection whose config names a tokenEndpoint asks that " +
        "endpoint for every token, so it holds no key pair of its own: its " +
        "credentials are the endpoint's auth headers, shaped { headers }. " +
        "Send those, or drop the tokenEndpoint and egma will mint its own " +
        "tokens from an apiKey and apiSecret.",
    );
  });

  it("refuses endpoint headers on a connection that names no endpoint", () => {
    expect(() => validCredentials("livekit", { url: A_URL }, HEADERS)).toThrow(
      "a livekit connection mints its own tokens, so it needs the project's " +
        "apiKey and apiSecret. Send the pair, or name a tokenEndpoint in the " +
        "config and egma will ask that endpoint for a token instead — which " +
        "is the shape where the project's secret never leaves the customer.",
    );
  });

  it("refuses a connection carrying neither auth shape, naming both", () => {
    expect(() =>
      validCredentials("livekit", { url: A_URL }, undefined),
    ).toThrow(/Send the pair, or name a tokenEndpoint in the config/);
  });

  /**
   * A stray key is a typo, not a mix, and it has to keep reading like one:
   * pointing somebody at the other shape would be egma guessing at an
   * intention nothing in the payload supports.
   */
  it("still calls a stray credential key a stray key", () => {
    expect(() =>
      validCredentials("livekit", { url: A_URL }, { ...KEYS, apiToken: "x" }),
    ).toThrow(/have no key "apiToken"/);
  });
});

/**
 * Which types egma can conduct a run over, which is the whole of what the
 * capability registry publishes about the simulator.
 *
 * It is a fact about the shipped build and never about one deployment: a
 * platform whose carrier has never been configured still holds the phone
 * adapter, and what it does about that is phone readiness' business, asked at
 * the API where a deployment's configuration is known.
 */
describe("what the shipped simulator can conduct", () => {
  it("counts phone among them, because the phone plug ships", () => {
    expect(descriptorOf("phone").simulatorAdapter).toBe(true);
    expect(conductableConnectionTypes()).toContain("phone");
  });

  it("names every shipped type in the refusal, and takes the list from the registry", () => {
    // The sentence exists for a type egma has not shipped an adapter for.
    // Every type in `CONNECTION_TYPES` has one today, so the rule is exercised
    // on a name the registry does not hold — which is exactly the case the
    // refusal is kept for.
    expect(noSimulatorAdapterMessage("vapi")).toBe(
      "egma has no simulator adapter for a vapi connection yet, so it will " +
        "not start a run it cannot conduct. Run these tests over a " +
        `connection egma conducts today: ${conductableConnectionTypes().join(", ")}.`,
    );
    expect(conductableConnectionTypes()).toEqual(["retell", "phone", "livekit"]);
  });
});
