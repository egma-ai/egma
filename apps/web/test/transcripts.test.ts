import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as copy from "../lib/transcript-copy.ts";
import { SPEAKERS } from "../ui/evidence.tsx";
import {
  agentPlatformLabel,
  everyStep,
  howFarIn,
  howLong,
  humanizeIdentifier,
  isHuman,
  isWidestWindow,
  milliseconds,
  monitoringPath,
  namesWholeOrganization,
  quietState,
  recentWindow,
  somethingFailed,
  stepsInside,
  transcriptPath,
  transcriptsPath,
  watchesProduction,
  windowAround,
  windowChoiceOf,
  WINDOW_PARAMETER,
  type Facts,
  type Step,
} from "../lib/transcripts.ts";

/**
 * What the transcript pages decide for themselves: the window they ask about,
 * the numbers they read out of the contract, and every word they say.
 */

const WEB = path.join(import.meta.dirname, "..");

/** Where the two pages live, now that both are inside a project. */
const SECTION = "app/projects/[projectId]/monitoring";
const LIST_PAGE = `${SECTION}/transcripts/page.tsx`;
const DETAIL_PAGE = `${SECTION}/transcripts/[transcriptId]/page.tsx`;

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
  emitter: "agent",
  environment: "default",
  connectionKind: "",
  providerCallId: "egma-fixture-capture-1",
  agentPlatform: "livekit_agents",
  platformAgentId: "",
  platformAgentName: "kelly",
  platformAgentVersion: "",
  runId: "",
  agentId: "",
};

function step(overrides: Partial<Step> = {}): Step {
  return {
    spanId: "a1",
    parentSpanId: "",
    name: "llm_request",
    kind: "model",
    status: "unset",
    startedAt: "2026-08-02T18:04:41.000000Z",
    durationNs: "1000000",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    spans: [],
    ...overrides,
  };
}

