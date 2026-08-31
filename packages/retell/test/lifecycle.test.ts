import { describe, expect, it } from "vitest";

import {
  bindingsFor,
  bindingVerdictOf,
  branchAgentVersion,
  deleteAgentVersion,
  LATEST_PUBLISHED,
  listAgentVersions,
  listRoutedNumbers,
  numbersRouting,
  pinNumberBinding,
  readEngineConfiguration,
  resolveAgentVersion,
  resolveServingAgentVersion,
  restoreNumberBinding,
  writeEngineTools,
  type RetellCredential,
} from "../src/index.ts";

/**
 * The write verbs, against a Retell that only exists in this file.
 *
 * Nothing here reaches a network. What is proved is the shape of every request
 * egma makes — which path, which method, which query string, which body — and
 * the value every verb ends in, because those are the two things a live
 * account would otherwise have to be trusted for.
 */

const KEY = "retell-secret-key-9f2b1c";
const key: RetellCredential = { reveal: () => KEY };

type Seen = {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly authorization: string | null;
};

type Route = (seen: Seen) => Response | undefined;

/** A stand-in Retell: the requests it saw, and the answers it gave. */
function retell(routes: readonly Route[]): {
  readonly fetchImpl: typeof fetch;
  readonly seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const request: Seen = {
      method: init?.method ?? "GET",
      url,
      body,
      authorization: headers["authorization"] ?? null,
    };
    seen.push(request);
    for (const route of routes) {
      const answer = route(request);
      if (answer !== undefined) return answer;
    }
    return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

const REACH = (fetchImpl: typeof fetch) => ({
  url: "https://retell.invalid",
  fetchImpl,
});

const AGENT = "agent_b0e2e9cb267c47e7e7026cd8e8";

describe("resolving a version reference", () => {
  it("turns an environment tag into the number the account serves", async () => {
    const { fetchImpl, seen } = retell([
      (request) =>
        request.url.includes("/get-agent/")
          ? json({
              agent_id: AGENT,
              version: 105,
              is_published: true,
              response_engine: {
                type: "conversation-flow",
                conversation_flow_id: "conversation_flow_2346a0e8367c",
                version: 105,
              },
            })
          : undefined,
    ]);

    const resolved = await resolveAgentVersion(
      key,
      AGENT,
      "prod",
      REACH(fetchImpl),
    );

    expect(resolved).toEqual({
      kind: "version",
      agentVersion: {
        version: 105,
        published: true,
        engine: {
          type: "conversation-flow",
          engineId: "conversation_flow_2346a0e8367c",
          version: 105,
        },
      },
    });
    expect(seen[0]?.url).toBe(
      `https://retell.invalid/get-agent/${AGENT}?version=prod`,
    );
    expect(seen[0]?.authorization).toBe(`Bearer ${KEY}`);
  });

  it("resolves `latest` the same way, and never assumes it", async () => {
    const { fetchImpl, seen } = retell([
      () =>
        json({
          version: 41,
          response_engine: { type: "retell-llm", llm_id: "llm_1", version: 7 },
        }),
    ]);

    const resolved = await resolveAgentVersion(
      key,
      AGENT,
      "latest",
      REACH(fetchImpl),
    );

    expect(resolved).toEqual({
      kind: "version",
      agentVersion: {
        version: 41,
        published: false,
        engine: { type: "retell-llm", engineId: "llm_1", version: 7 },
      },
    });
    expect(seen[0]?.url).toContain("?version=latest");
  });

  it("answers gone for an agent Retell no longer holds", async () => {
    const { fetchImpl } = retell([() => json({ error: "not found" }, 404)]);
    expect(
      await resolveAgentVersion(key, AGENT, 105, REACH(fetchImpl)),
    ).toEqual({ kind: "gone" });
  });

  it("answers invalid-key without repeating the key", async () => {
    const { fetchImpl } = retell([() => json({ error: "bad key" }, 401)]);
    const answer = await resolveAgentVersion(key, AGENT, 105, REACH(fetchImpl));
    expect(answer).toEqual({ kind: "invalid-key" });
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });
});

describe("reading an engine's configuration", () => {
  it("reads a conversation flow at the version it was asked for", async () => {
    const { fetchImpl, seen } = retell([
      () => json({ conversation_flow_id: "flow_1", version: 105, tools: [] }),
    ]);

    const read = await readEngineConfiguration(
      key,
      { type: "conversation-flow", engineId: "flow_1", version: 105 },
      REACH(fetchImpl),
    );

    expect(read).toEqual({
      kind: "engine",
      engine: {
        reference: {
          type: "conversation-flow",
          engineId: "flow_1",
          version: 105,
        },
        document: { conversation_flow_id: "flow_1", version: 105, tools: [] },
      },
    });
    expect(seen[0]?.url).toBe(
      "https://retell.invalid/get-conversation-flow/flow_1?version=105",
    );
  });

  it("reads a Retell LLM at its own address", async () => {
    const { fetchImpl, seen } = retell([
      () => json({ llm_id: "llm_1", version: 7, general_tools: [] }),
    ]);

    const read = await readEngineConfiguration(
      key,
      { type: "retell-llm", engineId: "llm_1", version: 7 },
      REACH(fetchImpl),
    );

    expect(read.kind).toBe("engine");
    expect(seen[0]?.url).toBe(
      "https://retell.invalid/get-retell-llm/llm_1?version=7",
    );
  });

  it("says a custom LLM's configuration is not Retell's to hold", async () => {
    const { fetchImpl, seen } = retell([() => json({})]);
    const read = await readEngineConfiguration(
      key,
      { type: "custom-llm", engineId: "", version: null },
      REACH(fetchImpl),
    );

    expect(read.kind).toBe("not-held");
    // And it asks Retell nothing, because there is nothing to ask.
    expect(seen).toHaveLength(0);
  });
});

describe("branching, writing and deleting a version", () => {
  it("branches from a named base and sends nothing else", async () => {
    const { fetchImpl, seen } = retell([
      (request) =>
        request.url.includes("/create-agent-version/")
          ? json({
              agent_id: AGENT,
              version: 106,
              is_published: false,
              response_engine: {
                type: "conversation-flow",
                conversation_flow_id: "flow_1",
                version: 106,
              },
            })
          : undefined,
    ]);

    const branched = await branchAgentVersion(key, AGENT, 105, REACH(fetchImpl));

    expect(branched).toEqual({
      kind: "branched",
      agentVersion: {
        version: 106,
        published: false,
        engine: {
          type: "conversation-flow",
          engineId: "flow_1",
          version: 106,
        },
      },
    });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe(
      `https://retell.invalid/create-agent-version/${AGENT}`,
    );
    // A title and a description belong to publishing; this endpoint refuses
    // them and creates nothing when they are sent.
    expect(seen[0]?.body).toEqual({ base_version: 105 });
  });

  it("names the version on every engine write", async () => {
    const { fetchImpl, seen } = retell([() => json({ ok: true })]);

    await writeEngineTools(
      key,
      {
        reference: {
          type: "conversation-flow",
          engineId: "flow_1",
          version: 106,
        },
        version: 106,
        tools: { tools: [] },
      },
      REACH(fetchImpl),
    );
    await writeEngineTools(
      key,
      { reference: { type: "retell-llm", engineId: "llm_1", version: 8 }, version: 8, tools: { general_tools: [] } },
      REACH(fetchImpl),
    );

    expect(seen.map((request) => request.url)).toEqual([
      "https://retell.invalid/update-conversation-flow/flow_1?version=106",
      "https://retell.invalid/update-retell-llm/llm_1?version=8",
    ]);
    expect(seen.every((request) => request.method === "PATCH")).toBe(true);
  });

  it("never relies on Retell's default-to-latest", async () => {
    const { fetchImpl, seen } = retell([
      (request) =>
        // The stand-in refuses any write that leaves the version to Retell,
        // which
        // is the behaviour a real account would give a concurrent branch: the
        // latest version is whichever one was minted last, anywhere.
        request.method === "PATCH" && !request.url.includes("version=")
          ? json({ error: "would have hit latest" }, 500)
          : json({ ok: true }),
    ]);

    // Every engine version this client can be asked to write, including the
    // one a caller is most likely to fumble: version zero.
    for (const version of [0, 1, 106]) {
      const written = await writeEngineTools(
        key,
        {
          reference: {
            type: "conversation-flow",
            engineId: "flow_1",
            version,
          },
          version,
          tools: { tools: [] },
        },
        REACH(fetchImpl),
      );
      expect(written).toEqual({ kind: "written" });
    }

    for (const request of seen) {
      expect(new URL(request.url).searchParams.get("version")).not.toBeNull();
    }
  });

  it("refuses to write onto a custom LLM, and asks Retell nothing", async () => {
    const { fetchImpl, seen } = retell([() => json({ ok: true })]);
    const written = await writeEngineTools(
      key,
      {
        reference: { type: "custom-llm", engineId: "", version: null },
        version: 1,
        tools: {},
      },
      REACH(fetchImpl),
    );
    expect(written.kind).toBe("refused");
    expect(seen).toHaveLength(0);
  });

  it("names the version to delete as a query parameter", async () => {
    // Retell's router has no `/delete-agent-version/{agent}/{version}` route:
    // the path form answers 404 "Cannot DELETE" and the query form answers 204
    // (verified live, 2026-08-31). The stand-in answers exactly that way, so a
    // return to the path form fails here rather than on somebody's account.
    const { fetchImpl, seen } = retell([
      (request) =>
        request.method === "DELETE" &&
        new URL(request.url).searchParams.get("version") === null
          ? json({ error: "Cannot DELETE" }, 404)
          : new Response(null, { status: 204 }),
    ]);

    expect(await deleteAgentVersion(key, AGENT, 106, REACH(fetchImpl))).toEqual({
      kind: "deleted",
    });
    expect(seen[0]?.method).toBe("DELETE");
    expect(seen[0]?.url).toBe(
      `https://retell.invalid/delete-agent-version/${AGENT}?version=106`,
    );
    // Version zero is the one a caller is most likely to fumble into a falsy
    // check and leave off the query string entirely.
    await deleteAgentVersion(key, AGENT, 0, REACH(fetchImpl));
    expect(new URL(String(seen[1]?.url)).searchParams.get("version")).toBe("0");
  });

  it("answers gone for a version that is already not there", async () => {
    const { fetchImpl } = retell([() => json({ error: "not found" }, 404)]);
    expect(await deleteAgentVersion(key, AGENT, 106, REACH(fetchImpl))).toEqual({
      kind: "gone",
    });
  });
});

describe("reading an agent's versions back", () => {
  it("reads the current listing, never the one that retires 2026-09-15", async () => {
    const { fetchImpl, seen } = retell([
      (request) =>
        request.url.includes("/list-agent-versions/")
          ? json([
              { version: 105, is_published: true },
              { version: 106, is_published: false },
            ])
          : undefined,
    ]);

    const listed = await listAgentVersions(key, AGENT, REACH(fetchImpl));

    expect(listed).toEqual({
      kind: "versions",
      versions: [
        { version: 105, published: true },
        { version: 106, published: false },
      ],
    });
    expect(seen[0]?.url).toContain(
      `https://retell.invalid/list-agent-versions/${AGENT}?`,
    );
    expect(seen.some((one) => one.url.includes("/get-agent-versions"))).toBe(
      false,
    );
  });

  it("pages to the end of a paged listing", async () => {
    const { fetchImpl, seen } = retell([
      (request) => {
        if (!request.url.includes("/list-agent-versions/")) return undefined;
        const cursor = new URL(request.url).searchParams.get("pagination_key");
        return cursor === null
          ? json({
              items: [{ version: 105, is_published: true }],
              has_more: true,
              pagination_key: "page-2",
            })
          : json({ items: [{ version: 106 }], has_more: false });
      },
    ]);

    const listed = await listAgentVersions(key, AGENT, REACH(fetchImpl));
    expect(listed).toEqual({
      kind: "versions",
      versions: [
        { version: 105, published: true },
        { version: 106, published: false },
      ],
    });
    expect(seen).toHaveLength(2);
  });

  it("says it cannot tell rather than answering an empty list", async () => {
    for (const [answer, reason] of [
      [json({ nothing: true }), /malformed/u],
      [json({ items: [], has_more: true }), /without a new cursor/u],
      [json({ error: "boom" }, 500), /unavailable/u],
    ] as const) {
      const { fetchImpl } = retell([() => answer.clone()]);
      const listed = await listAgentVersions(key, AGENT, REACH(fetchImpl));
      expect(listed.kind).toBe("refused");
      expect(listed.kind === "refused" ? listed.reason : "").toMatch(reason);
    }
  });
});

describe("resolving the version a run should conduct against", () => {
  it("asks Retell for the newest published version, and pins the number", async () => {
    const { fetchImpl, seen } = retell([
      () =>
        json({
          version: 105,
          is_published: true,
          response_engine: {
            type: "conversation-flow",
            conversation_flow_id: "flow_1",
            version: 105,
          },
        }),
    ]);

    const serving = await resolveServingAgentVersion(
      key,
      AGENT,
      LATEST_PUBLISHED,
      REACH(fetchImpl),
    );

    expect(serving.kind).toBe("version");
    expect(
      serving.kind === "version" ? serving.agentVersion.version : null,
    ).toBe(105);
    expect(seen).toHaveLength(1);
    expect(new URL(String(seen[0]?.url)).searchParams.get("version")).toBe(
      "latest_published",
    );
  });

  it("refuses an agent whose newest version is a draft, and names both doors", async () => {
    // Retell answers the published reference with nothing, and `latest` with a
    // draft: the agent is there and has published nothing.
    const { fetchImpl } = retell([
      (request) =>
        new URL(request.url).searchParams.get("version") === "latest"
          ? json({ version: 3, is_published: false, response_engine: {} })
          : json({ error: "not found" }, 404),
    ]);

    const serving = await resolveServingAgentVersion(
      key,
      AGENT,
      LATEST_PUBLISHED,
      REACH(fetchImpl),
    );

    expect(serving.kind).toBe("none-published");
    const reason = serving.kind === "none-published" ? serving.reason : "";
    expect(reason).toContain("no published version");
    expect(reason).toContain("publish the version");
    expect(reason).toContain("name a version for the run explicitly");
  });

  it("refuses a published pointer that resolved to a draft anyway", async () => {
    const { fetchImpl } = retell([
      () => json({ version: 9, is_published: false, response_engine: {} }),
    ]);
    const serving = await resolveServingAgentVersion(
      key,
      AGENT,
      LATEST_PUBLISHED,
      REACH(fetchImpl),
    );
    expect(serving.kind).toBe("none-published");
  });

  it("still says gone for an agent that is not there at all", async () => {
    const { fetchImpl } = retell([() => json({ error: "not found" }, 404)]);
    const serving = await resolveServingAgentVersion(
      key,
      AGENT,
      LATEST_PUBLISHED,
      REACH(fetchImpl),
    );
    expect(serving).toEqual({ kind: "gone" });
  });

  it("passes an explicitly named version or tag straight through", async () => {
    const { fetchImpl, seen } = retell([
      () =>
        json({
          version: 42,
          is_published: false,
          response_engine: { type: "retell-llm", llm_id: "llm_1", version: 42 },
        }),
    ]);

    // A draft named on purpose is a candidate a developer wants tested. It
    // resolves, and nothing here second-guesses it.
    const named = await resolveServingAgentVersion(
      key,
      AGENT,
      42,
      REACH(fetchImpl),
    );
    expect(named.kind).toBe("version");
    expect(named.kind === "version" ? named.agentVersion.version : null).toBe(
      42,
    );

    const tagged = await resolveServingAgentVersion(
      key,
      AGENT,
      "prod",
      REACH(fetchImpl),
    );
    expect(tagged.kind).toBe("version");
    expect(seen.map((one) => new URL(one.url).searchParams.get("version"))).toEqual(
      ["42", "prod"],
    );
  });
});

/** Two pages of numbers, the second holding the one that rides `latest`. */
function accountWithTwoPagesOfNumbers(): readonly Route[] {
  return [
    (request) => {
      if (!request.url.includes("/v2/list-phone-numbers")) return undefined;
      const cursor = new URL(request.url).searchParams.get("pagination_key");
      if (cursor === null) {
        return json({
          items: [
            {
              phone_number: "+12567332874",
              nickname: "Front desk",
              inbound_agents: [
                { agent_id: AGENT, agent_version: "prod", weight: 1 },
              ],
            },
            {
              phone_number: "+12025550100",
              nickname: "Another agent's line",
              inbound_agents: [
                { agent_id: "agent_other", agent_version: 3 },
              ],
            },
          ],
          has_more: true,
          pagination_key: "page-2",
        });
      }
      return json({
        items: [
          {
            phone_number: "+14155550199",
            nickname: "Overflow",
            inbound_agents: [
              { agent_id: "agent_other", agent_version: "latest_published" },
              {
                agent_id: AGENT,
                agent_version: "latest",
                weight: 2,
                a_field_egma_has_never_heard_of: "keep me",
              },
            ],
          },
        ],
        has_more: false,
      });
    },
  ];
}

describe("discovering the numbers that route to an agent", () => {
  it("pages to the end and finds a second page's `latest` binding", async () => {
    const { fetchImpl, seen } = retell(accountWithTwoPagesOfNumbers());

    const listed = await listRoutedNumbers(key, REACH(fetchImpl));
    expect(listed.kind).toBe("numbers");
    if (listed.kind !== "numbers") return;

    expect(seen).toHaveLength(2);
    const routing = numbersRouting(listed.numbers, AGENT);
    expect(routing.map((one) => one.number)).toEqual([
      "+12567332874",
      "+14155550199",
    ]);

    const overflow = routing[1]!;
    const mine = bindingsFor(overflow, AGENT);
    expect(mine).toHaveLength(1);
    expect(bindingVerdictOf(mine[0]!)).toBe("hijackable");
    // And the other agent's entry is still on the number, because putting the
    // number back means putting the whole array back.
    expect(overflow.bindings).toHaveLength(2);
  });

  it("gives every binding its verdict", async () => {
    const verdicts = (
      [
        105,
        0,
        "latest",
        "",
        null,
        "latest_published",
        "prod",
        "staging",
      ] as const
    ).map((agentVersion) =>
      bindingVerdictOf({
        agentId: AGENT,
        agentVersion,
        verbatim: { agent_id: AGENT, agent_version: agentVersion },
      }),
    );

    expect(verdicts).toEqual([
      "numeric",
      "numeric",
      "hijackable",
      "hijackable",
      "hijackable",
      "latest-published",
      "environment-tag",
      "environment-tag",
    ]);
  });
});

describe("pinning and restoring a binding", () => {
  it("pins only this agent's entry, keeping every other field verbatim", async () => {
    const listing = retell(accountWithTwoPagesOfNumbers());
    const listed = await listRoutedNumbers(key, REACH(listing.fetchImpl));
    if (listed.kind !== "numbers") throw new Error("expected numbers");
    const overflow = numbersRouting(listed.numbers, AGENT)[1]!;

    const { fetchImpl, seen } = retell([() => json({ ok: true })]);
    const pinned = await pinNumberBinding(
      key,
      {
        number: overflow.number,
        agentId: AGENT,
        version: 106,
        bindings: overflow.bindings,
      },
      REACH(fetchImpl),
    );

    expect(pinned).toEqual({ kind: "written" });
    expect(seen[0]?.method).toBe("PATCH");
    expect(seen[0]?.url).toBe(
      "https://retell.invalid/update-phone-number/%2B14155550199",
    );
    expect(seen[0]?.body).toEqual({
      inbound_agents: [
        { agent_id: "agent_other", agent_version: "latest_published" },
        {
          agent_id: AGENT,
          agent_version: 106,
          weight: 2,
          a_field_egma_has_never_heard_of: "keep me",
        },
      ],
    });
  });

  it("reads the number first and puts back only what it still pinned", async () => {
    // The number as it stands now: this agent's entry still points where the
    // run pinned it, so the recorded `was` goes back — onto the array read
    // now, so a sibling agent's entry survives whatever it has become since.
    const { fetchImpl, seen } = retell([
      () =>
        json({
          phone_number: "+14155550199",
          nickname: "Overflow",
          inbound_agents: [
            { agent_id: "agent_other", agent_version: "latest_published" },
            {
              agent_id: AGENT,
              agent_version: 106,
              weight: 2,
              a_field_egma_has_never_heard_of: "keep me",
            },
          ],
        }),
      () => json({ ok: true }),
    ]);

    const restored = await restoreNumberBinding(
      key,
      { number: "+14155550199", agentId: AGENT, pinnedTo: 106, was: "latest" },
      REACH(fetchImpl),
    );

    expect(restored).toEqual({ kind: "restored" });
    expect(seen[0]?.method).toBe("GET");
    expect(seen[1]?.method).toBe("PATCH");
    expect(seen[1]?.body).toEqual({
      inbound_agents: [
        { agent_id: "agent_other", agent_version: "latest_published" },
        {
          agent_id: AGENT,
          agent_version: "latest",
          weight: 2,
          a_field_egma_has_never_heard_of: "keep me",
        },
      ],
    });
  });

  it("writes nothing when the binding has moved, and says why", async () => {
    // Race rule two. A teardown that failed once retries later, and by then
    // the number may point somewhere else — the customer rebound it, or a
    // newer run pinned it. Writing the recorded value back then would undo a
    // deliberate change, and in the worst case would put `latest` onto a newer
    // run's temporary copy.
    const { fetchImpl, seen } = retell([
      () =>
        json({
          phone_number: "+14155550199",
          nickname: "Overflow",
          inbound_agents: [{ agent_id: AGENT, agent_version: 112 }],
        }),
    ]);

    const restored = await restoreNumberBinding(
      key,
      { number: "+14155550199", agentId: AGENT, pinnedTo: 106, was: "latest" },
      REACH(fetchImpl),
    );

    expect(restored.kind).toBe("left-alone");
    if (restored.kind !== "left-alone") throw new Error("expected left-alone");
    expect(restored.reason).toContain("no longer points at version 106");
    // One request, and it was the read. Nothing was written.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
  });

  it("leaves a number that is no longer on the account alone", async () => {
    const { fetchImpl, seen } = retell([() => json({ error: "gone" }, 404)]);
    const restored = await restoreNumberBinding(
      key,
      { number: "+14155550199", agentId: AGENT, pinnedTo: 106, was: null },
      REACH(fetchImpl),
    );
    expect(restored.kind).toBe("left-alone");
    expect(seen).toHaveLength(1);
  });

  it("reports a refused restore instead of throwing, and quotes no key", async () => {
    const { fetchImpl } = retell([() => json({ error: "boom" }, 500)]);
    const restored = await restoreNumberBinding(
      key,
      { number: "+14155550199", agentId: AGENT, pinnedTo: 106, was: "latest" },
      REACH(fetchImpl),
    );
    expect(restored).toEqual({
      kind: "refused",
      reason: "Retell is unavailable. Try again.",
    });
    expect(JSON.stringify(restored)).not.toContain(KEY);
  });
});
