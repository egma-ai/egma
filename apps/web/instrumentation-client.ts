/**
 * Product analytics for the pages, off unless the build was given a key.
 *
 * Next loads this file once in every browser session, before the app's own
 * code. `NEXT_PUBLIC_*` is resolved at build time — the hosted deployment
 * sets both variables where it builds (Vercel), and a self-hoster who sets
 * nothing builds pages that contain an empty string here, initialize nothing,
 * and send nothing anywhere. The key is a PostHog project token, which is
 * write-only by design: it can submit events and read none back, which is
 * what makes it publishable inside a page at all.
 *
 * What a key turns on: pageviews and clicks, session replay (as far as the
 * PostHog project's own settings allow), web vitals, and the errors pages
 * throw. All of it is about how egma's own product is used — nothing here
 * reads a transcript, a recording, or anything else a customer's agent said.
 */

import posthog from "posthog-js";

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (key !== undefined && key !== "") {
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    // PostHog's dated defaults preset: history-change pageviews and the rest
    // of what a single-page app needs, pinned so an SDK upgrade cannot change
    // behavior silently.
    defaults: "2025-05-24",
    capture_exceptions: true,
  });
}
