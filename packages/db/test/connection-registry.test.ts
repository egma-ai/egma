import { AgentWriteRefusedError } from "@egma/db";
import { describe, expect, it } from "vitest";

import {
  connectionIsConductable,
  descriptorOf,
  gatedConfig,
  livekitServerOrigin,
  tokenEndpointIdentity,
  optional,
  validConfig,
  validCredentials,
  validModality,
} from "../src/access/connection-registry.ts";

/**
 * Synthetic field definitions test optional-field validation independently
 * of shipped connection types. Real types verify their required fields.
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

/** One livekit connection's config keys, in each of its two shapes. */
const A_URL = "wss://acme.livekit.cloud";
const A_NAME = "front-desk";
const AN_ENDPOINT = "https://acme.example/egma/livekit-token";

/** The key-pair shape's config, whole, for the tests that vary one key. */
const LIVEKIT_CONFIG = { url: A_URL, agentName: A_NAME };

describe("a config gate marked optional", () => {
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
    expect(() => validConfig("retell_text_mode", "retell_text_mode.api_key", {})).toThrow(
      "a Retell text mode connection's config needs retellAgentId",
    );
    expect(() => validConfig("phone_number", "phone_number.public_e164", {})).toThrow(
      "a phone-number connection's config needs phoneNumber",
    );
  });

  it("still list their keys without an optional marker anywhere", () => {
    expect(() => validConfig("retell_text_mode", "retell_text_mode.api_key", { retellAgentld: "typo" })).toThrow(
      'a Retell text mode connection\'s config has no key "retellAgentld"; it holds retellAgentId',
    );
  });

  it("still answer the stored config for a payload they take", () => {
    expect(validConfig("retell_text_mode", "retell_text_mode.api_key", { retellAgentId: "  agent_abc  " })).toEqual({
      retellAgentId: "agent_abc",
    });
    expect(validConfig("phone_number", "phone_number.public_e164", { phoneNumber: "+15551234567" })).toEqual({
      phoneNumber: "+15551234567",
    });
  });
});

describe("what a livekit connection is made of", () => {
  /**
   * A worker reached through a key pair and one reached through an endpoint
   * are two registrations egma cannot know to be one worker, so they never
   * compare equal — even where the endpoint and the server share a host.
   */
  it("never reads a server url and a token endpoint as one identity", () => {
    const reuse = descriptorOf("livekit_room").reuse;
    expect(
      reuse?.identityOf({ url: "wss://acme.example", agentName: "front-desk" }),
    ).not.toBe(
      reuse?.identityOf({ tokenEndpoint: "https://acme.example", agentName: "front-desk" }),
    );
  });
});

describe("a token endpoint read as an identity", () => {
  it.each([
    { written: "https://acme.example:443/egma/livekit-token", identity: "acme.example/egma/livekit-token" },
    { written: "https://ACME.Example./egma/livekit-token", identity: "acme.example/egma/livekit-token" },
    { written: "  https://acme.example/egma/livekit-token  ", identity: "acme.example/egma/livekit-token" },
    { written: "https://acme.example:8443/token", identity: "acme.example:8443/token" },
    { written: "https://acme.example", identity: "acme.example/" },
    { written: "https://acme.example/Token", identity: "acme.example/Token" },
    { written: "https://acme.example/token?tenant=a", identity: "acme.example/token?tenant=a" },
  ])("reads $written as $identity", ({ written, identity }) => {
    expect(tokenEndpointIdentity(written)).toBe(identity);
  });
});

/**
 * Which server a url names, once the spellings that mean one server have been
 * folded together. It is a comparison key and never a value anybody dials —
 * the url is stored as it was written.
 */
describe("a LiveKit server url read as an origin", () => {
  it.each([
    // A real port is a real difference: a self-hosted LiveKit on 7880 is not
    // whatever else answers on that host.
    { written: "ws://127.0.0.1:7880", origin: "127.0.0.1:7880" },
    { written: "ws://[::1]:7880", origin: "[::1]:7880" },
  ])("reads $written as $origin", ({ written, origin }) => {
    expect(livekitServerOrigin(written)).toBe(origin);
  });
});

describe("a LiveKit room connection's url", () => {
  it("is stored trimmed, so a padded paste still reaches the server", () => {
    expect(
      validConfig("livekit_room", "livekit_room.project_credentials", {
        url: "  wss://acme.livekit.cloud  ",
        agentName: A_NAME,
      }),
    ).toEqual(LIVEKIT_CONFIG);
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
      expect(() =>
        validConfig("livekit_room", "livekit_room.project_credentials", {
          url,
          agentName: A_NAME,
        }),
      ).toThrow(/config's url/);
    }
  });

  it("is demanded: a livekit connection with no url is refused by name", () => {
    expect(() =>
      validConfig("livekit_room", "livekit_room.project_credentials", {
        agentName: A_NAME,
      }),
    ).toThrow("a LiveKit room connection's config needs url");
  });
});

