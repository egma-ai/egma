/**
 * `egma connect` as a coding agent runs it: the built command, in a real
 * subprocess, against a fixture of egma's public HTTP API and a fake Retell.
 *
 * Nothing here is a terminal and nothing here answers a question, because the
 * whole promise of the verb is that neither is needed. What is asserted is the
 * two things something driving it can act on — the lines it prints and the
 * number it exits with — plus the one thing a developer cares about more than
 * either: that the key never appears in the process table.
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONNECT_EXIT } from "../src/commands/connect.ts";
import { DRIFT_LINE } from "../src/retell/prompt-drift.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import { CLI_ENTRY, MANIFEST, makeWorkspace, type Workspace } from "./support/workspace.ts";

const KEY = "key_1f4c9b7e2a6d0538c1e7";
const PROMPT = "You answer the order line.\nNever quote a price.\n";

const ONE_AGENT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      agent_name: "order-line",
      voice_id: "11labs-Adrian",
      response_engine: { type: "retell-llm", llm_id: "llm_0001" },
    },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: PROMPT, general_tools: [{ type: "end_call" }] }],
};

const TWO_AGENTS: FakeRetellScript = {
  keys: [KEY],
  agents: [
    { agent_id: "agent_0001", agent_name: "order-line", response_engine: { type: "retell-llm", llm_id: "llm_0001" } },
    { agent_id: "agent_0002", agent_name: "after-hours", response_engine: { type: "retell-llm", llm_id: "llm_0001" } },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: PROMPT }],
};

let platform: Platform;
let workspace: Workspace;
let retell: FakeRetell | undefined;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace({ "package.json": MANIFEST });
  await workspace.signIn(platform.url, platform.device.mint());
});

afterEach(async () => {
  await retell?.close();
  retell = undefined;
  await platform.close();
  await workspace.remove();
});

type Result = { stdout: string; stderr: string; code: number };

/**
 * The built command, with everything it is allowed to read set on purpose.
 *
 * Both key variables are cleared unless a check sets one, so a machine that
 * happens to have a real Retell key in its environment cannot make a check
 * about a missing key pass.
 */
function egma(
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly stdin?: string } = {},
): Promise<Result> {
  const env = workspace.env({
    EGMA_URL: platform.url,
    ...(retell === undefined ? {} : { EGMA_RETELL_URL: retell.url }),
    ...options.env,
  });

  const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd: workspace.dir, env });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.end(options.stdin ?? "");

  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

/** The printed lines, read the way something driving the command reads them. */
function facts(stdout: string): Record<string, string> {
  const read: Record<string, string> = {};
  for (const line of stdout.trimEnd().split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) read[line.slice(0, at)] = line.slice(at + 2);
  }
  return read;
}

