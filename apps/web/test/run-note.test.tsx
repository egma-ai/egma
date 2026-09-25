// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RunNote, type RunNoteTest } from "../ui/run-note.tsx";

afterEach(cleanup);

const PLAIN: RunNoteTest = { mockTools: [], env: null };
const MOCKING: RunNoteTest = {
  mockTools: [{ tool: "check_calendar", answer: { slots: [] } }],
  env: null,
};
const BODY: RunNoteTest = {
  mockTools: [],
  env: { pipecat_body_params: { tenant: "lakeside" } },
};
const RETELL_VARS: RunNoteTest = {
  mockTools: [],
  env: { retell_dynamic_variables: { caller_name: "Margaret" } },
};
const DISPATCH: RunNoteTest = {
  mockTools: [],
  env: { job_dispatch_metadata: { tenant: "acme" } },
};

/** The note's lines as a person reads them, and the box's volume. */
function noteOn(
  connectionType: string,
  tests: readonly RunNoteTest[],
): { readonly lines: readonly string[]; readonly accent: string | null } {
  const { container } = render(
    <RunNote connection={{ connectionType }} tests={tests} />,
  );
  const note = container.querySelector('[data-slot="run-note"]');
  const lines = [...(note?.querySelectorAll("p") ?? [])].map(
    (line) => line.textContent ?? "",
  );
  cleanup();
  return { lines, accent: note?.getAttribute("data-accent") ?? null };
}

describe("the run note on a Pipecat connection", () => {
  it("says the SDK requirement on every Pipecat run", () => {
    expect(noteOn("daily_room", [PLAIN, PLAIN])).toEqual({
      lines: ["A Pipecat simulation needs the Egma SDK in your agent."],
      accent: "brand",
    });
  });

  it("counts the tests that carry mock tools, as it does for LiveKit", () => {
    expect(noteOn("daily_room", [MOCKING, PLAIN]).lines).toEqual([
      "A Pipecat simulation needs the Egma SDK in your agent.",
      "1 of 2 tests carries mock tools. They are served only when your agent runs simulation(...). Tools a test does not mock run real, and every call is on the transcript.",
    ]);
  });

  it("names the other platforms' env keys a Pipecat connection does not use", () => {
    expect(noteOn("daily_room", [RETELL_VARS, DISPATCH, DISPATCH]).lines).toEqual([
      "A Pipecat simulation needs the Egma SDK in your agent.",
      "1 test carries retell_dynamic_variables, which a Pipecat connection does not use.",
      "2 tests carry job_dispatch_metadata, which a Pipecat connection does not use.",
    ]);
    // Its own key is used, so it earns no line.
    expect(noteOn("daily_room", [BODY]).lines).toEqual([
      "A Pipecat simulation needs the Egma SDK in your agent.",
    ]);
  });

  it("keeps three lines at most, dropping whole quiet facts in written order", () => {
    expect(
      noteOn("daily_room", [MOCKING, RETELL_VARS, DISPATCH]).lines,
    ).toEqual([
      "A Pipecat simulation needs the Egma SDK in your agent.",
      "1 of 3 tests carries mock tools. They are served only when your agent runs simulation(...). Tools a test does not mock run real, and every call is on the transcript.",
      "1 test carries retell_dynamic_variables, which a Pipecat connection does not use.",
    ]);
  });
});

describe("pipecat_body_params on the other platforms", () => {
  it("says a LiveKit connection does not use it", () => {
    expect(noteOn("livekit_room", [BODY, BODY]).lines).toEqual([
      "A LiveKit simulation needs the Egma SDK in your agent.",
      "2 tests carry pipecat_body_params, which a LiveKit connection does not use.",
    ]);
  });

  it("says every Retell connection does not use it, the phone lane included", () => {
    for (const connectionType of [
      "retell_text_mode",
      "retell_web_call",
      "retell_chat_api",
      "phone_number",
    ]) {
      expect(noteOn(connectionType, [BODY, PLAIN])).toEqual({
        lines: [
          "1 test carries pipecat_body_params, which a Retell connection does not use.",
        ],
        accent: "quiet",
      });
    }
    // Behind the Retell lane's own dispatch-metadata line, in written order.
    expect(noteOn("retell_text_mode", [DISPATCH, BODY]).lines).toEqual([
      "1 test carries job_dispatch_metadata, which a Retell connection does not use.",
      "1 test carries pipecat_body_params, which a Retell connection does not use.",
    ]);
  });
});
