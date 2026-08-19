/**
 * The interview's list of settings, held against the two lists it has to agree
 * with: the platform's catalog, and the variables the API seeds from.
 *
 * **These three cannot import each other.** The catalog and the seeder live in
 * the database package and the API; this CLI is a published npm package and must
 * not carry a Postgres client into somebody's repository, so `SETUP_INPUTS` is
 * written out by hand. The catalog arrives here as a test-time import, which is
 * the arrangement the pull/push checks already use; the seeder is *read as
 * text*, because what has to match is a variable's name rather than a value it
 * produces, and the same shape of check already keeps the API's own compose
 * entries honest.
 *
 * What a drift would cost, in the order it would hurt:
 *
 * 1. **A setting the catalog requires and nothing supplies** leaves an operator
 *    who followed the whole documented setup still reading `setup required`,
 *    with nothing sensible to type. That is this effort's own failure — a
 *    platform that looks configured and is not — wearing the opposite face, and
 *    it is the agreement ticket 03 asked to keep: readiness waits only for what
 *    setup writes. *Declaring* a way in is not supplying one, so the checks
 *    below follow each of the two ways to something that really writes a value.
 * 2. **A variable renamed on one side** is an interview and a seeder that
 *    disagree about which word feeds a setting, so an operator's exported value
 *    silently answers nothing.
 * 3. **A secret the interview thinks is not one** is a provider key echoed on
 *    somebody's screen and left in their scrollback.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORM_SETTINGS } from "@egma/db";
import { describe, expect, it } from "vitest";

import { CARRIER_VARIABLES } from "../src/self-host/protected-input.ts";
import {
  inputFor,
  SETUP_INPUTS,
  type SettingInput,
} from "../src/self-host/settings.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_CONFIG = path.resolve(HERE, "../../api/src/config.ts");

/** The complete runtime phone bundle, with no Twilio account authority in it. */
const PHONE_INPUTS = {
  carrier_trunk_address: {
    variable: "EGMA_PHONE_TRUNK_ADDRESS",
    secret: false,
    required: true,
  },
  carrier_trunk_number: {
    variable: "EGMA_PHONE_SOURCE_NUMBER",
    secret: false,
    required: true,
  },
  carrier_trunk_username: {
    variable: "EGMA_PHONE_TRUNK_USERNAME",
    secret: false,
    required: false,
  },
  carrier_trunk_password: {
    variable: "EGMA_PHONE_TRUNK_PASSWORD",
    secret: true,
    required: false,
  },
} as const;

/**
 * The interview's own entry for a setting, or a failure naming the setting.
 *
 * Read through the module's lookup rather than with a bare subscript, because a
 * bare one turns real drift into a `TypeError` on `undefined`: the check still
 * fails, and the sentence explaining what broke never prints.
 */
function inputOf(name: string): SettingInput {
  const input = inputFor(name);
  expect(
    input,
    `the platform holds the setting ${name} and the setup interview has no entry ` +
      "for it, so setup would never ask for it and never write it",
  ).not.toBeNull();
  return input as SettingInput;
}

/**
 * Which environment variable the API seeds each setting from, read off the API
 * itself.
 *
 * The seeder writes every read out literally and by name — deliberately, so its
 * compose entries can be checked against it — which is what makes it readable
 * here without running anything.
 */
function seededFrom(): Record<string, string> {
  const text = readFileSync(API_CONFIG, "utf8");
  const opening = text.indexOf("function platformSettings(");
  expect(
    opening,
    `${API_CONFIG} no longer has a platformSettings function to read`,
  ).toBeGreaterThan(-1);
  const body = text.slice(opening, text.indexOf("\n}", opening));
  const found: Record<string, string> = {};
  for (const read of body.matchAll(
    /^\s*([a-z_]+):\s*environment\.(EGMA_[A-Z0-9_]+)\?\.trim\(\),/gmu,
  )) {
    found[read[1] as string] = read[2] as string;
  }
  return found;
}