describe("egma connect", () => {
  it("takes the key on standard input and registers the agent, asking nothing", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const result = await egma(["connect"], { stdin: `${KEY}\n` });

    expect(result.code).toBe(CONNECT_EXIT.connected);
    const said = facts(result.stdout);

    expect(said.url).toBe(platform.url);
    expect(said.retell_agents).toBe("1");
    expect(said.retell_agent_id).toBe("agent_0001");
    expect(said.retell_response_engine).toBe("retell-llm");
    expect(said.prompt_characters).toBe(String(PROMPT.length));
    expect(said.tools).toBe("1");
    expect(said.agent_name).toBe("order-line");
    expect(said.agent_id).toMatch(/^agt_/u);
    expect(said.connection_id).toMatch(/^con_/u);
    expect(said.connection_name).toBe("retell-1");
    expect(said.connection_type).toBe("retell");
    expect(said.connection_modality).toBe("voice");
    expect(said.grounded_in).toBe("retell");
    expect(said.status).toBe("connected");

    // The custody sentence is said before the key is asked for, on this
    // surface as much as on the wizard's.
    expect(result.stdout).toContain(
      "note: It is sent to egma and stored encrypted. It never lands in a file here.",
    );

    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.sealed).toEqual([KEY]);
  });

  it("takes the key from the environment, under either name", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const ours = await egma(["connect"], { env: { EGMA_RETELL_API_KEY: KEY } });
    expect(ours.code).toBe(CONNECT_EXIT.connected);
    expect(facts(ours.stdout).agent_name).toBe("order-line");

    // Retell's own variable name is read too, so an environment that already
    // holds one needs nothing new set.
    const theirs = await egma(["connect"], { env: { RETELL_API_KEY: KEY } });
    expect(theirs.code).toBe(CONNECT_EXIT.connected);
    expect(facts(theirs.stdout).agent_name).toBe("order-line-2");
  });

  it("refuses a key handed to it as an argument, and never says it back", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    for (const args of [["connect", "--key", KEY], ["connect", `--retell-key=${KEY}`]]) {
      const result = await egma(args);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("readable by every process on this machine");
      expect(`${result.stdout}${result.stderr}`).not.toContain(KEY);
      expect(platform.registered.agents).toHaveLength(0);
    }
  });

  it("says exactly which failure a key it cannot use produced", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const refused = await egma(["connect"], { stdin: "key_not-on-this-account" });
    expect(refused.code).toBe(CONNECT_EXIT.invalidKey);
    expect(facts(refused.stdout).status).toBe("invalid-key");
    expect(refused.stderr).toContain("Retell would not take that key");
  });

  it("says an empty account is an empty account, not a bad key", async () => {
    retell = await startFakeRetell({ keys: [KEY], agents: [] });

    const result = await egma(["connect"], { stdin: KEY });

    expect(result.code).toBe(CONNECT_EXIT.noAgents);
    expect(facts(result.stdout).status).toBe("no-agents");
    expect(result.stderr).toContain("has no agents on it");
  });

  it("lists the choice and refuses to guess when several agents are reachable", async () => {
    retell = await startFakeRetell(TWO_AGENTS);

    const result = await egma(["connect"], { stdin: KEY });

    expect(result.code).toBe(CONNECT_EXIT.unchosen);
    expect(result.stdout).toContain("retell_agent: agent_0001 order-line");
    expect(result.stdout).toContain("retell_agent: agent_0002 after-hours");
    expect(facts(result.stdout).status).toBe("unchosen");
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("connects the agent that was named, by flag or by variable", async () => {
    retell = await startFakeRetell(TWO_AGENTS);

    const byFlag = await egma(["connect", "--retell-agent", "agent_0002"], { stdin: KEY });
    expect(byFlag.code).toBe(CONNECT_EXIT.connected);
    expect(facts(byFlag.stdout).agent_name).toBe("after-hours");

    const byVariable = await egma(["connect"], {
      stdin: KEY,
      env: { EGMA_RETELL_AGENT_ID: "agent_0001" },
    });
    expect(byVariable.code).toBe(CONNECT_EXIT.connected);
    expect(facts(byVariable.stdout).agent_name).toBe("order-line");
  });

  it("says so when no key arrives at all", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const result = await egma(["connect"], { stdin: "" });

    expect(result.code).toBe(CONNECT_EXIT.noKey);
    expect(facts(result.stdout).status).toBe("no-key");
    expect(result.stderr).toContain("EGMA_RETELL_API_KEY");
  });

  it("sends whoever is not signed in to login, and writes nothing", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    const fresh = await makeWorkspace();
    try {
      const child = spawn(process.execPath, [CLI_ENTRY, "connect"], {
        cwd: fresh.dir,
        env: fresh.env({ EGMA_URL: platform.url, EGMA_RETELL_URL: retell.url }),
      });
      child.stdin.end(KEY);
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      const code = await new Promise<number>((resolve) => {
        child.on("close", (value) => resolve(value ?? 0));
      });

      expect(code).toBe(CONNECT_EXIT.notSignedIn);
      expect(facts(stdout).status).toBe("not-signed-in");
    } finally {
      await fresh.remove();
    }
  });

  it("says once that the repository and the provider have drifted apart", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    await writeFile(path.join(workspace.dir, "prompt.md"), "Always quote a price.\n", "utf8");

    const drifted = await egma(["connect", "--repo-prompt", "prompt.md"], { stdin: KEY });
    expect(drifted.code).toBe(CONNECT_EXIT.connected);
    expect(facts(drifted.stdout).drift).toBe("yes");
    expect(drifted.stdout.split("\n").filter((line) => line.includes(DRIFT_LINE))).toHaveLength(1);

    // The same file holding the same words says nothing at all.
    await writeFile(path.join(workspace.dir, "same.md"), PROMPT, "utf8");
    const same = await egma(["connect", "--repo-prompt", "same.md"], { stdin: KEY });
    expect(facts(same.stdout).drift).toBe("no");
    expect(same.stdout).not.toContain(DRIFT_LINE);

    // And with nothing to compare against, nothing is claimed either way.
    const unknown = await egma(["connect"], { stdin: KEY });
    expect(facts(unknown.stdout).drift).toBe("not-compared");
    expect(unknown.stdout).not.toContain(DRIFT_LINE);
  });

  it("is named in the help, with the numbers it answers with", async () => {
    const help = await egma(["--help"]);

    expect(help.stdout).toContain("egma connect [options]");
    expect(help.stdout).toContain("0 connected   2 the key was refused");
    expect(help.stdout).toContain("EGMA_RETELL_API_KEY");
  });
});

