import {
  connectionOptionMetadata,
  credentialRuleOf,
  productLabelOf,
  accessVariantById,
} from "@egma/db";
import { describe, expect, it } from "vitest";

// Straight from the source, because these two are how the registry answers the
// question the catalog's guard asks, and neither belongs on the package
// surface: what a browser is handed is the projection, never the registry.
import {
  descriptorOf,
  modalitiesOf,
} from "../src/access/connection-registry.ts";

/**
 * The connection catalog a form is drawn from, and the rules that keep it honest.
 *
 * Neither reaches a store and neither names a customer, so both are exercised
 * as the pure value it is. What is under test is the contract a browser is
 * handed: that every gated key is described, that no gate, hint or secret can
 * cross, that the three credential rules are named the way the product's
 * refusals name them.
 */

describe("what a browser is told about a simulation connection", () => {
  it("describes every key its shapes gate, and gates every key it describes", () => {
    // The projection is built by reading the registry, and it refuses to
    // describe a shape whose two lists disagree. A gated key nobody described
    // would be a box a form never draws and a create that then refuses for the
    // missing value; a described key nothing gates would be a box whose answer
    // is silently dropped.
    expect(() => connectionOptionMetadata()).not.toThrow();

    for (const option of connectionOptionMetadata()) {
      expect(option.fields.length).toBeGreaterThan(0);
      for (const field of option.fields) {
        expect(field.key).not.toBe("");
        expect(field.label).not.toBe("");
        expect(field.help).not.toBe("");
        expect(["text", "url", "e164", "json"]).toContain(field.kind);
      }
    }
  });

  it("carries labels and shapes, and nothing that could be a gate or a secret", () => {
    // The projection travels as JSON, so a function cannot survive the trip.
    // What this holds is the shape *before* it is serialized: nothing in it is
    // callable, and nothing in it is a value somebody sealed.
    const seen = new Set<unknown>();
    const walk = (value: unknown): void => {
      if (typeof value === "function") {
        throw new Error("a function reached the safe projection");
      }
      if (typeof value !== "object" || value === null) return;
      if (seen.has(value)) return;
      seen.add(value);
      for (const held of Object.values(value as Record<string, unknown>)) {
        walk(held);
      }
    };

    expect(() => walk(connectionOptionMetadata())).not.toThrow();

    // And it says nothing about how a value is refused. Refusal wording is
    // written for a terminal and names egma's own rules.
    const written = JSON.stringify(connectionOptionMetadata());
    expect(written).not.toContain("not_admitted");
    expect(written).not.toContain("needs_a_name");
  });

  it("names each shape's credential rule in the words a Restore is held to", () => {
    const catalog = connectionOptionMetadata();
    const ruleOf = (accessVariant: string) =>
      catalog.find((one) => one.accessVariant === accessVariant)
        ?.credentialRule ?? "missing";

    // Three shapes, three rules, and each one is what its Restore demands: a
    // new credential, no credential, or an explicit choice between the two.
    // The chat-native door is dormant — no flow offers it — so the catalog a
    // form is drawn from does not carry it. The text door is the offered one.
    expect(ruleOf("retell_text_mode.api_key")).toBe("required");
    expect(ruleOf("phone_number.public_e164")).toBe("forbidden");
    expect(ruleOf("livekit_room.project_credentials")).toBe("required");
    expect(ruleOf("livekit_room.customer_token_endpoint")).toBe("required");
  });

  it("says a shape that takes no credential has no credential fields", () => {
    const phone = connectionOptionMetadata().find(
      (one) => one.accessVariant === "phone_number.public_e164",
    );
    expect(phone?.credentialRule).toBe("forbidden");
    expect(phone?.credentialFields).toEqual([]);
    // And still says why, because a person looking at an empty section needs
    // to know it is empty on purpose.
    expect(phone?.credentialHelp).not.toBe("");
  });

  it("marks every config key a form must demand, and lists no other", () => {
    const keyPair = connectionOptionMetadata().find(
      (one) => one.accessVariant === "livekit_room.project_credentials",
    );

    const fields = new Map(
      (keyPair?.fields ?? []).map((field) => [field.key, field]),
    );
    // The agent name is demanded because every egma dispatch is explicit:
    // the record must name the agent it graded, and a form that let somebody
    // skip the name would quietly hand the room to whichever worker was
    // listening.
    expect(fields.get("url")).toMatchObject({
      label: "LiveKit WebSocket URL",
      required: true,
    });
    expect(fields.get("agentName")).toMatchObject({
      label: "LiveKit agent name",
      required: true,
    });
    // And nothing else. The dispatch metadata that used to sit here as the
    // optional third key is a test's own `env.job_dispatch_metadata` now, so a
    // form drawn from this catalog must not ask a connection for it.
    expect([...fields.keys()]).toEqual(["url", "agentName"]);

    // The endpoint variant holds no server url — its endpoint answers with
    // one — and asks for the same worker name and metadata the key pair does.
    const endpoint = connectionOptionMetadata().find(
      (one) => one.accessVariant === "livekit_room.customer_token_endpoint",
    );
    expect(endpoint?.fields.map((field) => field.key)).toEqual([
      "tokenEndpoint",
      "agentName",
    ]);
    expect(
      endpoint?.fields.find((field) => field.key === "agentName"),
    ).toMatchObject({ label: "LiveKit agent name", required: true });
  });

  /**
   * The product-label table and the access variants' modality lists are two
   * lists that must agree, and they are held level by a loud refusal when the
   * catalog is built rather than by discipline. An option nobody caught would
   * be a combination a form offers, a browser sends, and the door then refuses
   * — the one failure a customer cannot do anything about.
   */
  it("offers no option a named access variant does not speak", () => {
    expect(() => connectionOptionMetadata()).not.toThrow();

    for (const option of connectionOptionMetadata()) {
      const descriptor = descriptorOf(option.connectionType);
      const variant = accessVariantById(
        option.connectionType,
        option.accessVariant,
      );
      expect(modalitiesOf(descriptor, variant)).toContain(option.modality);
    }
  });

  /**
   * The chat lane's whole product surface, as the catalog says it: one chat
   * row on each of the two ways in, each with its own label so a person can
   * tell the four LiveKit room options apart.
   */
  it("offers LiveKit chat on both access variants", () => {
    const livekit = connectionOptionMetadata().filter(
      (one) => one.connectionType === "livekit_room",
    );

    expect(
      livekit.map((one) => `${one.accessVariant}/${one.modality}`),
    ).toEqual([
      "livekit_room.project_credentials/voice",
      "livekit_room.project_credentials/chat",
      "livekit_room.customer_token_endpoint/voice",
      "livekit_room.customer_token_endpoint/chat",
    ]);

    expect(
      livekit.find(
        (one) =>
          one.accessVariant === "livekit_room.project_credentials" &&
          one.modality === "chat",
      ),
    ).toMatchObject({
      agentPlatform: "livekit",
      productLabel: "LiveKit chat",
      topology: "agent-dials-out",
      credentialRule: "required",
    });

    expect(
      livekit.find(
        (one) =>
          one.accessVariant === "livekit_room.customer_token_endpoint" &&
          one.modality === "chat",
      ),
    ).toMatchObject({
      agentPlatform: "livekit",
      productLabel: "LiveKit chat token endpoint",
      topology: "agent-dials-out",
      credentialRule: "required",
    });
  });

  it("reads each explicit stored access variant without inferring from config", () => {
    expect(
      credentialRuleOf(
        accessVariantById(
          "livekit_room",
          "livekit_room.customer_token_endpoint",
        ),
      ),
    ).toBe("required");
    expect(
      credentialRuleOf(
        accessVariantById("livekit_room", "livekit_room.project_credentials"),
      ),
    ).toBe("required");
  });

  it("refuses a stored shape this egma has never heard of, naming what it holds", () => {
    // A row written by a later release. It is a fault rather than a refusal —
    // nothing the caller sent is wrong — and it says enough to go and find it.
    expect(() => accessVariantById("retell_chat_api", "retell.oauth")).toThrow(
      /retell\.oauth.*retell_chat_api\.api_key/s,
    );
  });

  it("keeps platform, connection, access, modality, and product label separate", () => {
    expect(connectionOptionMetadata()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentPlatform: "retell",
          connectionType: "phone_number",
          accessVariant: "phone_number.public_e164",
          modality: "voice",
          productLabel: "Retell phone",
        }),
        expect.objectContaining({
          agentPlatform: null,
          connectionType: "phone_number",
          accessVariant: "phone_number.public_e164",
          modality: "voice",
          productLabel: "Phone number",
        }),
      ]),
    );
  });

  it("refuses a platform that is not part of an explicit supported tuple", () => {
    expect(() =>
      productLabelOf(
        "vapi" as never,
        "phone_number",
        "phone_number.public_e164",
        "voice",
      ),
    ).toThrow(
      "agent platform, connection type, access variant, and modality do not form a supported simulation connection",
    );
  });
});