describe("what setup asks for", () => {
  it("names every setting the platform holds, and no others", () => {
    expect(Object.keys(SETUP_INPUTS)).toEqual(
      PLATFORM_SETTINGS.map((setting) => setting.name),
    );
  });

  it("agrees with the catalog about which settings are required", () => {
    for (const setting of PLATFORM_SETTINGS) {
      expect(
        inputOf(setting.name).required,
        `the catalog and the interview disagree about whether ${setting.name} is required`,
      ).toBe(setting.required);
    }
  });

  it("agrees with the catalog about which settings are secret", () => {
    for (const setting of PLATFORM_SETTINGS) {
      const input = inputOf(setting.name);
      if (input.supply !== "asked") continue;
      expect(
        input.secret,
        `the interview would ${setting.secret ? "echo" : "hide"} ${setting.name} as it ` +
          "is typed, and the catalog says the opposite",
      ).toBe(setting.secret);
    }
  });

  it("asks for exactly four runtime phone values and no Twilio account credential", () => {
    // Normal setup copies a developer's limited SIP credential into a fresh
    // database. It never has the account authority that can change Twilio.
    expect(Object.keys(CARRIER_VARIABLES).sort()).toEqual(
      ["sipPassword", "sipUsername", "sourceNumber", "trunkAddress"].sort(),
    );

    for (const [name, expected] of Object.entries(PHONE_INPUTS)) {
      expect(inputOf(name)).toMatchObject({
        supply: "carrier",
        variable: expected.variable,
        secret: expected.secret,
        required: expected.required,
      });
    }
  });

  it("supplies every required setting through something that writes a value", () => {
    for (const setting of PLATFORM_SETTINGS) {
      if (!setting.required) continue;
      const input = inputOf(setting.name);
      if (input.supply === "carrier") {
        expect(
          Object.hasOwn(PHONE_INPUTS, setting.name),
          `${setting.name} is required but is not part of the grouped phone interview`,
        ).toBe(true);
        continue;
      }
      expect(input.supply, `${setting.name} is required but setup does not ask for it`).toBe(
        "asked",
      );
      if (input.supply !== "asked") continue;
      expect(
        input.variable,
        `${setting.name} is required and the interview has no variable to take it from`,
      ).not.toBe("");
    }
  });

  it("takes every answer from the variable the API seeds that setting from", () => {
    // One word for one setting, whichever of the two ways in an operator uses.
    // Pinned against the API's own reads rather than against a copy typed into
    // this file: a third copy of one list is a third thing to drift, and this
    // drift would be silent — an exported value that answers nothing.
    const seeded = seededFrom();
    expect(
      Object.keys(seeded).sort(),
      "the API seeds a different set of settings than the platform holds",
    ).toEqual(PLATFORM_SETTINGS.map((setting) => setting.name).sort());

    for (const setting of PLATFORM_SETTINGS) {
      const input = inputOf(setting.name);
      if (input.supply !== "asked") continue;
      expect(
        input.variable,
        `setup reads ${setting.name} from ${input.variable} and the API seeds it from ` +
          `${String(seeded[setting.name])}`,
      ).toBe(seeded[setting.name]);
    }

    // The same four variables also seed a fresh database at API startup. A
    // developer can therefore rebuild locally without getting a new SIP user.
    for (const [name, expected] of Object.entries(PHONE_INPUTS)) {
      expect(expected.variable).toBe(seeded[name]);
    }
  });

  it("never suggests a value for a secret", () => {
    // A default provider name is a convenience. A default key would be a
    // credential written into a public repository, which is the exact class of
    // mistake the media-server credential was.
    for (const setting of PLATFORM_SETTINGS) {
      const input = inputOf(setting.name);
      if (input.supply !== "asked" || !input.secret) continue;
      expect(
        input.suggested,
        `${setting.name} is a secret and the interview offers a value for it`,
      ).toBeNull();
    }
  });
});