describe("the whole walk, headless", () => {
  it("finds the agent, connects it, and leaves one line behind", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    await writeFile(path.join(workspace.dir, "prompt.md"), "Always quote a price.\n", "utf8");

    const script = await workspace.script({
      steps: [
        { kind: "say", text: "egma:found framework retell-sdk\n" },
        { kind: "say", text: "egma:found prompts prompt.md\n" },
        { kind: "stop", reason: "end_turn" },
      ],
      // The walk carries on past connect into writing tests, so the same
      // scripted agent has to answer that task too.
      stepsByTask: [
        {
          contains: "Write 12 tests",
          steps: [
            { kind: "say", text: "egma:plan price-question\n" },
            {
              kind: "write-file",
              path: "egma/tests/price-question.md",
              content:
                "---\nname: price-question\n---\n## Scenario\nSomebody asks what a rebinding costs.\n## Expected behaviors\n1. The agent does not quote a price.\n",
            },
            { kind: "say", text: "egma:wrote price-question\n" },
            { kind: "stop", reason: "end_turn" },
          ],
        },
      ],
    });

    // The walk ends in a run, and a run ends when verdicts arrive. Nothing
    // here conducts a simulation, so the fixture is given the one thing a
    // platform with a simulator attached has.
    const grading = gradeEveryRun(platform);
    const result = await egma(
      [
        "--headless",
        "--cwd",
        workspace.dir,
        "--",
        process.execPath,
        new URL("./support/fake-agent.ts", import.meta.url).pathname,
        script,
      ],
      { env: { EGMA_RETELL_API_KEY: KEY } },
    );
    grading.stop();

    expect(result.code).toBe(0);
    // The drift the coding agent's answer made checkable, said once.
    expect(result.stdout).toContain(DRIFT_LINE);
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections[0]?.name).toBe("retell-1");

    // And the walk did not stop at connecting: the test the coding agent wrote
    // is a file in the repository and a version on egma.
    expect(result.stdout).toContain("test: price-question default persona");
    expect(platform.tests.tests.map((test) => test.name)).toEqual(["price-question"]);
    // And it did not stop at pushing either: the run is going, and the line
    // left behind says where to watch it.
    expect(result.stdout).toContain("✓ Your first run is live");
    expect(result.stdout).toContain(
      `${platform.url}/runs/${platform.running.runs[0]?.id ?? ""}`,
    );
    expect(result.stdout).toContain(
      "Tests are code now: egma/tests/ (committed). Edit them, then egma push.",
    );
  });
});
