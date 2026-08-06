/**
 * Connecting a Retell voice agent, end to end, with nobody watching.
 *
 * A fake Retell speaking the shapes its published SDK speaks, the fixture
 * platform speaking egma's public API, and the headless UI in between. No real
 * key exists anywhere here and CI never reaches the real Retell.
 *
 * What is asserted is what a developer could check afterwards: what was said on
 * screen, what landed on the platform, and — for the one rule that cannot be
 * checked any other way — that what landed is byte for byte what the provider
 * answered.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INVALID_KEY_LINE,
  KEY_ASK_LINE,
  CUSTODY_LINE,
  NO_AGENTS_LINE,
} from "../src/retell/connect.ts";
import { DRIFT_LINE } from "../src/retell/prompt-drift.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import { connectStep } from "../src/wizard/connect-step.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

/** A key shaped like a real one, and belonging to nobody. */
const KEY = "key_1f4c9b7e2a6d0538c1e7";
const OTHER_KEY = "key_9a8b7c6d5e4f3021b9d8";

const PROMPT = "You answer the order line.\nNever quote a price.\n";

const ONE_AGENT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      agent_name: "order-line",
      voice_id: "11labs-Adrian",
      response_engine: { type: "retell-llm", llm_id: "llm_0001", version: 3 },
      extra: { language: "en-GB", webhook_url: null },
    },
  ],
  llms: [
    {
      llm_id: "llm_0001",
      general_prompt: PROMPT,
      general_tools: [{ type: "end_call", name: "end_call", description: "hang up" }],
      extra: { model: "gpt-4.1", begin_message: "Quillfeather Bindery, hello." },
    },
  ],
};

const THREE_AGENTS: FakeRetellScript = {
  keys: [KEY],
  agents: [
    { agent_id: "agent_0001", agent_name: "order-line", response_engine: { type: "retell-llm", llm_id: "llm_0001" } },
    { agent_id: "agent_0002", agent_name: "after-hours", response_engine: { type: "retell-llm", llm_id: "llm_0002" } },
    { agent_id: "agent_0003", agent_name: "chat-desk", channel: "chat", response_engine: { type: "custom-llm", llm_websocket_url: "wss://example.invalid/llm" } },
  ],
  llms: [
    { llm_id: "llm_0001", general_prompt: PROMPT },
    { llm_id: "llm_0002", general_prompt: "You answer out of hours." },
  ],
};

let platform: Platform;
let workspace: Workspace;
let retell: FakeRetell | undefined;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace();
  await workspace.signIn(platform.url, platform.device.mint());
});

afterEach(async () => {
  await retell?.close();
  retell = undefined;
  await platform.close();
  await workspace.remove();
});

type RunOptions = {
  /** What the developer types, in order. `null` is "I have none to give". */
  readonly keys: readonly (string | null)[];
  /** Which agent they pick, when they are asked. */
  readonly agent?: string | null;
  /** Where the coding agent said the repository keeps its prompt. */
  readonly repoPrompts?: string | null;
};

/**
 * The headless wizard, answering a different thing each time it is asked.
 *
 * The plain headless UI answers one fixed thing per question, which cannot
 * express "a wrong key, then the right one" — the whole point of the re-ask.
 */
class ScriptedUI extends HeadlessUI {
  private readonly keys: (string | null)[];
  private readonly agent: string | null;

  constructor(options: RunOptions) {
    super();
    this.keys = [...options.keys];
    this.agent = options.agent ?? null;
  }

  override waitForAnswer(ask: "prompts-pointer" | "retell-key" | "retell-agent") {
    this.record.asked.push(ask);
    if (ask === "retell-key") return Promise.resolve(this.keys.shift() ?? null);
    if (ask === "retell-agent") return Promise.resolve(this.agent);
    return Promise.resolve(null);
  }
}

/** One run of the step, with the answers written in advance. */
async function run(options: RunOptions) {
  const ui = new ScriptedUI(options);

  const report = await connectStep({
    ui,
    platform: { url: platform.url, credentialsFile: workspace.credentialsFile },
    cwd: workspace.dir,
    repoPrompts: options.repoPrompts ?? null,
    signal: new AbortController().signal,
    retell: { url: retell?.url ?? "http://127.0.0.1:1" },
  });

  return { ui, report };
}

