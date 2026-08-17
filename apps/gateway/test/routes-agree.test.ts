import { readFileSync } from "node:fs";

import {
  GATEWAY_ROUTE,
  JUDGE_PROVIDERS,
  PROVIDER_CATALOG,
  RESERVED_PROVIDER_JOBS,
} from "@egma/db";
import { describe, expect, it } from "vitest";

import { ROUTES } from "../src/routes.ts";

/**
 * The one list four things have to agree about.
 *
 * The gateway's route table is the authority: it is what actually answers, and
 * a path it does not carry is a `404` from Egma that whoever sees it reads as
 * the provider being wrong. Three other places hold a copy or a counterpart —
 * the control plane's `GATEWAY_ROUTE`, the simulator's own in `spec.py`, and
 * the legs and judges that execute a selection — because none of them can
 * import this application: two speak to Postgres and this one runs on
 * Cloudflare Workers.
 *
 * So the copies are checked against the authority here rather than trusted.
 * **What is checked for an address is that each copy's suffix is a prefix of a
 * real route's path**, not that the two are equal: a suffix deliberately stops
 * where the shipped provider adapter starts appending, which is a different
 * place for every provider.
 */

/**
 * A prefix no route's path can begin with, for the one comparison that has to
 * mean "there is no suffix to compare against".
 *
 * Named rather than written inline, because what it has to be is "not a
 * prefix of anything" and an empty string is a prefix of everything — which
 * would turn a missing suffix into a silent pass.
 */
const NO_SUCH_PREFIX = "\u0000";

/** What the product lets somebody select, as `provider/job`. */
const SELECTABLE = PROVIDER_CATALOG.map((entry) => `${entry.provider}/${entry.job}`).sort();

describe("where each provider is reached through this gateway", () => {
  /**
   * The direction that was missing, and the one that matters as the catalog
   * grows.
   *
   * Every other check here walks from a route or a copy *outward* and asks
   * whether the gateway carries it — which is true of a shrinking list and
   * says nothing about a growing one. **This walks from the product catalog
   * in.** A provider-job pair a persona or a grader can select and the
   * gateway has no route for is the pair that arms the leak: the leg is
   * handed an Egma credential and no address, and a builder reading a missing
   * address as "the provider's own" would put that credential on a third
   * party's wire.
   *
   * The simulator refuses that at build time and the grader answers
   * `NoJudge`, so the failure is contained either way — but a visible
   * catalog entry nothing can execute is a broken promise, and the
   * specification says so out loud: an entry cannot become visible until
   * managed execution exists for it. This is that rule, as a test.
   */
  it("exists for every provider-job pair the product catalog offers", () => {
    for (const entry of PROVIDER_CATALOG) {
      const suffix = GATEWAY_ROUTE[entry.provider]?.[entry.job];
      expect(
        suffix,
        `the catalog offers ${entry.provider} for ${entry.job} and the Egma model gateway carries no route for it, so managed access cannot execute a selection the product lets somebody make`,
      ).toBeDefined();

      const carried = ROUTES.find(
        (route) =>
          route.provider === entry.provider &&
          route.job === entry.job &&
          route.path.startsWith(suffix ?? NO_SUCH_PREFIX),
      );
      expect(carried, `${entry.provider}/${entry.job}`).toBeDefined();
    }
  });

  /**
   * And the other direction, which is the one a shrinking catalog gets wrong.
   *
   * A route the gateway carries and the catalog does not offer is Egma's own
   * provider account reachable by any organization with an inference key, for
   * a pair no product surface admits exists. It is not a leak of a customer's
   * credential — it is spend on Egma's, through a door nobody is watching
   * because nobody remembers it is there.
   */
  it("carries no route the product catalog does not offer", () => {
    expect(ROUTES.map((route) => `${route.provider}/${route.job}`).sort()).toEqual(SELECTABLE);
  });

  it("is a prefix of a route this gateway actually carries, in the control plane's copy", () => {
    for (const [provider, jobs] of Object.entries(GATEWAY_ROUTE)) {
      for (const [job, suffix] of Object.entries(jobs)) {
        const carried = ROUTES.find(
          (route) =>
            route.provider === provider &&
            route.job === job &&
            route.path.startsWith(suffix),
        );
        expect(carried, `${provider}/${job} → ${suffix}`).toBeDefined();
      }
    }
  });

  it("is the same list the simulator holds, read out of its own source", () => {
    expect([...simulatorsCopy().entries()].sort()).toEqual(
      [...controlPlanesCopy().entries()].sort(),
    );
  });
});