describe("the window the list asks about", () => {
  const now = new Date("2026-08-02T20:00:00.000Z");

  it("is the last day when nobody chose", () => {
    const window = recentWindow(windowChoiceOf(null), now);
    expect(window.from).toBe("2026-08-01T20:00:00.000Z");
  });

  it("is whichever span of time was chosen instead", () => {
    expect(recentWindow(windowChoiceOf("1h"), now).from).toBe(
      "2026-08-02T19:00:00.000Z",
    );
    expect(recentWindow(windowChoiceOf("7d"), now).from).toBe(
      "2026-07-26T20:00:00.000Z",
    );
  });

  /**
   * A word nobody offered is not a window. The store refuses an absent one and
   * caps a wide one, and neither refusal is worth reaching by mistyping a URL.
   */
  it("falls back to the last day for anything it was not offered", () => {
    expect(windowChoiceOf("all-of-it")).toBe("24h");
    expect(windowChoiceOf("")).toBe("24h");
  });

  /**
   * The default is written once. Three copies of "24h" — one in the page's
   * initial state, one behind `windowChoiceOf`, one behind `recentWindow` —
   * would be three places to change it and two to forget.
   */
  it("takes its default from the one place that names it", () => {
    expect(windowChoiceOf(null)).toBe(copy.DEFAULT_WINDOW);
    expect(recentWindow(windowChoiceOf(null), now)).toEqual(
      recentWindow(copy.DEFAULT_WINDOW, now),
    );
  });

  /**
   * The choice rides in the address so a reload and a link both stay on the
   * window somebody chose — and it is the *choice* that rides there rather
   * than the two instants it computes to, which would freeze the list at
   * whenever the link was made.
   */
  it("is named in the address by the choice, not by the instants", () => {
    const address = new URLSearchParams(`${WINDOW_PARAMETER}=7d`);
    expect(windowChoiceOf(address.get(WINDOW_PARAMETER))).toBe("7d");
    expect(recentWindow(windowChoiceOf(address.get(WINDOW_PARAMETER)), now).from)
      .toBe("2026-07-26T20:00:00.000Z");
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

describe("agent platform labels", () => {
  it("uses product names for known platforms and keeps an unknown name", () => {
    expect(agentPlatformLabel("retell")).toBe("Retell");
    expect(agentPlatformLabel("livekit_agents")).toBe("LiveKit Agents");
    expect(agentPlatformLabel("future_platform")).toBe("Future platform");
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

  /** Which is what makes one transcript a link somebody can send. */
  it("rides in the address, so the page opens on its own", () => {
    const where = transcriptPath("prj_2", FACTS);
    expect(
      where.startsWith(
        `/projects/prj_2/monitoring/transcripts/${FACTS.traceId}?`,
      ),
    ).toBe(true);

    const asked = new URLSearchParams(where.slice(where.indexOf("?")));
    expect(Date.parse(asked.get("from") ?? "")).toBeLessThan(
      Date.parse(FACTS.startedAt),
    );
    expect(Date.parse(asked.get("to") ?? "")).toBeGreaterThan(
      Date.parse(FACTS.endedAt),
    );
  });
});

/**
 * Where the monitoring section is, and what its two pages ask for.
 *
 * Every segment is a glossary word. The store files a trace made of spans and
 * the v1 paths say so, because that is the machine surface; what a person
 * navigates is **monitoring**, and what they open is a **transcript**.
 */
describe("the addresses the monitoring section holds", () => {
  it("puts both pages inside the project that owns them", () => {
    expect(monitoringPath("prj_2")).toBe("/projects/prj_2/monitoring");
    expect(transcriptsPath("prj_2")).toBe(
      "/projects/prj_2/monitoring/transcripts",
    );
  });

  /**
   * `dashboard` is reserved and undecided. Nothing ships there and nothing
   * claims it, so no address this module can build reaches it.
   */
  it("claims nothing at the reserved dashboard address", () => {
    for (const where of [
      monitoringPath("prj_2"),
      transcriptsPath("prj_2"),
      transcriptPath("prj_2", FACTS),
    ]) {
      expect(where, where).not.toContain("dashboard");
    }
  });

  it("says trace nowhere in an address a person is shown", () => {
    for (const where of [
      monitoringPath("prj_2"),
      transcriptsPath("prj_2"),
      transcriptPath("prj_2", FACTS).split("?")[0] ?? "",
    ]) {
      // The identifier a row carries is the store's, and it is a value rather
      // than a segment — so the check is on the path with the name removed.
      expect(where.replace(FACTS.traceId, ""), where).not.toMatch(
        /\btrace|\bspan/iu,
      );
    }
  });
});

/**
 * What a quiet Monitoring page owes its reader — four states, and never two at
 * once.
 *
 * Each answers a different question, and the wrong one costs an afternoon:
 * somebody with a week of traffic reading the last hour told to set up an
 * export they already have, somebody with no export told that no grader watches
 * production, somebody whose key names the whole organization told to point an
 * export at egma a second time.
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
   * **And nothing anywhere is the day-one page, whatever window is selected.**
   *
   * A developer who has just signed up lands on the default window, not on the
   * widest, and an empty page is the one thing standing between them and a
   * working export. Deciding this by the selected window alone would put a
   * click in front of the teaching written for exactly this moment — so the
   * question asked is "has this project ever recorded anything", which the
   * window cannot answer and one extra read can.
   */
  it("teaches the setup whenever nothing has ever arrived, at any window", () => {
    expect(seen({ listed: 0, everRecorded: 0 })).toBe("set-up-capture");
  });

  it("knows which window is the widest, so the extra read can be skipped there", () => {
    expect(isWidestWindow("30d")).toBe(true);
    for (const narrower of ["1h", "24h", "7d"] as const) {
      expect(isWidestWindow(narrower), narrower).toBe(false);
    }
  });

  /** A visible organization key points to the exact scope that must change. */
  it("names the organization-wide key instead, when one is visible", () => {
    expect(seen({ organizationWideKeys: 1 })).toBe("key-names-the-organization");
  });

  it("says nothing watches production once traffic is arriving", () => {
    expect(seen({ listed: 4, organizationWideKeys: 1 })).toBe(
      "nothing-watches-production",
    );
  });

  /** A healthy project gets no guidance at all, which is the fifth answer. */
  it("says nothing at all when traffic is arriving and something judges it", () => {
    expect(seen({ listed: 3, watchingProduction: 1 })).toBeNull();
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

  /**
   * With no traffic, telling somebody that no grader watches production is
   * noise about a problem they do not have yet — so the order is fixed and
   * exactly one state can ever be on screen.
   */
  it("never shows two of them, whatever the four inputs say", () => {
    const named = [
      "nothing-in-this-window",
      "set-up-capture",
      "key-names-the-organization",
      "nothing-watches-production",
    ];

    for (const listed of [0, 5]) {
      for (const everRecorded of [0, 7, null]) {
        for (const organizationWideKeys of [0, 2, null]) {
          for (const watchingProduction of [0, 1, null]) {
            const state = quietState({
              listed,
              everRecorded,
              organizationWideKeys,
              watchingProduction,
            });
            expect(state === null || named.includes(state)).toBe(true);
          }
        }
      }
    }
  });

  it("counts a grader as watching only when its scope reaches production", () => {
    expect(watchesProduction({ scope: { production: { samplePercent: 10 } } })).toBe(
      true,
    );
    expect(watchesProduction({ scope: { production: null } })).toBe(false);
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
  /**
   * Durations arrive as decimal strings because a nanosecond count passes what
   * a JSON number holds exactly. Reading one as a number would round the low
   * digits away, so it is read as a `bigint` and narrowed once it is small.
   */
  it("keeps a nanosecond count that a JSON number could not have held", () => {
    // 2^53 nanoseconds and one more: the first count a double cannot name.
    expect(milliseconds("9007199254740993")).toBeCloseTo(9007199254.740993, 3);
  });

  it("reads a duration at a precision somebody can use", () => {
    expect(howLong("340000000")).toBe("340 ms");
    expect(howLong("1234000000")).toBe("1.2 s");
    expect(howLong("73494876403")).toBe("1m 13s");
  });

  /**
   * A unit is chosen by what it would print. Rounding after the choice is what
   * produces `1000 ms` and `60.0 s` — both of which are the next unit up,
   * spelled as though it were not.
   */
  it("never prints a figure that is really the next unit up", () => {
    expect(howLong("999400000")).toBe("999 ms");
    expect(howLong("999600000")).toBe("1.0 s");
    expect(howLong("59940000000")).toBe("59.9 s");
    expect(howLong("59960000000")).toBe("1m 0s");
  });

  it("says how far into the exchange something happened", () => {
    expect(howFarIn("2026-08-02T18:04:52.681989Z", FACTS.startedAt)).toBe(
      "+12.4 s",
    );
  });

});

describe("reading the shape of a turn", () => {
  const failing = step({ spanId: "b1", status: "error", name: "llm_request" });
  const turn = step({
    kind: "turn:agent",
    spans: [step({ spanId: "a2", spans: [failing] }), step({ spanId: "a3" })],
  });

  it("counts every step inside, however deeply it is nested", () => {
    expect(stepsInside(turn)).toBe(3);
    expect(everyStep([turn])).toHaveLength(4);
  });

  /**
   * A failure four adapters down is still this turn's failure, and somebody
   * scanning a transcript for what went wrong must not have to open every turn
   * to find out which one holds it.
   */
  it("marks a turn something failed inside, however deep the failure is", () => {
    expect(somethingFailed(turn)).toBe(true);
    expect(somethingFailed(step({ kind: "turn:human" }))).toBe(false);
  });

  /** A turn with nothing timed inside it is a real answer, not a missing one. */
  it("counts nothing for a turn no provider reported steps for", () => {
    expect(stepsInside(step({ kind: "turn:human" }))).toBe(0);
  });

  it("knows which of the two speakers a turn belongs to", () => {
    expect(isHuman(step({ kind: "turn:human" }))).toBe(true);
    expect(isHuman(step({ kind: "turn:agent" }))).toBe(false);
  });
});

describe("what a stored kind is called where somebody reads it", () => {
  it("maps every kind the store has a word for", () => {
    expect(copy.stepLabel("model")).toBe("Model");
    expect(copy.stepLabel("tts")).toBe("Speech");
    expect(copy.stepLabel("tool")).toBe("Tool");
    expect(copy.stepLabel("end-of-turn")).toBe("Turn detection");
    expect(copy.stepLabel("speaking")).toBe("Speaking");
    expect(copy.stepLabel("root")).toBe("Overview");
    expect(copy.stepLabel("other")).toBe("Other");
  });

  /**
   * Named ahead of a provider that emits it. LiveKit puts what was heard on the
   * turn itself, so nothing egma has met sends this kind — and the first
   * framework that does should meet a word rather than **Other**.
   */
  it("already has a word for the recognition step nobody sends yet", () => {
    expect(copy.stepLabel("stt")).toBe("Speech recognition");
  });

  /**
   * Span coverage is not uniform across providers, and the vocabulary grows one
   * framework at a time. A page that hid what it could not classify would
   * under-report exactly the frameworks egma has not met yet, so an unknown
   * kind renders as something rather than as nothing.
   */
  it("still names a kind it has never seen", () => {
    expect(copy.stepLabel("vad")).toBe("Other");
    expect(copy.stepLabel("")).toBe("Other");
  });

  /**
   * The two labels a transcript uses for its speakers, and no third one.
   *
   * Read from the shared evidence surface rather than from this copy deck.
   * Both used to declare the same two words, so the monitoring page and the
   * simulation page could have come to label a speaker differently; one
   * declaration is what stops that, and this is the assertion that follows it.
   */
  it("labels the two speakers the way a transcript does", () => {
    expect(SPEAKERS).toEqual({ human: "human:", agent: "agent:" });
  });

  it("makes a grader assertion key readable without changing its words", () => {
    expect(humanizeIdentifier("appointment_change_policy")).toBe(
      "Appointment change policy",
    );
  });
});

/**
 * Two different things with one word between them.
 *
 * A step on this page can carry audio the agent's **own telemetry** attached to
 * it — somebody else's file, at somebody else's address. Beside it now sits
 * egma's own recording of the exchange, both channels, measured off the line
 * egma drove. Hearing one while believing it is the other is a wrong conclusion
 * about a production agent, so the rule is that neither is ever called just
 * "audio": every label that names audio names whose it is.
 */
describe("the two kinds of audio a transcript can offer", () => {
  const NAMES_WHOSE_IT_IS = /\begma\b|\byour\b/iu;

  it("never leaves either one unattributed", () => {
    const labels = {
      "the link to a step's audio": copy.DETAIL.openAudio,
      "the recorded fact beside it": copy.FACTS.audio,
      "the player's own name": copy.RECORDING.label,
      "what is said beside the player": copy.RECORDING.caption,
      // The sentences a reader meets when something goes wrong are the ones
      // this rule is easiest to forget, and the worst ones to forget it in:
      // they arrive when somebody is already confused about what they heard.
      "what is said when it will not play": copy.RECORDING.unplayable,
      "what a browser that cannot play it is told": copy.RECORDING.fallback,
      "what is said when Egma will not hand it over": copy.RECORDING.refused(404),
    };

    for (const [where, said] of Object.entries(labels)) {
      expect(NAMES_WHOSE_IT_IS.test(said), `${where}: "${said}"`).toBe(true);
    }

    // And no two of them are the same words, which is the failure this is
    // guarding: one label copied onto both would attribute nothing.
    expect(new Set(Object.values(labels)).size).toBe(
      Object.values(labels).length,
    );
  });

  /**
   * Two channels exist so that either speaker can be heard alone when a turn
   * reads wrong, which is worth nothing if nobody is told which is which.
   */
  it("says which speaker is on which channel, in the transcript's own words", () => {
    expect(copy.RECORDING.caption).toContain(copy.LIST.human);
    expect(copy.RECORDING.caption).toContain(copy.LIST.agent);
  });
});

/**
 * The banned list, as the domain model writes it.
 *
 * `trace` and `span` are on it for these pages specifically: both are storage
 * words, correct in the API's paths and in the columns underneath, and never
 * something a person is shown. `session` is the one carve-out and it is not a
 * loophole — it names a signed-in browser session and never an exchange —
 * so it is checked for separately below.
 */
const NEVER_SAID = [
  "trace",
  "span",
  "call",
  "caller",
  "conversation",
  "eval",
  "evaluation",
  "evaluator",
  "scorer",
  "assertion",
  "digital human",
  "simulant",
  "virtual human",
  "synthetic user",
  "digital twin",
  "scenario",
  "experiment",
  "batch",
  "trial",
  "attempt",
  "iteration",
];

/** Every string these pages can put on a screen. */
function everySentence(said: unknown): string[] {
  if (typeof said === "string") return [said];
  if (typeof said === "function") {
    // The counted ones, asked at both the singular and the plural.
    return [1, 2].map((howMany) => String((said as (n: number) => string)(howMany)));
  }
  if (Array.isArray(said)) return said.flatMap(everySentence);
  if (typeof said === "object" && said !== null) {
    return Object.values(said).flatMap(everySentence);
  }
  return [];
}

/**
 * Everything under the discipline: the transcript pages' own shared words.
 */
const EVERY_WORD = [copy];

describe("what the pages say out loud", () => {
  it("is gathered in one place, so it can be held against the list", () => {
    const said = everySentence(copy);
    expect(said.length).toBeGreaterThan(40);
  });

  /**
   * The store files a trace made of spans; a person reads a transcript made of
   * turns. Those are two vocabularies on purpose, and this is the seam that
   * keeps the first out of the second.
   */
  it("uses no storage word and no banned one", () => {
    for (const sentence of everySentence(EVERY_WORD)) {
      for (const banned of NEVER_SAID) {
        expect(
          new RegExp(`\\b${banned}`, "iu").test(sentence),
          `"${sentence}" says "${banned}"`,
        ).toBe(false);
      }
    }
  });

  /**
   * `session` is the carve-out: it is the right word for a signed-in browser
   * session and the wrong one for an exchange. These pages have nothing to say
   * about either, so they say it about neither.
   */
  it("does not borrow `session` for an exchange", () => {
    for (const sentence of everySentence(EVERY_WORD)) {
      expect(/\bsession/iu.test(sentence), sentence).toBe(false);
    }
  });

  /**
   * The pages render what is in that file and not string literals of their own.
   * A heading typed straight into the markup is a word nothing above can check,
   * which is the failure this whole arrangement exists to prevent.
   */
  it("is what the pages actually render", async () => {
    for (const page of [
      LIST_PAGE,
      DETAIL_PAGE,
    ]) {
      const source = await readFile(path.join(WEB, page), "utf8");
      expect(source, page).toContain("transcript-copy.ts");
    }
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

  /**
   * **The addresses they used to live at are gone rather than forwarded.**
   *
   * They were never linked from the product — the pages carried no project, so
   * no navigation could honestly point at them — which means a saved address is
   * a hand-typed one. A redirect would be a second name for a page that has one
   * name now, kept alive for nobody.
   */
  it("no longer resolve at the top-level addresses they came from", async () => {
    for (const gone of ["app/traces", "app/traces/[traceId]"]) {
      await expect(readdir(path.join(WEB, gone))).rejects.toThrow();
    }
  });

  it("forwards the versioned platform API on this origin", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    expect(rewrites).toContain('source: "/v1/:path*"');
    expect(rewrites).toContain('destination: `${api}/v1/:path*`');
  });
});

/**
 * The metrics display: what this exchange measured, shown beside the exchange.
 *
 * **The page derives no number.** Every figure it shows arrived already computed
 * by the platform's one shared measure module — the same module a future
 * metric-based grader can read — so a duration worked out in a browser would be a
 * second answer about one exchange and exactly what that module exists to
 * prevent. What the page decides is which of the samples to lead with, and it
 * says which one that is.
 */
describe("what the exchange measured", () => {
  it("is read from the answer, and never worked out from the timings", async () => {
    const page = await readFile(
      path.join(WEB, DETAIL_PAGE),
      "utf8",
    );

    // Rendered from the answer's own field.
    expect(page).toContain("detail.measures");
    // With the unit the answer carried, never one this page assumed — a page
    // that said "ms" would be wrong the moment a measure is not a duration.
    expect(page).toContain("one.unit");
    // And separate from grades, because a metric is observed and a grader gives
    // a score: nothing here is green or red.
    expect(page).toContain("MEASURES.label");
  });

  /**
   * **The reduction is the platform's, and this page must not be able to
   * repeat it.**
   *
   * The one number a bound is held against arrives on the answer as `worst`.
   * Taking the maximum here instead would look harmless and would be a second
   * implementation of exactly that figure — correct while both happen to take
   * the maximum, silently wrong the first day a grader reduces some other way,
   * with nothing anywhere failing. The page held those four lines once; this is
   * what stops them coming back.
   *
   * The rule that no source file outside the measure module reduces a series
   * lives in `packages/db/test/one-measure-path.test.ts` and covers this file
   * too. What is asserted here is the positive half: the page reads the reduced
   * figure it was sent.
   */
  it("prints the reduction it was handed, and never computes one", async () => {
    const page = await readFile(
      path.join(WEB, DETAIL_PAGE),
      "utf8",
    );

    expect(page).toContain("one.worst");
    // The series is used for one thing, which is saying how many there were.
    expect(page).toContain("one.samples.length");
    expect(page).not.toContain("samples.reduce");
    expect(page).not.toContain("samples[0]");
  });

  it("says which measurement it is showing, and how many there were", () => {
    expect(copy.MEASURES.worst).toBe("worst");
    expect(copy.MEASURES.counted(1)).toContain("1 measurement");
    expect(copy.MEASURES.counted(11)).toContain("11 measurements");
  });

  /**
   * A reading the store's span limit cut short holds the first part of a long
   * exchange, so its worst measurement is the worst of that part — the slowest
   * turn may be past the cut. Saying so is the difference between a figure a
   * reader can use and one that quietly means something else.
   */
  it("qualifies the figure when the reading is only part of the exchange", async () => {
    const page = await readFile(
      path.join(WEB, DETAIL_PAGE),
      "utf8",
    );

    expect(page).toContain("one.partial");
    expect(copy.MEASURES.partialWorst).toContain("part Egma holds");
  });

  it("says nothing was measured rather than showing a blank", () => {
    expect(copy.MEASURES.none.length).toBeGreaterThan(40);
  });
});

/**
 * Where a number came from, said on the page that shows it.
 *
 * **A grade's evidence must never be a surprise.** Some figures on this
 * page were not timed by anybody: Egma worked them out from the timings the
 * agent's own framework already records. A developer whose latency check starts
 * failing is owed that sentence beside the number, not in a document.
 *
 * And the quiet sentence for an exchange that measured nothing stays exactly as
 * it was, because it is still exactly as true — a framework emitting nothing
 * Egma recognises still measures nothing.
 */
describe("saying which numbers Egma worked out", () => {
  it("adds a clause only when a worked-out figure is on the page", async () => {
    const page = await readFile(path.join(WEB, DETAIL_PAGE), "utf8");

    // Shown from the answer's own flag, and only when one is set — a caveat
    // about something that did not happen is noise on every other exchange.
    expect(page).toContain("one.derived === true");
    expect(page).toContain("MEASURES.derived");
    expect(copy.MEASURES.derived).toContain("your framework's own timings");
    // Marked on the figure too, so a page mixing the two can be read without
    // counting rows.
    expect(copy.MEASURES.derivedOne).toContain("framework");
  });

  /**
   * **A figure an agent platform measured reads bare — no mark, no caveat.**
   *
   * Who took a number is a fact about the record, and the record keeps it: the
   * measure still arrives carrying `reportedBy`. What it no longer does is
   * appear in a sentence a customer reads, so a platform-reported figure sits on
   * this page exactly as a figure Egma timed does. The day a surface wants
   * provenance back, the answer already carries it.
   */
  it("renders a platform-reported figure bare, with nothing said about it", async () => {
    const page = await readFile(path.join(WEB, DETAIL_PAGE), "utf8");

    // No sentence and no mark on the page, and no words left in the copy for
    // either: a phrase nothing renders is a phrase somebody re-wires by mistake.
    expect(page).not.toContain("MEASURES.reported");
    expect(Object.keys(copy.MEASURES)).not.toContain("reported");
    expect(Object.keys(copy.MEASURES)).not.toContain("reportedOne");
    // And nothing anywhere in the page's words names a platform.
    expect(page).not.toContain("as reported by");
  });

  /**
   * **The wording that must never come back.** A figure a platform reported
   * arrives `derived: true` as well, because Egma did not time it either — so a
   * page reading `derived` alone would tell a developer their platform's number
   * was "worked out from your framework's own timings", about an observation
   * Egma never made. A caveat that is itself untrue is worse than none: it is
   * the sentence somebody decides how far to believe a failing check on.
   *
   * One predicate answers it for both the mark and the panel's sentence, so the
   * two can never come to disagree about a figure.
   */
  it("never words a platform-reported figure as one Egma worked out", async () => {
    const page = await readFile(path.join(WEB, DETAIL_PAGE), "utf8");

    // The gate itself: reported figures are outside it, by the field that is
    // the only thing telling them from worked-out ones.
    expect(page).toContain(
      "return one.derived === true && one.reportedBy === undefined;",
    );
    // And it is the only way to either the caveat or the mark.
    expect(page).toContain("{measured.some(workedOut) ? (");
    expect(page).toContain("const from = workedOut(one)");
    expect(page.split("MEASURES.derivedOne")).toHaveLength(2);
  });

  it("keeps the nothing-was-measured sentence exactly as it was", () => {
    expect(copy.MEASURES.none).toBe(
      "Nothing was measured here. Egma's own simulations time their turns; an " +
        "exchange your agent had carries whatever its telemetry emitted, which " +
        "for most frameworks is no timings at all.",
    );
  });

  /**
   * The words on the page are the product's, and three storage words are not
   * among them: a developer reading a transcript never has to know what a span,
   * a trace or an instrumentation scope is to understand where a number
   * came from.
   */
  it("says none of it in the storage vocabulary", () => {
    for (const said of [
      copy.MEASURES.derived,
      copy.MEASURES.derivedOne,
      copy.MEASURES.none,
    ]) {
      expect(said.toLowerCase()).not.toContain("span");
      expect(said.toLowerCase()).not.toContain("trace");
      expect(said.toLowerCase()).not.toContain("scope");
    }
  });
});
