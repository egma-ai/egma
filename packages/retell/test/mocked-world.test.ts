import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  bindingDecisionsFor,
  buildMockedWorld,
  finishMockedWorld,
  mockRunIsSettled,
  mockToolUrl,
  SIMULATION_VARIABLE,
  versionReferenceIn,
  type MockRunRecord,
  type RetellCredential,
} from "../src/index.ts";

/**
 * The whole lifecycle, against a Retell that exists only in this file — and
 * every guard in it made to fire.
 *
 * The fake below is **an account, not a router**: it holds numbers, agent
 * versions and engine documents, and it answers requests by changing them. So
 * what these checks assert is what a developer would see afterwards — which
 * version their number routes to, what their live agent's tools point at, what
 * is left behind — rather than which requests Egma happened to send. The
 * request log is read only where the *order* is the safety property, which is
 * exactly twice: the write that must not happen before the fork guard, and the
 * delete that must happen before the restore.
 */

const KEY = "retell-secret-key-9f2b1c";
const key: RetellCredential = { reveal: () => KEY };

const AGENT = "agent_b0e2e9cb267c47e7e7026cd8e8";
const OTHER_AGENT = "agent_someone_elses_9911";
const FLOW = "conversation_flow_2346a0e8367c";
const LLM = "llm_5f1c02";