describe("a LiveKit room connection's agent name", () => {
  /**
   * Demanded, because every egma dispatch is explicit: the record names the
   * agent it graded, and a test's own dispatch metadata always has a dispatch
   * to ride — where a nameless connection would hand each room to whichever
   * worker was listening.
   */
  it("is demanded, and the refusal names the key", () => {
    expect(() =>
      validConfig("livekit_room", "livekit_room.project_credentials", {
        url: A_URL,
      }),
    ).toThrow("a LiveKit room connection's config needs agentName");
  });

  it("is refused blank too, in the words of the gate it faces", () => {
    expect(() =>
      validConfig("livekit_room", "livekit_room.project_credentials", {
        url: A_URL,
        agentName: "   ",
      }),
    ).toThrow("the config's agentName must be a non-empty string");
  });

  it("is stored trimmed, so a padded paste dispatches the right worker", () => {
    expect(
      validConfig("livekit_room", "livekit_room.project_credentials", {
        url: A_URL,
        agentName: "  front-desk  ",
      }),
    ).toEqual(LIVEKIT_CONFIG);
  });
});

describe("a LiveKit room connection's modality", () => {
  it("refuses a word that is not a modality at all as exactly that", () => {
    expect(() =>
      validModality(
        "livekit_room",
        "livekit_room.project_credentials",
        "telepathy",
      ),
    ).toThrow(
      '"telepathy" is not a modality; a livekit_room connection speaks voice or chat',
    );
  });

  /**
   * An access variant no entry claims is a tuple nobody supports, and
   * `productLabelOf` is what has the sentence for it. Reaching for
   * `accessVariantById` here would raise a fault first and answer a caller
   * with a 500 where the door answers 400 today.
   */
  it("falls back to the kind's own list for an access variant it never heard of", () => {
    expect(validModality("livekit_room", "livekit_room.oauth", "chat")).toBe(
      "chat",
    );
  });

  it("still holds the kinds that speak one modality to it", () => {
    expect(() =>
      validModality("phone_number", "phone_number.public_e164", "chat"),
    ).toThrow(
      "a phone_number connection speaks voice, and this one was asked for chat",
    );
    expect(() =>
      validModality("retell_text_mode", "retell_text_mode.api_key", "voice"),
    ).toThrow(
      "a retell_text_mode connection speaks chat, and this one was asked for voice",
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
  const AT = { tokenEndpoint: AN_ENDPOINT, agentName: "front-desk" };
  const HEADERS = { headers: '{"Authorization":"Bearer sentinel-not-real"}' };

  it("holds an endpoint and an agent name, both stored as they were written", () => {
    expect(validConfig("livekit_room", "livekit_room.customer_token_endpoint", AT)).toEqual(AT);
    expect(
      validConfig("livekit_room", "livekit_room.customer_token_endpoint", { tokenEndpoint: `  ${AN_ENDPOINT}  `, agentName: "front-desk" }),
    ).toEqual(AT);
  });

  /**
   * Demanded here for the reason it is demanded on the key-pair shape: egma
   * asks the endpoint for this worker by name, so the record names the agent
   * it graded.
   */
  it("demands the worker's name", () => {
    expect(() => validConfig("livekit_room", "livekit_room.customer_token_endpoint", { tokenEndpoint: AN_ENDPOINT })).toThrow(
      /agentName/,
    );
    expect(() => validConfig("livekit_room", "livekit_room.customer_token_endpoint", { tokenEndpoint: AN_ENDPOINT, agentName: "  " })).toThrow(
      /agentName/,
    );
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
      expect(() => validConfig("livekit_room", "livekit_room.customer_token_endpoint", { ...AT, tokenEndpoint })).toThrow(
        "the config's tokenEndpoint must be a public https URL, which " +
          "looks like https://example.com/egma/livekit-token",
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
  const AT = { tokenEndpoint: AN_ENDPOINT, agentName: "front-desk" };
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
  it("checks the exact stored kind, access variant, and modality before dispatch", () => {
    expect(
      connectionIsConductable(
        "retell_text_mode",
        "retell_text_mode.api_key",
        "chat",
      ),
    ).toBe(true);
    expect(
      connectionIsConductable(
        "retell_text_mode",
        "retell_text_mode.api_key",
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

  /**
   * Dispatch reads the variant's list rather than the kind's, or a stored row
   * on a narrowed variant would be handed to a simulator for a modality the
   * door refused to write. The narrowing rule is proven on the made-up kind
   * above; this is the shipped catalog, where no LiveKit variant narrows any
   * more, so both ways in conduct both modalities.
   */
  it("conducts both modalities on both LiveKit access variants", () => {
    for (const variant of [
      "livekit_room.project_credentials",
      "livekit_room.customer_token_endpoint",
    ] as const) {
      for (const modality of ["chat", "voice"] as const) {
        expect(connectionIsConductable("livekit_room", variant, modality)).toBe(
          true,
        );
      }
    }
  });
});
