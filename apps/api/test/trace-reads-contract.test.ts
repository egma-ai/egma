import { createProject, type AuthContext } from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  ingest,
  listTracesAsSignedIn,
  listTracesOverHttp,
  mintKey,
  readTraceOverHttp,
  signUp,
  syntheticExport,
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
    expect((response.json() as { message: string }).message).toContain(
      "scoped to project",
    );
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
