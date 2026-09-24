import { AgentWriteRefusedError, laneProducesAnAgentPov, LANES_SERVING_MOCK_TOOLS } from "@egma/db";
import { describe, expect, it } from "vitest";

import {
  conductableConnectionTypes,
  connectionIsConductable,
  connectionOptionMetadata,
  descriptorOf,
  platformOfConnectionType,
  productLabelOf,
  startUrlIdentity,
  validConfig,
  validCredentials,
  validModality,
} from "../src/access/connection-registry.ts";
import { allowanceKindOf } from "../src/billing/allowance.ts";

/**
 * A Pipecat bot is reached through a Daily room that a starter makes: Pipecat
 * Cloud's start API with the agent's name and a public key, or the customer's
 * own start URL with auth headers. These tests hold the registry's side of that
 * — what each variant stores, what it refuses, what a form is told, and which
 * identity two registrations share.
 */

const CLOUD = "daily_room.pipecat_cloud";
const SELF_HOSTED = "daily_room.self_hosted";
const A_PUBLIC_KEY = "pk_live_1a2b3c4d5e6f7g8h";
const A_START_URL = "https://bots.lakeside.example/start";
const HEADERS = '{"Authorization":"Bearer starter-secret-0001"}';

function refusalOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentWriteRefusedError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal and got none");
}

describe("what a daily_room connection is", () => {
  it("is pinned to Pipecat, speaks voice and chat, and is brokered by a starter", () => {
    const descriptor = descriptorOf("daily_room");
    expect(descriptor.agentPlatforms).toEqual(["pipecat"]);
    expect(descriptor.modalities).toEqual(["voice", "chat"]);
    expect(descriptor.topology).toBe("hosted-broker");
    expect(descriptor.simulatorAdapter).toBe(true);
    expect(descriptor.usesPlatformCarrier).toBe(false);
    expect(descriptor.accessVariants.map((variant) => variant.id)).toEqual([
      CLOUD,
      SELF_HOSTED,
    ]);
    expect(platformOfConnectionType("daily_room")).toBe("pipecat");
  });

  it("is conducted in both modalities on both variants", () => {
    expect(conductableConnectionTypes()).toContain("daily_room");
    for (const variant of [CLOUD, SELF_HOSTED]) {
      for (const modality of ["voice", "chat"]) {
        expect(connectionIsConductable("daily_room", variant, modality)).toBe(true);
        expect(validModality("daily_room", variant, modality)).toBe(modality);
      }
    }
  });

  it("serves mock tools and supplies the agent's own record", () => {
    expect(LANES_SERVING_MOCK_TOOLS).toContain("daily_room");
    expect(laneProducesAnAgentPov("daily_room")).toBe(true);
  });

  it("is billed as web-call minutes for voice and chat simulations for chat", () => {
    expect(allowanceKindOf({ modality: "voice", connectionType: "daily_room" })).toBe(
      "web_call_minutes",
    );
    expect(allowanceKindOf({ modality: "chat", connectionType: "daily_room" })).toBe(
      "chat_simulations",
    );
  });
});

