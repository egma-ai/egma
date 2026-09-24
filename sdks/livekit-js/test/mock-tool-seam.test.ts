import { describe, expect, it } from "vitest";

import {
  SeamError,
  mockedToolsIn,
  servedIn,
} from "../src/mock-tool-seam.ts";

describe("mock-tool exchange", () => {
  it("refuses malformed replies instead of guessing an answer", () => {
    for (const reply of [
      "not-json",
      "[]",
      '{"protocol_version":true,"mocked_tools":[]}',
      '{"protocol_version":2,"mocked_tools":[]}',
      '{"protocol_version":1,"mocked_tools":"check_calendar"}',
      '{"protocol_version":1,"mocked_tools":[""]}',
    ]) {
      expect(() => mockedToolsIn(reply)).toThrow(SeamError);
    }
    expect(
      mockedToolsIn(
        '{"protocol_version":1,"mocked_tools":[" check_calendar ","check_calendar"]}',
      ),
    ).toEqual(["check_calendar"]);

    for (const reply of ["not-json", "[]", "{}", '{"error":42}']) {
      expect(() => servedIn(reply)).toThrow(SeamError);
    }
    expect(servedIn('{"answer":"success","error":"failure"}')).toEqual({
      failed: true,
      message: "failure",
    });
  });
});
