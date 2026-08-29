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
 * What a key turns on: pageviews, session replay, web vitals, and the errors
 * pages throw.
 *
 * **Replay reads the page, and that is the point.** It used to mask every word
 * on every page and the recordings were grey blocks that answered nothing. It
 * records the pages now; `lib/replay-privacy.ts` marks the one thing it must
 * not read, which is a secret on screen. Inputs stay masked whatever the page
 * says, so every password and credential field is covered without a mark.
 *
 * Off for the whole product either way: request and response headers and
 * bodies, the console, cross-origin frames, canvases, and the query and
 * fragment of any URL that reaches an event.
 */

import posthog, {
  type BeforeSendFn,
  type CapturedNetworkRequest,
} from "posthog-js";

import { REPLAY_PRIVATE_SELECTOR } from "./lib/replay-privacy.ts";

const RECORDED_URL_PROPERTY = /(?:url|href|referrer)$/i;

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
      /*
       * Written out rather than left unset, because unset is not neutral: the
       * PostHog project can carry a masking setting of its own, and the value
       * set here is what overrides it.
       */
      maskTextSelector: REPLAY_PRIVATE_SELECTOR,
      recordHeaders: false,
      recordBody: false,
      recordCrossOriginIframes: false,
      captureCanvas: { recordCanvas: false },
      maskCapturedNetworkRequestFn: sanitizeRecordedRequest,
    },
  });
}
