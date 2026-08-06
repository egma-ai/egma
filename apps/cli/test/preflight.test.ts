import { describe, expect, it } from "vitest";

import { LOWEST_NODE_MAJOR, nodeVersionRefusal } from "../src/preflight.ts";

describe("the Node check", () => {
  it("refuses an old Node in plain words, naming both versions", () => {
    const refusal = nodeVersionRefusal("18.20.4");

    expect(refusal).not.toBeNull();
    expect(refusal).toContain(`Node ${LOWEST_NODE_MAJOR} or newer`);
    expect(refusal).toContain("18.20.4");
  });

  it("says nothing about a Node that is new enough", () => {
    expect(nodeVersionRefusal(`${LOWEST_NODE_MAJOR}.0.0`)).toBeNull();
    expect(nodeVersionRefusal("v24.16.0")).toBeNull();
  });

  it("lets a version it cannot read through rather than refusing on it", () => {
    expect(nodeVersionRefusal("unknown")).toBeNull();
  });
});
