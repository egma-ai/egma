/**
 * Product analytics for the pages, off unless the build said `on` and gave a
 * key.
 *
 * Next loads this file once in every browser session, before the app's own
 * code. `NEXT_PUBLIC_*` is resolved at build time — the hosted deployment
 * sets the flag and both variables where it builds (Vercel), and a
 * self-hoster who sets nothing builds pages that contain empty strings here,
 * initialize nothing, and send nothing anywhere. The flag is the same
 * `EGMA_TELEMETRY` every other process reads, mapped through next.config at
 * build — one flag is the whole decision, so a key left set in a build
 * environment cannot turn reporting on by itself. The key is a PostHog
 * project token, which is write-only by design: it can submit events and
 * read none back, which is what makes it publishable inside a page at all.
 *
 * What a key turns on: pageviews, session replay (as far as the PostHog
 * project's own settings allow), web vitals, and the errors pages throw.
 * Replay sees the page, so the fixed policy below masks its text, inputs,
 * private attributes, URLs, network content, console, frames, and canvases.
 */

import posthog, {
  type BeforeSendFn,
  type CapturedNetworkRequest,
} from "posthog-js";

const RECORDED_URL_PROPERTY = /(?:url|href|referrer)$/i;
const PRIVATE_REPLAY_ATTRIBUTE =
  /^(?:aria-|data-)|^(?:action|alt|for|formaction|href|id|name|placeholder|src|srcset|title|value)$/i;

function stripUrlSecrets(value: string): string {
  const separator = value.search(/[?#]/);
  const stripped = separator === -1 ? value : value.slice(0, separator);

  try {
    const url = new URL(stripped);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return stripped;
  }
}

const sanitizeEventUrls: BeforeSendFn = (event) => {
  if (event === null) return null;

  for (const properties of [event.properties, event.$set, event.$set_once]) {
    if (properties === undefined) continue;
    for (const [name, value] of Object.entries(properties)) {
      if (typeof value === "string" && RECORDED_URL_PROPERTY.test(name)) {
        properties[name] = stripUrlSecrets(value);
      }
    }
  }
  return event;
};

function sanitizeRecordedRequest(
  request: CapturedNetworkRequest,
): CapturedNetworkRequest {
  request.name = stripUrlSecrets(request.name);
  request.requestHeaders = undefined;
  request.requestBody = undefined;
  request.responseHeaders = undefined;
  request.responseBody = undefined;
  return request;
}

// One condition, the flag. next.config already refused any build that said
// `on` without a key, so the key read below is TypeScript's concern, not a
// second switch.
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (process.env.NEXT_PUBLIC_EGMA_TELEMETRY === "on" && key !== undefined && key !== "") {
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    // PostHog's dated defaults preset: history-change pageviews and the rest
    // of what a single-page app needs, pinned so an SDK upgrade cannot change
    // behavior silently.
    defaults: "2025-05-24",
    autocapture: false,
    capture_exceptions: true,
    disable_capture_url_hashes: true,
    enable_recording_console_log: false,
    logs: { captureConsoleLogs: false },
    before_send: sanitizeEventUrls,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      maskAttributeFn: (name, value) =>
        PRIVATE_REPLAY_ATTRIBUTE.test(name) ? "" : value,
      recordHeaders: false,
      recordBody: false,
      recordCrossOriginIframes: false,
      captureCanvas: { recordCanvas: false },
      maskCapturedNetworkRequestFn: sanitizeRecordedRequest,
    },
  });
}
