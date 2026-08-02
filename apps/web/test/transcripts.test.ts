import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import * as copy from "../lib/transcript-copy.ts";
import {
  everyStep,
  howFarIn,
  howLong,
  isHuman,
  milliseconds,
  recentWindow,
  somethingFailed,
  stepsInside,
  transcriptPath,
  whenItWas,
  windowAround,
  windowChoiceOf,
  type Facts,
  type Step,
} from "../lib/transcripts.ts";

/**
 * What the transcript pages decide for themselves: the window they ask about,
 * the numbers they read out of the contract, and every word they say.
 */

const WEB = path.join(import.meta.dirname, "..");

const FACTS: Facts = {
  trace_id: "5c1e4b0f8d2a4e6b9f0c1d2e3a4b5c6d",
  started_at: "2026-08-02T18:04:40.281989Z",
  ended_at: "2026-08-02T18:05:53.776865Z",
  duration_ns: "73494876403",
  span_count: 133,
  turn_counts: { human: 5, agent: 8 },
  tool_span_count: 2,
  errored_span_count: 3,
  source: "production",
  emitter: "agent",
  environment: "default",
  connection_type: "livekit",
  provider_call_id: "egma-fixture-capture-1",
  run_id: "",
  agent_id: "",
};

function step(overrides: Partial<Step> = {}): Step {
  return {
    span_id: "a1",
    parent_span_id: "",
    name: "llm_request",
    kind: "model",
    status: "unset",
    started_at: "2026-08-02T18:04:41.000000Z",
    duration_ns: "1000000",
    text: "",
    audio_url: "",
    tool_name: "",
    tool_arguments: "",
    tool_result: "",
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
    expect(Date.parse(window.from)).toBeLessThan(Date.parse(FACTS.started_at));
    expect(Date.parse(window.to)).toBeGreaterThan(Date.parse(FACTS.ended_at));
  });

  /** Which is what makes one transcript a link somebody can send. */
  it("rides in the address, so the page opens on its own", () => {
    const where = transcriptPath(FACTS);
    expect(where.startsWith(`/traces/${FACTS.trace_id}?`)).toBe(true);

    const asked = new URLSearchParams(where.slice(where.indexOf("?")));
    expect(Date.parse(asked.get("from") ?? "")).toBeLessThan(
      Date.parse(FACTS.started_at),
    );
    expect(Date.parse(asked.get("to") ?? "")).toBeGreaterThan(
      Date.parse(FACTS.ended_at),
    );
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

  it("says how far into the exchange something happened", () => {
    expect(howFarIn("2026-08-02T18:04:52.681989Z", FACTS.started_at)).toBe(
      "+12.4 s",
    );
  });

  /**
   * UTC, and said so. Traces are read beside logs and beside a provider's own
   * dashboard, and a page that quietly shifted the numbers into the reader's
   * timezone would make the two disagree with nothing on screen to say why.
   */
  it("shows an instant in UTC and names the zone", () => {
    expect(whenItWas(FACTS.started_at)).toBe("2026-08-02 18:04:40 UTC");
  });
});

describe("reading the shape of a turn", () => {
  const failing = step({ span_id: "b1", status: "error", name: "llm_request" });
  const turn = step({
    kind: "turn:agent",
    spans: [step({ span_id: "a2", spans: [failing] }), step({ span_id: "a3" })],
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
   * Span coverage is not uniform across providers, and the vocabulary grows one
   * framework at a time. A page that hid what it could not classify would
   * under-report exactly the frameworks egma has not met yet, so an unknown
   * kind renders as something rather than as nothing.
   */
  it("still names a kind it has never seen", () => {
    expect(copy.stepLabel("vad")).toBe("Other");
    expect(copy.stepLabel("")).toBe("Other");
  });

  /** The two labels a transcript uses for its speakers, and no third one. */
  it("labels the two speakers the way a transcript does", () => {
    expect(copy.SPEAKERS).toEqual({ human: "human:", agent: "agent:" });
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
  "persona",
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
    for (const sentence of everySentence(copy)) {
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
    for (const sentence of everySentence(copy)) {
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
      "app/traces/page.tsx",
      "app/traces/[traceId]/page.tsx",
    ]) {
      const source = await readFile(path.join(WEB, page), "utf8");
      expect(source, page).toContain("transcript-copy.ts");
    }
  });
});

describe("the transcript pages", () => {
  it("exist, at the two addresses the list links between", async () => {
    const found = await readdir(path.join(WEB, "app/traces"), {
      recursive: true,
    });
    expect(found).toContain("page.tsx");
    expect(found.map((one) => one.replaceAll(path.sep, "/"))).toContain(
      "[traceId]/page.tsx",
    );
  });

  /**
   * The pages consume the two v1 endpoints and nothing else, on the origin they
   * were served from — which only works if this process forwards that path. A
   * path a page fetches and the config does not forward would be served by this
   * process, which has no such route, and the page would 404.
   */
  it("reach the v1 read endpoints at paths this instance rewrites", async () => {
    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    expect(rewrites).toContain("/v1/traces");
    expect(rewrites).toContain("/v1/traces/:path*");

    for (const page of [
      "app/traces/page.tsx",
      "app/traces/[traceId]/page.tsx",
    ]) {
      const source = await readFile(path.join(WEB, page), "utf8");
      expect(source, page).toContain("/v1/traces");
    }
  });
});