const FLOW_DOCUMENT = JSON.parse(
  readFileSync(new URL("./fixtures/conversation-flow.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const LLM_DOCUMENT = JSON.parse(
  readFileSync(new URL("./fixtures/retell-llm.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const TARGET = { base: "https://mock.egma.test/mock-tools", runId: "run_01HZ" };

type Seen = { readonly method: string; readonly url: string };

type EngineKind = "conversation-flow" | "retell-llm";

type AccountOptions = {
  /** The engine the agent runs on. A flow unless a test says otherwise. */
  readonly engine?: EngineKind;
  /** Numbers, by E.164, with their whole `inbound_agents` array. */
  readonly numbers?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  /** Environment tags this account resolves, by name. */
  readonly tags?: Readonly<Record<string, number>>;
  /** Versions beyond the serving one, for an account with a newer draft on it. */
  readonly alsoVersions?: readonly number[];
  /**
   * What branching does to the engine reference. `fork` is the observed
   * behaviour for a conversation flow; `share` is the case the fork guard
   * exists for and is what an engine Retell does not version would look like.
   */
  readonly branching?: "fork" | "share" | "unversioned";
  /**
   * When true, the serving version's `response_engine` carries no `version` at
   * all — the case the serving-side guard exists for, where reading it back
   * would mean "Retell's newest" rather than the version served.
   */
  readonly unversionedServingEngine?: boolean;
  /** Called after the capture is read, so a test can move the world underneath. */
  readonly whenCaptured?: (account: Account) => void;
  /** Requests that fail, by a substring of the path, with the status to answer. */
  readonly refuse?: Readonly<Record<string, number>>;
  /** Whether the serving version is published. It is, unless a test says not. */
  readonly published?: boolean;
  /**
   * The delete answers, and deletes nothing — the defect the read-back proof
   * exists for. `"gone"` is the production failure exactly: a delete Retell had
   * no route for answered 404, and Egma read 404 as "already deleted".
   */
  readonly deletePretends?: "gone" | "deleted" | undefined;
};

type Account = {
  readonly fetchImpl: typeof fetch;
  readonly seen: Seen[];
  /** Every agent version that exists, by number. */
  readonly versions: Map<number, Record<string, unknown>>;
  /** Every engine document that exists, keyed by id and version. */
  readonly engines: Map<string, Record<string, unknown>>;
  readonly numbers: Map<string, Record<string, unknown>>;
  /** The tools one engine version holds right now. */
  toolsAt(version: number): readonly Record<string, unknown>[];
  /** The `inbound_agents` array one number holds right now. */
  bindingsOf(number: string): readonly Record<string, unknown>[];
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

/** A Retell account this test can read the state of afterwards. */
function account(options: AccountOptions = {}): Account {
  const kind: EngineKind = options.engine ?? "conversation-flow";
  const engineId = kind === "conversation-flow" ? FLOW : LLM;
  const source = kind === "conversation-flow" ? FLOW_DOCUMENT : LLM_DOCUMENT;
  const branching = options.branching ?? "fork";
  const seen: Seen[] = [];

  const engines = new Map<string, Record<string, unknown>>();
  const versions = new Map<number, Record<string, unknown>>();
  const numbers = new Map<string, Record<string, unknown>>();

  const engineKey = (id: string, version: number) => `${id}@${version}`;
  engines.set(engineKey(engineId, 105), structuredClone(source));
  const servingEngineRef =
    kind === "conversation-flow"
      ? {
          type: "conversation-flow",
          conversation_flow_id: engineId,
          ...(options.unversionedServingEngine ? {} : { version: 105 }),
        }
      : {
          type: "retell-llm",
          llm_id: engineId,
          ...(options.unversionedServingEngine ? {} : { version: 105 }),
        };
  versions.set(105, {
    agent_id: AGENT,
    version: 105,
    is_published: options.published ?? true,
    response_engine: servingEngineRef,
  });

  for (const extra of options.alsoVersions ?? []) {
    engines.set(engineKey(engineId, extra), structuredClone(source));
    versions.set(extra, {
      agent_id: AGENT,
      version: extra,
      is_published: false,
      response_engine:
        kind === "conversation-flow"
          ? { type: "conversation-flow", conversation_flow_id: engineId, version: extra }
          : { type: "retell-llm", llm_id: engineId, version: extra },
    });
  }

  for (const [number, bindings] of Object.entries(options.numbers ?? {})) {
    numbers.set(number, {
      phone_number: number,
      nickname: "Front desk",
      inbound_agents: structuredClone(bindings) as unknown,
    });
  }

  const toolsIn = (document: Record<string, unknown>) =>
    (kind === "conversation-flow"
      ? document["tools"]
      : document["general_tools"]) as Record<string, unknown>[];

  let captured = false;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    seen.push({ method, url });
    const path = url.replace("https://retell.invalid", "");

    for (const [fragment, status] of Object.entries(options.refuse ?? {})) {
      if (path.includes(fragment)) return json({ error: "no" }, status);
    }

    if (path.startsWith("/v2/list-phone-numbers")) {
      return json({ items: [...numbers.values()], has_more: false });
    }

    if (method === "GET" && path.startsWith("/get-phone-number/")) {
      // The restore reads the number before it writes, so the account has to
      // be able to answer for one number as well as for the listing.
      const held = decodeURIComponent(path.slice("/get-phone-number/".length));
      const number = numbers.get(held);
      return number === undefined ? json({ error: "gone" }, 404) : json(number);
    }

    if (method === "PATCH" && path.startsWith("/update-phone-number/")) {
      const held = decodeURIComponent(path.slice("/update-phone-number/".length));
      const number = numbers.get(held);
      if (number === undefined) return json({ error: "gone" }, 404);
      number["inbound_agents"] = body?.["inbound_agents"];
      return json(number);
    }

    if (path.startsWith("/list-agent-versions/")) {
      // Retell's current listing. The legacy `/get-agent-versions` retires
      // 2026-09-15 and this account deliberately has no route for it.
      return json({
        items: [...versions.values()].map((held) => ({
          version: held["version"],
          is_published: held["is_published"] === true,
        })),
        has_more: false,
      });
    }

    if (path.startsWith("/get-agent/")) {
      const asked = new URL(url).searchParams.get("version") ?? "latest";
      const published = [...versions.values()]
        .filter((held) => held["is_published"] === true)
        .map((held) => Number(held["version"]));
      const resolved =
        asked === "latest"
          ? Math.max(...versions.keys())
          : asked === "latest_published"
            ? // Nothing published resolves to nothing, which is a 404 below —
              // the same answer Retell gives for an agent that is not there,
              // and the reason the resolve disambiguates with a second read.
              (published.length === 0 ? Number.NaN : Math.max(...published))
            : options.tags?.[asked] ?? Number(asked);
      const version = versions.get(resolved);
      return version === undefined ? json({ error: "gone" }, 404) : json(version);
    }

    if (path.startsWith("/get-conversation-flow/") || path.startsWith("/get-retell-llm/")) {
      const asked = Number(new URL(url).searchParams.get("version"));
      const document = engines.get(engineKey(engineId, asked));
      if (document === undefined) return json({ error: "gone" }, 404);
      const answer = json(structuredClone(document));
      if (!captured) {
        captured = true;
        options.whenCaptured?.(built);
      }
      return answer;
    }

    if (method === "POST" && path.startsWith("/create-agent-version/")) {
      const base = Number(body?.["base_version"]);
      const next = Math.max(...versions.keys()) + 1;
      const baseEngineVersion = base;
      const draftEngineVersion =
        branching === "share" ? baseEngineVersion : next;
      if (branching !== "share") {
        engines.set(
          engineKey(engineId, draftEngineVersion),
          structuredClone(engines.get(engineKey(engineId, baseEngineVersion)) ?? {}),
        );
      }
      const engine =
        kind === "conversation-flow"
          ? {
              type: "conversation-flow",
              conversation_flow_id: engineId,
              ...(branching === "unversioned"
                ? {}
                : { version: draftEngineVersion }),
            }
          : {
              type: "retell-llm",
              llm_id: engineId,
              ...(branching === "unversioned"
                ? {}
                : { version: draftEngineVersion }),
            };
      const created = {
        agent_id: AGENT,
        version: next,
        is_published: false,
        response_engine: engine,
      };
      versions.set(next, created);
      return json(created);
    }

    if (
      method === "PATCH" &&
      (path.startsWith("/update-conversation-flow/") ||
        path.startsWith("/update-retell-llm/"))
    ) {
      const asked = Number(new URL(url).searchParams.get("version"));
      const document = engines.get(engineKey(engineId, asked));
      if (document === undefined) return json({ error: "gone" }, 404);
      Object.assign(document, structuredClone(body ?? {}));
      return json(document);
    }

    if (method === "DELETE" && path.startsWith("/delete-agent-version/")) {
      // The version rides in the query string, exactly as Retell's router
      // requires. A path-segment delete finds no route here and answers 404 —
      // the same "Cannot DELETE" a real account answers, which is what let a
      // teardown that deleted nothing call itself done.
      const asked = new URL(url).searchParams.get("version");
      if (asked === null) return json({ error: "Cannot DELETE" }, 404);
      if (options.deletePretends !== undefined) {
        return options.deletePretends === "gone"
          ? json({ error: "Cannot DELETE" }, 404)
          : json({ deleted: true });
      }
      const version = Number(asked);
      if (!versions.has(version)) return json({ error: "gone" }, 404);
      versions.delete(version);
      // Deleting the agent version takes its lockstep engine version with it.
      engines.delete(engineKey(engineId, version));
      return json({ deleted: true });
    }

    return json({ error: "no route" }, 404);
  }) as typeof fetch;

  const built: Account = {
    fetchImpl,
    seen,
    versions,
    engines,
    numbers,
    toolsAt: (version) => toolsIn(engines.get(engineKey(engineId, version)) ?? {}) ?? [],
    bindingsOf: (number) =>
      (numbers.get(number)?.["inbound_agents"] ?? []) as Record<string, unknown>[],
  };
  return built;
}

const REACH = (fetchImpl: typeof fetch) => ({
  url: "https://retell.invalid",
  fetchImpl,
});

/** Every record the build wrote down, in the order it wrote them. */
function recorder(): {
  readonly record: (state: MockRunRecord) => Promise<void>;
  readonly written: MockRunRecord[];
  readonly last: () => MockRunRecord;
} {
  const written: MockRunRecord[] = [];
  return {
    record: async (state) => {
      written.push(structuredClone(state));
    },
    written,
    last: () => {
      const held = written.at(-1);
      if (held === undefined) throw new Error("nothing was recorded");
      return held;
    },
  };
}

const RIDES_LATEST = [{ agent_id: AGENT, agent_version: "latest", weight: 3 }];
const RIDES_TAG = [{ agent_id: AGENT, agent_version: "prod" }];

describe("the binding verdicts, for every number routing to the agent", () => {
  it("pins `latest` and an unset binding, and lets the other three through", () => {
    const decisions = bindingDecisionsFor(
      [
        {
          number: "+15550000001",
          label: "numeric",
          bindings: [
            { agentId: AGENT, agentVersion: 105, verbatim: { agent_id: AGENT } },
          ],
        },
        {
          number: "+15550000002",
          label: "tag",
          bindings: [
            { agentId: AGENT, agentVersion: "prod", verbatim: { agent_id: AGENT } },
          ],
        },
        {
          number: "+15550000003",
          label: "published",
          bindings: [
            {
              agentId: AGENT,
              agentVersion: "latest_published",
              verbatim: { agent_id: AGENT },
            },
          ],
        },
        {
          number: "+15550000004",
          label: "latest",
          bindings: [
            { agentId: AGENT, agentVersion: "latest", verbatim: { agent_id: AGENT } },
          ],
        },
        {
          number: "+15550000005",
          label: "unset",
          bindings: [
            { agentId: AGENT, agentVersion: null, verbatim: { agent_id: AGENT } },
          ],
        },
        {
          number: "+15550000006",
          label: "somebody else's",
          bindings: [
            {
              agentId: OTHER_AGENT,
              agentVersion: "latest",
              verbatim: { agent_id: OTHER_AGENT },
            },
          ],
        },
      ],
      AGENT,
    );

    expect(decisions.map((one) => [one.label, one.pin])).toEqual([
      ["numeric", false],
      ["tag", false],
      ["published", false],
      ["latest", true],
      ["unset", true],
    ]);
    // The sixth number routes to somebody else and is not this agent's
    // business at all.
    expect(decisions.some((one) => one.number === "+15550000006")).toBe(false);
  });

  it("pins a shared number when any one of this agent's entries rides latest", () => {
    const [decision] = bindingDecisionsFor(
      [
        {
          number: "+15550000007",
          label: "weighted",
          bindings: [
            { agentId: AGENT, agentVersion: 105, verbatim: { agent_id: AGENT } },
            { agentId: AGENT, agentVersion: "latest", verbatim: { agent_id: AGENT } },
            {
              agentId: OTHER_AGENT,
              agentVersion: 7,
              verbatim: { agent_id: OTHER_AGENT },
            },
          ],
        },
      ],
      AGENT,
    );

    expect(decision?.pin).toBe(true);
    expect(decision?.verdicts).toEqual(["numeric", "hijackable"]);
    // The whole array rides along, the other agent's entry included: the write
    // that puts it back replaces the array, so a decision that dropped an entry
    // would delete somebody's routing.
    expect(decision?.bindings).toHaveLength(3);
    // But the reading of what runs against the number is this agent's entries
    // only.
    expect(decision?.ownBindings).toHaveLength(2);
  });

  it("resolves the version from this agent's binding, never a sibling agent's", () => {
    // A number two agents share: the other agent pins it to 7, this agent
    // rides `latest`. The version this run tests must be this agent's `latest`,
    // not the stranger's 7 — a version no traffic to this agent ever reaches.
    const decisions = bindingDecisionsFor(
      [
        {
          number: "+15550000008",
          label: "shared",
          bindings: [
            {
              agentId: OTHER_AGENT,
              agentVersion: 7,
              verbatim: { agent_id: OTHER_AGENT, agent_version: 7 },
            },
            {
              agentId: AGENT,
              agentVersion: "latest",
              verbatim: { agent_id: AGENT, agent_version: "latest" },
            },
          ],
        },
      ],
      AGENT,
    );

    // Neither 7 nor the stranger's binding: this agent rides `latest`, which
    // names no version, so the answer is the published pointer below.
    expect(versionReferenceIn(decisions)).toBe("latest_published");
  });

  it("reads a number riding `latest` as naming no version at all", () => {
    // `latest` is Retell's word for the newest version *created*, drafts
    // included — so it is the one reference a run must never resolve. An agent
    // whose numbers all ride it is tested against what it publishes.
    for (const rides of ["latest", "", null] as const) {
      const decisions = bindingDecisionsFor(
        [
          {
            number: "+15550000009",
            label: "front desk",
            bindings: [
              {
                agentId: AGENT,
                agentVersion: rides,
                verbatim: { agent_id: AGENT, agent_version: rides },
              },
            ],
          },
        ],
        AGENT,
      );
      expect(versionReferenceIn(decisions)).toBe("latest_published");
    }
  });

  it("keeps an explicitly bound version or tag as the version to test", () => {
    const bound = (agentVersion: string | number) =>
      versionReferenceIn(
        bindingDecisionsFor(
          [
            {
              number: "+15550000010",
              label: "front desk",
              bindings: [
                {
                  agentId: AGENT,
                  agentVersion,
                  verbatim: { agent_id: AGENT, agent_version: agentVersion },
                },
              ],
            },
          ],
          AGENT,
        ),
      );

    // A customer whose traffic is pinned to an older published version, or
    // routed through a movable tag, keeps reaching exactly what it reaches.
    expect(bound(101)).toBe(101);
    expect(bound("prod")).toBe("prod");
  });
});

describe("building the world over a conversation flow", () => {
  it("branches from the serving version, swaps only the draft, and leaves the live version alone", async () => {
    const retell = account({ numbers: { "+12567332874": RIDES_TAG }, tags: { prod: 105 } });
    const kept = recorder();

    const built = await buildMockedWorld(
      key,
      {
        agentId: AGENT,
        versionReference: "prod",
        target: TARGET,
        record: kept.record,
      },
      REACH(retell.fetchImpl),
    );

    expect(built.kind, JSON.stringify(built)).toBe("built");
    if (built.kind !== "built") return;
    expect(built.agentVersion).toBe(105);
    expect(built.state.tempMockAgentVersion).toBe(106);

    // The draft's custom tools point at Egma, carrying the run and the
    // simulation variable Retell fills per call.
    const draftTools = retell.toolsAt(106);
    const availability = draftTools.find((tool) => tool["name"] === "get_availability");
    expect(availability?.["url"]).toBe(
      mockToolUrl(TARGET, "get_availability"),
    );
    expect(String(availability?.["url"])).toContain(`{{${SIMULATION_VARIABLE}}}`);
    // The credentials never travelled.
    expect(availability?.["headers"]).toEqual({});
    expect(JSON.stringify(draftTools)).not.toContain("FIXTURESECRET");
    // The contract the model reads is byte-identical.
    expect(availability?.["description"]).toBe(
      "Look up open appointment slots for a service on a date.",
    );

    // And the version the customer's callers are served from did not move.
    const serving = retell.toolsAt(105);
    expect(serving.find((tool) => tool["name"] === "get_availability")?.["url"]).toBe(
      "https://backend.example.com/emrs/boulevard/tools/get_availability",
    );

    // The stamp is honest about all three classes.
    expect(built.coverage).toEqual({
      mocked: ["get_availability", "book_appointment", "price list/lookup?v=2"],
      notInterceptable: [
        "normalise_phone",
        "transfer_to_front_desk",
        "text_directions",
        "end_call",
      ],
      notInThisVersion: ["inventory"],
    });
  });

  it("never lets Retell choose the version it writes to", async () => {
    const retell = account({ tags: { prod: 105 } });
    await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: "prod", target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );

    const write = retell.seen.find(
      (one) => one.method === "PATCH" && one.url.includes("/update-conversation-flow/"),
    );
    // The draft's own engine version, in the query string. Retell's default is
    // "latest", and after a branch the latest version is the branch.
    expect(write?.url).toBe(
      `https://retell.invalid/update-conversation-flow/${FLOW}?version=106`,
    );
  });

  it("walks both tool arrays of a Retell LLM", async () => {
    const retell = account({ engine: "retell-llm" });
    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: 105, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );

    expect(built.kind).toBe("built");
    const draft = retell.engines.get(`${LLM}@106`) ?? {};
    const states = draft["states"] as Record<string, unknown>[];
    const stateTools = states.flatMap(
      (state) => (state["tools"] ?? []) as Record<string, unknown>[],
    );
    // A multi-prompt agent keeps most of its tools in its states, so a
    // transform that stopped at `general_tools` would mock almost nothing.
    expect(stateTools.length).toBeGreaterThan(0);
    for (const tool of stateTools) {
      if (tool["type"] !== "custom") continue;
      expect(String(tool["url"])).toContain("https://mock.egma.test/mock-tools/run_01HZ");
    }
  });
});

describe("the version a run is conducted against", () => {
  it("branches from what the agent publishes, never from a leftover draft", async () => {
    // The exact production shape: a stray draft above the published version,
    // left by a run whose teardown deleted nothing. `latest` is that draft.
    const retell = account({
      numbers: { "+12567332874": RIDES_LATEST },
      alsoVersions: [106],
    });

    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );

    expect(built.kind, JSON.stringify(built)).toBe("built");
    if (built.kind !== "built") return;
    // 105, the published version — not 106, the leftover.
    expect(built.agentVersion).toBe(105);
    expect(built.state.tempMockAgentVersion).toBe(107);

    const asked = retell.seen
      .filter((one) => one.url.includes("/get-agent/"))
      .map((one) => new URL(one.url).searchParams.get("version"));
    expect(asked).toContain("latest_published");
  });

  it("refuses an agent that has published nothing, before it writes anything", async () => {
    const retell = account({ published: false });

    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );

    expect(built.kind).toBe("refused");
    if (built.kind !== "refused") return;
    expect(built.reason).toContain("no published version");
    expect(built.reason).toContain("publish the version");
    expect(built.reason).toContain("name a version for this run explicitly");
    // Nothing was made and nothing is owed.
    expect(built.state).toBeNull();
    expect(retell.versions.size).toBe(1);
    expect(retell.seen.some((one) => one.method === "POST")).toBe(false);
    expect(retell.seen.some((one) => one.method === "PATCH")).toBe(false);
  });

  it("still conducts against a draft a developer named on purpose", async () => {
    // Testing a candidate before publishing it is the whole point of door two.
    const retell = account({ published: false, alsoVersions: [106] });

    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: 106, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );

    expect(built.kind, JSON.stringify(built)).toBe("built");
    if (built.kind !== "built") return;
    expect(built.agentVersion).toBe(106);
  });
});

