import { describe, expect, it } from "vitest";

import { envSummary, readEnv } from "../lib/tests.ts";

/**
 * The env editor reads a value the way the platform would before sending it,
 * and says no in the platform's own sentence, so the person needs no round
 * trip to learn why.
 */
describe("the env editor's reading of pipecat_body_params", () => {
  it("accepts it beside the other platforms' keys", () => {
    const held = readEnv(
      JSON.stringify({
        retell_dynamic_variables: { caller_name: "Margaret" },
        job_dispatch_metadata: { tenant: "acme" },
        pipecat_body_params: { tenant: "lakeside", caller: { plan: "gold" } },
      }),
    );
    expect(held).toEqual({
      ok: true,
      value: {
        retell_dynamic_variables: { caller_name: "Margaret" },
        job_dispatch_metadata: { tenant: "acme" },
        pipecat_body_params: { tenant: "lakeside", caller: { plan: "gold" } },
      },
    });
    expect(
      envSummary({ pipecat_body_params: { tenant: "lakeside" } }),
    ).toBe("View env variables");
  });

  it("drops an empty object, as the platform stores it", () => {
    expect(readEnv('{ "pipecat_body_params": {} }')).toEqual({
      ok: true,
      value: null,
    });
  });

  it("refuses egma's own key and a value that is not an object, in the platform's words", () => {
    expect(
      readEnv('{ "pipecat_body_params": { "egma": { "simulation_id": "x" } } }'),
    ).toEqual({
      ok: false,
      why: 'env.pipecat_body_params holds the key "egma", which Egma keeps for its own simulation marker in the start request. Name the key something else.',
    });
    expect(readEnv('{ "pipecat_body_params": ["acme"] }')).toEqual({
      ok: false,
      why: 'env.pipecat_body_params is a JSON object merged into the body of the start request, which your Pipecat bot reads at runner_args.body, and looks like {"tenant": "acme"}',
    });
  });

  it("names all three keys when it refuses an env", () => {
    expect(readEnv("[]")).toEqual({
      ok: false,
      why: "env is an object with at most retell_dynamic_variables, job_dispatch_metadata and pipecat_body_params in it",
    });
    expect(readEnv('{ "body": {} }')).toEqual({
      ok: false,
      why: 'env has no "body" in it. An env carries retell_dynamic_variables, job_dispatch_metadata and pipecat_body_params, and nothing else.',
    });
  });
});
