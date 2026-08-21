import { describe, expect, it } from "vitest";

import {
  isErrorAnswer,
  NO_MOCK_TOOLS,
  resolveMockTools,
  type MockToolSnapshot,
} from "../src/index.ts";

/**
 * The merge that turns a run's frozen world into the answers one simulation is
 * served.
 *
 * It reaches nothing, so it is tested as what it is: arithmetic. The half that
 * needs a database — that a run freezes the right world in the first place, and
 * that an edit afterwards reaches none of it — is proven at the API seam, where
 * a caller would meet it.
 *
 * What is pinned here is the merge's own rules, because two things downstream
 * lean on them: the answers reach a simulator in this order, and each one says
 * whether the project or the test put it there.
 */

const PROJECT_WORLD: MockToolSnapshot = {
  defaults: [
    {
      toolName: "check_availability",
      mockToolId: "mck_00000000000000000000000001",
      answer: { answer: { slots: ["Tuesday 14:00"] } },
      delayMilliseconds: 0,
    },
    {
      toolName: "book_appointment",
      mockToolId: "mck_00000000000000000000000002",
      answer: { answer: { booked: true } },
      delayMilliseconds: 120,
    },
  ],
  overrides: {
    tstv_forcing: [
      {
        toolName: "check_availability",
        answer: { answer: { slots: [] } },
        delayMilliseconds: 900,
      },
    ],
    tstv_extra: [
      {
        toolName: "lookup_customer",
        answer: { error: "the customer record service is down" },
        delayMilliseconds: 0,
      },
    ],
  },
};

describe("the answers one simulation is served", () => {
  it("are the project's, for a version that overrides nothing", () => {
    expect(resolveMockTools(PROJECT_WORLD, "tstv_plain")).toEqual(
      PROJECT_WORLD.defaults,
    );
  });

  it("put a test's override in the place of the default it replaces", () => {
    const resolved = resolveMockTools(PROJECT_WORLD, "tstv_forcing");

    // The order is the project's, so the set a caller reads is the same shape
    // for every test of one project rather than reordering itself whenever a
    // test overrides something.
    expect(resolved.map((one) => one.toolName)).toEqual([
      "check_availability",
      "book_appointment",
    ]);
    expect(resolved[0]).toEqual({
      toolName: "check_availability",
      // Null, because an override is the test's own content and has no
      // identity of its own for a record to name.
      mockToolId: null,
      answer: { answer: { slots: [] } },
      delayMilliseconds: 900,
    });
    expect(resolved[1]).toEqual(PROJECT_WORLD.defaults[1]);
  });

  it("add an override for a tool the project answers for at all", () => {
    const resolved = resolveMockTools(PROJECT_WORLD, "tstv_extra");

    expect(resolved.map((one) => one.toolName)).toEqual([
      "check_availability",
      "book_appointment",
      "lookup_customer",
    ]);
    const added = resolved[2];
    expect(added?.mockToolId).toBeNull();
    expect(added?.answer).toEqual({
      error: "the customer record service is down",
    });
    expect(isErrorAnswer(added!.answer)).toBe(true);
  });

  it("are none at all for a run that froze nothing", () => {
    expect(resolveMockTools(NO_MOCK_TOOLS, "tstv_forcing")).toEqual([]);
  });

  it("tell a value answer from a failure, including a value that is null", () => {
    const answering: MockToolSnapshot = {
      defaults: [
        {
          toolName: "read_note",
          mockToolId: "mck_00000000000000000000000003",
          answer: { answer: null },
          delayMilliseconds: 0,
        },
      ],
      overrides: {},
    };

    const [only] = resolveMockTools(answering, "tstv_with_null_answer");
    expect(isErrorAnswer(only!.answer)).toBe(false);
    expect(only!.answer.answer).toBeNull();
  });
});