describe("the pin, and the routing it promises to put back", () => {
  it("pins a number riding `latest`, and puts every byte of it back", async () => {
    const original = [
      { agent_id: AGENT, agent_version: "latest", weight: 3, a_field_egma_never_read: "keep me" },
      { agent_id: OTHER_AGENT, agent_version: 7 },
    ];
    const retell = account({ numbers: { "+12567332874": original } });
    const kept = recorder();

    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: "latest", target: TARGET, record: kept.record },
      REACH(retell.fetchImpl),
    );
    expect(built.kind, JSON.stringify(built)).toBe("built");
    if (built.kind !== "built") return;

    // During the run the number is on a real numeric version, so a caller
    // ringing mid-run reaches the real agent with real tools.
    expect(retell.bindingsOf("+12567332874")).toEqual([
      { agent_id: AGENT, agent_version: 105, weight: 3, a_field_egma_never_read: "keep me" },
      { agent_id: OTHER_AGENT, agent_version: 7 },
    ]);
    // The note says where the binding pointed and what Egma pinned it to —
    // the two values a restore reads before it decides to write.
    expect(built.state.mockMetadata?.numbers).toEqual([
      { number: "+12567332874", was: "latest", pinnedTo: 105 },
    ]);

    const finished = await finishMockedWorld(
      key,
      { agentId: AGENT, state: built.state, record: kept.record },
      REACH(retell.fetchImpl),
    );

    expect(finished.unfinished).toEqual([]);
    // Restored, not reconstructed: the field Egma never read is still there.
    expect(retell.bindingsOf("+12567332874")).toEqual(original);
    expect(mockRunIsSettled(finished.state)).toBe(true);
  });

  it("never touches a tag assignment", async () => {
    const retell = account({
      numbers: { "+12567332874": RIDES_TAG },
      tags: { prod: 105 },
    });

    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: "prod", target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );
    expect(built.kind).toBe("built");
    if (built.kind !== "built") return;
    await finishMockedWorld(
      key,
      { agentId: AGENT, state: built.state, record: async () => undefined },
      REACH(retell.fetchImpl),
    );

    // Not one write to the number, in either direction. A tagged number was
    // never pinned, so putting it "back" would be Egma editing a binding it
    // had no business in.
    expect(
      retell.seen.filter((one) => one.url.includes("/update-phone-number/")),
    ).toEqual([]);
    expect(retell.bindingsOf("+12567332874")).toEqual(RIDES_TAG);
  });

  it("pins to what that number reaches now, not to the version the run tests", async () => {
    // The customer's tagged number serves 105. A second number rides `latest`,
    // which is 110 today. Pinning the second number to 105 would quietly move
    // its callers back five versions for the length of a run.
    const retell = account({
      alsoVersions: [110],
      tags: { prod: 105 },
      numbers: {
        "+12567332874": RIDES_TAG,
        "+12567332875": RIDES_LATEST,
      },
    });

    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );

    expect(built.kind, JSON.stringify(built)).toBe("built");
    if (built.kind !== "built") return;
    // The run tests what a real caller reaches, worked out from the numbers.
    expect(built.agentVersion).toBe(105);
    // And the pin preserves the other number's behaviour exactly.
    expect(retell.bindingsOf("+12567332875")[0]?.["agent_version"]).toBe(110);
    expect(retell.bindingsOf("+12567332874")).toEqual(RIDES_TAG);
  });

  it("pins only the hijackable entry, and leaves a numeric sibling alone", async () => {
    // Weighted routing: this agent has both a numeric entry (105) and a
    // hijackable one (latest) on one number. Pinning the whole array to
    // `latest`'s resolved version would move the 105 sibling — the exact
    // hijack this pin exists to stop, by Egma's own hand.
    const mixed = [
      { agent_id: AGENT, agent_version: 105, weight: 1 },
      { agent_id: AGENT, agent_version: "latest", weight: 4 },
      { agent_id: OTHER_AGENT, agent_version: 9 },
    ];
    const retell = account({
      alsoVersions: [112],
      numbers: { "+12567332874": mixed },
    });

    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: 105, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );
    expect(built.kind, JSON.stringify(built)).toBe("built");
    if (built.kind !== "built") return;

    // Only the hijackable entry moved to what `latest` reaches now; the numeric
    // sibling kept its 105, and the other agent kept its 9.
    expect(retell.bindingsOf("+12567332874")).toEqual([
      { agent_id: AGENT, agent_version: 105, weight: 1 },
      { agent_id: AGENT, agent_version: 112, weight: 4 },
      { agent_id: OTHER_AGENT, agent_version: 9 },
    ]);

    await finishMockedWorld(
      key,
      { agentId: AGENT, state: built.state, record: async () => undefined },
      REACH(retell.fetchImpl),
    );
    // And the whole array is restored, byte for byte.
    expect(retell.bindingsOf("+12567332874")).toEqual(mixed);
  });

  it("records the pin it is about to make before it makes it", async () => {
    const retell = account({ numbers: { "+12567332874": RIDES_LATEST } });
    const kept = recorder();
    await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: "latest", target: TARGET, record: kept.record },
      REACH(retell.fetchImpl),
    );

    // The very first record is written before a single request goes out, and
    // it already owes a cleanup: a crash anywhere after it is a run the next
    // claim finds by one indexed query.
    const first = kept.written[0];
    expect(first?.tempMockAgentVersion).toBeNull();
    expect(first?.tempMockAgentVersionCleanup).toBe(false);

    // And the pin is written down before it is made, so a crash between the
    // two leaves a restore that finds the binding untouched and leaves it
    // alone, rather than a pin nobody knows about.
    const beforeThePin = kept.written.find(
      (one) => (one.mockMetadata?.numbers.length ?? 0) > 0,
    );
    expect(beforeThePin?.tempMockAgentVersion).toBeNull();
    expect(beforeThePin?.mockMetadata?.numbers).toEqual([
      { number: "+12567332874", was: "latest", pinnedTo: 105 },
    ]);
  });
});

