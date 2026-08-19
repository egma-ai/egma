import {
  appendVerdicts,
  createAgent,
  createPersona,
  createProject,
  createTest,
  startRun,
  type AuthContext,
} from "@egma/db";
import { newId } from "@egma/ids";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  ingest,
  listTracesAsSignedIn,
  listTracesOverHttp,
  mintKey,
  readTraceAsSignedIn,
  readTraceOverHttp,
  signUp,
  syntheticExport,
  NEUTRAL_TRAITS,
  type Customer,
  type ListedPage,
} from "./support/traces.ts";

/**
 * What the v1 read contract refuses, and what it promises while refusing it.
 *
 * These are the one-way-door tests. A required window, a capped one, a page
 * token that is a position rather than an offset, and an organization that comes
 * off the credential are all things that can be added on the first day and never
 * afterwards — every one of them breaks an integration written against their
 * absence. So each is asserted here, through the routes, at the point where
 * changing the answer is still free.
 *
 * The traces are synthetic and go in at the real door. The captured LiveKit
 * trace is one exchange at the instants it really happened, which is exactly
 * right for the spine test and useless for asking whether page two follows page
 * one.
 */

let api: TestApi;
let acme: Customer;
let globex: Customer;

/** The minute every paging trace is filed under, and the day around it. */
const DAY = { from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z" } as const;

/**
 * Twelve traces, of which three share a minute and two share it to the second.
 *
 * The minute matters because it is what the store files by: the sort key buckets
 * `started_at` to `toStartOfMinute`, so several traces of one minute are the
 * case where a page boundary has nothing but the trace id to break a tie with.
 * A cursor that carried only a time would skip or repeat exactly here.
 */
const PAGING_TRACES = [
  { traceId: "aa000000000000000000000000000001", at: "2026-06-01T09:00:00Z" },
  { traceId: "aa000000000000000000000000000002", at: "2026-06-01T09:00:00Z" },
  { traceId: "aa000000000000000000000000000003", at: "2026-06-01T09:00:30Z" },
  { traceId: "aa000000000000000000000000000004", at: "2026-06-01T09:05:00Z" },
  { traceId: "aa000000000000000000000000000005", at: "2026-06-01T09:10:00Z" },
  { traceId: "aa000000000000000000000000000006", at: "2026-06-01T09:15:00Z" },
  { traceId: "aa000000000000000000000000000007", at: "2026-06-01T09:20:00Z" },
  { traceId: "aa000000000000000000000000000008", at: "2026-06-01T09:25:00Z" },
  { traceId: "aa000000000000000000000000000009", at: "2026-06-01T09:30:00Z" },
  { traceId: "aa00000000000000000000000000000a", at: "2026-06-01T09:35:00Z" },
  { traceId: "aa00000000000000000000000000000b", at: "2026-06-01T09:40:00Z" },
  { traceId: "aa00000000000000000000000000000c", at: "2026-06-01T09:45:00Z" },
] as const;

beforeAll(async () => {
  api = await createApi("trace_reads_contract", { traceStore: true });
  acme = await signUp(api.app, "ada@acme.example", "Acme");
  globex = await signUp(api.app, "grace@globex.example", "Globex");

  for (const trace of PAGING_TRACES) {
    await ingest(
      api.app,
      acme.secret,
      syntheticExport({
        traceId: trace.traceId,
        startedAt: new Date(trace.at),
        humanSaid: `This is trace ${trace.traceId.slice(-2)}.`,
      }),
    );
  }
});

afterAll(async () => {
  await api?.close();
});

async function page(
  secret: string,
  query: Record<string, string | number>,
): Promise<ListedPage> {
  const response = await listTracesOverHttp(api.app, secret, query);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ListedPage;
}

describe("a list request that does not say when", () => {
  it("is refused, and told what to send", async () => {
    const response = await listTracesOverHttp(api.app, acme.secret, {});
    expect(response.statusCode).toBe(400);

    const body = response.json() as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toContain("no from");
    expect(body.message).toContain("no to");
    expect(body.message).toContain("RFC 3339");
  });

  it("is refused when only half the window is there", async () => {
    for (const half of [{ from: DAY.from }, { to: DAY.to }]) {
      const response = await listTracesOverHttp(api.app, acme.secret, half);
      expect(response.statusCode).toBe(400);
    }
  });

  it("is refused when the window is not a time", async () => {
    const response = await listTracesOverHttp(api.app, acme.secret, {
      from: "last tuesday",
      to: DAY.to,
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain(
      "not a time",
    );
  });

  /**
   * A year a `Date` will hold and the store will not.
   *
   * `new Date('+275760-09-12T00:00:00Z')` is a perfectly good JavaScript date,
   * and `toISOString` writes its year with a sign and six digits — so a window
   * naming one used to reach ClickHouse as a timestamp literal that was not a
   * timestamp, and the caller was told their query was a fault of egma's. It is
   * a window, it is refused, and it is refused with the reason.
   */
  it("is refused when it names a year the trace store cannot hold", async () => {
    const outside = [
      { from: "+275760-09-11T00:00:00Z", to: "+275760-09-12T00:00:00Z" },
      { from: "-000001-01-01T00:00:00Z", to: "-000001-01-02T00:00:00Z" },
    ];

    for (const window of outside) {
      const response = await listTracesOverHttp(api.app, acme.secret, window);
      expect(response.statusCode, window.from).toBe(400);

      const body = response.json() as { error: string; message: string };
      expect(body.error).toBe("invalid_request");
      expect(body.message).toContain("outside the range");

      const detail = await readTraceOverHttp(
        api.app,
        acme.secret,
        PAGING_TRACES[0].traceId,
        window,
      );
      expect(detail.statusCode, window.from).toBe(400);
    }
  });

  /**
   * A bound finer than the store's own precision is refused rather than
   * rounded, which is the same rule as the too-wide window: the seventh digit
   * has nowhere to go, and honouring it would mean moving somebody's bound
   * without saying so. `to` is exclusive, so where it lands decides whether a
   * span is in the answer.
   */
  it("refuses a bound finer than the microsecond the store holds", async () => {
    const finer = await listTracesOverHttp(api.app, acme.secret, {
      from: "2026-06-01T00:00:00.0000001Z",
      to: DAY.to,
    });
    expect(finer.statusCode).toBe(400);
    expect((finer.json() as { message: string }).message).toContain("six");
  });

  /** The detail endpoint is bounded on the same terms, and for the same reason. */
  it("is refused on the detail endpoint too, which is filed by time as well", async () => {
    const response = await readTraceOverHttp(
      api.app,
      acme.secret,
      PAGING_TRACES[0].traceId,
      {},
    );
    expect(response.statusCode).toBe(400);
  });
});

/**
 * A window wider than the cap is **refused, not clamped**, and the refusal says
 * what the cap is.
 *
 * Clamping would answer a different question than the one asked while saying
 * nothing about having done so: a caller walking ninety days would reach the end
 * of a month and conclude that was everything there was. What to do about a
 * window too wide to serve is the caller's decision to make, and only a refusal
 * lets them make it.
 */
describe("a window wider than one request may ask for", () => {
  it("is refused rather than quietly narrowed", async () => {
    const response = await listTracesOverHttp(api.app, acme.secret, {
      from: "2026-01-01T00:00:00Z",
      to: "2026-06-01T00:00:00Z",
    });
    expect(response.statusCode).toBe(400);

    const body = response.json() as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toContain("31 days");
    expect(body.message).toContain("refused rather than narrowed");
  });

  it("is refused on the detail endpoint on the same terms", async () => {
    const response = await readTraceOverHttp(
      api.app,
      acme.secret,
      PAGING_TRACES[0].traceId,
      { from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" },
    );
    expect(response.statusCode).toBe(400);
  });

  it("takes a window exactly the width of the cap", async () => {
    const response = await listTracesOverHttp(api.app, acme.secret, {
      from: "2026-06-01T00:00:00Z",
      to: "2026-07-02T00:00:00Z",
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it("refuses a window that ends before it starts", async () => {
    const response = await listTracesOverHttp(api.app, acme.secret, {
      from: DAY.to,
      to: DAY.from,
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain(
      "ends at or before it starts",
    );
  });
});

describe("walking every page of a list", () => {
  /**
   * The whole promise, in one walk: every trace once, in order, across
   * boundaries that fall in the middle of a shared minute.
   */
  it("returns every trace exactly once, newest first, across every boundary", async () => {
    for (const size of [1, 2, 5, 7]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;

      do {
        const answered = await page(acme.secret, {
          ...DAY,
          limit: size,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(answered.traces.length).toBeLessThanOrEqual(size);
        seen.push(...answered.traces.map((trace) => trace.trace_id));
        cursor = answered.next_cursor ?? undefined;
        pages += 1;
        expect(pages, "the walk did not terminate").toBeLessThan(50);
      } while (cursor !== undefined);

      expect(new Set(seen).size, `page size ${size} repeated a trace`).toBe(
        seen.length,
      );
      expect(seen, `page size ${size} skipped a trace`).toHaveLength(
        PAGING_TRACES.length,
      );

      // Newest first. The three traces of 09:00 are ordered among themselves by
      // id descending, which is the tie-break the cursor carries.
      const expected = [...PAGING_TRACES]
        .map((trace) => ({ ...trace }))
        .sort(
          (left, right) =>
            Date.parse(right.at) - Date.parse(left.at) ||
            right.traceId.localeCompare(left.traceId),
        )
        .map((trace) => trace.traceId);
      expect(seen).toEqual(expected);
    }
  });

  it("splits a shared minute across a page boundary without losing either side", async () => {
    // Page size two, so the boundary falls between the two traces that share
    // 09:00:00 exactly — the case where a cursor carrying only a time cannot
    // tell the second from the first.
    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      const answered = await page(acme.secret, {
        ...DAY,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      walked.push(...answered.traces.map((trace) => trace.trace_id));
      cursor = answered.next_cursor ?? undefined;
    } while (cursor !== undefined);

    const sharingTheMinute = walked.filter((id) =>
      ["01", "02", "03"].includes(id.slice(-2)),
    );
    expect(sharingTheMinute).toEqual([
      "aa000000000000000000000000000003",
      "aa000000000000000000000000000002",
      "aa000000000000000000000000000001",
    ]);
  });

  it("hands out no cursor on the last page, so nobody asks for nothing", async () => {
    const answered = await page(acme.secret, { ...DAY, limit: 200 });
    expect(answered.traces).toHaveLength(PAGING_TRACES.length);
    expect(answered.next_cursor).toBeNull();
  });

  it("refuses a token it did not issue", async () => {
    for (const cursor of ["not-a-cursor", "MTox", Buffer.from("9:1:x").toString("base64url")]) {
      const response = await listTracesOverHttp(api.app, acme.secret, {
        ...DAY,
        cursor,
      });
      expect(response.statusCode, cursor).toBe(400);
      expect((response.json() as { message: string }).message).toContain(
        "page token",
      );
    }
  });

  it("clamps a page size nobody could want, and refuses one that is not a count", async () => {
    const enormous = await page(acme.secret, { ...DAY, limit: 100_000 });
    expect(enormous.traces).toHaveLength(PAGING_TRACES.length);

    for (const limit of ["lots", "0", "-1"]) {
      const nonsense = await listTracesOverHttp(api.app, acme.secret, {
        ...DAY,
        limit,
      });
      expect(nonsense.statusCode, limit).toBe(400);
      expect((nonsense.json() as { message: string }).message).toContain(
        "not a count",
      );
    }
  });
});

/**
 * A query parameter that arrived carrying nothing.
 *
 * `?project_id=&limit=` is what a form submits for fields left blank, and it is
 * a request a client sends without meaning anything by it. Both used to be read
 * as though somebody had said something: `project_id` became a predicate on a
 * project no row is filed under and answered with an empty list, and `limit`
 * became `Number("")`, which is zero, which is refused. Neither is what the
 * caller asked, and neither said so.
 */
describe("a parameter that arrived empty", () => {
  it("is the whole organization, when it is the project", async () => {
    const answered = await page(acme.secret, {
      ...DAY,
      project_id: "",
      limit: 200,
    });
    expect(answered.traces).toHaveLength(PAGING_TRACES.length);
  });

  it("is the default page size, when it is the limit", async () => {
    const answered = await page(acme.secret, { ...DAY, limit: "" });
    expect(answered.traces).toHaveLength(PAGING_TRACES.length);
  });

  it("is the same on the detail endpoint, which takes the project too", async () => {
    const response = await readTraceOverHttp(
      api.app,
      acme.secret,
      PAGING_TRACES[0].traceId,
      { ...DAY, project_id: "" },
    );
    expect(response.statusCode, response.body).toBe(200);
  });
});

/**
 * Two customers, and the enforcement the ingest door deferred to the reads.
 *
 * The strongest form of the question is a trace id that is *right* — Globex asks
 * for Acme's trace by its actual id, inside the window it actually happened in,
 * and is told there is no such trace. Nothing about the answer differs from the
 * one they would get for an id nobody ever minted, which is the point: the
 * organization leads the filing order, so the query never reached the rows and
 * there is nothing to leak the difference.
 */
describe("another organization asking for a trace that is not theirs", () => {
  it("finds nothing in a list of the same window", async () => {
    const answered = await page(globex.secret, { ...DAY, limit: 200 });
    expect(answered.traces).toEqual([]);
  });

  it("is told there is no such trace, even guessing the id exactly right", async () => {
    const response = await readTraceOverHttp(
      api.app,
      globex.secret,
      PAGING_TRACES[0].traceId,
      DAY,
    );
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe("no_such_trace");

    // Word for word what an id nobody ever minted is answered with.
    const invented = await readTraceOverHttp(
      api.app,
      globex.secret,
      "ffffffffffffffffffffffffffffffff",
      DAY,
    );
    expect(invented.statusCode).toBe(404);
    expect(invented.json()).toEqual(response.json());
  });

  it("still reads its own, so the refusal is about tenancy and not about the store", async () => {
    await ingest(
      api.app,
      globex.secret,
      syntheticExport({
        traceId: "bb000000000000000000000000000001",
        startedAt: new Date("2026-06-01T11:00:00Z"),
        humanSaid: "Globex speaking.",
      }),
    );

    const answered = await page(globex.secret, { ...DAY, limit: 200 });
    expect(answered.traces.map((trace) => trace.trace_id)).toEqual([
      "bb000000000000000000000000000001",
    ]);
    expect(answered.traces[0]?.preview).toBe("Globex speaking.");
  });
});

/**
 * A project labels rows; it never walls them.
 *
 * So the organization-wide read is the first-class one and returns everything
 * the customer has, and `project_id` narrows it. A key minted for one project
 * reads that project and cannot be argued into another — and is told so out
 * loud rather than having its filter silently dropped.
 */
describe("filtering a list to one project", () => {
  const OUTBOUND_WINDOW = {
    from: "2026-07-01T00:00:00Z",
    to: "2026-07-02T00:00:00Z",
  } as const;

  let outboundProjectId: string;
  let outboundSecret: string;

  beforeAll(async () => {
    const admin: AuthContext = {
      userId: acme.userId,
      organizationId: acme.organizationId,
      projectId: acme.projectId,
      role: "admin",
      via: "session",
    };
    const outbound = await createProject(admin, {
      name: "Outbound",
      slug: "outbound",
    });
    outboundProjectId = outbound.id;
    outboundSecret = await mintKey(
      api.app,
      acme.cookie,
      "Outbound's agent",
      outbound.id,
    );

    // One trace in Outbound, and one on the organization-scoped key, which files
    // under the sentinel a credential naming no project means.
    await ingest(
      api.app,
      outboundSecret,
      syntheticExport({
        traceId: "cc000000000000000000000000000001",
        startedAt: new Date("2026-07-01T09:00:00Z"),
        humanSaid: "Calling about the outbound campaign.",
      }),
    );
    await ingest(
      api.app,
      acme.secret,
      syntheticExport({
        traceId: "cc000000000000000000000000000002",
        startedAt: new Date("2026-07-01T10:00:00Z"),
        humanSaid: "Calling about nothing in particular.",
      }),
    );
  });

  it("reads across the whole organization when nobody narrowed it", async () => {
    const answered = await page(acme.secret, {
      ...OUTBOUND_WINDOW,
      limit: 200,
    });
    expect(answered.traces.map((trace) => trace.trace_id)).toEqual([
      "cc000000000000000000000000000002",
      "cc000000000000000000000000000001",
    ]);
  });

  it("narrows to the one project when asked", async () => {
    const answered = await page(acme.secret, {
      ...OUTBOUND_WINDOW,
      project_id: outboundProjectId,
      limit: 200,
    });
    expect(answered.traces.map((trace) => trace.trace_id)).toEqual([
      "cc000000000000000000000000000001",
    ]);
  });

  it("narrows the detail endpoint too, so a trace outside the filter is not there", async () => {
    const inside = await readTraceOverHttp(
      api.app,
      acme.secret,
      "cc000000000000000000000000000001",
      { ...OUTBOUND_WINDOW, project_id: outboundProjectId },
    );
    expect(inside.statusCode).toBe(200);

    const outside = await readTraceOverHttp(
      api.app,
      acme.secret,
      "cc000000000000000000000000000002",
      { ...OUTBOUND_WINDOW, project_id: outboundProjectId },
    );
    expect(outside.statusCode).toBe(404);
  });

  it("gives a project-scoped key its own project and nothing beside it", async () => {
    const answered = await page(outboundSecret, {
      ...OUTBOUND_WINDOW,
      limit: 200,
    });
    expect(answered.traces.map((trace) => trace.trace_id)).toEqual([
      "cc000000000000000000000000000001",
    ]);

    const elsewhere = await readTraceOverHttp(
      api.app,
      outboundSecret,
      "cc000000000000000000000000000002",
      OUTBOUND_WINDOW,
    );
    expect(elsewhere.statusCode).toBe(404);
  });

  it("tells a project-scoped key it cannot ask about another project", async () => {
    const response = await listTracesOverHttp(api.app, outboundSecret, {
      ...OUTBOUND_WINDOW,
      project_id: acme.projectId,
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("invalid_request");
    expect((response.json() as { message: string }).message).toContain(
      "scoped to project",
    );

    // And on the detail endpoint, which resolves the project the same way.
    const detail = await readTraceOverHttp(
      api.app,
      outboundSecret,
      "cc000000000000000000000000000002",
      { ...OUTBOUND_WINDOW, project_id: acme.projectId },
    );
    expect(detail.statusCode).toBe(400);
    expect((detail.json() as { message: string }).message).toContain(
      "scoped to project",
    );
  });

  /**
   * **A session's project is a default; a key's is a scope**, and until this was
   * written these reads could not tell the two apart.
   *
   * A browser session resolves to the first project its membership holds —
   * `auth/session.ts` fills one in and throws rather than leaving it out, and
   * every route depends on that. This surface then read it as though it were a
   * key's scope: naming any other project was refused with the key's own
   * sentence, so in an organization with two projects the Monitoring page
   * answered 400 on every project except the first. The project is in the
   * address on every page, and it is the *selector's* answer rather than the
   * credential's.
   *
   * The rule is `acting.ts`'s `browserProject` and is not restated here: every
   * member of an organization holds their organization role on every project in
   * it, so the only project a session can come to name is one its own membership
   * read already returned. The organization still comes off the credential, so
   * nothing about this widens tenancy — which is what the last two cases hold.
   */
  describe("a browser naming one of them", () => {
    it("reads the project the address named, not the one the session defaulted to", async () => {
      const response = await listTracesAsSignedIn(api.app, acme.cookie, {
        ...OUTBOUND_WINDOW,
        project_id: outboundProjectId,
        limit: 200,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(
        (response.json() as ListedPage).traces.map((trace) => trace.trace_id),
      ).toEqual(["cc000000000000000000000000000001"]);
    });

    /** Only that project's, so naming one narrows rather than merely permitting. */
    it("reads only that project's rows, on the detail endpoint too", async () => {
      const inside = await readTraceAsSignedIn(
        api.app,
        acme.cookie,
        "cc000000000000000000000000000001",
        { ...OUTBOUND_WINDOW, project_id: outboundProjectId },
      );
      expect(inside.statusCode, inside.body).toBe(200);

      // Filed by the organization-wide key, so it is under no project at all —
      // and a read narrowed to Outbound does not reach it.
      const outside = await readTraceAsSignedIn(
        api.app,
        acme.cookie,
        "cc000000000000000000000000000002",
        { ...OUTBOUND_WINDOW, project_id: outboundProjectId },
      );
      expect(outside.statusCode).toBe(404);
    });

    /**
     * And naming none is untouched: the session still reads the project it
     * resolved to, which in this window holds nothing.
     */
    it("keeps the project it resolved to when the request names none", async () => {
      const response = await listTracesAsSignedIn(api.app, acme.cookie, {
        ...OUTBOUND_WINDOW,
        limit: 200,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as ListedPage).traces).toEqual([]);
    });

    /**
     * **Tenancy does not widen.** The project comes from the address and the
     * organization comes from the credential, so a session naming a project of
     * another customer is refused — by the membership read, before any store is
     * asked anything.
     */
    it("is refused a project outside its own organization", async () => {
      for (const named of [globex.projectId, "prj_00000000000000000000000000"]) {
        const response = await listTracesAsSignedIn(api.app, acme.cookie, {
          ...OUTBOUND_WINDOW,
          project_id: named,
          limit: 200,
        });
        expect(response.statusCode, named).toBe(400);

        const body = response.json() as { error: string; message: string };
        expect(body.error, named).toBe("invalid_request");
        expect(body.message, named).toContain(named);

        const detail = await readTraceAsSignedIn(
          api.app,
          acme.cookie,
          "cc000000000000000000000000000001",
          { ...OUTBOUND_WINDOW, project_id: named },
        );
        expect(detail.statusCode, named).toBe(400);
      }
    });

    /**
     * The other direction of the same claim, and the one that would matter
     * most: Globex's own browser, naming Acme's project, reaches nothing of
     * Acme's — it is refused, rather than answered with an empty list that
     * could later become a full one.
     */
    it("does not let another organization's browser name this one's project", async () => {
      const response = await listTracesAsSignedIn(api.app, globex.cookie, {
        ...OUTBOUND_WINDOW,
        project_id: outboundProjectId,
        limit: 200,
      });
      expect(response.statusCode).toBe(400);
      expect((response.json() as { message: string }).message).toContain(
        outboundProjectId,
      );
    });
  });
});

/**
 * The other credential these endpoints take.
 *
 * The README says both of them read traces, and the plumbing is shared — the
 * same hook resolves a key or a cookie into the same context before either
 * route runs — but "shared" is a claim about code that only a request can
 * settle. A signed-in browser is how egma's own dashboard will read this, so it
 * is the path a regression would be found in last.
 *
 * A session acts in the project signup made, which is why this ingests through
 * a key scoped to that project rather than reusing the organization-wide one:
 * the question is whether the cookie reads, not which project it reads.
 */
describe("a browser session rather than a key", () => {
  const SESSION_WINDOW = {
    from: "2026-09-01T00:00:00Z",
    to: "2026-09-02T00:00:00Z",
  } as const;
  const SESSION_TRACE = "dd000000000000000000000000000001";

  beforeAll(async () => {
    const homeSecret = await mintKey(
      api.app,
      acme.cookie,
      "The project signup made",
      acme.projectId,
    );
    await ingest(
      api.app,
      homeSecret,
      syntheticExport({
        traceId: SESSION_TRACE,
        startedAt: new Date("2026-09-01T09:00:00Z"),
        humanSaid: "Reading this from a browser.",
      }),
    );
  });

  it("reads the same list, with no key anywhere in the request", async () => {
    const response = await listTracesAsSignedIn(api.app, acme.cookie, {
      ...SESSION_WINDOW,
      limit: 200,
    });
    expect(response.statusCode, response.body).toBe(200);

    const answered = response.json() as ListedPage;
    expect(answered.traces.map((trace) => trace.trace_id)).toEqual([
      SESSION_TRACE,
    ]);
    expect(answered.traces[0]?.preview).toBe("Reading this from a browser.");
  });

  it("is refused the same way when the window is missing", async () => {
    const response = await listTracesAsSignedIn(api.app, acme.cookie, {});
    expect(response.statusCode).toBe(400);
  });

  /**
   * And what it cannot see, which is the asymmetry the README and the empty
   * list both warn about.
   *
   * A key minted for a whole organization names no project, so what it exports
   * files under the sentinel the schema keeps for exactly that. A session is
   * always acting inside a real project, so it reads that project and never the
   * sentinel — the telemetry arrived, the key was valid, and the dashboard is
   * empty. That is documented in three places and asserted here, so a change
   * that quietly widened either side would be caught rather than read about.
   */
  it("cannot see what an organization-wide key filed, because that names no project", async () => {
    const OUTSIDE = {
      from: "2026-09-05T00:00:00Z",
      to: "2026-09-06T00:00:00Z",
    } as const;
    const FILED_WITHOUT_A_PROJECT = "dd000000000000000000000000000002";

    await ingest(
      api.app,
      acme.secret,
      syntheticExport({
        traceId: FILED_WITHOUT_A_PROJECT,
        startedAt: new Date("2026-09-05T09:00:00Z"),
        humanSaid: "Exported with a key for the whole organization.",
      }),
    );

    const asSignedIn = await listTracesAsSignedIn(api.app, acme.cookie, {
      ...OUTSIDE,
      limit: 200,
    });
    expect(asSignedIn.statusCode, asSignedIn.body).toBe(200);
    expect((asSignedIn.json() as ListedPage).traces).toEqual([]);

    // It is stored, and the credential that filed it reads it back. The
    // dashboard's blindness is about the project, not about the write.
    const asTheKey = await listTracesOverHttp(api.app, acme.secret, {
      ...OUTSIDE,
      limit: 200,
    });
    expect(asTheKey.statusCode, asTheKey.body).toBe(200);
    expect(
      (asTheKey.json() as ListedPage).traces.map((trace) => trace.trace_id),
    ).toEqual([FILED_WITHOUT_A_PROJECT]);
  });
});

/**
 * The one filter this list has, and the only one it is getting: which kind of
 * traffic.
 *
 * **Additive, and that is the whole claim.** A caller naming nothing reads both
 * kinds and gets byte for byte the answer they got before the parameter
 * existed — asserted below against the response body itself rather than against
 * a shape. Present, it narrows; misspelled, it is refused naming both accepted
 * words rather than quietly reading everything, because a page of simulations
 * under a heading that promised production is exactly the failure a silent
 * filter produces.
 *
 * The two kinds arrive at the two doors that actually make them: production
 * through a customer's key, simulations through the service token with each
 * resource naming a real simulation row this deployment conducted. Nothing is
 * written into the store by hand, so what is filtered here is what ingest files.
 *
 * They are **interleaved in time on purpose**. Newest-first over a mixed window
 * puts a simulation between every pair of production exchanges, so a walk of
 * `source=production` at page size one crosses a simulation at every boundary —
 * which is what separates a predicate inside the scan from a filter over a page
 * that has already been counted.
 */
describe("narrowing a list to one kind of traffic", () => {
  const MIXED = {
    from: "2026-10-01T00:00:00Z",
    to: "2026-10-02T00:00:00Z",
  } as const;

  /** What this test deployment's simulator would be started holding. */
  const SERVICE_TOKEN = "egma_st_held-by-this-test-suite-alone";

  const PRODUCTION_TRACES = [
    { traceId: "ee000000000000000000000000000001", at: "2026-10-01T09:00:00Z" },
    { traceId: "ee000000000000000000000000000002", at: "2026-10-01T09:10:00Z" },
    { traceId: "ee000000000000000000000000000003", at: "2026-10-01T09:20:00Z" },
  ] as const;

  /** Between each pair of the above, so neither kind is a contiguous block. */
  const SIMULATED_AT = [
    "2026-10-01T09:05:00Z",
    "2026-10-01T09:15:00Z",
    "2026-10-01T09:25:00Z",
  ] as const;

  const GLOBEX_TRACE = "ef000000000000000000000000000001";

  /** Filed under the ids the simulations' own ids spell, newest last. */
  const simulationTraces: string[] = [];

  const newestFirst = (ids: readonly string[]): string[] => [...ids].reverse();

  beforeAll(async () => {
    for (const trace of PRODUCTION_TRACES) {
      await ingest(
        api.app,
        acme.secret,
        syntheticExport({
          traceId: trace.traceId,
          startedAt: new Date(trace.at),
          humanSaid: `A real caller at ${trace.at}.`,
        }),
      );
    }

    // Three simulations of one run, which is what a run of three tests is. The
    // rows are real: the door reads the organization, the project, the run and
    // the pins off them, and that is what stamps the spans `simulation`.
    const auth: AuthContext = contextFor(acme, "member");
    const agent = await createAgent(auth, {
      name: "Front desk",
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_mixed" },
        credentials: { apiKey: "retell-secret-mixed" },
      },
    });
    const personaId = (
      await createPersona(auth, {
        name: "Patient Pat",
        personality: NEUTRAL_TRAITS.personality,
      })
    ).id;

    const testVersionIds: string[] = [];
    for (const which of ["one", "two", "three"]) {
      testVersionIds.push(
        (
          await createTest(auth, {
            name: `Reschedules ${which}`,
            scenario: "Their cleaning has to move to any afternoon next week.",
            expectedBehaviors: ["confirms the new time back before finishing"],
            personaIds: [personaId],
          })
        ).versionId,
      );
    }

    const started = await startRun(auth, {
      connectionId: agent.connection?.id ?? "",
      testVersionIds,
    });

    for (const [index, simulation] of started.simulations.entries()) {
      const traceId = traceIdOfSimulation(simulation.id);
      const at = SIMULATED_AT[index];
      if (traceId === undefined || at === undefined) {
        throw new Error(`simulation ${index} has no trace to file under`);
      }

      await ingest(
        api.app,
        SERVICE_TOKEN,
        syntheticExport({
          traceId,
          startedAt: new Date(at),
          humanSaid: `A persona at ${at}.`,
          simulationId: simulation.id,
        }),
      );
      simulationTraces.push(traceId);
    }

    expect(simulationTraces).toHaveLength(SIMULATED_AT.length);
  });

  it("reads both kinds when nobody narrowed it, newest first and interleaved", async () => {
    const answered = await page(acme.secret, { ...MIXED, limit: 200 });

    expect(answered.traces.map((trace) => trace.trace_id)).toEqual([
      simulationTraces[2],
      PRODUCTION_TRACES[2].traceId,
      simulationTraces[1],
      PRODUCTION_TRACES[1].traceId,
      simulationTraces[0],
      PRODUCTION_TRACES[0].traceId,
    ]);
  });

  it("answers only production traffic when that is what was asked for", async () => {
    const answered = await page(acme.secret, {
      ...MIXED,
      source: "production",
      limit: 200,
    });

    expect(answered.traces.map((trace) => trace.trace_id)).toEqual(
      newestFirst(PRODUCTION_TRACES.map((trace) => trace.traceId)),
    );
    expect([...new Set(answered.traces.map((trace) => trace.source))]).toEqual([
      "production",
    ]);
  });

  it("answers only simulations when that is what was asked for", async () => {
    const answered = await page(acme.secret, {
      ...MIXED,
      source: "simulation",
      limit: 200,
    });

    expect(answered.traces.map((trace) => trace.trace_id)).toEqual(
      newestFirst(simulationTraces),
    );
    expect([...new Set(answered.traces.map((trace) => trace.source))]).toEqual([
      "simulation",
    ]);
  });

  /**
   * **The compatibility claim, asserted against the bytes.**
   *
   * An integration written before this parameter existed sends nothing, and
   * what comes back has to be the response it has always had — not a response
   * of the same shape, the same response. `?source=` is the third parameter to
   * read as absence, beside `?project_id=` and `?limit=`: it is what a form
   * submits for a field left blank.
   */
  it("is the same answer, byte for byte, when the parameter is absent or empty", async () => {
    const absent = await listTracesOverHttp(api.app, acme.secret, {
      ...MIXED,
      limit: 200,
    });
    const blank = await listTracesOverHttp(api.app, acme.secret, {
      ...MIXED,
      source: "",
      limit: 200,
    });

    expect(absent.statusCode, absent.body).toBe(200);
    expect(blank.statusCode, blank.body).toBe(200);
    expect(blank.body).toBe(absent.body);
  });

  it("refuses a word that is neither, and names the two that are", async () => {
    for (const asked of ["prod", "PRODUCTION", "both", "live", "0"]) {
      const response = await listTracesOverHttp(api.app, acme.secret, {
        ...MIXED,
        source: asked,
      });
      expect(response.statusCode, asked).toBe(400);

      const body = response.json() as { error: string; message: string };
      expect(body.error, asked).toBe("invalid_request");
      expect(body.message, asked).toContain("simulation");
      expect(body.message, asked).toContain("production");
      expect(body.message, asked).toContain(asked);
    }
  });

  /** The window is the one thing no filter buys anybody out of. */
  it("still requires a window, narrowed or not", async () => {
    const response = await listTracesOverHttp(api.app, acme.secret, {
      source: "production",
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain("no from");
  });

  /**
   * A token minted under a filter pages **within** it.
   *
   * At page size one every boundary of this walk falls between a production
   * exchange and a simulation, so a token that was a position in the unfiltered
   * ordering would resume at the simulation and either repeat or skip. It is a
   * position in the narrowed ordering because the predicate is inside the scan
   * the grouping and the `having` are written over.
   */
  it("walks a filtered list with its own token, skipping none and repeating none", async () => {
    for (const size of [1, 2]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;

      do {
        const answered = await page(acme.secret, {
          ...MIXED,
          source: "production",
          limit: size,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(answered.traces.length).toBeLessThanOrEqual(size);
        for (const trace of answered.traces) {
          expect(trace.source, `page size ${size} crossed into a simulation`).toBe(
            "production",
          );
        }
        seen.push(...answered.traces.map((trace) => trace.trace_id));
        cursor = answered.next_cursor ?? undefined;
        pages += 1;
        expect(pages, "the walk did not terminate").toBeLessThan(20);
      } while (cursor !== undefined);

      expect(new Set(seen).size, `page size ${size} repeated a trace`).toBe(
        seen.length,
      );
      expect(seen, `page size ${size} skipped a trace`).toEqual(
        newestFirst(PRODUCTION_TRACES.map((trace) => trace.traceId)),
      );
    }
  });

  /**
   * And tenancy holds under it, which is the property a filter is most likely
   * to be written around: two organizations, one window, one word.
   */
  it("shows each organization only its own, whichever kind is asked for", async () => {
    await ingest(
      api.app,
      globex.secret,
      syntheticExport({
        traceId: GLOBEX_TRACE,
        startedAt: new Date("2026-10-01T09:30:00Z"),
        humanSaid: "Globex, in the same window.",
      }),
    );

    const theirs = await page(globex.secret, {
      ...MIXED,
      source: "production",
      limit: 200,
    });
    expect(theirs.traces.map((trace) => trace.trace_id)).toEqual([GLOBEX_TRACE]);

    const ours = await page(acme.secret, {
      ...MIXED,
      source: "production",
      limit: 200,
    });
    expect(ours.traces.map((trace) => trace.trace_id)).toEqual(
      newestFirst(PRODUCTION_TRACES.map((trace) => trace.traceId)),
    );

    // Acme's three simulations are in the same window and the same store, and
    // asking for simulations from the other organization reaches none of them.
    const none = await page(globex.secret, {
      ...MIXED,
      source: "simulation",
      limit: 200,
    });
    expect(none.traces).toEqual([]);
  });
});

describe("a read with no usable credential", () => {
  it("is refused before anything is looked up", async () => {
    for (const url of [
      `/v1/traces?from=${DAY.from}&to=${DAY.to}`,
      `/v1/traces/${PAGING_TRACES[0].traceId}?from=${DAY.from}&to=${DAY.to}`,
    ]) {
      const anonymous = await api.app.inject({ method: "GET", url });
      expect(anonymous.statusCode).toBe(401);

      const invented = await api.app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer egma_sk_${"a".repeat(43)}` },
      });
      expect(invented.statusCode).toBe(401);
    }
  });
});

/**
 * **What egma judged a production conversation, found where egma filed it.**
 *
 * A simulation's verdicts are filed under its simulation id and its spans under
 * the same 128 bits written as hex, so the read derives one from the other. The
 * derivation is a pure bit conversion and therefore succeeds for *every* trace
 * id — including a customer's own production trace, which converts to a
 * perfectly well-formed simulation id nothing ever minted.
 *
 * That is the bug this describes. The read looked under the phantom id, found
 * nothing, and answered "nothing was judged" while the real verdict rows sat in
 * the store under the trace id it had been handed. A live call caught it: a
 * passed latency verdict, written by the grader, invisible on the transcript.
 *
 * A judgment egma wrote and then could not find is the exact false trust this
 * product exists to kill, so it is pinned here, at the read, through the routes.
 */
describe("a production conversation egma judged", () => {
  const JUDGED_TRACE = "cc000000000000000000000000000001";
  const JUDGED_AT = "2026-06-01T11:00:00Z";
  const GRADER = newId("grd");
  const GRADER_VERSION = newId("grv");

  beforeAll(async () => {
    await ingest(
      api.app,
      acme.secret,
      syntheticExport({
        traceId: JUDGED_TRACE,
        startedAt: new Date(JUDGED_AT),
        humanSaid: "How long will the wait be?",
      }),
    );

    // Written the way the grader writes one: under the **trace id**, because a
    // production conversation is not a simulation and has no simulation id.
    await appendVerdicts(contextFor(acme, "admin"), [
      {
        traceId: JUDGED_TRACE,
        graderId: GRADER,
        graderVersionId: GRADER_VERSION,
        assertion: "turn_response_latency",
        source: "production",
        verdict: "passed",
        score: 1,
        rationale: "every turn was answered inside the bound.",
        citedSpanIds: [],
        runId: "",
        agentId: "",
        agentVersionId: "",
        judgedAtMicroseconds: BigInt(Date.parse(JUDGED_AT)) * 1000n,
      },
    ]);
  });

  it("shows the judgment on its transcript, rather than nothing at all", async () => {
    const read = await readTraceOverHttp(
      api.app,
      acme.secret,
      JUDGED_TRACE,
      DAY,
    );
    expect(read.statusCode, read.body).toBe(200);

    const detail = read.json() as {
      trace: { source: string };
      simulation_id: string | null;
      verdicts: readonly { assertion: string; verdict: string }[];
      outcome: { verdict: string; counts: Record<string, number> } | null;
    };

    // A production conversation, and it names no simulation — which is exactly
    // the case the lookup used to get wrong.
    expect(detail.trace.source).toBe("production");
    expect(detail.simulation_id).toBeNull();

    expect(detail.verdicts).toHaveLength(1);
    expect(detail.verdicts[0]?.assertion).toBe("turn_response_latency");
    expect(detail.verdicts[0]?.verdict).toBe("passed");
  });

  it("folds a real outcome, and never a skipped nothing", async () => {
    const read = await readTraceOverHttp(
      api.app,
      acme.secret,
      JUDGED_TRACE,
      DAY,
    );
    expect(read.statusCode, read.body).toBe(200);

    const outcome = (
      read.json() as {
        outcome: { verdict: string; counts: Record<string, number> } | null;
      }
    ).outcome;

    // Present, decided, and counting the row — the three things the phantom
    // lookup destroyed, in the order somebody reading the page notices them.
    expect(outcome).not.toBeNull();
    expect(outcome?.verdict).toBe("passed");
    expect(outcome?.counts.passed).toBe(1);
  });

});
