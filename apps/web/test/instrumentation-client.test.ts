// @vitest-environment jsdom
import type {
  BeforeSendFn,
  CapturedNetworkRequest,
  PostHogConfig,
} from "posthog-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REPLAY_PRIVATE_ATTRIBUTE } from "../lib/replay-privacy.ts";

const init = vi.hoisted(() => vi.fn());

vi.mock("posthog-js", () => ({ default: { init } }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  init.mockReset();
  document.body.innerHTML = "";
});

/** One element inside a region replay must not read, and one outside it. */
function twoRegions(markup: string): {
  readonly open: HTMLElement;
  readonly closed: HTMLElement;
} {
  document.body.innerHTML = `
    <main data-open>${markup}</main>
    <main ${REPLAY_PRIVATE_ATTRIBUTE}>${markup}</main>
  `;
  const open = document.querySelector("[data-open] :first-child");
  const closed = document.querySelector(
    `[${REPLAY_PRIVATE_ATTRIBUTE}] :first-child`,
  );
  if (open === null || closed === null) throw new Error("no such element");
  return { open: open as HTMLElement, closed: closed as HTMLElement };
}

async function recordingPolicy(): Promise<PostHogConfig> {
  vi.stubEnv("NEXT_PUBLIC_EGMA_TELEMETRY", "on");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://us.i.posthog.com");

  await import("../instrumentation-client.ts");

  return init.mock.calls[0]?.[1] as PostHogConfig;
}

/**
 * **What a replay is allowed to hold**, which is the whole of this policy and
 * cannot be read off the source: every hook below decides per element, and a
 * hook that decided the other way round would look identical in a diff.
 *
 * The first policy masked the entire product and the recordings were worthless
 * for it, so what these tests defend now runs in both directions — the pages
 * are recorded, *and* production traces and secrets are not.
 */
describe("browser platform telemetry", () => {
  it("keeps the whole product recordable and the page's own words readable", async () => {
    const config = await recordingPolicy();

    expect(config).toMatchObject({
      autocapture: false,
      disable_capture_url_hashes: true,
      enable_recording_console_log: false,
      logs: { captureConsoleLogs: false },
      session_recording: {
        /*
         * Every field, so `maskInputFn` is asked about every field. See the
         * note beside it: `false` here would silently record all of them.
         */
        maskAllInputs: true,
        // One selector, and it is the mark rather than "everything".
        maskTextSelector: `[${REPLAY_PRIVATE_ATTRIBUTE}]`,
        recordHeaders: false,
        recordBody: false,
        recordCrossOriginIframes: false,
        captureCanvas: { recordCanvas: false },
      },
    });

    const maskAttribute = config.session_recording.maskAttributeFn;
    const { open, closed } = twoRegions(`<button title="Run this test"></button>`);

    // The product itself: labels, tooltips and the attributes this application
    // styles itself with all survive.
    expect(maskAttribute?.("title", "Run this test", open)).toBe("Run this test");
    expect(maskAttribute?.("aria-label", "Open the run", open)).toBe("Open the run");
    expect(maskAttribute?.("data-slot", "page-body", open)).toBe("page-body");
    expect(maskAttribute?.("class", "recording-player", open)).toBe(
      "recording-player",
    );

    // A private region: what carries words goes, what draws the page stays.
    expect(maskAttribute?.("title", "Run this test", closed)).toBe("");
    expect(maskAttribute?.("aria-label", "+1 415 555 0134", closed)).toBe("");
    expect(maskAttribute?.("src", "https://app.egma.ai/audio.wav", closed)).toBe("");
    expect(maskAttribute?.("data-slot", "page-body", closed)).toBe("page-body");
    expect(maskAttribute?.("class", "recording-player", closed)).toBe(
      "recording-player",
    );
  });

  it("records what somebody types, except a secret or a production trace", async () => {
    const config = await recordingPolicy();
    const maskInput = config.session_recording.maskInputFn;

    const { open, closed } = twoRegions(`<input type="text" />`);
    expect(maskInput?.("Refund flow", open)).toBe("Refund flow");
    expect(maskInput?.("+1 415 555 0134", closed)).toBe("*".repeat(15));

    /*
     * A password field while somebody is holding the reveal control down. Its
     * type says `text` for as long as they look, which is exactly the second a
     * recording would keep — so the autocomplete token is what is asked.
     */
    document.body.innerHTML = `
      <input id="hidden" type="password" autocomplete="current-password" />
      <input id="shown" type="text" autocomplete="current-password" />
    `;
    const hidden = document.querySelector("#hidden") as HTMLElement;
    const shown = document.querySelector("#shown") as HTMLElement;
    expect(maskInput?.("hunter2", hidden)).toBe("*******");
    expect(maskInput?.("hunter2", shown)).toBe("*******");
  });

  it("removes URL secrets from events and from recorded requests", async () => {
    const config = await recordingPolicy();

    const beforeSend = config.before_send as BeforeSendFn;
    const event = beforeSend({
      uuid: "00000000-0000-4000-8000-000000000000",
      event: "$pageview",
      properties: {
        $current_url: "https://user:pass@app.egma.ai/invite?token=secret#private",
        $referrer: "https://example.com/source?email=private@example.com",
      },
    });
    expect(event?.properties).toMatchObject({
      $current_url: "https://app.egma.ai/invite",
      $referrer: "https://example.com/source",
    });

    const maskRequest = config.session_recording.maskCapturedNetworkRequestFn;
    const request = maskRequest?.({
      name: "https://app.egma.ai/audio.wav?signature=secret#private",
      entryType: "resource",
      startTime: 0,
      duration: 1,
      requestHeaders: { Authorization: "Bearer secret" },
      responseBody: "private transcript",
    } as CapturedNetworkRequest);
    expect(request).toMatchObject({ name: "https://app.egma.ai/audio.wav" });
    expect(JSON.stringify(request)).not.toContain("secret");
    expect(JSON.stringify(request)).not.toContain("private transcript");
  });
});