describe("the fork guard", () => {
  it("refuses a branch that still shares the serving engine version, before any write", async () => {
    const retell = account({ branching: "share" });
    const kept = recorder();

    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: 105, target: TARGET, record: kept.record },
      REACH(retell.fetchImpl),
    );

    expect(built.kind).toBe("refused");
    if (built.kind !== "refused") return;
    expect(built.reason).toContain("still points at the same");
    expect(built.reason).toContain("wrote nothing and stopped");

    // Nothing was written to any engine version at all — which is the whole
    // point, because the version it would have been written to is the one the
    // customer's callers are served from.
    expect(
      retell.seen.filter((one) => one.method === "PATCH" && one.url.includes("conversation-flow")),
    ).toEqual([]);
    expect(retell.toolsAt(105).find((tool) => tool["name"] === "get_availability")?.["url"]).toBe(
      "https://backend.example.com/emrs/boulevard/tools/get_availability",
    );

    // The stray version it did mint is on the record, so the teardown deletes it.
    expect(built.state?.tempMockAgentVersion).toBe(106);
    await finishMockedWorld(
      key,
      { agentId: AGENT, state: built.state!, record: kept.record },
      REACH(retell.fetchImpl),
    );
    expect(retell.versions.has(106)).toBe(false);
  });

  it("refuses a branch that names no engine version to write to", async () => {
    const retell = account({ branching: "unversioned" });
    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: 105, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );

    expect(built.kind).toBe("refused");
    if (built.kind !== "refused") return;
    expect(built.reason).toContain("never writes to an unnamed version");
    expect(
      retell.seen.filter((one) => one.method === "PATCH" && one.url.includes("conversation-flow")),
    ).toEqual([]);
  });
});

