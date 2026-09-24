import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { safeReturnPath as apiSafeReturnPath } from "../../api/src/auth/password-reset.ts";
import { CODES } from "../../api/src/http/refusals.ts";
import { readJson } from "../lib/api.ts";
import { readSession } from "../lib/me.ts";
import {
  NOTHING_TO_HEAR,
  offersNothing,
} from "../lib/recording-refusals.ts";
import { safeReturnPath } from "../lib/return-to.ts";
import {
  citedTurnPositions,
  priorGrades,
  withoutCurrentGrade,
  type EvidenceGrade,
  type EvidenceStep,
} from "../lib/simulations.ts";

/**
 * The two things the pages decide for themselves, and one thing about where
 * they are served from.
 */

const WEB = path.join(import.meta.dirname, "..");

/**
 * Bound stalled session reads so the document cannot remain behind the
 * loading cover indefinitely. Ordinary readJson calls set no default deadline.
 */
describe("reading who is signed in", () => {
  /** A connection that is open and silent: no response, and no error either. */
  function stalls(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init?: RequestInit) =>
          new Promise<Response>((_keep, give) => {
            init?.signal?.addEventListener("abort", () => {
              give((init.signal as AbortSignal).reason);
            });
          }),
      ),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives up on a server that accepts the connection and then says nothing", async () => {
    stalls();

    const answer = await readSession(5);

    // The ordinary failure every page already answers: the shell settles on
    // it and lifts the cover, and the entrance offers a way to try again.
    expect(answer.status).toBe("failed");
    expect(answer).toMatchObject({ refusal: { error: "unreachable" } });
  });

  /**
   * The deadline belongs to this read and not to reading JSON. Every other
   * request in the product fails into a page that is already drawn and stays
   * usable around it, and a deadline in the shared helper would be one they
   * all silently inherited.
   */
  it("puts no deadline on any other read", async () => {
    stalls();

    void readJson("/v1/agents");

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect((init as RequestInit | undefined)?.signal).toBeUndefined();
  });
});

describe("the pages", () => {
  /**
   * And the rule that keeps it from being a way off this instance is one rule,
   * written twice because the two halves cannot import each other: the API
   * refuses anything else before it writes a link, and the page refuses it
   * again before it follows one. Two copies of a security rule are worth having
   * only while something checks they still say the same thing.
   */
  it("agree with the API about what a return path may be", async () => {
    for (const raw of [
      "/device/approve?code=WDJB",
      "/traces",
      "https://elsewhere.example/x",
      "//elsewhere.example/x",
      "/\\elsewhere.example",
      "javascript:alert(1)",
      "  /device  ",
      "",
      // The shapes a list of shapes let through. A URL parser strips tab,
      // carriage return and newline before it parses, so each of these is read
      // as `//elsewhere.example` by the browser that would follow it — and the
      // last two also travelled to the auth provider as a header, where a line
      // ending turned a public request into a 500.
      "/\telsewhere.example",
      "/\t/elsewhere.example",
      "/\t\\elsewhere.example",
      "/\n/elsewhere.example",
      "/\r\n//elsewhere.example",
      "/foo\r\nx: y",
    ]) {
      expect(safeReturnPath(raw), raw).toBe(apiSafeReturnPath(raw));
    }
  });

  it("reach the API for a password reset at paths this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const forgot = await readFile(
      path.join(WEB, "app/forgot-password/page.tsx"),
      "utf8",
    );
    const reset = await readFile(
      path.join(WEB, "app/reset-password/page.tsx"),
      "utf8",
    );

    expect(rewrites).toContain("/api/password-reset/:path*");
    expect(forgot).toContain('fetch("/api/password-reset"');
    expect(reset).toContain('fetch("/api/password-reset/complete"');
  });

  /**
   * Forward mock-tool requests from the agent platform to the API. Otherwise
   * Next returns an HTML not-found page for the generated tool URL.
   */
  it("reach the API for a mocked run's tool calls at a path this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const endpoint = await readFile(
      path.join(WEB, "../api/src/routes/mock-endpoint.ts"),
      "utf8",
    );

    expect(rewrites).toContain('source: "/mock-tools/:path*"');
    expect(rewrites).toContain("destination: `${api}/mock-tools/:path*`");
    // The whole tail, never the bare prefix: a rule matching only
    // `/mock-tools` would forward nothing a real call is addressed to.
    expect(rewrites).not.toContain('source: "/mock-tools",');
    // The prefix the API answers on and the prefix this process forwards are
    // the same prefix. A minted URL points at this origin, so a disagreement
    // here is a 404 on somebody's live agent.
    expect(endpoint).toContain('export const MOCK_TOOL_PREFIX = "/mock-tools"');
    // The simulation and the tool live under the prefix, so the rule has to
    // carry the whole tail rather than one segment. The run is not in the path
    // any more: a simulation names its own run, so asking the caller to repeat
    // it was one more thing a minted URL could get wrong.
    expect(endpoint).toContain(
      "`${MOCK_TOOL_PREFIX}/:simulationId/:toolName`",
    );
  });

  it("forwards usage reads, ledger pages, and billing actions to the API", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    expect(rewrites).toContain('source: "/api/organization/:path*"');
    expect(rewrites).toContain('destination: `${api}/api/organization/:path*`');
    expect(rewrites).toContain('source: "/api/billing/:path*"');
    expect(rewrites).toContain('destination: `${api}/api/billing/:path*`');
  });

  /**
   * Somewhere to click, and a path that reaches the API rather than this
   * process. Without the rewrite the button would post at Next, which has no
   * such route, and signing out would 404 while looking like a product bug.
   */
  it("give a signed-in person somewhere to sign out, at a path this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    const home = await readFile(path.join(WEB, "app/page.tsx"), "utf8");
    const shell = await readFile(path.join(WEB, "ui/shell.tsx"), "utf8");

    expect(rewrites).toContain("/api/sign-out");
    expect(shell).toContain('fetch("/api/sign-out"');
    expect(shell).toContain("Sign out");
    expect(home).not.toContain('fetch("/api/sign-out"');
    expect(home).not.toContain("Sign out");
  });
});

