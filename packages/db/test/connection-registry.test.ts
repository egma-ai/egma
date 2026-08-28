import { AgentWriteRefusedError } from "@egma/db";
import { describe, expect, it } from "vitest";

import {
  conductableConnectionTypes,
  connectionIsConductable,
  descriptorOf,
  gatedConfig,
  noSimulatorAdapterMessage,
  optional,
  accessVariantById,
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

describe("the types that carry no optional key", () => {
  it("still demand every key they hold, retell's and phone's alike", () => {
    expect(() => validConfig("retell_chat_api", "retell_chat_api.api_key", {})).toThrow(
      "a Retell chat connection's config needs retellAgentId",
    );
    expect(() => validConfig("phone_number", "phone_number.public_e164", {})).toThrow(
      "a phone-number connection's config needs phoneNumber",
    );
  });

  it("still list their keys without an optional marker anywhere", () => {
    expect(() => validConfig("retell_chat_api", "retell_chat_api.api_key", { retellAgentld: "typo" })).toThrow(
      'a Retell chat connection\'s config has no key "retellAgentld"; it holds retellAgentId',
    );
  });

  it("still answer the stored config for a payload they take", () => {
    expect(validConfig("retell_chat_api", "retell_chat_api.api_key", { retellAgentId: "  agent_abc  " })).toEqual({
      retellAgentId: "agent_abc",
    });
    expect(validConfig("phone_number", "phone_number.public_e164", { phoneNumber: "+15551234567" })).toEqual({
      phoneNumber: "+15551234567",
    });
  });
});

describe("what a livekit connection is made of", () => {
  it("speaks voice, dials out, and takes two credential fields", () => {
    const descriptor = descriptorOf("livekit_room");

    expect(descriptor.modalities).toEqual(["voice"]);
    // Derived from the type: a livekit agent joins the room egma opened, so
    // egma never has to reach a laptop.
    expect(descriptor.topology).toBe("agent-dials-out");
    expect(
      accessVariantById("livekit_room", "livekit_room.project_credentials")
        .credentials,
    ).toMatchObject({ required: true, fields: ["apiKey", "apiSecret"] });
  });

  /**
   * The two shapes are two answers to one question — who mints the token that
   * opens the room — and the config key that names an endpoint is the whole of
   * what tells them apart.
   */
  it("comes in two explicit access variants", () => {
    expect(
      accessVariantById("livekit_room", "livekit_room.project_credentials").named,
    ).toBe("a LiveKit room connection");
    expect(
      accessVariantById(
        "livekit_room",
        "livekit_room.customer_token_endpoint",
      ).named,
    ).toBe("a token-endpoint livekit connection");
  });

  it("holds no key pair on the shape that asks an endpoint for tokens", () => {
    expect(
      accessVariantById(
        "livekit_room",
        "livekit_room.customer_token_endpoint",
      ).credentials,
    ).toMatchObject({ required: true, fields: ["headers"] });
  });

  it("has no reuse rule: nothing in the config names one agent", () => {
    expect(descriptorOf("livekit_room").reuseKey).toBeUndefined();
  });
});

describe("a LiveKit room connection's url", () => {
  it("takes ws, wss, http and https alike, stored as it was written", () => {
    for (const url of [
      "wss://acme.livekit.cloud",
      "ws://127.0.0.1:7880",
      "https://acme.livekit.cloud",
      "http://localhost:7880",
    ]) {
      expect(validConfig("livekit_room", "livekit_room.project_credentials", { url })).toEqual({ url });
    }
  });

  it("is stored trimmed, so a padded paste still reaches the server", () => {
    expect(validConfig("livekit_room", "livekit_room.project_credentials", { url: "  wss://acme.livekit.cloud  " })).toEqual(
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
      expect(() => validConfig("livekit_room", "livekit_room.project_credentials", { url })).toThrow(/config's url/);
    }
  });

  it("is demanded: a livekit connection with no url is refused by name", () => {
    expect(() => validConfig("livekit_room", "livekit_room.project_credentials", {})).toThrow(
      "a LiveKit room connection's config needs url",
    );
  });
});

describe("a LiveKit room connection's agent name", () => {
  /**
   * Absent is not a gap to be filled in later — it is the setting every
   * quickstart agent on a laptop runs under, where LiveKit dispatches whoever
   * is listening rather than a named worker.
   */
  it("may be left out, which is what automatic dispatch is", () => {
    expect(validConfig("livekit_room", "livekit_room.project_credentials", { url: "wss://acme.livekit.cloud" })).toEqual({
      url: "wss://acme.livekit.cloud",
    });
  });

  it("is still gated when it is there", () => {
    expect(
      validConfig("livekit_room", "livekit_room.project_credentials", {
        url: "wss://acme.livekit.cloud",
        agentName: "  front-desk  ",
      }),
    ).toEqual({ url: "wss://acme.livekit.cloud", agentName: "front-desk" });

    expect(() =>
      validConfig("livekit_room", "livekit_room.project_credentials", {
        url: "wss://acme.livekit.cloud",
        agentName: "   ",
      }),
    ).toThrow("the config's agentName must be a non-empty string");
  });
});

describe("a LiveKit room connection's metadata", () => {
  /**
   * It rides to the agent verbatim as the room's metadata, so a typo has to
   * die here. Refused at create, a person is looking at the mistake; refused
   * at dispatch, a run has already started and the agent is the one confused.
   */
  it("may be left out, and is kept exactly as written when it is there", () => {
    const url = "wss://acme.livekit.cloud";
    expect(validConfig("livekit_room", "livekit_room.project_credentials", { url })).toEqual({ url });
    expect(
      validConfig("livekit_room", "livekit_room.project_credentials", { url, metadata: '{"tenant":"acme","tier":2}' }),
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
      expect(() => validConfig("livekit_room", "livekit_room.project_credentials", { url, metadata })).toThrow(
        /config's metadata/,
      );
    }
  });
});

describe("a LiveKit room connection's modality", () => {
  it("takes voice, and refuses chat by naming what it speaks", () => {
    expect(validModality("livekit_room", "voice")).toBe("voice");
    expect(() => validModality("livekit_room", "chat")).toThrow(
      "a livekit_room connection speaks voice, and this one was asked for chat",
    );
  });

  it("refuses a word that is not a modality at all as exactly that", () => {
    expect(() => validModality("livekit_room", "telepathy")).toThrow(
      '"telepathy" is not a modality; a livekit_room connection speaks voice',
    );
  });
});

describe("a LiveKit room connection's credentials", () => {
  const KEYS = { apiKey: "APIhx4bmvHnLcWXYZ", apiSecret: "livekit-secret-9f2c1d" };

  it("seal both fields, and the hint is the last four of the key", () => {
    expect(validCredentials("livekit_room", "livekit_room.project_credentials", KEYS)).toEqual({
      sealed: KEYS,
      hint: "WXYZ",
    });
  });

  it("refuses a pair with either half missing, naming the shape", () => {
    expect(() =>
      validCredentials("livekit_room", "livekit_room.project_credentials", { apiKey: KEYS.apiKey }),
    ).toThrow(
      "a LiveKit room connection's credentials need apiSecret to be a non-empty string",
    );
    expect(() =>
      validCredentials("livekit_room", "livekit_room.project_credentials", { apiSecret: KEYS.apiSecret }),
    ).toThrow(
      "a LiveKit room connection's credentials need apiKey to be a non-empty string",
    );
  });

  it("refuses a key that does not belong, naming it and the shape", () => {
    expect(() =>
      validCredentials("livekit_room", "livekit_room.project_credentials", { ...KEYS, apiToken: "extra" }),
    ).toThrow(
      'a LiveKit room connection\'s credentials have no key "apiToken"; they are ' +
        "shaped { apiKey, apiSecret }",
    );
  });

  it("refuses either half so short its last-4 hint would give it away", () => {
    expect(() =>
      validCredentials("livekit_room", "livekit_room.project_credentials", { ...KEYS, apiSecret: "abcd" }),
    ).toThrow(
      "a LiveKit room connection's credentials need apiSecret to be at least 8 characters",
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
    expect(validConfig("livekit_room", "livekit_room.customer_token_endpoint", AT)).toEqual(AT);
    expect(
      validConfig("livekit_room", "livekit_room.customer_token_endpoint", { url: A_URL, tokenEndpoint: `  ${AN_ENDPOINT}  ` }),
    ).toEqual(AT);
  });

  it("takes only a public https endpoint", () => {
    expect(validConfig("livekit_room", "livekit_room.customer_token_endpoint", AT)).toEqual(AT);

    for (const tokenEndpoint of [
      "http://tokens.example/egma/livekit-token",
      "https://127.0.0.1/egma/livekit-token",
      "https://10.0.0.4/egma/livekit-token",
      "https://169.254.169.254/latest/meta-data",
      "https://0.0.0.0/egma/livekit-token",
      "https://224.0.0.1/egma/livekit-token",
      "https://2130706433/egma/livekit-token",
      "https://0x7f000001/egma/livekit-token",
      "https://[::1]/egma/livekit-token",
      "https://localhost/egma/livekit-token",
      "https://secret@tokens.example/egma/livekit-token",
      "https://tokens.example\\@127.0.0.1/egma/livekit-token",
      "https://tokens.example/egma/\u0000livekit-token",
      // The server URL's own schemes: egma POSTs to this one, so a websocket
      // address here is the two keys pasted the wrong way round.
      "wss://acme.livekit.cloud",
      "ws://127.0.0.1:7880",
      "acme.example/token",
      "https:acme.example",
      "",
    ]) {
      expect(() => validConfig("livekit_room", "livekit_room.customer_token_endpoint", { url: A_URL, tokenEndpoint })).toThrow(
        "the config's tokenEndpoint must be a public https URL, which " +
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
      expect(() => validConfig("livekit_room", "livekit_room.customer_token_endpoint", { ...AT, [key]: "front-desk" })).toThrow(
        `a token-endpoint livekit connection's config has no key "${key}"; ` +
          "it holds url, tokenEndpoint",
      );
    }
  });

  it("seals the headers, and hints at their names and never their values", () => {
    expect(validCredentials("livekit_room", "livekit_room.customer_token_endpoint", HEADERS)).toEqual({
      sealed: HEADERS,
      hint: "Authorization",
    });
    expect(
      validCredentials("livekit_room", "livekit_room.customer_token_endpoint", {
        headers: '{"Authorization":"Bearer x0","X-Tenant":"acme"}',
      })?.hint,
    ).toBe("Authorization, X-Tenant");
  });

  it("never lets a value into the hint, however short the header is", () => {
    const hint = validCredentials("livekit_room", "livekit_room.customer_token_endpoint", {
      headers: '{"X-Key":"abcdefgh"}',
    })?.hint;
    expect(hint).toBe("X-Key");
    expect(hint).not.toContain("abcd");
  });

  it("requires auth headers because every admitted endpoint is public", () => {
    expect(() => validCredentials("livekit_room", "livekit_room.customer_token_endpoint", undefined)).toThrow(
      "a livekit connection whose config names a tokenEndpoint asks that " +
        "endpoint for every token, so it holds no key pair of its own: its " +
        "credentials are the endpoint's auth headers, shaped { headers }. " +
        "Send those, or drop the tokenEndpoint and Egma will mint its own " +
        "tokens from an apiKey and apiSecret.",
    );
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
      expect(() => validCredentials("livekit_room", "livekit_room.customer_token_endpoint", { headers })).toThrow(
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
      validCredentials("livekit_room", "livekit_room.customer_token_endpoint", {
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
describe("a LiveKit connection that is half of each access variant", () => {
  const AT = { url: A_URL, tokenEndpoint: AN_ENDPOINT };
  const KEYS = { apiKey: "APIhx4bmvHnLcWXYZ", apiSecret: "livekit-secret-9f2c1d" };
  const HEADERS = { headers: '{"Authorization":"Bearer sentinel-not-real"}' };

  it("refuses a key pair sent alongside a token endpoint", () => {
    expect(() => validCredentials("livekit_room", "livekit_room.customer_token_endpoint", KEYS)).toThrow(
      "a livekit connection whose config names a tokenEndpoint asks that " +
        "endpoint for every token, so it holds no key pair of its own: its " +
        "credentials are the endpoint's auth headers, shaped { headers }. " +
        "Send those, or drop the tokenEndpoint and Egma will mint its own " +
        "tokens from an apiKey and apiSecret.",
    );
  });

  it("refuses endpoint headers on a connection that names no endpoint", () => {
    expect(() => validCredentials("livekit_room", "livekit_room.project_credentials", HEADERS)).toThrow(
      "a livekit connection mints its own tokens, so it needs the project's " +
        "apiKey and apiSecret. Send the pair, or name a tokenEndpoint in the " +
        "config and Egma will ask that endpoint for a token instead — which " +
        "is the access variant where the project's secret never leaves the customer.",
    );
  });

  it("refuses a connection carrying neither access variant's auth, naming both", () => {
    expect(() =>
      validCredentials("livekit_room", "livekit_room.project_credentials", undefined),
    ).toThrow(
      "a livekit connection mints its own tokens, so it needs the project's " +
        "apiKey and apiSecret. Send the pair, or name a tokenEndpoint in the " +
        "config and Egma will ask that endpoint for a token instead — which " +
        "is the access variant where the project's secret never leaves the customer.",
    );
  });

  /**
   * A stray key is a typo, not a mix, and it has to keep reading like one:
   * pointing somebody at the other access variant would be egma guessing at an
   * intention nothing in the payload supports.
   */
  it("still calls a stray credential key a stray key", () => {
    expect(() =>
      validCredentials("livekit_room", "livekit_room.project_credentials", { ...KEYS, apiToken: "x" }),
    ).toThrow(/have no key "apiToken"/);
  });
});

/**
 * Which types egma can conduct a run over, which is what the connection
 * registry publishes about the simulator.
 *
 * It is a fact about the shipped build and never about one deployment: a
 * platform whose carrier has never been configured still holds the phone
 * adapter, and what it does about that is phone readiness' business, asked at
 * the API where a deployment's configuration is known.
 */
describe("what the shipped simulator can conduct", () => {
  it("counts phone among them, because the phone plug ships", () => {
    expect(descriptorOf("phone_number").simulatorAdapter).toBe(true);
    expect(conductableConnectionTypes()).toContain("phone_number");
  });

  it("checks the exact stored kind, access variant, and modality before dispatch", () => {
    expect(
      connectionIsConductable(
        "retell_chat_api",
        "retell_chat_api.api_key",
        "chat",
      ),
    ).toBe(true);
    expect(
      connectionIsConductable(
        "retell_chat_api",
        "retell_chat_api.api_key",
        "voice",
      ),
    ).toBe(false);
    expect(
      connectionIsConductable(
        "phone_number",
        "phone_number.public_e164",
        "voice",
      ),
    ).toBe(true);
  });

  it("names every shipped type in the refusal, and takes the list from the registry", () => {
    // The sentence exists for a type egma has not shipped an adapter for.
    // Every connection type has one today, so the rule is exercised
    // on a name the registry does not hold — which is exactly the case the
    // refusal is kept for.
    expect(noSimulatorAdapterMessage("vapi")).toBe(
      "Egma has no simulator adapter for a vapi connection yet, so it will " +
        "not start a run it cannot conduct. Run these tests over a " +
        `connection Egma conducts today: ${conductableConnectionTypes().join(", ")}.`,
    );
    expect(conductableConnectionTypes()).toEqual([
      "retell_chat_api",
      "retell_playground",
      "phone_number",
      "livekit_room",
    ]);
  });
});