describe("the serving-version guard", () => {
  it("refuses a serving version with no engine version, before it reads or writes anything", async () => {
    // The serving version names no engine version, so reading it back would
    // mean "Retell's newest" — which after a branch is the draft Egma just
    // mocked. Egma stops before the capture read rather than corrupt a version
    // it never read.
    const retell = account({ unversionedServingEngine: true });

    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: 105, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );

    expect(built.kind).toBe("refused");
    if (built.kind !== "refused") return;
    expect(built.reason).toContain("names no response engine version");
    expect(built.state).toBeNull();

    // Nothing was read or written past the version resolve: no engine read, no
    // branch, no engine write. The false hijack alarm and the corrupting repair
    // both live downstream of a read this guard never lets happen.
    expect(retell.seen.some((one) => one.url.includes("/get-conversation-flow/"))).toBe(
      false,
    );
    expect(retell.seen.some((one) => one.method === "POST")).toBe(false);
    expect(retell.seen.some((one) => one.method === "PATCH")).toBe(false);
    // And the serving version's tools are exactly as they were.
    expect(retell.toolsAt(105)[0]?.["url"]).toBe(
      "https://backend.example.com/emrs/boulevard/tools/get_availability",
    );
  });
});

describe("the serving-version read-back", () => {
  it("restores the capture and fails loudly when the live version moved", async () => {
    // Somebody edits the serving version while Egma is building — the one
    // failure this whole design exists to prevent.
    const retell = account({
      whenCaptured: (live) => {
        const document = live.engines.get(`${FLOW}@105`);
        const tools = (document?.["tools"] ?? []) as Record<string, unknown>[];
        const first = tools[0];
        if (first !== undefined) first["url"] = "https://somewhere.else.example/hijack";
      },
    });

    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: 105, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );

    expect(built.kind).toBe("refused");
    if (built.kind !== "refused") return;
    expect(built.reason).toContain("changed while Egma");
    expect(built.reason).toContain("failed the run");
    // The capture went back onto the serving version.
    expect(retell.toolsAt(105)[0]?.["url"]).toBe(
      "https://backend.example.com/emrs/boulevard/tools/get_availability",
    );
  });
});