describe("coming back after signing in", () => {
  /**
   * Exercise same-origin URL resolution, including control characters that
   * change how a browser parses an apparent local path.
   */
  it("refuses anywhere that is not this instance", () => {
    for (const elsewhere of [
      "https://elsewhere.example/steal",
      "//elsewhere.example/steal",
      "/\\elsewhere.example/steal",
      "javascript:alert(1)",
      "device/approve",
      "",
      "/\t/elsewhere.example",
      "/\t\\elsewhere.example",
      "/\n/elsewhere.example",
      "/\r\n//elsewhere.example",
    ]) {
      expect(safeReturnPath(elsewhere), elsewhere).toBeNull();
    }
  });

  /**
   * And what survives is the parser's own path — the same string the browser
   * would have made of it — so a return path can never carry a control
   * character on into a header, and never means one thing here and another
   * where it is followed.
   */
  it("hands back the path a browser would have read, and nothing else", () => {
    expect(safeReturnPath("/device/approve?code=WDJB")).toBe(
      "/device/approve?code=WDJB",
    );
    // Still on this instance once the tab is gone, so it is kept — as the one
    // path it can mean, rather than as the two it looked like.
    expect(safeReturnPath("/\telsewhere.example")).toBe("/elsewhere.example");
    expect(safeReturnPath("/foo\r\nx: y")).not.toMatch(/[\t\r\n]/);
  });
});

/**
 * Hide only expected absence before a recording is known to exist. Failures
 * after a player has worked must remain visible.
 */
describe("a refusal of a recording", () => {
  const A_TRANSCRIPT = { knownToExist: false, afterOneWorked: false };
  const A_RUNS_RESULTS = { knownToExist: true, afterOneWorked: false };

  /**
   * A run's results were told there is a recording before this component was
   * mounted at all, so any refusal contradicts what the same page just said.
   */
  it("is always said where the page had already been told there is one", () => {
    expect(offersNothing({ code: "not_found" }, A_RUNS_RESULTS)).toBe(false);
    expect(offersNothing({ code: "unprocessable" }, A_RUNS_RESULTS)).toBe(false);
  });

  /**
   * Configuration, transport, and unsignable-reference failures must not look
   * like a simulation that recorded no audio.
   */
  it("is said out loud when it is about egma rather than about the conversation", () => {
    for (const code of [
      "no_object_store",
      "unsignable_reference",
      "not_permitted",
      "too_many_requests",
      "internal_error",
    ]) {
      expect(offersNothing({ code }, A_TRANSCRIPT), code).toBe(false);
    }
  });

  /**
   * The codes are the API's, so they are read from the API's own vocabulary
   * rather than typed twice. A code renamed on one side and not the other would
   * make a transcript start speaking about every chat, or stop speaking about a
   * fault — and neither would fail anything else.
   */
  it("names codes this API actually answers with", () => {
    for (const code of NOTHING_TO_HEAR) {
      expect(Object.keys(CODES), code).toContain(code);
    }
    expect(Object.keys(CODES)).toContain("unsignable_reference");
  });
});

/** The transcript turns cited by one grade's assertion details. */
describe("the turns a grade cites", () => {
  function step(id: string, children: EvidenceStep[] = []): EvidenceStep {
    return {
      spanId: id,
      parentSpanId: "",
      name: id,
      kind: "turn:agent",
      status: "ok",
      startedAt: "2026-08-15T10:00:00.000000Z",
      durationNs: "1000",
      text: "",
      audioUrl: "",
      toolName: "",
      toolArguments: "",
      toolResult: "",
      pov: "agent",
      spans: children,
    };
  }

  const turns = [step("one"), step("two", [step("tool-inside-two")]), step("three")];

  it("names them by their position in the transcript", () => {
    expect(citedTurnPositions(["three", "one"], turns)).toEqual([1, 3]);
  });

  it("sends a cited step to the turn it happened inside", () => {
    expect(citedTurnPositions(["tool-inside-two"], turns)).toEqual([2]);
  });

  it("drops an id that is nowhere in the transcript rather than inventing a turn", () => {
    expect(citedTurnPositions(["nothing-here"], turns)).toEqual([]);
  });
});

describe("equal-time grade history", () => {
  const current: EvidenceGrade = {
    projectGraderId: "grd_current",
    graderDefinitionId: "grl_expected",
    graderDefinitionVersion: 1,
    graderName: "expected_behaviors",
    parameterValues: { llm_provider: "openai", llm_model: "gpt-4o-mini" },
    score: 1,
    details: { rationale: "the reclaimed worker scored it" },
    passThreshold: 0.5,
    result: "passed",
    gradedAt: "2026-08-21T08:01:00.000000Z",
  };
  const stale: EvidenceGrade = {
    ...current,
    score: 0,
    details: { rationale: "the stale worker scored it" },
    result: "failed",
  };

  it("removes only the current public row", () => {
    expect(withoutCurrentGrade(current, [stale, current])).toEqual([stale]);
  });

  it("keeps the equal-time stale row in simulation history", () => {
    expect(priorGrades(current, [stale, current])).toEqual([stale]);
  });
});
