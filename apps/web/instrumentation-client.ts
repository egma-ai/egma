/**
 * Enable browser analytics only when the build enables Egma telemetry and
 * supplies a PostHog key. Public environment values are fixed at build time.
 *
 * Mask input values and explicitly marked credential text. Strip query strings,
 * fragments, and URL userinfo from recognized event URL properties, request
 * names, and DOM href/src attributes. This does not sanitize arbitrary strings.
 * Disable captured headers, bodies, console logs, cross-origin frames, and canvas.
 */

import posthog, {
  type BeforeSendFn,
  type CapturedNetworkRequest,
} from "posthog-js";

import { REPLAY_PRIVATE_SELECTOR } from "./lib/replay-privacy.ts";

const RECORDED_URL_PROPERTY = /(?:url|href|referrer)$/i;

/**
 * Strip secrets from recorded href/src attributes, including signed recording
 * URLs. Apply the same URL sanitizer used for events and captured requests.
 */
const RECORDED_URL_ATTRIBUTE = /^(?:href|src)$/i;

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
      maskAttributeFn: (name, value) =>
        RECORDED_URL_ATTRIBUTE.test(name) ? stripUrlSecrets(value) : value,
      recordHeaders: false,
      recordBody: false,
      recordCrossOriginIframes: false,
      captureCanvas: { recordCanvas: false },
      maskCapturedNetworkRequestFn: sanitizeRecordedRequest,
    },
  });
}
