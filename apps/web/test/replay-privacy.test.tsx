// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionFields } from "../app/projects/[projectId]/agents/[agentId]/connections/fields.tsx";
import type { ConnectionOption } from "../lib/connection-options.ts";
import { REPLAY_PRIVATE_ATTRIBUTE } from "../lib/replay-privacy.ts";
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
      help: "A JSON object of header name to header value.",
    },
  ],
};

/**
 * **What session replay may and may not read**, which is a policy rather than a
 * setting: `instrumentation-client.ts` masks one selector, and these are the
 * places that wear it.
 *
 * The reason to hold it down here rather than trust the source: a mark is
 * invisible on the page. A secret box and an ordinary box look the same in a
 * browser, so a mark that stopped being applied would go on looking right until
 * somebody opened a recording of a customer minting a key.
 */
describe("what a session replay is allowed to read", () => {
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

  /**
   * **A whole page is never marked, the Traces screens included** (developer
   * decision, 2026-08-29). Hiding production traces was this policy's first
   * exception and it was dropped: the screens are new, and watching somebody
   * use them is how they get fixed. The record is
   * `egma-planning/docs/adr/0021-session-replay-records-the-product.md`.
   *
   * This is here because masking a page is the intuitive thing to reach for,
   * and it is a decision rather than an omission. Anybody re-adding it should
   * delete this test on purpose and reopen that record.
   */
  it("records every page, and the Traces screens like the rest", () => {
    for (const pathname of [
      "/projects/prj_2/monitoring/transcripts",
      "/projects/prj_2/monitoring/transcripts/trc_1",
      "/projects/prj_2/runs",
    ]) {
      routed.pathname = pathname;
      const { container } = render(
        <ProductPage>
          <div>Any page</div>
        </ProductPage>,
      );
      expect(
        container.querySelector("main")?.hasAttribute(REPLAY_PRIVATE_ATTRIBUTE),
        pathname,
      ).toBe(false);
      cleanup();
    }
  });
});
