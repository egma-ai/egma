import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signedInAt } from "../src/platform/signed-in.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://app.egma.example";

let workspace: Workspace;

beforeEach(async () => {
  workspace = await makeWorkspace();
});

afterEach(async () => {
  await workspace.remove();
});

describe("control-plane authentication", () => {
  it("uses EGMA_API_KEY before a login stored on this machine", async () => {
    await workspace.signIn(URL, "egma_sk_stored");

    expect(
      await signedInAt(
        { url: URL, credentialsFile: workspace.credentialsFile },
        workspace.env({ EGMA_API_KEY: "  egma_sk_from_ci  " }),
      ),
    ).toEqual({
      url: URL,
      key: "egma_sk_from_ci",
      source: "environment",
    });
  });
});
