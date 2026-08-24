/**
 * Connecting a Retell agent, end to end, with nobody watching.
 *
 * A fake Retell speaking the shapes its published SDK speaks, the fixture
 * platform speaking egma's public API, and the headless UI in between. No real
 * key exists anywhere here and CI never reaches the real Retell.
 *
 * What is asserted is what a developer could check afterwards: what was said on
 * screen, what landed on the platform, and — for the two rules that cannot be
 * checked any other way — that egma read both halves of the provider's agent,
 * and that neither of them went anywhere near egma's own store.
 */

import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INVALID_KEY_LINE,
  KEY_ASK_LINE,
  CUSTODY_LINE,
  NO_AGENTS_LINE,
  VOICE_REQUIRES_PHONE_LINE,
} from "../src/retell/connect.ts";
import { DRIFT_LINE } from "../src/retell/prompt-drift.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import type { AskId } from "../src/ui/wizard-ui.ts";
import { connectionSetupStep } from "../src/wizard/connection-setup-step.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

/** A key shaped like a real one, and belonging to nobody. */
const KEY = "key_1f4c9b7e2a6d0538c1e7";
const OTHER_KEY = "key_9a8b7c6d5e4f3021b9d8";

const PROMPT = "You answer the order line.\nNever quote a price.\n";

const ONE_CHAT_AGENT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      agent_name: "order-line",
      channel: "chat",
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

/** Two numbers on the account, one of them answered by the order line. */
const NUMBERS = [
  { phone_number: "+15551110000", nickname: "order line", inbound_agents: [{ agent_id: "agent_0001" }] },
  { phone_number: "+15552220000", nickname: "somebody else", inbound_agents: [{ agent_id: "agent_9999" }] },
] as const;

const ONE_VOICE_AGENT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      agent_name: "order-line",
      channel: "voice",
      voice_id: "11labs-Adrian",
      response_engine: { type: "retell-llm", llm_id: "llm_0001", version: 3 },
      extra: { language: "en-GB", webhook_url: null },
    },
  ],
  ...(ONE_CHAT_AGENT.llms === undefined ? {} : { llms: ONE_CHAT_AGENT.llms }),
  numbers: NUMBERS,
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
  /**
   * Which way they say egma should reach it. `text` unless a check is about
   * the phone: every check written before there was a choice is about the
   * connection egma made then, and text is that connection.
   */
  readonly reach?: string | null;
  /** Which number they pick, when Retell routes the agent more than one. */
  readonly number?: string | null;
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
  private readonly reach: string | null;
  private readonly number: string | null;

  constructor(options: RunOptions) {
    super();
    this.keys = [...options.keys];
    this.agent = options.agent ?? null;
    this.reach = options.reach === undefined ? "text" : options.reach;
    this.number = options.number ?? null;
  }

  override waitForAnswer(ask: AskId) {
    this.record.asked.push(ask);
    if (ask === "retell-key") return Promise.resolve(this.keys.shift() ?? null);
    if (ask === "retell-agent") return Promise.resolve(this.agent);
    if (ask === "reach") return Promise.resolve(this.reach);
    if (ask === "phone-number") return Promise.resolve(this.number);
    return Promise.resolve(null);
  }
}

/** One run of the step, with the answers written in advance. */
async function run(options: RunOptions) {
  const ui = new ScriptedUI(options);

  const { report, connected } = await connectionSetupStep({
    ui,
    platform: {
      url: platform.url,
      credentialsFile: workspace.credentialsFile,
    },
    cwd: workspace.dir,
    repoPrompts: options.repoPrompts ?? null,
    signal: new AbortController().signal,
    retell: { url: retell?.url ?? "http://127.0.0.1:1" },
  });

  return { ui, report, connected };
}