/**
 * The other agreement, which is about who can *execute* a selection rather than
 * where it is reached.
 *
 * A catalog entry is a promise that all three paths behind it exist. Two of
 * them are the ones above; the third is that something in the simulator or the
 * grader knows how to speak to that provider at all. **A visible entry with no
 * factory behind it is a persona that fails at its first word, and a factory
 * with no visible entry is code nobody can reach** — the second is not a leak,
 * but it is how a scripted stand-in becomes selectable by accident, which is
 * the one thing the deterministic providers must never be.
 */
describe("what the catalog offers, and what can execute it", () => {
  it("has a judge maker for every language-model provider it offers", () => {
    const offered = PROVIDER_CATALOG.filter((entry) => entry.job === "llm").map(
      (entry) => entry.provider,
    );
    for (const provider of offered) {
      expect(
        JUDGE_PROVIDERS.some((known) => known === provider),
        `the catalog offers ${provider} for llm work and the grader ships no judge for it, so a grader that selected it could not judge`,
      ).toBe(true);
    }
    // And no judge provider the catalog cannot offer, so the grader's roster
    // and the product's list are the same list rather than two.
    expect([...JUDGE_PROVIDERS].sort()).toEqual([...new Set(offered)].sort());
  });

  it("has a simulator speech leg for every speech provider it offers", () => {
    const legs = simulatorsSpeechProviders();
    for (const entry of PROVIDER_CATALOG) {
      if (entry.job === "llm") continue;
      const built = entry.job === "stt" ? legs.stt : legs.tts;
      // The catalog's word, translated to the leg that serves it where the two
      // differ — which today is OpenAI STT, whose catalog entry means the
      // realtime socket rather than the segmented endpoint beside it.
      const adapter = entry.job === "stt" ? (legs.selected[entry.provider] ?? entry.provider) : entry.provider;
      expect(
        built.includes(adapter),
        `the catalog offers ${entry.provider} for ${entry.job} and the simulator builds no ${adapter} leg for it`,
      ).toBe(true);
    }
  });

  /**
   * The Ticket 02 review note, kept down by a test rather than by memory.
   *
   * The scripted legs are how the deterministic suite speaks and listens with
   * no account, no network and no corpus. They are also, by construction, a
   * pair that always succeeds — so a scripted provider that became selectable
   * would be a completed, green simulation conducted by a canned robot, which
   * is worse than a failure because a failure tells the truth about what
   * happened.
   */
  it("offers no scripted provider, so a deterministic stand-in cannot be selected", () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.provider).not.toMatch(/scripted/);
    }
    for (const route of ROUTES) {
      expect(route.provider).not.toMatch(/scripted/);
    }
  });

  /**
   * The live proof runs the catalog, rather than a list beside it.
   *
   * **A recommended default is a promise a release proved**, and the proof
   * lives in a process that cannot import this catalog: it is a Python opt-in
   * suite driving real Pipecat legs. So it restates the entries, and this is
   * what stops the restatement drifting. A default changed here without its
   * proof being re-run fails on the day it changes rather than the day a
   * customer's first run uses it.
   */
  it("is what the opt-in live proof runs, entry for entry and default for default", () => {
    const proved = read("../../simulator/tests/test_live_catalog.py");
    const written = /^CATALOG = \((.*?)^\)/ms.exec(proved);
    expect(written, "the live proof no longer declares CATALOG as a literal").not.toBeNull();

    const held = [...(written?.[1] ?? "").matchAll(/Entry\(([^)]*)\)/gs)].map((one) => {
      const fields = new Map<string, string>();
      for (const [, name, value] of (one[1] as string).matchAll(/(\w+)="([^"]*)"/g)) {
        fields.set(name as string, value as string);
      }
      return [
        fields.get("provider"),
        fields.get("job"),
        fields.get("model"),
        fields.get("voice") ?? "",
      ].join(" ");
    });

    expect(held).toEqual(
      PROVIDER_CATALOG.map((entry) =>
        [entry.provider, entry.job, entry.recommendedModel, entry.recommendedVoiceId ?? ""].join(
          " ",
        ),
      ),
    );
  });

  /**
   * The narrowing, held down where it can be read.
   *
   * These four left the first catalog by founder decision because Egma cannot
   * live-prove them with the provider accounts it holds, and the rule is that
   * Egma does not name a provider it cannot keep. They are deferred rather than
   * cancelled: each returns through its own ticket with its own live proof, and
   * on that day this list is what has to be edited deliberately.
   *
   * **What this scans is the model catalog and everything downstream of it** —
   * the entries, the reserved list, both copies of the address map, the route
   * table. It deliberately does not claim to scan every surface in the product:
   * the pre-catalog persona-traits voice path still offers `elevenlabs`, that
   * leg still works, and it is the compatibility surface a later ticket
   * removes. Nothing a persona or a grader selects as a *model* can reach it.
   */
  it("names no provider this release cannot live-prove, anywhere the model catalog reaches", () => {
    const notYet = ["anthropic", "google", "gemini", "assemblyai", "elevenlabs"];
    const named = [
      ...PROVIDER_CATALOG.flatMap((entry) => [entry.provider, entry.label.toLowerCase()]),
      ...RESERVED_PROVIDER_JOBS.map((one) => one.provider),
      ...Object.keys(GATEWAY_ROUTE),
      ...ROUTES.map((route) => route.provider),
    ];
    for (const absent of notYet) {
      expect(named, `${absent} is still named in catalog data`).not.toContain(absent);
    }
  });
});

