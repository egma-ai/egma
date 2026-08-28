import { describe, expect, it } from "vitest";

import {
  accessVariantById,
  connectionIsConductable,
  connectionOptionMetadata,
  descriptorOf,
  productLabelOf,
  validConfig,
  validCredentials,
  validModality,
} from "../src/access/connection-registry.ts";
import { CONNECTION_TYPES, ACCESS_VARIANTS } from "../src/schema/agents.ts";

/**
 * The playground door, by refusal table.
 *
 * Pure functions over a payload, with no database anywhere near them: what is
 * under test is what a person is told when they get it wrong, and what a
 * browser is handed when they get it right.
 */

const KIND = "retell_playground";
const VARIANT = "retell_playground.api_key";
const AGENT = "agent_b0e2e9cb267c47e7e7026cd8e8";
const A_KEY = "key_e2e9cb267c47e7e7026cd8e8";

describe("what a Retell playground connection is made of", () => {
  it("is a chat door onto a Retell agent, brokered by Retell", () => {
    const descriptor = descriptorOf(KIND);
    expect(descriptor.label).toBe("Retell playground");
    expect(descriptor.agentPlatforms).toEqual(["retell"]);
    expect(descriptor.modalities).toEqual(["chat"]);
    expect(descriptor.topology).toBe("hosted-broker");
    expect(descriptor.usesPlatformCarrier).toBe(false);
  });

  it("reuses the agent the voice connection already named", () => {
    // Chat and voice land as two connections on one Egma agent, so the
    // comparison the domain model promises is between two histories of one
    // identity rather than between twins.
    expect(descriptorOf(KIND).reuseKey).toBe("retellAgentId");
    expect(descriptorOf("retell_web_call").reuseKey).toBe("retellAgentId");
  });

  it("is in the schema's two lists, so a row can carry it at all", () => {
    expect(CONNECTION_TYPES).toContain(KIND);
    expect(ACCESS_VARIANTS).toContain(VARIANT);
  });
});

describe("the playground row in the connection options", () => {
  it("is offered, labelled 'Retell playground', on chat", () => {
    const row = connectionOptionMetadata().find(
      (option) => option.connectionType === KIND,
    );
    expect(row).toBeDefined();
    expect(row?.agentPlatform).toBe("retell");
    expect(row?.agentPlatformLabel).toBe("Retell");
    expect(row?.accessVariant).toBe(VARIANT);
    expect(row?.modality).toBe("chat");
    expect(row?.productLabel).toBe("Retell playground");
    expect(row?.credentialRule).toBe("required");
    expect(row?.usesPlatformCarrier).toBe(false);
  });

  it("describes exactly the two config fields it gates", () => {
    const row = connectionOptionMetadata().find(
      (option) => option.connectionType === KIND,
    );
    expect(row?.fields.map((field) => [field.key, field.required])).toEqual([
      ["retellAgentId", true],
      ["baseUrl", false],
    ]);
    expect(row?.credentialFields.map((field) => field.field)).toEqual([
      "apiKey",
    ]);
  });

  it("answers its product label for the exact supported tuple", () => {
    expect(productLabelOf("retell", KIND, VARIANT, "chat")).toBe(
      "Retell playground",
    );
  });

  it("refuses the same tuple asked for on voice", () => {
    // A playground exchange synthesizes nothing and hears nothing. Voice is a
    // phone or a web-call connection beside this one, never this one.
    expect(() => productLabelOf("retell", KIND, VARIANT, "voice")).toThrow(
      /do not form a supported simulation connection/u,
    );
  });
});