describe("the key, and the two failures worth a second try", () => {
  it("names a key Retell refused and asks exactly once more", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const { ui, report } = await run({ keys: [OTHER_KEY, OTHER_KEY] });

    // Said in Retell's own terms, not as a generic failure.
    expect(ui.record.statuses).toContain(INVALID_KEY_LINE);
    // Twice asked, and no more: the second failure is an ending.
    expect(ui.record.asked.filter((ask) => ask === "retell-key")).toEqual([
      "retell-key",
      "retell-key",
    ]);
    expect(report).toEqual({ kind: "failed", reason: "Retell would not take that key." });
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("names an account with nothing on it, which is not the same failure", async () => {
    retell = await startFakeRetell({ keys: [KEY], agents: [] });

    const { ui, report } = await run({ keys: [KEY, KEY] });

    expect(ui.record.statuses).toContain(NO_AGENTS_LINE);
    expect(ui.record.statuses).not.toContain(INVALID_KEY_LINE);
    expect(ui.record.asked.filter((ask) => ask === "retell-key")).toHaveLength(2);
    expect(report).toEqual({
      kind: "failed",
      reason: "there are no agents on that Retell account.",
    });
  });

  it("takes the corrected key on the second ask, so a typo costs seconds", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const { report } = await run({ keys: [OTHER_KEY, KEY] });

    expect(report).toEqual({
      kind: "connected",
      agentName: "order-line",
      connectionName: "retell-1",
    });
  });

  it("says where the key goes before it is typed, every time it asks", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const { ui } = await run({ keys: [OTHER_KEY, KEY] });

    expect(ui.record.keyAsks).toHaveLength(2);
    expect(ui.record.keyAsks[0]).toEqual({
      asking: KEY_ASK_LINE,
      custody: CUSTODY_LINE,
      problem: null,
    });
    // The second ask carries the reason the first answer did not work.
    expect(ui.record.keyAsks[1]?.problem).toBe(INVALID_KEY_LINE);
    expect(CUSTODY_LINE).toBe(
      "It is sent to egma and stored encrypted. It never lands in a file here.",
    );
  });

  it("ends plainly when the developer has no key to give", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const { ui, report } = await run({ keys: [null] });

    expect(ui.record.asked.filter((ask) => ask === "retell-key")).toHaveLength(1);
    expect(report).toEqual({
      kind: "failed",
      reason: "no Retell key was given, so there is nothing to test.",
    });
  });
});

