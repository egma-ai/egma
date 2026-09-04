import { AgentWriteRefusedError } from "@egma/db";
import { describe, expect, it } from "vitest";

import {
  conductableConnectionTypes,
  connectionIsConductable,
  descriptorOf,
  gatedConfig,
  livekitServerOrigin,
  modalitiesOf,
  noSimulatorAdapterMessage,
  optional,
  accessVariantById,
  validConfig,
  validCredentials,
  validModality,
  type AccessVariantDescriptor,
  type ConnectionDescriptor,
} from "../src/access/connection-registry.ts";
import type { Modality } from "../src/schema/agents.ts";

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

/** One livekit connection's config keys, in each of its two shapes. */
const A_URL = "wss://acme.livekit.cloud";
const A_NAME = "front-desk";
const AN_ENDPOINT = "https://acme.example/egma/livekit-token";

/** The key-pair shape's config, whole, for the tests that vary one key. */
const LIVEKIT_CONFIG = { url: A_URL, agentName: A_NAME };

/**
 * The made-up kind the per-variant modality rule is exercised on: it speaks
 * both, and its access variants are built one at a time, with a narrowing or
 * without one.
 *
 * Made up for the same reason the optional-gate machinery above is. What is
 * under test is the rule — absent means the kind's list, present replaces it —
 * and a test written against whichever real variant happens to narrow today
 * would start measuring that variant instead the moment its reasons changed.
 */
function madeUpVariant(
  narrowing?: AccessVariantDescriptor["modalities"],
): AccessVariantDescriptor {
  return {
    id: "made_up.plain",
    label: "A made-up access variant",
    config: GATES,
    fields: [],
    credentialHelp: "",
    credentialFields: [],
    credentials: { required: false, refusal: "it takes no credential" },
    ...(narrowing === undefined ? {} : { modalities: narrowing }),
  };
}

function madeUpKind(variant: AccessVariantDescriptor): ConnectionDescriptor {
  return {
    label: "A made-up connection",
    agentPlatforms: "any",
    modalities: ["voice", "chat"] as readonly Modality[],
    topology: "hosted-broker",
    accessVariants: [variant],
    simulatorAdapter: false,
    usesPlatformCarrier: false,
  };
}

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

