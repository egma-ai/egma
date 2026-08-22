/**
 * Text or phone: the choice that decides what egma creates.
 *
 * A fake Retell speaking the shapes the real service answers with, the fixture
 * platform speaking egma's public API, and the headless UI in between. What is
 * asserted is what a developer could check afterwards in their own project: how
 * many connections are on it, what each one holds, and — the whole reason this
 * exists — that the one they did not choose was never created.
 *
 * The rule under all of it: **egma creates the selected connection and nothing
 * else.** A wizard that made both would put a connection in somebody's project
 * that they never asked for, and on the phone side that is a connection egma
 * would dial a real telephone over.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NO_NUMBERS_LINE } from "../src/retell/connect.ts";
import { HeadlessUI } from "../src/ui/headless-ui.ts";
import type { AskId } from "../src/ui/wizard-ui.ts";
import { connectStep } from "../src/wizard/connect-step.ts";
import { startFakeRetell, type FakeRetell, type FakeRetellScript } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { filesUnder, makeWorkspace, type Workspace } from "./support/workspace.ts";

const KEY = "key_1f4c9b7e2a6d0538c1e7";

/** The one number the agent under test answers, and one it does not. */
const DIALLED = "+14155550111";
const SOMEBODY_ELSE = "+14155550222";

const ACCOUNT: FakeRetellScript = {
  keys: [KEY],
  agents: [
    {
      agent_id: "agent_0001",
      agent_name: "front-desk",
      response_engine: { type: "retell-llm", llm_id: "llm_0001" },
    },
  ],
  llms: [{ llm_id: "llm_0001", general_prompt: "You answer the front desk.\n" }],
  numbers: [
    {
      phone_number: DIALLED,
      nickname: "front desk",
      inbound_agents: [{ agent_id: "agent_0001", weight: 1 }],
    },
    {
      phone_number: SOMEBODY_ELSE,
      nickname: "another team",
      inbound_agents: [{ agent_id: "agent_9999" }],
    },
  ],
};

const CHAT_ACCOUNT: FakeRetellScript = {
  ...ACCOUNT,
  agents: ACCOUNT.agents.map((agent) => ({ ...agent, channel: "chat" as const })),
};