describe("the custom-LLM refusal", () => {
  it("says Retell holds none of its tools, and reaches no version at all", async () => {
    const retell = account();
    retell.versions.set(105, {
      agent_id: AGENT,
      version: 105,
      response_engine: {
        type: "custom-llm",
        llm_websocket_url: "wss://customer.example/agent",
      },
    });

    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: 105, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );

    expect(built.kind).toBe("refused");
    if (built.kind !== "refused") return;
    expect(built.reason).toContain("custom LLM");
    expect(built.reason).toContain("your own service");
    expect(built.state).toBeNull();
    expect(retell.seen.some((one) => one.method === "POST")).toBe(false);
  });
});

describe("the teardown, and the sweep that finishes it", () => {
  it("deletes the draft before it restores a pin", async () => {
    const retell = account({ numbers: { "+12567332874": RIDES_LATEST } });
    const kept = recorder();
    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: "latest", target: TARGET, record: kept.record },
      REACH(retell.fetchImpl),
    );
    expect(built.kind).toBe("built");
    if (built.kind !== "built") return;

    const before = retell.seen.length;
    await finishMockedWorld(
      key,
      { agentId: AGENT, state: built.state, record: kept.record },
      REACH(retell.fetchImpl),
    );
    const during = retell.seen.slice(before);

    const deleteAt = during.findIndex((one) => one.method === "DELETE");
    const restoreAt = during.findIndex((one) => one.url.includes("/update-phone-number/"));
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(restoreAt).toBeGreaterThanOrEqual(0);
    // The reverse order is lethal: restoring `latest` while the draft exists
    // makes the draft *be* latest.
    expect(deleteAt).toBeLessThan(restoreAt);
  });

  it("does not restore a pin when the delete failed", async () => {
    const retell = account({
      numbers: { "+12567332874": RIDES_LATEST },
      refuse: { "/delete-agent-version/": 500 },
    });
    const kept = recorder();
    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: "latest", target: TARGET, record: kept.record },
      REACH(retell.fetchImpl),
    );
    expect(built.kind).toBe("built");
    if (built.kind !== "built") return;

    const finished = await finishMockedWorld(
      key,
      { agentId: AGENT, state: built.state, record: kept.record },
      REACH(retell.fetchImpl),
    );

    expect(finished.unfinished[0]).toContain("deleting temporary version 106");
    // Still pinned, and still owed. A number left on `latest` beside a live
    // draft is the one state that hurts a customer.
    expect(retell.bindingsOf("+12567332874")[0]?.["agent_version"]).toBe(105);
    expect(finished.state.mockMetadata?.numbers).toHaveLength(1);
    expect(mockRunIsSettled(finished.state)).toBe(false);
  });

  it("sweeps what a crashed run left, from that run's own recorded bindings", async () => {
    // A run that branched, pinned, and then died: its record is all that is
    // left of it, and it is enough.
    const retell = account({ numbers: { "+12567332874": RIDES_LATEST } });
    const kept = recorder();
    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, versionReference: "latest", target: TARGET, record: kept.record },
      REACH(retell.fetchImpl),
    );
    expect(built.kind).toBe("built");
    if (built.kind !== "built") return;

    // A second process, days later, holding only what was written down.
    const crashed: MockRunRecord = structuredClone(built.state);
    const swept = await finishMockedWorld(
      key,
      { agentId: AGENT, state: crashed, record: kept.record },
      REACH(retell.fetchImpl),
    );

    expect(swept.unfinished).toEqual([]);
    expect(retell.versions.has(106)).toBe(false);
    expect(retell.bindingsOf("+12567332874")).toEqual(RIDES_LATEST);
    expect(mockRunIsSettled(swept.state)).toBe(true);
  });

  it("reads a version that is already gone as a delete that is already done", async () => {
    const retell = account();
    const state: MockRunRecord = {
      tempMockAgentVersion: 999,
      tempMockAgentVersionCleanup: false,
      mockMetadata: {
        engine: { type: "conversation-flow", engineId: FLOW, version: 999 },
        numbers: [],
      },
    };

    const swept = await finishMockedWorld(
      key,
      { agentId: AGENT, state, record: async () => undefined },
      REACH(retell.fetchImpl),
    );

    expect(swept.unfinished).toEqual([]);
    // The version number stays — it is what the run branched. What says the
    // account is back is the cleanup flag.
    expect(swept.state.tempMockAgentVersion).toBe(999);
    expect(swept.state.tempMockAgentVersionCleanup).toBe(true);
    // And "gone" was a success only because the versions were read back: the
    // account's own listing says 999 is not there.
    expect(
      retell.seen.some((one) => one.url.includes("/list-agent-versions/")),
    ).toBe(true);
  });
});

