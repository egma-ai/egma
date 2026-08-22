import {
  connectionOptionMetadata,
  credentialRuleOf,
  productLabelOf,
  accessVariantById,
} from "@egma/db";
import { describe, expect, it } from "vitest";

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
    expect(ruleOf("retell_chat_api.api_key")).toBe("required");
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

  it("marks an optional config key optional and a demanded one demanded", () => {
    const keyPair = connectionOptionMetadata().find(
      (one) => one.accessVariant === "livekit_room.project_credentials",
    );

    const fields = new Map(
      (keyPair?.fields ?? []).map((field) => [field.key, field]),
    );
    // A blank agent name is automatic dispatch, which is the state every
    // quickstart agent runs in — so demanding it would make somebody write a
    // value down to mean the default they already had.
    expect(fields.get("url")).toMatchObject({
      label: "LiveKit WebSocket URL",
      required: true,
    });
    expect(fields.get("agentName")).toMatchObject({
      label: "LiveKit agent name",
      required: false,
    });
    expect(fields.get("metadata")).toMatchObject({
      required: false,
      afterCredentials: true,
    });

    const endpoint = connectionOptionMetadata().find(
      (one) => one.accessVariant === "livekit_room.customer_token_endpoint",
    );
    expect(endpoint?.fields.find((field) => field.key === "url")?.label).toBe(
      "LiveKit WebSocket URL",
    );
  });

  it("reads each explicit stored access variant without inferring from config", () => {
    expect(
      credentialRuleOf(
        accessVariantById(
          "livekit_room",
          "livekit_room.customer_token_endpoint",
        ),
      ),
    ).toBe(
      "required",
    );
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

  it("answers the platform from the type, and null where the type spans them", () => {
    const byVariant = new Map(
      connectionOptionMetadata().map((one) => [one.accessVariant, one]),
    );

    // A chat connection is Retell's and a room connection is LiveKit's,
    // because nothing else answers those APIs.
    expect(byVariant.get("retell_chat_api.api_key")).toMatchObject({
      agentPlatform: "retell",
      agentPlatformLabel: "Retell",
      connectionType: "retell_chat_api",
      productLabel: "Retell chat",
    });
    expect(byVariant.get("livekit_room.project_credentials")).toMatchObject({
      agentPlatform: "livekit_agents",
      connectionType: "livekit_room",
    });

    // A number is where egma dials, not who answers, so it pins no platform
    // and appears once rather than once per platform.
    expect(byVariant.get("phone_number.public_e164")).toMatchObject({
      agentPlatform: null,
      agentPlatformLabel: "Any or unknown",
      connectionType: "phone_number",
      modality: "voice",
      productLabel: "Phone number",
    });
    expect(
      connectionOptionMetadata().filter(
        (one) => one.connectionType === "phone_number",
      ),
    ).toHaveLength(1);
  });

  it("refuses a tuple that is not one of the explicit supported ones", () => {
    expect(() =>
      productLabelOf("phone_number", "retell_chat_api.api_key", "voice"),
    ).toThrow(
      "connection type, access variant, and modality do not form a supported simulation connection",
    );
  });
});
