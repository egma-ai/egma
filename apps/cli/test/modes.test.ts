import { describe, expect, it } from "vitest";

import { zeroPromptMode } from "../src/acp/modes.ts";

describe("the first belt: the mode that stops an agent asking", () => {
  it("takes the most permissive mode the agent offers", () => {
    expect(
      zeroPromptMode({
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Ask every time" },
          { id: "acceptEdits", name: "Accept edits" },
          { id: "bypassPermissions", name: "Do not ask" },
        ],
      }),
    ).toBe("bypassPermissions");
  });

  it("settles for the next best when the best is not on offer", () => {
    expect(
      zeroPromptMode({
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Ask every time" },
          { id: "acceptEdits", name: "Accept edits" },
        ],
      }),
    ).toBe("acceptEdits");
  });

  it("asks for nothing when the agent is already in the right mode", () => {
    expect(
      zeroPromptMode({
        currentModeId: "bypassPermissions",
        availableModes: [{ id: "bypassPermissions", name: "Do not ask" }],
      }),
    ).toBeNull();
  });

  it("leaves it to the second belt when the agent has no modes at all", () => {
    expect(zeroPromptMode(null)).toBeNull();
    expect(zeroPromptMode({ currentModeId: "only", availableModes: [{ id: "only", name: "Only" }] })).toBeNull();
  });
});