describe("the Pipecat rows of the connection catalog", () => {
  const pipecat = connectionOptionMetadata().filter(
    (option) => option.agentPlatform === "pipecat",
  );

  it("offers both variants in both modalities under their product labels", () => {
    expect(
      pipecat.map((option) => [option.accessVariant, option.modality, option.productLabel]),
    ).toEqual([
      [CLOUD, "voice", "Pipecat Cloud"],
      [CLOUD, "chat", "Pipecat Cloud chat"],
      [SELF_HOSTED, "voice", "Pipecat self-hosted"],
      [SELF_HOSTED, "chat", "Pipecat self-hosted chat"],
    ]);
    for (const option of pipecat) {
      expect(option.agentPlatformLabel).toBe("Pipecat");
      expect(option.connectionType).toBe("daily_room");
      expect(option.topology).toBe("hosted-broker");
      expect(option.simulatorAdapter).toBe(true);
      expect(option.credentialRule).toBe("required");
    }
  });

  it("asks for one field and one credential per variant, each with its help", () => {
    const cloud = pipecat.find((option) => option.accessVariant === CLOUD);
    const selfHosted = pipecat.find((option) => option.accessVariant === SELF_HOSTED);
    expect(cloud?.accessVariantLabel).toBe("Pipecat Cloud");
    expect(cloud?.fields).toEqual([
      {
        key: "agentName",
        label: "Pipecat Cloud agent name",
        kind: "text",
        help: "As in pcc-deploy.toml.",
        required: true,
      },
    ]);
    expect(cloud?.credentialFields).toEqual([
      {
        field: "publicApiKey",
        label: "Public API key",
        kind: "secret",
        help: "Starts with pk_.",
        required: true,
      },
    ]);
    expect(cloud?.credentialHelp).toBe(
      "Egma starts your agent with this public key and stores it sealed. " +
        "A read gives back its last four characters, never the key.",
    );

    expect(selfHosted?.accessVariantLabel).toBe("Self-hosted");
    expect(selfHosted?.fields).toEqual([
      {
        key: "startUrl",
        label: "Start URL",
        kind: "url",
        help: "Public HTTPS URL of your bot starter.",
        required: true,
      },
    ]);
    expect(selfHosted?.credentialFields).toEqual([
      {
        field: "headers",
        label: "Auth headers",
        kind: "json",
        help: "Sent with every start request.",
        required: true,
      },
    ]);
    expect(selfHosted?.credentialHelp).toBe(
      "Egma sends these headers with every start request and stores them " +
        "sealed. A read gives back the header names and never their values.",
    );
  });

  it("refuses a Pipecat tuple on another platform", () => {
    expect(() =>
      productLabelOf("livekit", "daily_room", CLOUD, "voice"),
    ).toThrow(AgentWriteRefusedError);
    expect(productLabelOf("pipecat", "daily_room", SELF_HOSTED, "chat")).toBe(
      "Pipecat self-hosted chat",
    );
  });
});

describe("a Pipecat Cloud connection", () => {
  it("stores the agent name trimmed", () => {
    expect(validConfig("daily_room", CLOUD, { agentName: "  lakeside-front-desk " })).toEqual({
      agentName: "lakeside-front-desk",
    });
  });

  it("refuses an agent name that could not be one path segment", () => {
    for (const agentName of ["", "   ", "two words", "a/b", "../start", "-leading", "x?y"]) {
      const message = refusalOf(() => validConfig("daily_room", CLOUD, { agentName }));
      expect(message).toBe(
        "the config's agentName must be a Pipecat Cloud agent name, like my-voice-agent: letters, digits, dots, dashes and underscores",
      );
    }
  });

  it("holds no start URL", () => {
    expect(
      refusalOf(() =>
        validConfig("daily_room", CLOUD, { agentName: "a", startUrl: A_START_URL }),
      ),
    ).toBe('a Pipecat Cloud connection\'s config has no key "startUrl"; it holds agentName');
  });

  it("seals the public key and hints its last four characters", () => {
    expect(
      validCredentials("daily_room", CLOUD, { publicApiKey: ` ${A_PUBLIC_KEY} ` }),
    ).toEqual({ sealed: { publicApiKey: A_PUBLIC_KEY }, hint: "7g8h" });
  });

  it("refuses a private key by name, and any other key as not a public one", () => {
    expect(
      refusalOf(() =>
        validCredentials("daily_room", CLOUD, { publicApiKey: "sk_live_1a2b3c4d5e6f" }),
      ),
    ).toBe(
      "a Pipecat Cloud connection's credentials need publicApiKey to be the public API key, which starts with pk_; a private key (sk_) is never needed",
    );
    for (const publicApiKey of ["1a2b3c4d5e6f7g8h", "", "pk_1"]) {
      const message = refusalOf(() =>
        validCredentials("daily_room", CLOUD, { publicApiKey }),
      );
      expect(message).toBe(
        "a Pipecat Cloud connection's credentials need publicApiKey to be a Pipecat Cloud public API key, which starts with pk_",
      );
    }
  });

  it("tells a caller who sent the other variant's credentials which door is which", () => {
    const mixedUp =
      "a Pipecat Cloud connection starts your agent with its public API key, so its credentials are shaped { publicApiKey }. Send that, or use daily_room.self_hosted with a startUrl and { headers }.";
    expect(refusalOf(() => validCredentials("daily_room", CLOUD, { headers: HEADERS }))).toBe(
      mixedUp,
    );
    expect(refusalOf(() => validCredentials("daily_room", CLOUD, undefined))).toBe(mixedUp);
  });
});