describe("the proof that the delete happened", () => {
  it("does not record the account put back when a 404 delete left the version standing", async () => {
    // The production defect exactly: Egma's delete was a shape Retell has no
    // route for, Retell answered 404, and 404 read as "already deleted". Every
    // teardown reported the account put back and every draft survived.
    const retell = account({
      numbers: { "+12567332874": RIDES_LATEST },
      deletePretends: "gone",
    });
    const kept = recorder();
    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, target: TARGET, record: kept.record },
      REACH(retell.fetchImpl),
    );
    expect(built.kind, JSON.stringify(built)).toBe("built");
    if (built.kind !== "built") return;

    const finished = await finishMockedWorld(
      key,
      { agentId: AGENT, state: built.state, record: kept.record },
      REACH(retell.fetchImpl),
    );

    expect(mockRunIsSettled(finished.state)).toBe(false);
    expect(finished.unfinished.join(" ")).toContain("still hold it");
    // The draft is what it says: still there.
    expect(retell.versions.has(106)).toBe(true);
    // And the pin stands, which is what keeps real callers off it.
    expect(retell.bindingsOf("+12567332874")[0]?.["agent_version"]).toBe(105);
  });

  it("does not record the account put back when a 204 delete left the version standing", async () => {
    const retell = account({ deletePretends: "deleted" });
    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );
    expect(built.kind).toBe("built");
    if (built.kind !== "built") return;

    const finished = await finishMockedWorld(
      key,
      { agentId: AGENT, state: built.state, record: async () => undefined },
      REACH(retell.fetchImpl),
    );

    expect(mockRunIsSettled(finished.state)).toBe(false);
    expect(finished.unfinished.join(" ")).toContain("still hold it");
  });

  it("does not record the account put back when the read-back cannot say", async () => {
    for (const [status, expected] of [
      [404, /is not proof/u],
      [500, /unavailable/u],
    ] as const) {
      const retell = account({ refuse: { "/list-agent-versions/": status } });
      const built = await buildMockedWorld(
        key,
        { agentId: AGENT, target: TARGET, record: recorder().record },
        REACH(retell.fetchImpl),
      );
      expect(built.kind).toBe("built");
      if (built.kind !== "built") return;

      const finished = await finishMockedWorld(
        key,
        { agentId: AGENT, state: built.state, record: async () => undefined },
        REACH(retell.fetchImpl),
      );

      expect(mockRunIsSettled(finished.state), String(status)).toBe(false);
      expect(finished.unfinished.join(" ")).toMatch(expected);
      expect(JSON.stringify(finished)).not.toContain(KEY);
    }
  });

  it("deletes the version with the version in the query string", async () => {
    const retell = account();
    const built = await buildMockedWorld(
      key,
      { agentId: AGENT, target: TARGET, record: recorder().record },
      REACH(retell.fetchImpl),
    );
    expect(built.kind).toBe("built");
    if (built.kind !== "built") return;

    const finished = await finishMockedWorld(
      key,
      { agentId: AGENT, state: built.state, record: async () => undefined },
      REACH(retell.fetchImpl),
    );

    expect(finished.unfinished).toEqual([]);
    expect(mockRunIsSettled(finished.state)).toBe(true);
    const removed = retell.seen.find((one) => one.method === "DELETE");
    expect(removed?.url).toBe(
      `https://retell.invalid/delete-agent-version/${AGENT}?version=106`,
    );
    // The lockstep engine version went with it — there is no second cleanup.
    expect(retell.engines.has(`${FLOW}@106`)).toBe(false);
  });
});