describe("the key, and the two failures worth a second try", () => {
  it("names a key Retell refused and asks exactly once more", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);

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
    retell = await startFakeRetell(ONE_CHAT_AGENT);

    const { report } = await run({ keys: [OTHER_KEY, KEY] });

    expect(report).toEqual({
      kind: "connected",
      agentName: "order-line",
      connectionName: "retell_chat_api-1",
    });
  });

  it("says where the key goes before it is typed, every time it asks", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);

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
      "It is sent to Egma and stored encrypted. It never lands in a file here.",
    );
  });

  it("ends plainly when the developer has no key to give", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);

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
    retell = await startFakeRetell(ONE_CHAT_AGENT);

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
      connectionName: "retell_chat_api-1",
    });
  });

  it("offers a choice when there are several, and registers the one chosen", async () => {
    retell = await startFakeRetell(THREE_AGENTS);

    const { ui, report } = await run({ keys: [KEY], agent: "agent_0003" });

    expect(ui.record.asked).toContain("retell-agent");
    expect(ui.record.agentChoices.map((agent) => agent.id)).toEqual([
      "agent_0001",
      "agent_0002",
      "agent_0003",
    ]);
    expect(report).toEqual({
      kind: "connected",
      agentName: "chat-desk",
      connectionName: "retell_chat_api-1",
    });

    const [connection] = platform.registered.connections;
    expect(connection?.config).toEqual({ retellAgentId: "agent_0003" });
  });

  it("follows the listing's pages, so an account bigger than one page is whole", async () => {
    // Retell answers a page at a time and says where the next one starts.
    retell = await startFakeRetell({ ...THREE_AGENTS, pageSize: 1 });

    const { ui } = await run({ keys: [KEY], agent: "agent_0003" });

    expect(ui.record.agentChoices.map((agent) => agent.id)).toEqual([
      "agent_0001",
      "agent_0002",
      "agent_0003",
    ]);
    // One request for each page, and one more that said there were no others.
    expect(retell.requests.filter((asked) => asked.path === "/v2/list-agents")).toHaveLength(3);
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

  it("makes a text connection a chat one for a Retell chat agent", async () => {
    retell = await startFakeRetell(THREE_AGENTS);

    const { connected } = await run({ keys: [KEY], agent: "agent_0003" });
    expect(connected?.config.modality).toBe("chat");
    expect(platform.registered.connections[0]?.modality).toBe("chat");
    // A custom model is the customer's own service, so Retell holds no prompt.
    expect(connected?.config.prompt).toBeNull();
  });

  it("refuses text for a Retell voice agent before it writes anything", async () => {
    retell = await startFakeRetell(THREE_AGENTS);

    const voice = await run({ keys: [KEY], agent: "agent_0002" });
    expect(voice.connected).toBeNull();
    expect(voice.report).toEqual({ kind: "failed", reason: VOICE_REQUIRES_PHONE_LINE });
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.connections).toHaveLength(0);
  });

  it("reads a chat agent at the address Retell keeps chat agents at", async () => {
    retell = await startFakeRetell(THREE_AGENTS);

    await run({ keys: [KEY], agent: "agent_0003" });

    // One listing answers with both kinds and each is then read at its own
    // address. Knocking on the other one answers nothing on a real account,
    // and the developer would be told their agent had gone away.
    expect(retell.requests.map((asked) => asked.path)).toContain("/get-chat-agent/agent_0003");
    expect(retell.requests.map((asked) => asked.path)).not.toContain("/get-agent/agent_0003");
  });
});

