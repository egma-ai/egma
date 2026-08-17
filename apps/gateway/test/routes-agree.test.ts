import { readFileSync } from "node:fs";

import { GATEWAY_ROUTE, PROVIDER_CATALOG } from "@egma/db";
import { describe, expect, it } from "vitest";

import { ROUTES } from "../src/routes.ts";

/**
 * The one list three things have to agree about.
 *
 * The gateway's route table is the authority: it is what actually answers, and
 * a path it does not carry is a `404` from Egma that whoever sees it reads as
 * the provider being wrong. Two other places hold a copy — the control plane's
 * `GATEWAY_ROUTE`, which the grader's judge makers read, and the simulator's
 * own in `spec.py`, which its speech legs read — because neither can import
 * this application: one speaks to Postgres and this one runs on Cloudflare
 * Workers.
 *
 * So the copies are checked against the authority here rather than trusted.
 * **What is checked is that each copy's suffix is a prefix of a real route's
 * path**, not that the two are equal: a suffix deliberately stops where the
 * shipped provider adapter starts appending, which is a different place for
 * every provider.
 */

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
          route.path.startsWith(suffix ?? "\u0000"),
      );
      expect(carried, `${entry.provider}/${entry.job}`).toBeDefined();
    }
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
    // A text read rather than a Python import, for the reason the deployment
    // check in `egma-cloud` is a text scan: this must give the same answer on a
    // runner with no Python toolchain as it does on a developer's machine.
    const source = readFileSync(
      new URL("../../simulator/src/egma_simulator/spec.py", import.meta.url),
      "utf8",
    );
    const written = /GATEWAY_ROUTE: dict\[str, dict\[str, str\]\] = \{(.*?)\n\}/s.exec(
      source,
    );
    expect(written, "the simulator no longer declares GATEWAY_ROUTE as a literal").not
      .toBeNull();

    const held = new Map<string, string>();
    for (const [, provider, job, suffix] of (written?.[1] ?? "").matchAll(
      /"([a-z]+)": \{"([a-z]+)": "([^"]+)"\}/g,
    )) {
      held.set(`${provider}/${job}`, suffix as string);
    }

    const expected = new Map<string, string>();
    for (const [provider, jobs] of Object.entries(GATEWAY_ROUTE)) {
      for (const [job, suffix] of Object.entries(jobs)) {
        expected.set(`${provider}/${job}`, suffix);
      }
    }

    expect([...held.entries()].sort()).toEqual([...expected.entries()].sort());
  });
});
