import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";
import { capturedRequests, type CapturedRequest } from "./support/fixture.ts";

/**
 * A real conversation ending, at the door it really ends at.
 *
 * The other half of what the ingest path does with an export: the spans go to
 * the trace store, and the conversations they belong to become grading work.
 * This file asserts the second half against the same evidence the first is
 * asserted against — the captured LiveKit trace, fourteen flushes, byte for
 * byte as an exporter sent them.
 *
 * **Why the capture rather than a payload invented here.** Whether a
 * conversation has ended is read off telemetry, and the reading is the thing
 * that can be wrong: the root span arrives alone in the fourteenth flush, thirty
 * seconds after the caller said goodbye, and no assertion written against a
 * hand-made body would have noticed if Egma had decided a trace was over on the
 * first one.
 *
 * It is a file of its own rather than more assertions beside the ingest tests,
 * because it needs a credential those do not: this capture is judged only when
 * it arrives on a key that names a project, and the ingest file's key names the
 * whole customer on purpose.
 */

let api: TestApi;
let requests: CapturedRequest[];

type Customer = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly cookie: string;
};

type JobRow = {
  readonly source: string;
  readonly trace_id: string | null;
  readonly simulation_id: string | null;
  readonly status: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly first_span_at: Date;
  readonly last_span_at: Date;
  readonly last_seen_at: Date;
  readonly root_closed_at: Date | null;
};

async function signUp(email: string, organizationName: string): Promise<Customer> {
  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: { email, password: "a-long-enough-password", organizationName },
  });
  expect(created.statusCode).toBe(201);

  const landed = created.json() as {
    organization: { id: string };
    project: { id: string };
  };
  return {
    organizationId: landed.organization.id,
    projectId: landed.project.id,
    cookie: cookiesFrom(created.headers["set-cookie"]),
  };
}

/** A key for one project, or — with no project named — for the whole customer. */
async function mintKey(
  customer: Customer,
  name: string,
  projectId?: string,
): Promise<string> {
  const minted = await api.app.inject({
    method: "POST",
    url: "/api/keys",
    headers: { cookie: customer.cookie },
    payload: { name, ...(projectId === undefined ? {} : { project_id: projectId }) },
  });
  expect(minted.statusCode).toBe(201);
  return (minted.json() as { secret: string }).secret;
}

/** Replay the whole capture, in order, as the exporter's fourteen flushes. */
async function replay(secret: string): Promise<void> {
  for (const request of requests) {
    const response = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": request.contentType,
        authorization: `Bearer ${secret}`,
      },
      payload: request.body,
    });
    expect(response.statusCode, request.file).toBe(200);
  }
}

async function jobsFor(organizationId: string): Promise<JobRow[]> {
  const { rows } = await api.database.sql<JobRow>(
    "select * from grading_job where organization_id = $1",
    [organizationId],
  );
  return rows;
}

let acme: Customer;
let globex: Customer;

beforeAll(async () => {
  requests = await capturedRequests();
  api = await createApi("otlp_grading", { traceStore: true });

  acme = await signUp("ada@acme.example", "Acme");
  await replay(await mintKey(acme, "Acme's agent", acme.projectId));

  globex = await signUp("gene@globex.example", "Globex");
  await replay(await mintKey(globex, "Globex's agent"));
});

afterAll(async () => {
  await api?.close();
});

describe("a captured conversation arriving on a project's key", () => {
  it("becomes exactly one piece of grading work, however many flushes carried it", async () => {
    const jobs = await jobsFor(acme.organizationId);

    // Fourteen exports, one conversation, one job. The unique on the trace is
    // what makes the second one unrepresentable rather than merely unwritten,
    // and it is the reason no conversation is ever judged twice.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: "production",
      status: "pending",
      project_id: acme.projectId,
    });
  });

  it("adopts the trace id off the wire and names no simulation", async () => {
    const [job] = await jobsFor(acme.organizationId);

    expect(job?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(job?.simulation_id).toBeNull();
  });

  it("is complete, because the root span closed it in the fourteenth flush", async () => {
    const [job] = await jobsFor(acme.organizationId);

    // An exporter sends a span when the span *ends*, so `agent_session` reaching
    // the door is the conversation having ended. This capture's root arrives
    // alone, last, which is exactly the case a door that guessed from the first
    // flush would get wrong.
    expect(job?.root_closed_at).toBeInstanceOf(Date);
  });

  it("records the window the whole conversation happened inside", async () => {
    const [job] = await jobsFor(acme.organizationId);

    // The capture's own timestamps. The window is what a reader prunes the
    // trace store with, so a job that recorded one flush's extent would read
    // back a fragment of the transcript — and the flush holding the earliest
    // span is not the flush holding the latest.
    //
    // Both are the instants spans *began* at, because the store files a span
    // under the minute it started in and the window is compared against exactly
    // that. Milliseconds, because that is what a timestamp column reads back:
    // the microseconds under them are dropped rather than rounded, and the read
    // widens the window at both ends before it uses it.
    expect(job?.first_span_at.toISOString()).toBe("2026-08-02T18:04:40.281Z");
    expect(job?.last_span_at.toISOString()).toBe("2026-08-02T18:05:53.771Z");
    // When Egma last *heard* about the trace, which is a different fact: a trace
    // backfilled an hour late would look silent the moment it landed if the two
    // were confused.
    expect(job?.last_seen_at.getTime()).toBeGreaterThan(
      job?.last_span_at.getTime() ?? 0,
    );
  });
});

describe("the same conversation arriving on a key for the whole customer", () => {
  it("is stored and not queued, because a trace in no project has no graders", async () => {
    // Its spans file under the store's own sentinel rather than under a project
    // row, so there is no tenancy for a job to carry — and graders belong to
    // projects, so there would be nothing to judge it by. The spans are kept:
    // what is refused is the pretence that somebody chose to monitor them.
    expect(await jobsFor(globex.organizationId)).toEqual([]);
  });
});
