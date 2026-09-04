import { describe, expect, it } from "vitest";

import { selectTarget } from "../src/folder/target-selection.ts";

describe("run target selection guidance", () => {
  it("explains both steps when this folder has no Agent", () => {
    const result = selectTarget({ agents: [] }, {});

    expect(result).toMatchObject({
      kind: "refused",
      status: "not-connected",
      message:
        "This folder has no registered Agent. Run egma agent register, then run egma agent connection add. Nothing was started.",
    });
  });

  it("asks for only a Connection when the selected Agent already exists", () => {
    const result = selectTarget(
      {
        agents: [
          {
            id: "agt_one",
            name: "Receptionist",
            platform: "livekit",
            connections: [],
          },
        ],
      },
      { agent: "agt_one" },
    );

    expect(result).toMatchObject({
      kind: "refused",
      status: "not-connected",
      message:
        'Agent "Receptionist" has no configured Connection. Run egma agent connection add to add one. Nothing was started.',
    });
    if (result.kind === "refused") {
      expect(result.message).not.toContain("agent register");
    }
  });
});
