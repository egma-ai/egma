import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
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
 * hand-made body would have noticed if egma had decided a trace was over on the
 * first one.
 *
 * It is a file of its own rather than more assertions beside the ingest tests,
 * because it needs a credential those do not: this capture is judged only when
 * it arrives on a key that names a project, and the ingest file's key names the
 * whole customer on purpose.
 */

const storage: ObjectStorage = await startObjectStorage("otlp-grading");

if (!storage.available) {
  process.stderr.write(`\nskipping the OTLP grading suite — ${storage.why}\n\n`);
}

let api: TestApi;
let requests: CapturedRequest[];

type Customer = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly cookie: string;
};

type JobRow = {
  readonly source: string;
  readonly trace_id: string;
  readonly simulation_id: string | null;
  readonly status: string;
  readonly organization_id: string;
  readonly project_id: string;
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
    url: "/v1/keys",
    headers: { cookie: customer.cookie },
    payload: { name, ...(projectId === undefined ? {} : { projectId: projectId }) },
  });
  expect(minted.statusCode).toBe(201);
  return (minted.json() as { secret: string }).secret;
}

/**
 * Replay the whole capture, in order, as the exporter's fourteen flushes, and
 * then drain.
 *
 * The evidence-ready handoff is an effect of the evidence becoming
 * query-visible, so it happens where the segment is drained rather than where
 * the request is answered. A suite about that handoff therefore has to carry
 * the evidence all the way, not just to the acceptance boundary.
 */
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
  await api.drainEvidence();
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
let globexOrganizationKey: string;

beforeAll(async () => {
  if (!storage.available) return;
  requests = await capturedRequests();
  api = await createApi("otlp_grading", {
    traceStore: true,
    ingestStore: storage.ingestStore,
  });

  acme = await signUp("ada@acme.example", "Acme");
  await replay(await mintKey(acme, "Acme's agent", acme.projectId));

  globex = await signUp("gene@globex.example", "Globex");
  globexOrganizationKey = await mintKey(globex, "Globex's organization");
});

afterAll(async () => {
  await api?.close();
  if (storage.available) storage.stop();
});

describe.skipIf(!storage.available)("a captured conversation arriving on a project's key", () => {
  it("freezes one empty plan because no production grader is selected", async () => {
    const traceStore = api.traceStore;
    if (traceStore === undefined) throw new Error("this API has no trace store");
    const plans = await traceStore.rows<{
      trace_id: string;
      entries: readonly unknown[];
    }>(
      "select trace_id, entries from production_grading_plans " +
        `where organization_id = '${acme.organizationId}' and project_id = '${acme.projectId}'`,
    );

    // Fourteen exporter flushes describe one conversation. LiveKit's session
    // span arrives in the final flush and creates one permanent selection
    // receipt. Expected behaviors grades simulations only, so the frozen
    // production selection is empty and there is no temporary queue row.
    expect(plans).toHaveLength(1);
    expect(plans[0]?.trace_id).toMatch(/^[0-9a-f]{32}$/u);
    expect(plans[0]?.entries).toEqual([]);
    expect(await jobsFor(acme.organizationId)).toEqual([]);
  });

  /**
   * **A span with no parent is not an ending**, and this is the case that used
   * to say otherwise.
   *
   * Completion was inferred from any parentless span, so a scope Egma does not
   * recognise could complete a conversation by flushing a span whose parent had
   * not arrived — and a mangled parent id, which normalises to no parent at all,
   * did the same. Neither says anything about whether the caller hung up. A
   * platform this release has no explicit end fact for gets no completion here.
   */
  it("is not completed by a parentless span from a platform Egma does not recognise", async () => {
    const traceId = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
    const secret = await mintKey(acme, "another framework", acme.projectId);
    const posted = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      payload: JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                scope: { name: "another-agent-platform" },
                spans: [
                  {
                    traceId,
                    spanId: "5a5a5a5a5a5a5a5a",
                    // No parent at all, which is what a lost flush leaves.
                    parentSpanId: "",
                    name: "agent_session",
                    startTimeUnixNano: "1785693880281989804",
                    endTimeUnixNano: "1785693881281989804",
                    attributes: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    expect(posted.statusCode, posted.body).toBe(200);
    await api.drainEvidence();

    const traceStore = api.traceStore;
    if (traceStore === undefined) throw new Error("this API has no trace store");
    const [receipt] = await traceStore.rows<{ n: string }>(
      "select count() as n from production_grading_plans " +
        `where organization_id = '${acme.organizationId}' and trace_id = '${traceId}'`,
    );
    expect(Number(receipt?.n ?? -1)).toBe(0);
    expect(await jobsFor(acme.organizationId)).toEqual([]);
  });
});

describe.skipIf(!storage.available)("telemetry sent with a key for the whole customer", () => {
  it("is refused before its body is decoded or any trace is stored", async () => {
    const response = await api.app.inject({
      method: "POST",
      url: OTLP_TRACES_PATH,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${globexOrganizationKey}`,
      },
      // Deliberately invalid OTLP. Project scope must be checked before a body
      // is decoded, because there is nowhere correct to file this telemetry.
      payload: "not valid OTLP JSON",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      message: expect.stringContaining("project API key"),
    });
    expect(await jobsFor(globex.organizationId)).toEqual([]);

    const traceStore = api.traceStore;
    if (traceStore === undefined) throw new Error("this API has no trace store");
    const [stored] = await traceStore.rows<{ n: string }>(
      `select count() as n from spans where organization_id = '${globex.organizationId}'`,
    );
    expect(Number(stored?.n ?? -1)).toBe(0);
  });
});
