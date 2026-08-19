import type {
  BeforeSendFn,
  CapturedNetworkRequest,
  PostHogConfig,
} from "posthog-js";
import { afterEach, describe, expect, it, vi } from "vitest";

const init = vi.hoisted(() => vi.fn());

vi.mock("posthog-js", () => ({ default: { init } }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  init.mockReset();
});

describe("browser platform telemetry", () => {
  it("removes page content and URL secrets before PostHog can record them", async () => {
    vi.stubEnv("NEXT_PUBLIC_EGMA_TELEMETRY", "on");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://us.i.posthog.com");

    await import("../instrumentation-client.ts");

    const config = init.mock.calls[0]?.[1] as PostHogConfig;
    expect(config).toMatchObject({
      autocapture: false,
      disable_capture_url_hashes: true,
      enable_recording_console_log: false,
      logs: { captureConsoleLogs: false },
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
        recordHeaders: false,
        recordBody: false,
        recordCrossOriginIframes: false,
        captureCanvas: { recordCanvas: false },
      },
    });

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

    const maskAttribute = config.session_recording.maskAttributeFn;
    expect(maskAttribute?.("aria-label", "private transcript")).toBe("");
    expect(maskAttribute?.("class", "recording-player")).toBe("recording-player");
  });
});
