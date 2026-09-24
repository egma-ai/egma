import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as copy from "../lib/transcript-copy.ts";
import {
  howFarIn,
  howLong,
  namesWholeOrganization,
  quietState,
  recentWindow,
  windowAround,
  windowChoiceOf,
  type Facts,
} from "../lib/transcripts.ts";

/**
 * What the transcript pages decide for themselves: the window they ask about,
 * the numbers they read out of the contract, and every word they say.
 */

const WEB = path.join(import.meta.dirname, "..");

/** Where the two pages live, now that both are inside a project. */
const SECTION = "app/projects/[projectId]/monitoring";

const FACTS: Facts = {
  traceId: "5c1e4b0f8d2a4e6b9f0c1d2e3a4b5c6d",
  startedAt: "2026-08-02T18:04:40.281989Z",
  endedAt: "2026-08-02T18:05:53.776865Z",
  durationNs: "73494876403",
  spanCount: 133,
  turnCounts: { human: 5, agent: 8 },
  toolSpanCount: 2,
  erroredSpanCount: 3,
  source: "production",
  pov: "agent",
  environment: "default",
  connectionType: "",
  providerCallId: "egma-fixture-capture-1",
  agentPlatform: "livekit",
  platformAgentId: "",
  platformAgentName: "kelly",
  platformAgentVersion: "",
  runId: "",
  agentId: "",
};

describe("the window the list asks about", () => {
  const now = new Date("2026-08-02T20:00:00.000Z");

  it("is whichever span of time was chosen instead", () => {
    expect(recentWindow(windowChoiceOf("1h"), now).from).toBe(
      "2026-08-02T19:00:00.000Z",
    );
    expect(recentWindow(windowChoiceOf("7d"), now).from).toBe(
      "2026-07-26T20:00:00.000Z",
    );
  });

  /**
   * The store holds at most thirty-one days in one read, and refuses a wider
   * window rather than narrowing it silently. Every choice the page offers is
   * therefore one the store will actually answer.
   */
  it("never offers a window wider than the store will read", () => {
    for (const choice of copy.WINDOWS) {
      const window = recentWindow(choice.id, now);
      const width = Date.parse(window.to) - Date.parse(window.from);
      expect(width, choice.id).toBeLessThan(31 * 24 * 60 * 60 * 1000);
    }
  });

  /**
   * The browser's clock and the clock that stamped the span are different
   * clocks. Without headroom, an exchange recorded seconds ago falls outside a
   * window this page computed from its own idea of now — and that exchange is
   * the one somebody is looking for.
   */
  it("leaves room for the two clocks to disagree", () => {
    expect(Date.parse(recentWindow("24h", now).to)).toBeGreaterThan(
      now.getTime(),
    );
  });
});

describe("the window one transcript carries", () => {
  /**
   * The end of a window is open, so a `to` at the closing instant would exclude
   * the very step that ended there — the page would ask about a transcript
   * using its own end time and be told there is no such thing.
   */
  it("holds the whole of it, at both ends", () => {
    const window = windowAround(FACTS);
    expect(Date.parse(window.from)).toBeLessThan(Date.parse(FACTS.startedAt));
    expect(Date.parse(window.to)).toBeGreaterThan(Date.parse(FACTS.endedAt));
  });
});

/**
 * Choose one guidance state from window contents, wider history, visible
 * key scopes, and production grader coverage.
 */