describe("one agent, and several", () => {
  it("asks nothing at all when the account holds one agent, and shows which", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const { ui, report } = await run({ keys: [KEY] });

    // The one question that must not appear.
    expect(ui.record.asked).not.toContain("retell-agent");
    expect(ui.record.agentChoices).toEqual([]);

    // Shown for confirmation inside the flow, with nothing to answer.
    expect(ui.record.statuses).toContain("◆ Retell agent order-line");
    expect(ui.record.statuses).toContain("┊ agent_0001");
    expect(report).toEqual({
      kind: "connected",
      agentName: "order-line",
      connectionName: "retell-1",
    });
  });

  it("offers a choice when there are several, and registers the one chosen", async () => {
    retell = await startFakeRetell(THREE_AGENTS);

    const { ui, report } = await run({ keys: [KEY], agent: "agent_0002" });

    expect(ui.record.asked).toContain("retell-agent");
    expect(ui.record.agentChoices.map((agent) => agent.id)).toEqual([
      "agent_0001",
      "agent_0002",
      "agent_0003",
    ]);
    expect(report).toEqual({
      kind: "connected",
      agentName: "after-hours",
      connectionName: "retell-1",
    });

    const [connection] = platform.registered.connections;
    expect(connection?.config).toEqual({ retellAgentId: "agent_0002" });
  });

  it("ends plainly when several are offered and none is chosen", async () => {
    retell = await startFakeRetell(THREE_AGENTS);

    const { report } = await run({ keys: [KEY], agent: null });

    expect(report).toEqual({
      kind: "failed",
      reason: "nobody said which Retell agent to test.",
    });
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("carries the agent's own modality, so a chat agent is not called a voice one", async () => {
    retell = await startFakeRetell(THREE_AGENTS);

    await run({ keys: [KEY], agent: "agent_0003" });

    const [connection] = platform.registered.connections;
    expect(connection?.modality).toBe("chat");
    // A custom model is the customer's own service, so Retell holds no prompt.
    expect(platform.registered.agents[0]?.pulled?.prompt).toBeNull();
  });
});

describe("what lands on the platform", () => {
  it("keeps the provider's answer byte for byte, beside what egma read out of it", async () => {
    const provider = await startFakeRetell(ONE_AGENT);
    retell = provider;

    await run({ keys: [KEY] });

    const [agent] = platform.registered.agents;
    const pulled = agent?.pulled;
    expect(pulled?.vendor).toBe("retell");

    // Both halves, each exactly as Retell answered it — not a re-encoding of
    // a parse, which is what would quietly drop a field egma has no place for.
    const kept = Object.fromEntries((pulled?.documents ?? []).map((one) => [one.of, one.body]));
    expect(kept["agent"]).toBe(provider.answered("/get-agent/agent_0001"));
    expect(kept["response-engine"]).toBe(provider.answered("/get-retell-llm/llm_0001"));

    // A field egma has no column for is still in there, because nothing was
    // dropped on the way through.
    expect(kept["agent"]).toContain('"language":"en-GB"');
    expect(kept["response-engine"]).toContain('"model":"gpt-4.1"');

    // And what egma read out of it is beside it, never instead of it.
    expect(pulled?.prompt).toBe(PROMPT);
    expect(pulled?.voice).toBe("11labs-Adrian");
    expect(pulled?.tools).toHaveLength(1);
  });

  it("registers an agent and a connection with names nobody had to type", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    await run({ keys: [KEY] });

    const [agent] = platform.registered.agents;
    const [connection] = platform.registered.connections;

    expect(agent?.name).toBe("order-line");
    expect(agent?.id).toMatch(/^agt_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(connection?.id).toMatch(/^con_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(connection?.name).toBe("retell-1");
    expect(connection?.type).toBe("retell");
    expect(connection?.modality).toBe("voice");
    expect(connection?.topology).toBe("hosted-broker");
    expect(connection?.agentId).toBe(agent?.id);
  });

  it("sends the key for sealing, and the platform answers only its last characters", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    await run({ keys: [KEY] });

    expect(platform.registered.sealed).toEqual([KEY]);
    expect(platform.registered.connections[0]?.credentialsHint).toBe(KEY.slice(-4));
  });

  it("takes the next free name when a run has been here before", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    await run({ keys: [KEY] });
    const second = await run({ keys: [KEY] });

    expect(second.report).toEqual({
      kind: "connected",
      agentName: "order-line-2",
      connectionName: "retell-1",
    });
    expect(platform.registered.agents.map((agent) => agent.name)).toEqual([
      "order-line",
      "order-line-2",
    ]);
  });
});

describe("the drift line", () => {
  /** Puts a prompt in the repository and says where the coding agent found it. */
  async function withRepoPrompt(text: string): Promise<string> {
    await writeFile(path.join(workspace.dir, "prompt.md"), text, "utf8");
    return "prompt.md";
  }

  it("says so once, and does not block, when the two have drifted apart", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    const said = await withRepoPrompt("You answer the order line.\nAlways quote a price.\n");

    const { ui, report } = await run({ keys: [KEY], repoPrompts: said });

    expect(ui.record.statuses.filter((line) => line === DRIFT_LINE)).toHaveLength(1);
    expect(DRIFT_LINE).toContain("Your repo's prompt differs from what Retell is running");
    expect(DRIFT_LINE).toContain("Tests will be generated from what Retell actually runs.");
    // Never blocking: the agent is registered either way.
    expect(report.kind).toBe("connected");
    expect(platform.registered.agents).toHaveLength(1);
  });

  it("says nothing when they are the same but for a line ending and a last newline", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    const said = await withRepoPrompt(`${PROMPT.replaceAll("\n", "\r\n")}\r\n\r\n`);

    const { ui } = await run({ keys: [KEY], repoPrompts: said });

    expect(ui.record.statuses).not.toContain(DRIFT_LINE);
  });

  it("says nothing when the coding agent found no prompt in the repository", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const { ui } = await run({ keys: [KEY], repoPrompts: null });

    expect(ui.record.statuses).not.toContain(DRIFT_LINE);
  });

  it("says nothing when what was found is a dashboard, not a file", async () => {
    retell = await startFakeRetell(ONE_AGENT);

    const { ui } = await run({
      keys: [KEY],
      repoPrompts: "managed in the Retell dashboard (llm_0001)",
    });

    expect(ui.record.statuses).not.toContain(DRIFT_LINE);
  });

  it("reads the file out of a sentence that names it, and reads no environment file", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    await withRepoPrompt("Something else entirely.\n");
    await writeFile(path.join(workspace.dir, ".env"), "SECRET=shhh\n", "utf8");

    const { ui } = await run({
      keys: [KEY],
      repoPrompts: ".env, prompt.md (pushed to Retell by scripts/deploy.ts)",
    });

    // The prompt was found in the sentence, so the line is shown; the fenced
    // file was stepped over rather than read.
    expect(ui.record.statuses).toContain(DRIFT_LINE);
  });
});

