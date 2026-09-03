import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../src/platform/credentials.ts";
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

  it("exposes the project attached to a current device login", async () => {
    await writeCredentials(workspace.credentialsFile, {
      url: URL,
      key: "egma_sk_login",
      login: { apiKeyId: "key_login", projectId: "prj_login" },
    });

    expect(
      await signedInAt(
        { url: URL, credentialsFile: workspace.credentialsFile },
        workspace.env(),
      ),
    ).toEqual({
      url: URL,
      key: "egma_sk_login",
      source: "device-login",
      projectId: "prj_login",
    });
  });

  it("keeps an older stored credential usable without inventing a project", async () => {
    await workspace.signIn(URL, "egma_sk_legacy");

    expect(
      await signedInAt(
        { url: URL, credentialsFile: workspace.credentialsFile },
        workspace.env(),
      ),
    ).toEqual({
      url: URL,
      key: "egma_sk_legacy",
      source: "stored",
    });
  });
});
