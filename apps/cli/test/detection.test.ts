import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detect } from "../src/wizard/detection.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

let workspace: Workspace;

beforeEach(async () => {
  workspace = await makeWorkspace();
});

afterEach(async () => {
  await workspace.remove();
});

describe("repository detection", () => {
  it("counts markdown tests inside every direct suite and not suite manifests", async () => {
    const tests = path.join(workspace.dir, "egma", "tests");
    await mkdir(path.join(tests, "release"), { recursive: true });
    await mkdir(path.join(tests, "regression"));
    await writeFile(path.join(tests, "release", "suite.yaml"), "id: one\nname: One\n");
    await writeFile(path.join(tests, "release", "one.md"), "test\n");
    await writeFile(path.join(tests, "regression", "two.md"), "test\n");
    await writeFile(path.join(tests, "legacy.md"), "not a direct suite test\n");

    await expect(detect({ cwd: workspace.dir, drivenAgentName: null })).resolves.toMatchObject({
      egmaFolder: true,
      testsAlreadyHere: 2,
    });
  });
});
