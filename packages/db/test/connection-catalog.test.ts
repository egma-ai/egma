import {
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
  admittedCapabilities,
  connectionTypeMetadata,
  credentialRuleOf,
  hasCapabilityDiscovery,
  isCapabilityKey,
  registerCapabilityDiscovery,
  variantById,
  variantIdOf,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The two catalogs a form is drawn from, and the rules that keep them honest.
 *
 * Neither reaches a store and neither names a customer, so both are exercised
 * as the pure values they are. What is under test is the contract a browser is
 * handed: that every gated key is described, that no gate, hint or secret can
 * cross, that the three credential rules are named the way the product's
 * refusals name them, and that a capability key nobody offered is refused
 * rather than stored.
 */

describe("what a browser is told about a connection type", () => {
  it("describes every key its shapes gate, and gates every key it describes", () => {
    // The projection is built by reading the registry, and it refuses to
    // describe a shape whose two lists disagree. A gated key nobody described
    // would be a box a form never draws and a create that then refuses for the
    // missing value; a described key nothing gates would be a box whose answer
    // is silently dropped.
    expect(() => connectionTypeMetadata()).not.toThrow();

    for (const type of connectionTypeMetadata()) {
      for (const variant of type.variants) {
        expect(variant.fields.length).toBeGreaterThan(0);
        for (const field of variant.fields) {
          expect(field.key).not.toBe("");
          expect(field.label).not.toBe("");
          expect(field.help).not.toBe("");
          expect(["text", "url", "e164", "json"]).toContain(field.kind);
        }
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

    expect(() => walk(connectionTypeMetadata())).not.toThrow();

    // And it says nothing about how a value is refused. Refusal wording is
    // written for a terminal and names egma's own rules.
    const written = JSON.stringify(connectionTypeMetadata());
    expect(written).not.toContain("not_admitted");
    expect(written).not.toContain("needs_a_name");
  });

  it("names each shape's credential rule in the words a Restore is held to", () => {
    const catalog = connectionTypeMetadata();
    const ruleOf = (type: string, variantId: string) =>
      catalog
        .find((one) => one.type === type)
        ?.variants.find((one) => one.id === variantId)?.credentialRule ??
      "missing";

    // Three shapes, three rules, and each one is what its Restore demands: a
    // new credential, no credential, or an explicit choice between the two.
    expect(ruleOf("retell", "retell.api_key")).toBe("required");
    expect(ruleOf("phone", "phone.number")).toBe("forbidden");
    expect(ruleOf("livekit", "livekit.key_pair")).toBe("required");
    expect(ruleOf("livekit", "livekit.token_endpoint")).toBe("optional");
  });

  it("says a shape that takes no credential has no credential fields", () => {
    const phone = connectionTypeMetadata().find((one) => one.type === "phone");
    const only = phone?.variants[0];
    expect(only?.credentialRule).toBe("forbidden");
    expect(only?.credentialFields).toEqual([]);
    // And still says why, because a person looking at an empty section needs
    // to know it is empty on purpose.
    expect(only?.credentialHelp).not.toBe("");
  });

  it("marks an optional config key optional and a demanded one demanded", () => {
    const keyPair = connectionTypeMetadata()
      .find((one) => one.type === "livekit")
      ?.variants.find((one) => one.id === "livekit.key_pair");

    const required = new Map(
      (keyPair?.fields ?? []).map((field) => [field.key, field.required]),
    );
    // A blank agent name is automatic dispatch, which is the state every
    // quickstart agent runs in — so demanding it would make somebody write a
    // value down to mean the default they already had.
    expect(required.get("url")).toBe(true);
    expect(required.get("agentName")).toBe(false);
    expect(required.get("metadata")).toBe(false);
  });

  it("says which shape a config lands in, and reads a stored one back", () => {
    // A config naming the discriminating key lands on that shape; one naming
    // none lands on the type's first.
    expect(variantIdOf("livekit", { url: "wss://x.livekit.cloud" })).toBe(
      "livekit.key_pair",
    );
    expect(
      variantIdOf("livekit", {
        url: "wss://x.livekit.cloud",
        tokenEndpoint: "https://x.example/token",
      }),
    ).toBe("livekit.token_endpoint");

    // And a stored id reads back to the same shape without the config being
    // consulted — which is the whole point of storing it.
    expect(credentialRuleOf(variantById("livekit", "livekit.token_endpoint"))).toBe(
      "optional",
    );
    expect(credentialRuleOf(variantById("livekit", "livekit.key_pair"))).toBe(
      "required",
    );
  });

  it("refuses a stored shape this egma has never heard of, naming what it holds", () => {
    // A row written by a later release. It is a fault rather than a refusal —
    // nothing the caller sent is wrong — and it says enough to go and find it.
    expect(() => variantById("retell", "retell.oauth")).toThrow(
      /retell\.oauth.*retell\.api_key/s,
    );
  });
});

describe("the capability catalog", () => {
  it("is one list, and every key on it carries words a person can act on", () => {
    expect(CAPABILITY_CATALOG.length).toBeGreaterThan(0);
    for (const entry of CAPABILITY_CATALOG) {
      expect(entry.key).toMatch(/^[a-z][a-z_]*$/);
      expect(entry.label).not.toBe("");
      expect(entry.description).not.toBe("");
      expect(isCapabilityKey(entry.key)).toBe(true);
    }
    expect(new Set(CAPABILITY_KEYS).size).toBe(CAPABILITY_KEYS.length);
  });

  it("refuses a key it does not hold, in the product's own sentence", () => {
    expect(() => admittedCapabilities(["dtmf", "telepathy"])).toThrow(
      "Capability telepathy is not in this Egma capability catalog. Choose a " +
        "capability offered by the test editor and save the test again.",
    );
  });

  it("refuses the whole set rather than admitting the half it recognised", () => {
    // A partial save would be egma quietly deciding which half of somebody's
    // requirement mattered, and the test would run claiming to need less than
    // it says it needs.
    expect(() => admittedCapabilities(["telepathy", "dtmf"])).toThrow();
    expect(admittedCapabilities(["dtmf", "dtmf", "barge_in"])).toEqual([
      "dtmf",
      "barge_in",
    ]);
  });
});

describe("the capability discovery seam", () => {
  const installed: string[] = [];

  afterEach(() => {
    for (const type of installed.splice(0)) {
      registerCapabilityDiscovery(type as "retell", undefined);
    }
  });

  it("ships empty, and says so rather than claiming an adapter it has not got", () => {
    // Discovery has to reach a real target and report what it found. None of
    // the three shipped types has a fact egma can establish without inferring
    // one from the provider's brand, and inferring is the one thing this rule
    // forbids — so the seam is real and empty, and an entry lands here in the
    // same commit as the adapter that earns it.
    for (const type of connectionTypeMetadata()) {
      expect(type.capabilityDiscovery).toBe(false);
      expect(hasCapabilityDiscovery(type.type)).toBe(false);
    }
  });

  it("shows up in what a browser is told the moment one is installed", () => {
    registerCapabilityDiscovery("retell", async () => ["dtmf"]);
    installed.push("retell");

    const described = connectionTypeMetadata().find(
      (one) => one.type === "retell",
    );
    expect(described?.capabilityDiscovery).toBe(true);

    // And the two facts stay separate: whether egma can conduct a run over a
    // type and whether it can measure one of its targets are different
    // questions with different answers.
    expect(described?.simulatorAdapter).toBe(true);
  });
});
