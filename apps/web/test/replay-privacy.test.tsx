// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionFields } from "../app/projects/[projectId]/agents/[agentId]/connections/fields.tsx";
import type { ConnectionOption } from "../lib/connection-options.ts";
import {
  REPLAY_PRIVATE_ATTRIBUTE,
  showsProductionTraces,
} from "../lib/replay-privacy.ts";
import { ProductPage } from "../ui/shell.tsx";

const routed = vi.hoisted(() => ({ pathname: "/projects/prj_2/runs" }));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: "prj_2" }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

/** The one connection shape whose credential is typed into a box, not a field. */
const CUSTOMER_TOKEN_ENDPOINT: ConnectionOption = {
  agentPlatform: "livekit",
  agentPlatformLabel: "LiveKit",
  connectionType: "livekit_room",
  accessVariant: "livekit_room.customer_token_endpoint",
  accessVariantLabel: "Your token endpoint",
  modality: "voice",
  productLabel: "LiveKit token endpoint",
  topology: "egma-dials-in",
  simulatorAdapter: true,
  fields: [
    {
      key: "metadata",
      label: "Agent metadata",
      kind: "json",
      required: false,
      help: "A JSON object handed to your agent.",
      afterCredentials: true,
    },
  ],
  credentialRule: "required",
  credentialHelp: "Auth headers are sent when Egma asks your endpoint.",
  credentialFields: [
    {
      field: "headers",
      label: "Auth headers",
      kind: "json",
      required: true,
      help: 'A JSON object of header name to header value.',
    },
  ],
};

/**
 * **What session replay may and may not read**, which is a policy rather than a
 * setting: `instrumentation-client.ts` masks one selector, and these are the
 * places that wear it.
 *
 * The reason to hold it down here rather than trust the source: a mark is
 * invisible on the page. Nothing about a Traces screen or an unmasked list
 * looks different in a browser, so a mark that stopped being applied would go
 * on looking right until somebody opened a recording of a customer's calls.
 */
describe("what a session replay is allowed to read", () => {
  it("counts the Traces screens as production traces, and nothing else", () => {
    expect(showsProductionTraces("/projects/prj_2/monitoring/transcripts")).toBe(
      true,
    );
    expect(
      showsProductionTraces("/projects/prj_2/monitoring/transcripts/trc_1"),
    ).toBe(true);

    // A simulation is egma's own persona talking to the agent under test, and
    // a test, a run and an agent are the customer's own words about their work.
    expect(showsProductionTraces("/projects/prj_2/runs/run_1/simulations")).toBe(
      false,
    );
    expect(showsProductionTraces("/projects/prj_2/agents")).toBe(false);
    expect(showsProductionTraces("/projects/prj_2/settings/keys")).toBe(false);
    expect(showsProductionTraces("/sign-in")).toBe(false);
  });

  it("marks the whole of a Traces page, and leaves every other page open", () => {
    routed.pathname = "/projects/prj_2/monitoring/transcripts";
    const traces = render(
      <ProductPage>
        <div>Trace table</div>
      </ProductPage>,
    );
    expect(
      traces.container.querySelector("main")?.hasAttribute(REPLAY_PRIVATE_ATTRIBUTE),
    ).toBe(true);
    cleanup();

    routed.pathname = "/projects/prj_2/runs";
    const runs = render(
      <ProductPage>
        <div>Run table</div>
      </ProductPage>,
    );
    expect(
      runs.container.querySelector("main")?.hasAttribute(REPLAY_PRIVATE_ATTRIBUTE),
    ).toBe(false);
  });

  it("marks the credential box that is a box rather than a password field", () => {
    render(
      <ConnectionFields
        option={CUSTOMER_TOKEN_ENDPOINT}
        draft={{ config: {}, credentials: {} }}
        onChange={() => undefined}
        credentialsEditable
      />,
    );

    // The secret one: a password field would have hidden it, and this one does
    // not, so the mark is what keeps it out of a recording.
    expect(
      screen.getByLabelText("Auth headers*").hasAttribute(REPLAY_PRIVATE_ATTRIBUTE),
    ).toBe(true);

    // The ordinary one: the same control, holding the customer's own metadata,
    // recorded like the rest of the form.
    expect(
      screen
        .getByLabelText("Agent metadata [optional]")
        .hasAttribute(REPLAY_PRIVATE_ATTRIBUTE),
    ).toBe(false);
  });
});