describe("a self-hosted Pipecat connection", () => {
  it("stores a public https start URL as it was written", () => {
    expect(validConfig("daily_room", SELF_HOSTED, { startUrl: ` ${A_START_URL} ` })).toEqual({
      startUrl: A_START_URL,
    });
    expect(
      validConfig("daily_room", SELF_HOSTED, {
        startUrl: "https://quiet-river-1234.trycloudflare.com/start",
      }),
    ).toEqual({ startUrl: "https://quiet-river-1234.trycloudflare.com/start" });
  });

  it("refuses a start URL that is not public https, with the token endpoint's rules", () => {
    for (const startUrl of [
      "http://bots.example.com/start",
      "https://localhost:7860/start",
      "https://bots.localhost/start",
      "https://127.0.0.1/start",
      "https://[::1]/start",
      "https://user:pass@bots.example.com/start",
      "bots.example.com/start",
    ]) {
      expect(refusalOf(() => validConfig("daily_room", SELF_HOSTED, { startUrl }))).toBe(
        "the config's startUrl must be a public https URL, which looks like https://bots.example.com/start",
      );
    }
  });

  it("seals the auth headers and hints only their names", () => {
    expect(
      validCredentials("daily_room", SELF_HOSTED, {
        headers: '{"Authorization":"Bearer starter-secret-0001","X-Tenant":"acme"}',
      }),
    ).toEqual({
      sealed: { headers: '{"Authorization":"Bearer starter-secret-0001","X-Tenant":"acme"}' },
      hint: "Authorization, X-Tenant",
    });
  });

  it("requires headers, shaped as the token endpoint's", () => {
    for (const headers of ["{}", "[]", '{"Authorization":""}', "not json"]) {
      const message = refusalOf(() => validCredentials("daily_room", SELF_HOSTED, { headers }));
      expect(message).toBe(
        'a self-hosted Pipecat connection\'s credentials need headers to be a JSON object of header name to header value, written in a string, which looks like {"Authorization":"Bearer …"}',
      );
      expect(message).not.toContain("starter-secret");
    }
    expect(refusalOf(() => validCredentials("daily_room", SELF_HOSTED, undefined))).toBe(
      "a self-hosted Pipecat connection sends the start request to your startUrl with your auth headers, so its credentials are shaped { headers }. Send those, or use daily_room.pipecat_cloud with an agentName and { publicApiKey }.",
    );
  });
});

describe("the identity two Pipecat registrations share", () => {
  const identityOf = (config: Record<string, string>) =>
    descriptorOf("daily_room").reuse?.identityOf(config);

  it("is the agent name on Pipecat Cloud", () => {
    expect(descriptorOf("daily_room").reuse?.matchedKeys).toEqual([]);
    expect(identityOf({ agentName: "front-desk" })).toBe("pipecat-cloud|front-desk");
  });

  it("is the start URL's host and path when self-hosted, scheme and query dropped", () => {
    expect(identityOf({ startUrl: "https://Bots.Example.com./start?x=1" })).toBe(
      "self-hosted|bots.example.com/start",
    );
    expect(identityOf({ startUrl: "https://bots.example.com:8443/v2/start" })).toBe(
      "self-hosted|bots.example.com:8443/v2/start",
    );
    expect(startUrlIdentity("not a url")).toBe("not a url");
  });

  it("is nothing for a config with neither key", () => {
    expect(identityOf({})).toBeUndefined();
  });
});
