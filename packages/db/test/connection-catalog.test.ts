import {
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
  admittedCapabilities,
  connectionTypeMetadata,
  credentialRuleOf,
  hasCapabilityDiscovery,
  isCapabilityKey,
  capabilityStanding,
  measuredCapabilities,
  registerCapabilityDiscovery,
  transportCapabilities,
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
    expect(ruleOf("livekit", "livekit.token_endpoint")).toBe("required");
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

    const endpoint = connectionTypeMetadata()
      .find((one) => one.type === "livekit")
      ?.variants.find((one) => one.id === "livekit.token_endpoint");
    expect(endpoint?.fields.find((field) => field.key === "url")?.label).toBe(
      "LiveKit WebSocket URL",
    );
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
      "required",
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
      registerCapabilityDiscovery(type as "retell", transportCapabilities);
    }
  });

  it("carries an adapter for every type egma can reach", () => {
    for (const type of connectionTypeMetadata()) {
      expect(type.capabilityDiscovery, type.type).toBe(true);
      expect(hasCapabilityDiscovery(type.type), type.type).toBe(true);
    }
  });

  it("says whether there is audio, from egma's transport and never from a brand", () => {
    // The distinction the no-brand-guessing rule is actually about. "Retell
    // supports audio" is a sentence about a company. "A voice simulation holds
    // PCM both ways and a chat simulation is text" is a sentence about egma's
    // own code, and it is true of the target as egma will reach it — which is
    // the only sense in which a capability decides whether a test can run.
    const target = (type: "retell" | "phone" | "livekit", modality: "voice" | "chat") =>
      ({ type, variantId: `${type}.x`, modality, config: {} }) as const;

    return Promise.all([
      transportCapabilities(target("retell", "chat")),
      transportCapabilities(target("retell", "voice")),
      transportCapabilities(target("phone", "voice")),
      transportCapabilities(target("livekit", "voice")),
    ]).then(([chat, spokenRetell, phone, livekit]) => {
      expect(chat.supported).toEqual([]);
      // The same type answers differently by modality, which is the proof that
      // the answer is not coming from the type's name.
      expect(spokenRetell.supported).toEqual(["raw_audio"]);
      expect(phone.supported).toEqual(["raw_audio"]);
      expect(livekit.supported).toEqual(["raw_audio"]);
    });
  });

  it("never claims egma can press a digit, over any transport", async () => {
    // There is no way to send DTMF anywhere in the simulator, so this is
    // measured and unsupported rather than unknown — a test that needs a phone
    // menu is skipped for a reason somebody can act on.
    for (const type of ["retell", "phone", "livekit"] as const) {
      for (const modality of ["voice", "chat"] as const) {
        const found = await transportCapabilities({
          type,
          variantId: `${type}.x`,
          modality,
          config: {},
        });
        expect(found.supported, `${type}/${modality}`).not.toContain("dtmf");
        // Measured, so its absence is a fact about egma's transport rather than
        // a question nobody asked.
        expect(found.measured, `${type}/${modality}`).toContain("dtmf");
      }
    }
  });

  it("answers nothing for a type whose adapter has been taken away", () => {
    registerCapabilityDiscovery("retell", undefined);
    installed.push("retell");

    // The state a type added ahead of its adapter is in. It is told plainly
    // rather than handed a plausible answer.
    expect(hasCapabilityDiscovery("retell")).toBe(false);
    expect(
      connectionTypeMetadata().find((one) => one.type === "retell")
        ?.capabilityDiscovery,
    ).toBe(false);

    // And the two facts stay separate: whether egma can conduct a run over a
    // type and whether it can measure one of its targets are different
    // questions with different answers.
    expect(
      connectionTypeMetadata().find((one) => one.type === "retell")
        ?.simulatorAdapter,
    ).toBe(true);
  });
});

describe("what a capability record says about one capability", () => {
  const checkedAt = new Date("2026-08-15T09:00:00.000Z");

  it("answers not-measured for every key while nothing has looked", () => {
    for (const entry of CAPABILITY_CATALOG) {
      expect(capabilityStanding({ state: "unknown" }, entry.key)).toBe(
        "not_measured",
      );
    }
  });

  it("tells a measured absence from an unasked question", () => {
    const held = measuredCapabilities(
      { measured: ["raw_audio", "dtmf"], supported: ["raw_audio"] },
      "transport",
      checkedAt,
    );

    expect(capabilityStanding(held, "raw_audio")).toBe("supported");
    // Looked at and not there.
    expect(capabilityStanding(held, "dtmf")).toBe("unsupported");
    // Never looked at — and this is the one a single list could not express,
    // because both keys are simply absent from `supported`.
    expect(capabilityStanding(held, "barge_in")).toBe("not_measured");
  });

  it("can never read an unmeasured capability as one the target lacks", () => {
    // The property, over every catalog key and every subset an adapter could
    // report: `unsupported` requires the key to have been measured, so a blind
    // spot can never become a claim about the target.
    for (const entry of CAPABILITY_CATALOG) {
      const measured = CAPABILITY_CATALOG.map((one) => one.key).filter(
        (key) => key !== entry.key,
      );
      const held = measuredCapabilities(
        { measured, supported: [] },
        "partial",
        checkedAt,
      );
      expect(capabilityStanding(held, entry.key), entry.key).toBe(
        "not_measured",
      );
      for (const other of measured) {
        expect(capabilityStanding(held, other), other).toBe("unsupported");
      }
    }
  });

  it("refuses an answer claiming a capability it never looked for", () => {
    // Evidence with no observation under it would make the two lists disagree
    // about what happened, and the three answers unreadable.
    expect(() =>
      measuredCapabilities(
        { measured: ["raw_audio"], supported: ["dtmf"] },
        "confused",
        checkedAt,
      ),
    ).toThrow(/without measuring it/);
  });
});