describe("the playground door's refusals", () => {
  it("takes the agent id on its own, which is the ordinary case", () => {
    expect(validConfig(KIND, VARIANT, { retellAgentId: AGENT })).toEqual({
      retellAgentId: AGENT,
    });
  });

  it("takes a Retell API URL beside it, stored as it was written", () => {
    expect(
      validConfig(KIND, VARIANT, {
        retellAgentId: AGENT,
        baseUrl: "https://retell-proxy.acme.example/",
      }),
    ).toEqual({
      retellAgentId: AGENT,
      baseUrl: "https://retell-proxy.acme.example/",
    });
  });

  it("names an unknown config key, and says which of its own are optional", () => {
    expect(() =>
      validConfig(KIND, VARIANT, {
        retellAgentId: AGENT,
        retellAgentID: AGENT,
      }),
    ).toThrow(
      'a Retell playground connection\'s config has no key "retellAgentID"; ' +
        "it holds retellAgentId, baseUrl (optional)",
    );
  });

  it("demands the agent id by name when it is missing", () => {
    expect(() => validConfig(KIND, VARIANT, {})).toThrow(
      "a Retell playground connection's config needs retellAgentId",
    );
  });

  it("refuses a base URL that is not an http or https address", () => {
    for (const baseUrl of [
      "api.retellai.com",
      "wss://api.retellai.com",
      "ftp://api.retellai.com",
      "https:api.retellai.com",
      "https://user:secret@api.retellai.com",
      "https://",
      "",
    ]) {
      expect(
        () => validConfig(KIND, VARIANT, { retellAgentId: AGENT, baseUrl }),
        `baseUrl ${JSON.stringify(baseUrl)}`,
      ).toThrow(/must be an http or https URL/u);
    }
  });

  it("admits a loopback address, which is what the key is for", () => {
    // A test conversing with a Retell-shaped server, and a deployment whose
    // outbound traffic goes through its own proxy. Refusing these would refuse
    // the two cases the key exists for.
    expect(
      validConfig(KIND, VARIANT, {
        retellAgentId: AGENT,
        baseUrl: "http://127.0.0.1:8787",
      }),
    ).toEqual({ retellAgentId: AGENT, baseUrl: "http://127.0.0.1:8787" });
  });

  it("refuses a garbage modality as not a modality at all", () => {
    expect(() => validModality(KIND, "telepathy")).toThrow(
      '"telepathy" is not a modality; a retell_playground connection speaks chat',
    );
  });

  it("refuses voice by naming what it does speak", () => {
    expect(() => validModality(KIND, "voice")).toThrow(
      "a retell_playground connection speaks chat, and this one was asked for voice",
    );
  });

  it("seals the API key and hints at its last four characters", () => {
    const sealed = validCredentials(KIND, VARIANT, { apiKey: A_KEY });
    expect(sealed?.sealed).toEqual({ apiKey: A_KEY });
    expect(sealed?.hint).toBe(A_KEY.slice(-4));
  });

  it("refuses a credential block with a key that does not belong", () => {
    expect(() =>
      validCredentials(KIND, VARIANT, { apiKey: A_KEY, apiSecret: A_KEY }),
    ).toThrow(
      'a Retell playground connection\'s credentials have no key "apiSecret"; ' +
        "they are shaped { apiKey }",
    );
  });

  it("demands a credential, because there is no other way in", () => {
    expect(() => validCredentials(KIND, VARIANT, undefined)).toThrow(
      "a Retell playground connection needs credentials shaped { apiKey }",
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

  it("names its one access variant, and refuses one it has never heard of", () => {
    expect(accessVariantById(KIND, VARIANT).label).toBe("Retell API key");
    expect(() => accessVariantById(KIND, "retell_playground.oauth")).toThrow(
      /is not one this Egma instance knows/u,
    );
  });
});

describe("what the shipped simulator can conduct over the playground", () => {
  it("says exactly what the shipped plug registry says", () => {
    // The registry may not claim what no code can run. This flips to `true` in
    // the same commit as the `retell_playground` plug, and until then a run
    // over such a connection is refused at creation rather than queued forever
    // for a conductor that does not exist.
    const shipped = descriptorOf(KIND).simulatorAdapter;
    expect(
      connectionIsConductable(KIND, VARIANT, "chat"),
    ).toBe(shipped);
    // Whatever the flag says, the modality check still stands on its own.
    expect(connectionIsConductable(KIND, VARIANT, "voice")).toBe(false);
    expect(
      connectionIsConductable(KIND, "retell_chat_api.api_key", "chat"),
    ).toBe(false);
  });
});