describe("an access variant that narrows its kind's modalities", () => {
  it("speaks the kind's whole list when it narrows nothing", () => {
    const plain = madeUpVariant();
    expect(modalitiesOf(madeUpKind(plain), plain)).toEqual(["voice", "chat"]);
  });

  it("speaks only what it narrowed to, whatever the kind says", () => {
    const narrowed = madeUpVariant({
      speaks: ["voice"],
      refusal: "a made-up connection reached this way speaks voice",
    });
    expect(modalitiesOf(madeUpKind(narrowed), narrowed)).toEqual(["voice"]);
  });

  /**
   * The narrowing and the sentence that explains it are one field, so a kind
   * cannot lose one and keep the other. Whoever is refused is being told that
   * the kind can do the thing and their way of reaching it cannot, and only
   * the person who wrote the narrowing knows why.
   */
  it("carries the reason beside the list, so a refusal can say it", () => {
    const narrowed = madeUpVariant({
      speaks: ["voice"],
      refusal: "a made-up connection reached this way speaks voice",
    });
    expect(narrowed.modalities?.refusal).toBe(
      "a made-up connection reached this way speaks voice",
    );
    expect(madeUpVariant().modalities).toBeUndefined();
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
  it("speaks voice and chat, dials out, and takes two credential fields", () => {
    const descriptor = descriptorOf("livekit_room");

    expect(descriptor.modalities).toEqual(["voice", "chat"]);
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

  /**
   * The url alone could never say two registrations are about one agent —
   * whole teams share one server — and the name alone could not either, since
   * a staging project and a production one commonly run a worker of the same
   * name. Together they name a worker, which is what demanding the name bought.
   */
  it("knows one agent by the server it stands on and the name it answers to", () => {
    const reuse = descriptorOf("livekit_room").reuse;
    expect(reuse?.matchedKeys).toEqual(["agentName"]);

    const one = reuse?.identityOf({ url: A_URL, agentName: A_NAME });
    expect(one).toBe("acme.livekit.cloud|front-desk");

    // Every spelling of one server is one identity — the other scheme pair,
    // and the port a customer's dashboard prints, are not second servers.
    for (const url of [
      "https://acme.livekit.cloud",
      "wss://acme.livekit.cloud:443",
      "ws://acme.livekit.cloud",
      "http://acme.livekit.cloud:80",
    ]) {
      expect(reuse?.identityOf({ url, agentName: A_NAME })).toBe(one);
    }

    // Two servers, and one name on each of them, stay two agents.
    expect(
      reuse?.identityOf({ url: "wss://staging.livekit.cloud", agentName: A_NAME }),
    ).not.toBe(one);
    expect(reuse?.identityOf({ url: A_URL, agentName: "night-shift" })).not.toBe(
      one,
    );
  });

  /**
   * A config with no agent name stands for no vendor agent, so every
   * registration through it creates. That is the whole job of an identity
   * that may answer `undefined`.
   */
  it("finds no identity in a config that carries no agent name", () => {
    const reuse = descriptorOf("livekit_room").reuse;
    expect(
      reuse?.identityOf({ tokenEndpoint: AN_ENDPOINT }),
    ).toBeUndefined();
  });

  /**
   * The token-endpoint shape holds no server url — the endpoint's answer
   * names the server — so the endpoint stands in for it: one worker behind
   * one endpoint is one agent, registered from the UI or the CLI alike.
   */
  it("reads a token-endpoint identity off the endpoint and the agent name", () => {
    const reuse = descriptorOf("livekit_room").reuse;
    const one = reuse?.identityOf({ tokenEndpoint: AN_ENDPOINT, agentName: "front-desk" });
    expect(one).toBeDefined();
    expect(
      reuse?.identityOf({ tokenEndpoint: AN_ENDPOINT, agentName: "front-desk" }),
    ).toBe(one);
    expect(
      reuse?.identityOf({ tokenEndpoint: AN_ENDPOINT, agentName: "night-shift" }),
    ).not.toBe(one);
  });
});

/**
 * Which server a url names, once the spellings that mean one server have been
 * folded together. It is a comparison key and never a value anybody dials —
 * the url is stored as it was written.
 */
describe("a LiveKit server url read as an origin", () => {
  it.each([
    { written: "wss://acme.livekit.cloud", origin: "acme.livekit.cloud" },
    { written: "https://acme.livekit.cloud", origin: "acme.livekit.cloud" },
    { written: "wss://acme.livekit.cloud:443", origin: "acme.livekit.cloud" },
    { written: "https://acme.livekit.cloud:443/", origin: "acme.livekit.cloud" },
    // All four schemes fold together, which is the whole point of dropping
    // them: one host reached two ways is one server, not two agents.
    { written: "ws://acme.livekit.cloud", origin: "acme.livekit.cloud" },
    { written: "http://acme.livekit.cloud:80", origin: "acme.livekit.cloud" },
    { written: "ws://livekit.internal", origin: "livekit.internal" },
    { written: "http://livekit.internal:80", origin: "livekit.internal" },
    // A real port is a real difference: a self-hosted LiveKit on 7880 is not
    // whatever else answers on that host.
    { written: "ws://127.0.0.1:7880", origin: "127.0.0.1:7880" },
    { written: "wss://ACME.LiveKit.Cloud", origin: "acme.livekit.cloud" },
    { written: "wss://acme.livekit.cloud.", origin: "acme.livekit.cloud" },
    { written: "  wss://acme.livekit.cloud  ", origin: "acme.livekit.cloud" },
    { written: "ws://[::1]:7880", origin: "[::1]:7880" },
  ])("reads $written as $origin", ({ written, origin }) => {
    expect(livekitServerOrigin(written)).toBe(origin);
  });

  /**
   * A url the gate would refuse cannot reach a stored row, so this answers
   * with what it was given rather than throwing — it then compares equal only
   * to itself, which is the safe answer for a row nobody can explain.
   */
  it("answers a url it cannot parse with the url itself", () => {
    expect(livekitServerOrigin("acme.livekit.cloud")).toBe("acme.livekit.cloud");
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
      expect(
        validConfig("livekit_room", "livekit_room.project_credentials", {
          url,
          agentName: A_NAME,
        }),
      ).toEqual({ url, agentName: A_NAME });
    }
  });

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
   * agent it graded, and the configured metadata always has a dispatch to
   * ride — where a nameless connection would hand each room to whichever
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

  it("is the one key left that a livekit config no longer marks optional", () => {
    expect(() =>
      validConfig("livekit_room", "livekit_room.project_credentials", {
        ...LIVEKIT_CONFIG,
        roomName: "lobby",
      }),
    ).toThrow(
      'a LiveKit room connection\'s config has no key "roomName"; it holds ' +
        "url, agentName, metadata (optional)",
    );
  });
});

describe("a LiveKit room connection's metadata", () => {
  /**
   * It rides to the agent verbatim, on the room's metadata and on the
   * dispatch's, so a typo has to die here. Refused at create, a person is
   * looking at the mistake; refused at dispatch, a run has already started and
   * the agent is the one confused.
   */
  it("may be left out, and is kept exactly as written when it is there", () => {
    expect(
      validConfig(
        "livekit_room",
        "livekit_room.project_credentials",
        LIVEKIT_CONFIG,
      ),
    ).toEqual(LIVEKIT_CONFIG);
    expect(
      validConfig("livekit_room", "livekit_room.project_credentials", {
        ...LIVEKIT_CONFIG,
        metadata: '{"tenant":"acme","tier":2}',
      }),
    ).toEqual({ ...LIVEKIT_CONFIG, metadata: '{"tenant":"acme","tier":2}' });
  });

  it("refuses anything that is not a JSON object in a string", () => {
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
      expect(() =>
        validConfig("livekit_room", "livekit_room.project_credentials", {
          ...LIVEKIT_CONFIG,
          metadata,
        }),
      ).toThrow(/config's metadata/);
    }
  });

  /**
   * LiveKit carries at most 512 KiB in a metadata field, and egma carries the
   * stored string onto both of its channels without adding to either, so the
   * limit checked here is LiveKit's own. A value refused at the dispatch
   * instead would be a room already opened and every simulation on the
   * connection failing for a reason the record cannot act on.
   *
   * The refusal names the number, because a size refused without one leaves
   * the customer guessing how much to cut.
   */
  it("refuses a value too large for livekit to carry, and says the size", () => {
    const roomy = `{"tenant":"${"a".repeat(520 * 1024)}"}`;
    expect(() =>
      validConfig("livekit_room", "livekit_room.project_credentials", {
        ...LIVEKIT_CONFIG,
        metadata: roomy,
      }),
    ).toThrow(/the config's metadata is \d+ bytes and livekit carries at most 524288/);

    // Measured in UTF-8 bytes rather than characters, because bytes are what
    // goes on the wire: this one is under the ceiling in characters and over
    // it in bytes, and a length check would let it through to the room.
    const multibyte = `{"tenant":"${"€".repeat(200_000)}"}`;
    expect(multibyte.length).toBeLessThan(512 * 1024);
    expect(() =>
      validConfig("livekit_room", "livekit_room.project_credentials", {
        ...LIVEKIT_CONFIG,
        metadata: multibyte,
      }),
    ).toThrow(/the config's metadata is \d+ bytes and livekit carries at most 524288/);

    // What a real value looks like beside those two: admitted whole.
    const ordinary = `{"tenant":"acme","locale":"en-GB"}`;
    expect(
      validConfig("livekit_room", "livekit_room.project_credentials", {
        ...LIVEKIT_CONFIG,
        metadata: ordinary,
      }),
    ).toEqual({ ...LIVEKIT_CONFIG, metadata: ordinary });
  });
});

describe("a LiveKit room connection's modality", () => {
  it("takes voice and chat where Egma dispatches the worker itself", () => {
    for (const modality of ["voice", "chat"]) {
      expect(
        validModality(
          "livekit_room",
          "livekit_room.project_credentials",
          modality,
        ),
      ).toBe(modality);
    }
  });

  /**
   * The kind speaks chat and this way of reaching it cannot, which is a
   * different thing to be told than "this kind speaks voice" — so the variant
   * says which variant, why, and where chat is offered instead.
   */
  it("refuses chat on the token endpoint with the variant's own reason", () => {
    expect(() =>
      validModality(
        "livekit_room",
        "livekit_room.customer_token_endpoint",
        "chat",
      ),
    ).toThrow(
      "a token-endpoint livekit connection speaks voice: chat is offered " +
        "on the LiveKit project credentials access variant, where Egma " +
        "mints the room whose name tells the worker it is in a chat.",
    );
  });

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

    // And on the narrowed variant it says what that variant speaks, because
    // that is the list the caller is actually being held to.
    expect(() =>
      validModality(
        "livekit_room",
        "livekit_room.customer_token_endpoint",
        "telepathy",
      ),
    ).toThrow(
      '"telepathy" is not a modality; a livekit_room connection speaks voice',
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
      validModality("retell_chat_api", "retell_chat_api.api_key", "voice"),
    ).toThrow(
      "a retell_chat_api connection speaks chat, and this one was asked for voice",
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
   * The endpoint's answer names the LiveKit server — `server_url` beside the
   * token, as LiveKit's own token endpoints answer — so a url held here would
   * be a second answer to a question the endpoint already settles.
   */
  it("holds no server url, and says which keys it holds", () => {
    expect(() => validConfig("livekit_room", "livekit_room.customer_token_endpoint", { ...AT, url: A_URL })).toThrow(
      'a token-endpoint livekit connection\'s config has no key "url"; ' +
        "it holds tokenEndpoint, agentName, metadata (optional)",
    );
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

  it("carries the worker's metadata when given, as a JSON object in a string", () => {
    expect(
      validConfig("livekit_room", "livekit_room.customer_token_endpoint", { ...AT, metadata: '{"tenant":"acme"}' }),
    ).toEqual({ ...AT, metadata: '{"tenant":"acme"}' });
    expect(() => validConfig("livekit_room", "livekit_room.customer_token_endpoint", { ...AT, metadata: "tenant=acme" })).toThrow(
      "the config's metadata must be a JSON object written in a string",
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

  /**
   * Dispatch reads the variant's list rather than the kind's, or a stored row
   * on a narrowed variant would be handed to a simulator for a modality the
   * door refused to write.
   */
  it("holds a narrowed access variant to what that variant speaks", () => {
    expect(
      connectionIsConductable(
        "livekit_room",
        "livekit_room.project_credentials",
        "chat",
      ),
    ).toBe(true);
    expect(
      connectionIsConductable(
        "livekit_room",
        "livekit_room.customer_token_endpoint",
        "chat",
      ),
    ).toBe(false);
    expect(
      connectionIsConductable(
        "livekit_room",
        "livekit_room.customer_token_endpoint",
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
      // Text mode and the web call both joined the conductable list with
      // the plugs that place them, in the registry's own order.
      "retell_text_mode",
      "retell_web_call",
      "phone_number",
      "livekit_room",
    ]);
  });
});
