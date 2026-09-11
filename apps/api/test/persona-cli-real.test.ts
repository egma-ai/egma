/** CLI persona controls through an authenticated API and real Postgres. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createEgmaFolder, EMPTY_CONFIG } from "../../cli/src/folder/egma-folder.ts";
import { CLI_ENTRY, makeWorkspace } from "../../cli/test/support/workspace.ts";
import { startInstance } from "./support/instance.ts";
import { projectKeyFor, signUp } from "./support/traces.ts";

const run = promisify(execFile);

it("persists CLI interruption and background controls through the authenticated API", async () => {
  const instance = await startInstance("persona_cli_real", { web: false });
  const workspace = await makeWorkspace();
  try {
    const customer = await signUp(instance.api, "persona-cli-real@example.com", "Persona CLI real");
    const key = await projectKeyFor(instance.api, customer);
    await workspace.signIn(instance.origin, key);
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        ...EMPTY_CONFIG,
        platform: { origin: instance.origin },
        project: { id: customer.projectId, name: "Persona CLI real" },
      },
    });

    const listed = await fetch(`${instance.origin}/v1/personas`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(listed.status, await listed.clone().text()).toBe(200);
    const persona = (await listed.json() as { personas: { id: string; name: string }[] }).personas
      .find((one) => one.name === "Interruptive caller");
    expect(persona).toBeDefined();

    const used = await run(process.execPath, [CLI_ENTRY, "persona", "use", persona!.id], {
      cwd: workspace.dir,
      env: workspace.env(),
    });
    expect(used.stderr).toBe("");

    const updated = await run(process.execPath, [CLI_ENTRY, "persona", "update", persona!.id,
      "--interruption-level", "occasional", "--background-sound", "rain-v1"], {
      cwd: workspace.dir,
      env: workspace.env(),
    });
    expect(updated.stderr).toBe("");

    const read = await fetch(`${instance.origin}/v1/personas/${persona!.id}?projectId=${customer.projectId}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(read.status, await read.clone().text()).toBe(200);
    expect(await read.json()).toMatchObject({
      settings: { controls: { interruptionLevel: "occasional", backgroundSoundId: "rain-v1" } },
    });
  } finally {
    await workspace.remove();
    await instance.close();
  }
});
