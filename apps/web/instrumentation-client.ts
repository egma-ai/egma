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
 * **Replay sees the page, and now it is allowed to.** The first policy here
 * masked all of it — every word, every field, and every attribute that could
 * carry a word — and what came back was grey blocks in the shape of a product,
 * with nothing in them to look at. So replay records the pages, and
 * `lib/replay-privacy.ts` names the one exception and marks it: a secret drawn
 * where a person can read it. All three masking hooks below read that one mark,
 * and the password rule below is the one thing they do not need it for.
 *
 * What no mark can turn back on, because it is off for the whole product:
 * request and response headers and bodies, the console, cross-origin frames,
 * canvases, and the query and fragment of any URL that reaches an event.
 */

import posthog, {
  type BeforeSendFn,
  type CapturedNetworkRequest,
} from "posthog-js";

import {
  isReplayPrivate,
  REPLAY_PRIVATE_SELECTOR,
} from "./lib/replay-privacy.ts";

const RECORDED_URL_PROPERTY = /(?:url|href|referrer)$/i;

/**
 * Inside a private region, the attributes that can carry the words the region
 * is masked for: a label read out by a screen reader, a tooltip, an alternative
 * text, a field's placeholder or value, and anything pointing at the recording
 * itself.
 *
 * Everything else survives, `class` and every `data-` hook with it. The first
 * policy emptied those too, across the whole product, and that is the other
 * half of why the recordings were unreadable: this application styles itself on
 * `data-` attributes, so a replay stripped of them cannot draw the page it
 * recorded even where nothing was masked.
 */
const PRIVATE_REPLAY_ATTRIBUTE =
  /^(?:aria-|(?:alt|href|placeholder|src|srcset|title|value)$)/i;

function stars(value: string): string {
  return "*".repeat(value.length);
}

/**
 * A field somebody types a secret into, whether or not it is showing one.
 *
 * The type alone answers this until a reveal control is pressed: sign-in swaps
 * its field to `text` while a person checks what they typed, and a recording
 * taken in that second would hold their password. The autocomplete token does
 * not move, so it is the second thing asked.
 */
function holdsSecret(element: HTMLElement | undefined): boolean {
  if (!(element instanceof HTMLInputElement)) return false;
  return element.type === "password" || /password/i.test(element.autocomplete);
}

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

/** What a field is recorded as: itself, unless it is private or holds a secret. */
function recordedInput(text: string, element?: HTMLElement): string {
  return isReplayPrivate(element) || holdsSecret(element) ? stars(text) : text;
}

/**
 * What an attribute is recorded as: itself, unless its region is private.
 *
 * The name is tested first because this runs on every attribute of every
 * element in a snapshot, and the name is a regular expression over a short
 * string while the region is a walk up the tree. Most attributes on a page are
 * `class` and `data-`, which the name test settles without touching the DOM.
 */
function recordedAttribute(
  name: string,
  value: string,
  element?: Element,
): string {
  return PRIVATE_REPLAY_ATTRIBUTE.test(name) && isReplayPrivate(element)
    ? ""
    : value;
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
      /*
       * **`true` is how a field gets asked about one at a time.** rrweb calls
       * `maskInputFn` only for the fields `maskAllInputs` has already selected,
       * so `false` here would hand the function the password fields alone and
       * record every other field in the clear, mark or no mark. `true` sends
       * all of them through, and the function below is the whole decision.
       */
      maskAllInputs: true,
      maskInputFn: recordedInput,
      /*
       * Written out rather than left unset, because unset is not neutral: the
       * PostHog project can carry a masking setting of its own, and the value
       * set here is what overrides it. This is the pages' policy, stated by the
       * pages.
       */
      maskTextSelector: REPLAY_PRIVATE_SELECTOR,
      maskAttributeFn: recordedAttribute,
      recordHeaders: false,
      recordBody: false,
      recordCrossOriginIframes: false,
      captureCanvas: { recordCanvas: false },
      maskCapturedNetworkRequestFn: sanitizeRecordedRequest,
    },
  });
}
