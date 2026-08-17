import { readFileSync } from "node:fs";

import { GATEWAY_ROUTE } from "@egma/db";
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