describe("what lands on the platform", () => {
  /**
   * egma reads both halves of a Retell agent, and sends neither anywhere.
   *
   * A Retell agent is in two halves at two addresses, and egma reads both —
   * the identity and the voice from one, the words and the tools from the
   * other — because the half it skipped would be the half the tests needed.
   * Then it lets them go. What the agent is running lives at the provider; a
   * copy on egma would start going stale the moment it was written and nothing
   * ever read it back. For a phone connection, egma keeps the identity and the
   * number it will dial, and nothing from the provider's agent document.
   */
  it("reads both halves of the agent, and sends neither to egma", async () => {
    const provider = await startFakeRetell(ONE_VOICE_AGENT);
    retell = provider;

    const { connected } = await run({ keys: [KEY], reach: "phone" });

    // Both halves were really read, each at its own address.
    const asked = provider.requests.map((one) => one.path);
    expect(asked).toContain("/get-agent/agent_0001");
    expect(asked).toContain("/get-retell-llm/llm_0001");

    // And what egma read out of them is what the next step is grounded in —
    // the identity and voice from the first, the words and tools from the
    // second.
    expect(connected?.config.name).toBe("order-line");
    expect(connected?.config.voice).toBe("11labs-Adrian");
    expect(connected?.config.engine).toBe("retell-llm");
    expect(connected?.config.prompt).toBe(PROMPT);
    expect(connected?.config.tools).toHaveLength(1);
    expect(connected?.reach).toBe("phone");
    expect(platform.registered.connections[0]?.modality).toBe("voice");

    // None of it went to egma. The agent it just registered holds no trace of
    // what the provider is running.
    const [agent] = platform.registered.agents;
    expect(agent).not.toHaveProperty("pulled");
    expect(Object.keys(agent ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "name",
      "projectId",
      "updatedAt",
    ]);
  });

  /**
   * And a client that still sent it hears about it by name.
   *
   * Dropping it silently would leave a client believing egma held something it
   * does not, which is the one outcome worse than either keeping it or
   * refusing it.
   */
  it("refuses a registration still carrying what was pulled, by name", async () => {
    const key = platform.device.mint();

    const answer = await fetch(`${platform.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "order-line",
        pulled: { vendor: "retell", documents: [], prompt: null, voice: null, tools: [] },
        connection: {
          agentPlatform: "retell",
          connectionType: "retell_chat_api",
          accessVariant: "retell_chat_api.api_key",
          modality: "chat",
          config: { retellAgentId: "agent_0001" },
          credentials: { apiKey: KEY },
        },
      }),
    });

    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({
      error: "invalid_request",
      message:
        "Egma no longer keeps what was pulled from the provider, so a " +
        'registration has no "pulled" key. Drop it and send name, ' +
        "projectId, connection; the agent's content stays at the " +
        "provider, where Egma reads it fresh rather than out of a copy that " +
        "would go stale.",
    });
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("registers an agent and a connection with names nobody had to type", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);

    await run({ keys: [KEY] });

    const [agent] = platform.registered.agents;
    const [connection] = platform.registered.connections;

    expect(agent?.name).toBe("order-line");
    expect(agent?.id).toMatch(/^agt_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(connection?.id).toMatch(/^con_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(connection?.name).toBe("retell_chat_api-1");
    expect(connection?.agentPlatform).toBe("retell");
    expect(connection?.connectionType).toBe("retell_chat_api");
    expect(connection?.accessVariant).toBe("retell_chat_api.api_key");
    expect(connection?.modality).toBe("chat");
    expect(connection?.productLabel).toBe("Retell chat");
    expect(connection?.topology).toBe("hosted-broker");
    expect(connection?.agentId).toBe(agent?.id);
  });

  it("sends the key for sealing, and the platform answers only its last characters", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);

    await run({ keys: [KEY] });

    expect(platform.registered.sealed).toEqual([KEY]);
    expect(platform.registered.connections[0]?.credentialsHint).toBe(KEY.slice(-4));
  });

  /**
   * The second connect over the same Retell agent, which is the ordinary case
   * and not a rare one: a developer runs it again, or a coding agent retries
   * after a network failure it could not read the answer to.
   *
   * egma answers the registration that already exists, rotates the key it was
   * just given, and writes no second identity — so results stay under one
   * agent. And it says so out loud, in its own words, because a screen that
   * looked identical to the first run would leave a developer counting agents
   * to find out what happened.
   */
  it("finds the registration already there when a run has been here before", async () => {
    // Two keys the account accepts, so the second connect can be a rotation as
    // well as a reuse — which is what a developer coming back with a fresh
    // provider key actually does.
    retell = await startFakeRetell({ ...ONE_CHAT_AGENT, keys: [KEY, OTHER_KEY] });

    const first = await run({ keys: [KEY] });
    const second = await run({ keys: [OTHER_KEY] });

    expect(second.report).toEqual({
      kind: "connected",
      agentName: "order-line",
      connectionName: "retell_chat_api-1",
    });
    expect(second.connected?.registered.result).toBe("reused");
    expect(first.connected?.registered.result).toBe("created");

    // Nothing new was registered — one agent, one way of reaching it.
    expect(platform.registered.agents.map((agent) => agent.name)).toEqual(["order-line"]);
    expect(platform.registered.connections).toHaveLength(1);
    expect(second.connected?.registered.agent.id).toBe(first.connected?.registered.agent.id);
    expect(second.connected?.registered.connection.id).toBe(
      first.connected?.registered.connection.id,
    );

    // The key it was just given is the one now sealed, replaced whole.
    expect(platform.registered.sealed).toEqual([KEY, OTHER_KEY]);
    expect(platform.registered.connections[0]?.credentialsHint).toBe(OTHER_KEY.slice(-4));

    // Said in plain words, on the screen, and never as a failure.
    expect(second.ui.record.statuses.join("\n")).toContain(
      "This voice agent was already registered as order-line, and retell_chat_api-1 was " +
        "already the way Egma reaches it. Nothing new was registered.",
    );
    // And each half is reported on its own, because a retry cares about both.
    expect(second.connected?.registration).toEqual({
      agent: "reused",
      connection: "reused",
    });
    expect(first.connected?.registration).toEqual({
      agent: "created",
      connection: "created",
    });
  });
});

describe("the drift line", () => {
  /** Puts a prompt in the repository and says where the coding agent found it. */
  async function withRepoPrompt(text: string): Promise<string> {
    await writeFile(path.join(workspace.dir, "prompt.md"), text, "utf8");
    return "prompt.md";
  }

  it("says so once, and does not block, when the two have drifted apart", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);
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
    retell = await startFakeRetell(ONE_CHAT_AGENT);
    const said = await withRepoPrompt(`${PROMPT.replaceAll("\n", "\r\n")}\r\n\r\n`);

    const { ui } = await run({ keys: [KEY], repoPrompts: said });

    expect(ui.record.statuses).not.toContain(DRIFT_LINE);
  });

  it("says nothing when the coding agent found no prompt in the repository", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);

    const { ui } = await run({ keys: [KEY], repoPrompts: null });

    expect(ui.record.statuses).not.toContain(DRIFT_LINE);
  });

  it("says nothing when what was found is a dashboard, not a file", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);

    const { ui } = await run({
      keys: [KEY],
      repoPrompts: "managed in the Retell dashboard (llm_0001)",
    });

    expect(ui.record.statuses).not.toContain(DRIFT_LINE);
  });

  it("reads the file out of a sentence that names it, and reads no environment file", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);
    await withRepoPrompt("Something else entirely.\n");
    // The fenced file is made to hold exactly what Retell runs, so a run that
    // read it would answer "the same" and say nothing. The line being said is
    // therefore proof that this file was stepped over and the next word read.
    await writeFile(path.join(workspace.dir, ".env"), PROMPT, "utf8");

    const { ui } = await run({
      keys: [KEY],
      repoPrompts: ".env, prompt.md (pushed to Retell by scripts/deploy.ts)",
    });

    expect(ui.record.statuses).toContain(DRIFT_LINE);
  });

  /**
   * A file above the repository, holding words that are not Retell's.
   *
   * Its contents differ on purpose: a run that reaches it says the drift line,
   * and a run that refuses it says nothing. So silence in these checks is proof
   * the file was never opened, rather than proof of a comparison that agreed.
   */
  async function fileAboveTheRepo(): Promise<string> {
    const above = path.join(
      path.dirname(workspace.dir),
      `outside-${path.basename(workspace.dir)}.md`,
    );
    await writeFile(above, "Words from somewhere Egma was never invited.\n", "utf8");
    return above;
  }

  it("reads nothing a link points at outside the repository, whatever it is called", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);
    // Two links inside the folder with innocent names: one to a file above it,
    // one to the fenced file beside it. A link is not a way around either rule.
    const above = await fileAboveTheRepo();
    await writeFile(path.join(workspace.dir, ".env.production"), "PROMPT=not this one\n", "utf8");
    await symlink(above, path.join(workspace.dir, "linked-prompt.md"));
    await symlink(path.join(workspace.dir, ".env.production"), path.join(workspace.dir, "notes.md"));

    try {
      const { ui, report } = await run({
        keys: [KEY],
        repoPrompts: "linked-prompt.md and notes.md",
      });

      expect(ui.record.statuses).not.toContain(DRIFT_LINE);
      // Never blocking, here as everywhere: refusing to read is not failing.
      expect(report.kind).toBe("connected");
    } finally {
      await rm(above, { force: true });
    }
  });

  it("reads nothing outside the repository, named plainly or climbed out to", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);
    const above = await fileAboveTheRepo();

    try {
      const { ui } = await run({
        keys: [KEY],
        repoPrompts: `${above} ../${path.basename(above)}`,
      });

      expect(ui.record.statuses).not.toContain(DRIFT_LINE);
    } finally {
      await rm(above, { force: true });
    }
  });
});

describe("the platform's own rules, held by the fixture", () => {
  it("refuses a modality the type does not speak, and writes nothing", async () => {
    const key = platform.device.mint();
    const answer = await fetch(`${platform.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "front-desk",
        connection: {
          agentPlatform: null,
          connectionType: "phone_number",
          accessVariant: "phone_number.public_e164",
          modality: "chat",
          config: { phoneNumber: "+15551234567" },
        },
      }),
    });

    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { message: string }).message).toContain(
      "a phone_number connection speaks voice",
    );
    expect(platform.registered.agents).toHaveLength(0);
  });

  it("refuses a config key the type has no place for", async () => {
    const key = platform.device.mint();
    const answer = await fetch(`${platform.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "front-desk",
        connection: {
          agentPlatform: "retell",
          connectionType: "retell_chat_api",
          accessVariant: "retell_chat_api.api_key",
          modality: "chat",
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
    const answer = await fetch(`${platform.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "front-desk",
        connection: {
          agentPlatform: null,
          connectionType: "phone_number",
          accessVariant: "phone_number.public_e164",
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
    retell = await startFakeRetell(ONE_CHAT_AGENT);
    await run({ keys: [KEY] });

    const agentId = platform.registered.agents[0]?.id as string;
    const key = platform.device.keys[0] as string;

    const second = await fetch(`${platform.url}/v1/agents/${agentId}/connections`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        agentPlatform: "retell",
        connectionType: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_0002" },
        credentials: { apiKey: OTHER_KEY },
      }),
    });

    expect(second.status).toBe(201);
    expect(((await second.json()) as { connection: { name: string } }).connection.name).toBe(
      "retell_chat_api-2",
    );

    const clash = await fetch(`${platform.url}/v1/agents/${agentId}/connections`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "retell_chat_api-1",
        agentPlatform: "retell",
        connectionType: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_0003" },
        credentials: { apiKey: OTHER_KEY },
      }),
    });
    expect(clash.status).toBe(409);
  });

  it("never answers a sealed secret back, on any read", async () => {
    retell = await startFakeRetell(ONE_CHAT_AGENT);
    await run({ keys: [KEY] });

    const key = platform.device.keys[0] as string;
    const agentId = platform.registered.agents[0]?.id as string;

    for (const where of ["/v1/agents", `/v1/agents/${agentId}`]) {
      const answer = await fetch(`${platform.url}${where}`, {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(answer.status).toBe(200);
      expect(await answer.text()).not.toContain(KEY);
    }
  });

  it("turns an unknown key away before it reads anything", async () => {
    const answer = await fetch(`${platform.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: "Bearer egma_sk_not-one-of-ours", "content-type": "application/json" },
      body: JSON.stringify({ name: "front-desk" }),
    });

    expect(answer.status).toBe(401);
    expect(platform.registered.agents).toHaveLength(0);
  });
});