describe("the platform's own rules, held by the fixture", () => {
  it("refuses a modality the type does not speak, and writes nothing", async () => {
    const key = platform.device.mint();
    const answer = await fetch(`${platform.url}/api/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "front-desk",
        connection: {
          type: "phone",
          modality: "chat",
          config: { phoneNumber: "+15551234567" },
        },
      }),
    });

    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { message: string }).message).toContain(
      "a phone connection speaks voice",
    );
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("refuses a config key the type has no place for", async () => {
    const key = platform.device.mint();
    const answer = await fetch(`${platform.url}/api/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "front-desk",
        connection: {
          type: "retell",
          modality: "voice",
          config: { retellAgentId: "agent_0001", retellLlmId: "llm_0001" },
          credentials: { apiKey: KEY },
        },
      }),
    });

    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { message: string }).message).toContain(
      'config has no key "retellLlmId"',
    );
  });

  it("refuses a credential where the type takes none", async () => {
    const key = platform.device.mint();
    const answer = await fetch(`${platform.url}/api/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "front-desk",
        connection: {
          type: "phone",
          modality: "voice",
          config: { phoneNumber: "+15551234567" },
          credentials: { apiKey: KEY },
        },
      }),
    });

    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { message: string }).message).toContain(
      "a phone connection takes no credential",
    );
  });

  it("numbers a second connection on the same agent, and refuses a name twice used", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    await run({ keys: [KEY] });

    const agentId = platform.registered.agents[0]?.id as string;
    const key = platform.device.keys[0] as string;

    const second = await fetch(`${platform.url}/api/agents/${agentId}/connections`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_0002" },
        credentials: { apiKey: OTHER_KEY },
      }),
    });

    expect(second.status).toBe(201);
    expect(((await second.json()) as { connection: { name: string } }).connection.name).toBe(
      "retell-2",
    );

    const clash = await fetch(`${platform.url}/api/agents/${agentId}/connections`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "retell-1",
        type: "retell",
        modality: "voice",
        config: { retellAgentId: "agent_0003" },
        credentials: { apiKey: OTHER_KEY },
      }),
    });
    expect(clash.status).toBe(409);
  });

  it("never answers a sealed secret back, on any read", async () => {
    retell = await startFakeRetell(ONE_AGENT);
    await run({ keys: [KEY] });

    const key = platform.device.keys[0] as string;
    const agentId = platform.registered.agents[0]?.id as string;

    for (const where of ["/api/agents", `/api/agents/${agentId}`]) {
      const answer = await fetch(`${platform.url}${where}`, {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(answer.status).toBe(200);
      expect(await answer.text()).not.toContain(KEY);
    }
  });

  it("turns an unknown key away before it reads anything", async () => {
    const answer = await fetch(`${platform.url}/api/agents`, {
      method: "POST",
      headers: { authorization: "Bearer egma_sk_not-one-of-ours", "content-type": "application/json" },
      body: JSON.stringify({ name: "front-desk" }),
    });

    expect(answer.status).toBe(401);
    expect(platform.registered.agents).toHaveLength(0);
  });
});