describe("which guidance a quiet page shows", () => {
  /** An empty page in a project that has never recorded anything, nothing failed. */
  function seen(overrides: Partial<Parameters<typeof quietState>[0]>) {
    return quietState({
      listed: 0,
      everRecorded: 0,
      organizationWideKeys: 0,
      watchingProduction: 0,
      ...overrides,
    });
  }

  /**
   * **The window is a reason for an empty list, and it is not the project's
   * fault** — but only where something *is* recorded further back. A project
   * with a week of traffic read at the last hour is empty and healthy, and a
   * setup tutorial there tells somebody their working export is broken.
   */
  it("blames the window when the project has traffic further back", () => {
    expect(seen({ listed: 0, everRecorded: 1 })).toBe("nothing-in-this-window");
    // Even where everything else would have had something to say.
    expect(seen({ listed: 0, everRecorded: 9, organizationWideKeys: 3 })).toBe(
      "nothing-in-this-window",
    );
  });

  /**
   * Use the wider recent-history probe for setup guidance, regardless of the
   * selected window. It does not establish that the project has never recorded a trace.
   */
  it("teaches the setup whenever nothing has ever arrived, at any window", () => {
    expect(seen({ listed: 0, everRecorded: 0 })).toBe("set-up-capture");
  });

  /** A visible organization key points to the exact scope that must change. */
  it("names the organization-wide key instead, when one is visible", () => {
    expect(seen({ organizationWideKeys: 1 })).toBe("key-names-the-organization");
  });

  /**
   * **A read that never answered is not a zero**, which is the same rule
   * `ui/page-state.tsx` states between failed and empty. A failed grader read
   * folded into a count would put "no grader watches production" on screen on
   * the strength of an answer egma never got, so a supporting read that did not
   * land means one thing less is said and never one thing more.
   */
  it("says nothing rather than guessing, when a supporting read did not answer", () => {
    expect(seen({ listed: 4, watchingProduction: null })).toBeNull();
    // And the keys read failing leaves the teaching, which claims nothing about
    // any key — its caution line covers the case for every reader anyway.
    expect(seen({ listed: 0, organizationWideKeys: null })).toBe(
      "set-up-capture",
    );
  });

  /**
   * **The unanswered probe is that rule at its sharpest**, because both
   * sentences it decides between are confident ones. *Nothing here, try a wider
   * window* is true whatever the answer would have been; the teaching would be
   * telling somebody with a working export to go and build one.
   */
  it("falls back to the window line, never the teaching, when the probe failed", () => {
    expect(seen({ listed: 0, everRecorded: null })).toBe(
      "nothing-in-this-window",
    );
    // Including where a visible organization-wide key would otherwise have
    // spoken: that sentence is about an empty project too.
    expect(seen({ listed: 0, everRecorded: null, organizationWideKeys: 2 })).toBe(
      "nothing-in-this-window",
    );
  });

  it("reads a key with no project as one that names the whole organization", () => {
    expect(
      namesWholeOrganization({ projectId: null, revokedAt: null }),
    ).toBe(true);
    expect(
      namesWholeOrganization({ projectId: "prj_2", revokedAt: null }),
    ).toBe(false);
  });

  /**
   * A revoked key authenticates nothing, so it files nothing anywhere. Counting
   * one would explain an empty page with a key somebody already dealt with —
   * a wrong answer wearing the clothes of a knowledgeable one.
   */
  it("does not count a key that has been revoked", () => {
    expect(
      namesWholeOrganization({
        projectId: null,
        revokedAt: "2026-08-15T09:00:00.000000Z",
      }),
    ).toBe(false);
  });
});

describe("the numbers the contract sends", () => {
  it("reads a duration at a precision somebody can use", () => {
    expect(howLong("340000000")).toBe("340 ms");
    expect(howLong("1234000000")).toBe("1.2 s");
    expect(howLong("73494876403")).toBe("1m 13s");
  });

  it("says how far into the exchange something happened", () => {
    expect(howFarIn("2026-08-02T18:04:52.681989Z", FACTS.startedAt)).toBe(
      "+12.4 s",
    );
  });

});

describe("the transcript pages", () => {
  it("exist, at the two addresses the list links between", async () => {
    const found = (
      await readdir(path.join(WEB, SECTION), { recursive: true })
    ).map((one) => one.replaceAll(path.sep, "/"));

    expect(found).toContain("transcripts/page.tsx");
    expect(found).toContain("transcripts/[transcriptId]/page.tsx");
    // The area's own address lands on the list, and it is the only other page
    // under here: `dashboard` is reserved and nothing claims it.
    expect(found).toContain("page.tsx");
    expect(found.filter((one) => one.includes("dashboard"))).toEqual([]);

    const landing = await readFile(path.join(WEB, SECTION, "page.tsx"), "utf8");
    expect(landing).toContain("redirect(transcriptsPath(projectId))");
  });
});
