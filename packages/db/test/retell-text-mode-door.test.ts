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

describe("what a Retell text mode connection is made of", () => {
  it("is a chat door onto a Retell agent, brokered by Retell", () => {
    const descriptor = descriptorOf(KIND);
    expect(descriptor.label).toBe("Retell text mode");
    expect(descriptor.agentPlatforms).toEqual(["retell"]);
    expect(descriptor.modalities).toEqual(["chat"]);
    expect(descriptor.topology).toBe("hosted-broker");
    expect(descriptor.usesPlatformCarrier).toBe(false);
  });

  it("reuses the agent the voice connection already named", () => {
    // Chat and voice land as two connections on one Egma agent, so the
    // comparison the domain model promises is between two histories of one
    // identity rather than between twins.
    expect(descriptorOf(KIND).reuse?.family).toBe("retellAgentId");
    expect(descriptorOf("retell_web_call").reuse?.family).toBe("retellAgentId");
    expect(descriptorOf("retell_chat_api").reuse?.family).toBe("retellAgentId");
  });

  it("is in the schema's two lists, so a row can carry it at all", () => {
    expect(CONNECTION_TYPES).toContain(KIND);
    expect(ACCESS_VARIANTS).toContain(VARIANT);
  });
});

describe("text mode row in the connection options", () => {
  it("is offered, labelled 'Retell text mode', on chat", () => {
    const row = connectionOptionMetadata().find(
      (option) => option.connectionType === KIND,
    );
    expect(row).toBeDefined();
    expect(row?.agentPlatform).toBe("retell");
    expect(row?.agentPlatformLabel).toBe("Retell");
    expect(row?.accessVariant).toBe(VARIANT);
    expect(row?.modality).toBe("chat");
    expect(row?.productLabel).toBe("Retell text mode");
    expect(row?.credentialRule).toBe("required");
    expect(row?.usesPlatformCarrier).toBe(false);
  });

  it("describes exactly the one config field it gates", () => {
    const row = connectionOptionMetadata().find(
      (option) => option.connectionType === KIND,
    );
    expect(row?.fields.map((field) => [field.key, field.required])).toEqual([
      ["retellAgentId", true],
    ]);
    expect(row?.credentialFields.map((field) => field.field)).toEqual([
      "apiKey",
    ]);
  });

  it("answers its product label for the exact supported tuple", () => {
    expect(productLabelOf("retell", KIND, VARIANT, "chat")).toBe(
      "Retell text mode",
    );
  });

  it("refuses the same tuple asked for on voice", () => {
    // A text-mode exchange synthesizes nothing and hears nothing. Voice is a
    // phone or a web-call connection beside this one, never this one.
    expect(() => productLabelOf("retell", KIND, VARIANT, "voice")).toThrow(
      /do not form a supported simulation connection/u,
    );
  });
});

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
    // plug's own seam, exactly as `retell_chat_api` does, and nothing persists
    // it.
    expect(() =>
      validConfig(KIND, VARIANT, {
        retellAgentId: AGENT,
        baseUrl: "https://retell-proxy.acme.example/",
      }),
    ).toThrow('a Retell text mode connection\'s config has no key "baseUrl"');
  });

  it("names an unknown config key, and says which of its own are optional", () => {
    expect(() =>
      validConfig(KIND, VARIANT, {
        retellAgentId: AGENT,
        retellAgentID: AGENT,
      }),
    ).toThrow(
      'a Retell text mode connection\'s config has no key "retellAgentID"; ' +
        "it holds retellAgentId",
    );
  });

  it("demands the agent id by name when it is missing", () => {
    expect(() => validConfig(KIND, VARIANT, {})).toThrow(
      "a Retell text mode connection's config needs retellAgentId",
    );
  });

  it("refuses a garbage modality as not a modality at all", () => {
    expect(() => validModality(KIND, VARIANT, "telepathy")).toThrow(
      '"telepathy" is not a modality; a retell_text_mode connection speaks chat',
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

  it("refuses a credential block with a key that does not belong", () => {
    expect(() =>
      validCredentials(KIND, VARIANT, { apiKey: A_KEY, apiSecret: A_KEY }),
    ).toThrow(
      'a Retell text mode connection\'s credentials have no key "apiSecret"; ' +
        "they are shaped { apiKey }",
    );
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

  it("names its one access variant, and refuses one it has never heard of", () => {
    expect(accessVariantById(KIND, VARIANT).label).toBe("Retell API key");
    expect(() => accessVariantById(KIND, "retell_text_mode.oauth")).toThrow(
      /is not one this Egma instance knows/u,
    );
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
      connectionIsConductable(KIND, "retell_chat_api.api_key", "chat"),
    ).toBe(false);
  });
});