/** The same account, with two numbers routed to the agent under test. */
const TWO_NUMBERS: FakeRetellScript = {
  ...ACCOUNT,
  numbers: [
    ...(ACCOUNT.numbers ?? []),
    {
      phone_number: "+14155550333",
      nickname: "overflow",
      inbound_agents: [{ agent_id: "agent_0001" }],
    },
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

type Answers = {
  readonly reach?: string | null;
  readonly number?: string | null;
  /** Which agent, when the account holds more than one. */
  readonly agent?: string | null;
};

/** Whether the walk left an egma folder behind in the repository. */
async function wroteAnEgmaFolder(): Promise<boolean> {
  return (await filesUnder(workspace.dir)).some((file) => file.startsWith("egma/"));
}

class ScriptedUI extends HeadlessUI {
  private readonly said: Answers;

  constructor(answers: Answers, write: (line: string) => void) {
    super({ write });
    this.said = answers;
  }

  override waitForAnswer(ask: AskId) {
    this.record.asked.push(ask);
    if (ask === "retell-key") return Promise.resolve<string | null>(KEY);
    if (ask === "retell-agent") return Promise.resolve(this.said.agent ?? null);
    if (ask === "reach") return Promise.resolve(this.said.reach ?? null);
    if (ask === "phone-number") return Promise.resolve(this.said.number ?? null);
    return Promise.resolve(null);
  }
}

async function run(answers: Answers, fetchImpl?: typeof fetch) {
  const lines: string[] = [];
  const ui = new ScriptedUI(answers, (line) => lines.push(line));
  const { report, connected } = await connectStep({
    ui,
    platform: {
      url: platform.url,
      credentialsFile: workspace.credentialsFile,
    },
    cwd: workspace.dir,
    repoPrompts: null,
    signal: new AbortController().signal,
    retell: { url: retell?.url ?? "http://127.0.0.1:1" },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  return { ui, report, connected, lines };
}

/**
 * The other terminal, getting there first.
 *
 * The first attempt to attach a connection is really made — so the platform
 * really holds it, exactly as it would if a second `connect` had won — and then
 * this run is told the name is taken, which is what the loser of that race is
 * told. Nothing is faked but the timing.
 */
function losingTheRace(): typeof fetch {
  let raced = false;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const where = input instanceof Request ? input.url : String(input);
    const method = input instanceof Request ? input.method : init?.method;
    if (raced || method !== "POST" || !where.endsWith("/connections")) {
      return fetch(input, init);
    }
    raced = true;
    // The winner's write, made through the same door and committed.
    await fetch(input instanceof Request ? input.clone() : input, init);
    return new Response(
      JSON.stringify({
        error: "name_taken",
        message: 'a connection named "phone-1" already exists on this agent',
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("choosing the phone", () => {
  it("refuses phone for a Retell chat agent before it writes anything", async () => {
    retell = await startFakeRetell(CHAT_ACCOUNT);

    const { report, connected } = await run({ reach: "phone" });

    expect(connected).toBeNull();
    expect(report).toEqual({
      kind: "failed",
      reason:
        "Retell says this is a chat agent. Chat agents require a Chat connection. " +
        "Choose --reach text and try again. Nothing was written.",
    });
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.connections).toHaveLength(0);
    expect(await wroteAnEgmaFolder()).toBe(false);
  });

  it("creates one phone connection holding the number and nothing else", async () => {
    retell = await startFakeRetell(ACCOUNT);

    const { connected } = await run({ reach: "phone" });

    expect(connected?.reach).toBe("phone");
    expect(connected?.number).toBe(DIALLED);

    // One connection, and it is the phone one. The retell connection egma used
    // to create whatever was chosen is the bug this whole ticket exists for.
    expect(platform.registered.connections).toHaveLength(1);
    const [connection] = platform.registered.connections;
    expect(connection?.agentPlatform).toBe("retell");
    expect(connection?.connectionType).toBe("phone_number");
    expect(connection?.accessVariant).toBe("phone_number.public_e164");
    expect(connection?.modality).toBe("voice");
    expect(connection?.name).toBe("phone_number-1");

    // The number, and not one other thing. A phone connection is
    // provider-blind: nothing in it says who answers, and nothing in it opens
    // anything.
    expect(connection?.config).toEqual({ phoneNumber: DIALLED });
    expect(connection?.credentialsHint).toBeNull();
    expect(platform.registered.sealed).toEqual([]);

    // The key reached the API only in the request-only platform selection. It
    // was discarded after confirmation because a phone connection has nowhere
    // to store one.
    const written = JSON.stringify(platform.registered);
    expect(written).not.toContain(KEY);
    expect(written).not.toContain("agent_0001");
  });

  it("offers only the numbers Retell routes to the chosen agent", async () => {
    retell = await startFakeRetell(TWO_NUMBERS);

    const { ui } = await run({ reach: "phone", number: "+14155550333" });

    expect(ui.record.numberChoices.map((one) => one.number)).toEqual([
      DIALLED,
      "+14155550333",
    ]);
    // Somebody else's number is never on the screen, so there is no way through
    // it to a telephone the agent under test does not answer.
    expect(ui.record.numberChoices.map((one) => one.number)).not.toContain(
      SOMEBODY_ELSE,
    );
    expect(platform.registered.connections[0]?.config).toEqual({
      phoneNumber: "+14155550333",
    });
  });

  it("asks nothing when Retell routes one number to the agent, and says which", async () => {
    retell = await startFakeRetell(ACCOUNT);

    const { ui } = await run({ reach: "phone" });

    expect(ui.record.asked).not.toContain("phone-number");
    expect(ui.record.statuses).toContain(`◆ Egma will dial ${DIALLED}.`);
  });

  it("reads the chosen number's own document before it registers it", async () => {
    const account = await startFakeRetell(ACCOUNT);
    retell = account;

    await run({ reach: "phone" });

    const asked = account.requests.map((one) => `${one.method} ${one.path}`);
    expect(asked).toContain("GET /v2/list-phone-numbers");
    expect(asked).toContain(`GET /get-phone-number/${encodeURIComponent(DIALLED)}`);
    // Reads only. Nothing in this flow writes to somebody's Retell account.
    expect(
      account.requests.filter(
        (one) => one.method !== "GET" && one.path !== "/v2/list-agents",
      ),
    ).toEqual([]);
  });

  it("ends plainly when Retell routes no number to the agent, and creates nothing", async () => {
    retell = await startFakeRetell({ ...ACCOUNT, numbers: [] });

    const { ui, report } = await run({ reach: "phone" });

    expect(ui.record.statuses).toContain(NO_NUMBERS_LINE);
    expect(report).toEqual({ kind: "failed", reason: NO_NUMBERS_LINE });
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.connections).toHaveLength(0);
    // And the repository is exactly as the walk found it.
    expect(await wroteAnEgmaFolder()).toBe(false);
  });

  it("ends plainly when several numbers reach the agent and none is chosen", async () => {
    retell = await startFakeRetell(TWO_NUMBERS);

    const { report } = await run({ reach: "phone", number: null });

    expect(report).toEqual({
      kind: "failed",
      reason: "nobody said which number Egma should dial.",
    });
    expect(platform.registered.agents).toHaveLength(0);
  });
});

describe("choosing text", () => {
  it("refuses text for a Retell voice agent before it writes anything", async () => {
    retell = await startFakeRetell(ACCOUNT);

    const { report, connected } = await run({ reach: "text" });

    expect(connected).toBeNull();
    expect(report).toEqual({
      kind: "failed",
      reason:
        "Retell says this is a voice agent. Voice agents require a Phone connection. " +
        "Choose --reach phone and try again. Nothing was written.",
    });
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.connections).toHaveLength(0);
    expect(await wroteAnEgmaFolder()).toBe(false);
  });

  it("creates one Retell chat connection for the selected chat agent", async () => {
    retell = await startFakeRetell(CHAT_ACCOUNT);

    const { connected } = await run({ reach: "text" });

    expect(connected?.reach).toBe("text");
    expect(connected?.number).toBeNull();

    expect(platform.registered.connections).toHaveLength(1);
    const [connection] = platform.registered.connections;
    expect(connection?.agentPlatform).toBe("retell");
    expect(connection?.connectionType).toBe("retell_chat_api");
    expect(connection?.accessVariant).toBe("retell_chat_api.api_key");
    expect(connection?.modality).toBe("chat");
    // The selected chat agent's own identity is the connection target.
    expect(connection?.config).toEqual({ retellAgentId: "agent_0001" });
    expect(connection?.credentialsHint).toBe(KEY.slice(-4));
    expect(platform.registered.sealed).toEqual([KEY]);
  });

  it("reads no phone number at all, because nothing is going to be dialled", async () => {
    const account = await startFakeRetell(CHAT_ACCOUNT);
    retell = account;

    await run({ reach: "text" });

    const asked = account.requests.map((one) => one.path);
    expect(asked).not.toContain("/v2/list-phone-numbers");
  });
});

describe("choosing neither", () => {
  it("offers only phone for a Retell voice agent", async () => {
    retell = await startFakeRetell(ACCOUNT);

    const { lines } = await run({ reach: null });

    expect(lines).toContainEqual(expect.stringContaining("reach_option: phone"));
    expect(lines).not.toContainEqual(expect.stringContaining("reach_option: text"));
  });

  it("offers only text for a Retell chat agent", async () => {
    retell = await startFakeRetell(CHAT_ACCOUNT);

    const { lines } = await run({ reach: null });

    expect(lines).toContainEqual(expect.stringContaining("reach_option: text"));
    expect(lines).not.toContainEqual(expect.stringContaining("reach_option: phone"));
  });

  it("creates nothing, and leaves the repository exactly as it was", async () => {
    retell = await startFakeRetell(ACCOUNT);

    const { ui, report } = await run({ reach: null });

    expect(ui.record.reachOffered).toBe(true);
    expect(report).toEqual({
      kind: "failed",
      reason: "nobody chose phone, so nothing was created.",
    });
    expect(platform.registered.agents).toHaveLength(0);
    expect(platform.registered.connections).toHaveLength(0);
    // The wart this ticket inherited: a walk that ends before anything is
    // created used to leave an egma folder behind holding nothing but a
    // platform binding, in a repository the developer had decided not to
    // connect.
    expect(await wroteAnEgmaFolder()).toBe(false);
  });

  it("binds the repository at the moment egma is asked to create something", async () => {
    retell = await startFakeRetell(ACCOUNT);

    const { ui } = await run({ reach: "phone" });

    expect(await wroteAnEgmaFolder()).toBe(true);
    expect(ui.record.statuses).toContain(
      `◆ Bound this repository to Egma platform ${platform.url}.`,
    );
  });
});

describe("running it twice", () => {
  it("finds the phone connection it made the first time, and writes nothing", async () => {
    retell = await startFakeRetell(ACCOUNT);

    const first = await run({ reach: "phone" });
    const second = await run({ reach: "phone" });

    expect(first.connected?.registration).toEqual({
      agent: "created",
      connection: "created",
    });
    expect(second.connected?.registration).toEqual({
      agent: "reused",
      connection: "reused",
    });
    expect(second.connected?.registered.agent.id).toBe(first.connected?.registered.agent.id);
    expect(second.connected?.registered.connection.id).toBe(
      first.connected?.registered.connection.id,
    );

    // One agent, one way of reaching it, however many times this ran. Two
    // identities for one voice agent would split a team's results history in
    // half, and a retry after a network failure nobody could read is ordinary.
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);
  });

  it("still takes the next name for a different voice agent called the same thing", async () => {
    // Two agents on the account with one name between them, which a real
    // account does produce. The second is a different agent and gets its own
    // egma agent — the name loop this replaced was there for exactly this, and
    // reading the refusal rather than working around it must not lose it.
    retell = await startFakeRetell({
      ...ACCOUNT,
      agents: [
        ...ACCOUNT.agents,
        {
          agent_id: "agent_0002",
          agent_name: "front-desk",
          response_engine: { type: "retell-llm", llm_id: "llm_0001" },
        },
      ],
      numbers: [
        ...(ACCOUNT.numbers ?? []),
        {
          phone_number: "+14155550444",
          nickname: "second front desk",
          inbound_agents: [{ agent_id: "agent_0002" }],
        },
      ],
    });

    // The first walk leaves an agent reached only by phone, so nothing on it
    // names a vendor at all. What tells the second walk that this is somebody
    // else's agent is the number: Retell routes it to agent_0001 and not to
    // agent_0002, and that is as good an answer as a vendor id would be.
    const first = await run({ reach: "phone", agent: "agent_0001" });
    const second = await run({ reach: "phone", agent: "agent_0002" });

    expect(first.connected?.registered.agent.name).toBe("front-desk");
    expect(second.connected?.registered.agent.name).toBe("front-desk-2");
    expect(second.connected?.registration).toEqual({
      agent: "created",
      connection: "created",
    });
    expect(platform.registered.agents).toHaveLength(2);
    expect(platform.registered.connections).toHaveLength(2);
  });

  /**
   * Two terminals attaching the same reach at the same instant.
   *
   * Both get past the check that says the reach is not there yet, because
   * neither has written anything when either looks. One then loses the
   * connection-name index — and the right answer for the loser is the
   * connection the winner just wrote, because that is what it was going to
   * create. Telling them their egma is out of date would send a developer to
   * check a version when the only thing that happened is that their other
   * terminal got there first.
   */
  it("reads the winner's connection as a reuse when it loses the race to attach", async () => {
    retell = await startFakeRetell(TWO_NUMBERS);

    const first = await run({ reach: "phone", number: DIALLED });
    const phone = await run({ reach: "phone", number: "+14155550333" }, losingTheRace());

    expect(phone.report.kind).toBe("connected");
    expect(phone.connected?.registration).toEqual({
      agent: "reused",
      connection: "reused",
    });
    expect(phone.connected?.registered.agent.id).toBe(first.connected?.registered.agent.id);
    expect(phone.connected?.registered.connection.name).toBe("phone_number-2");
    expect(phone.connected?.number).toBe("+14155550333");

    // One agent, one connection each way, and no second phone connection left
    // behind by the write that lost.
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections.map((one) => one.name)).toEqual([
      "phone_number-1",
      "phone_number-2",
    ]);
  });
});