/** The control plane's copy, flattened to `provider/job → suffix`. */
function controlPlanesCopy(): Map<string, string> {
  const held = new Map<string, string>();
  for (const [provider, jobs] of Object.entries(GATEWAY_ROUTE)) {
    for (const [job, suffix] of Object.entries(jobs)) held.set(`${provider}/${job}`, suffix);
  }
  return held;
}

/**
 * The simulator's copy, read as text rather than imported.
 *
 * A text read rather than a Python import, for the reason the deployment check
 * in `egma-cloud` is a text scan: this must give the same answer on a runner
 * with no Python toolchain as it does on a developer's machine.
 */
function simulatorsCopy(): Map<string, string> {
  const written = /GATEWAY_ROUTE: dict\[str, dict\[str, str\]\] = \{(.*?)\n\}/s.exec(
    read("../../simulator/src/egma_simulator/spec.py"),
  );
  expect(written, "the simulator no longer declares GATEWAY_ROUTE as a literal").not.toBeNull();

  const held = new Map<string, string>();
  // Provider by provider, then job by job inside it — a provider may do several
  // jobs and reach a different address for each, so a one-line-per-pair reader
  // would silently see only the last of them.
  for (const [, provider, jobs] of (written?.[1] ?? "").matchAll(
    /"([a-z_]+)": \{([^}]*)\}/gs,
  )) {
    for (const [, job, suffix] of (jobs as string).matchAll(/"([a-z]+)": "([^"]+)"/g)) {
      held.set(`${provider}/${job as string}`, suffix as string);
    }
  }
  return held;
}

/** Which speech legs the simulator can build, read out of its own source. */
function simulatorsSpeechProviders(): {
  readonly stt: readonly string[];
  readonly tts: readonly string[];
  readonly selected: Readonly<Record<string, string>>;
} {
  const config = read("../../simulator/src/egma_simulator/config.py");
  const speech = read("../../simulator/src/egma_simulator/speech.py");
  const list = (name: string): readonly string[] => {
    const written = new RegExp(`${name} = \\(([^)]*)\\)`).exec(config);
    expect(written, `the simulator no longer declares ${name} as a literal`).not.toBeNull();
    return [...(written?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((one) => one[1] as string);
  };

  const selected: Record<string, string> = {};
  const written = /SELECTED_STT_LEG = \{([^}]*)\}/s.exec(speech);
  expect(written, "the simulator no longer says which leg a selected provider means").not.toBeNull();
  for (const [, from, to] of (written?.[1] ?? "").matchAll(/"([a-z_]+)": "([a-z_]+)"/g)) {
    selected[from as string] = to as string;
  }

  return { stt: list("STT_PROVIDERS"), tts: list("TTS_PROVIDERS"), selected };
}

function read(where: string): string {
  return readFileSync(new URL(where, import.meta.url), "utf8");
}
