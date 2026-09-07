import type { NextConfig } from "next";

/**
 * Proxy API paths through the web origin for browser sessions and agent-platform
 * mock-tool requests. Next resolves EGMA_API_ORIGIN when building rewrites;
 * the default is the local API port.
 */
const api = process.env.EGMA_API_ORIGIN ?? "http://127.0.0.1:3100";

/**
 * Produce standalone output for self-hosted runtime images. Vercel builds
 * use its deployment output instead.
 */
const forSelfHosting = !process.env.VERCEL;

const config: NextConfig = {
  ...(forSelfHosting ? { output: "standalone" as const } : {}),
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,

  // The one telemetry flag, made visible to the browser bundle. Pages cannot
  // read a server variable at runtime — Next inlines only NEXT_PUBLIC_* at
  // build — so the flag is mapped through here, at build, from the same
  // EGMA_TELEMETRY every other process reads. A build that was not told `on`
  // bakes in an empty string, and the client initializes nothing even if a
  // PostHog key was left set: one flag is the whole decision, in the browser
  // exactly as in the containers. And exactly as in the containers, `on`
  // without the key is refused here, by name, rather than built into pages
  // that quietly report nothing.
  env: {
    NEXT_PUBLIC_EGMA_TELEMETRY: (() => {
      const on = (process.env.EGMA_TELEMETRY ?? "").trim().toLowerCase() === "on";
      if (on && !process.env.NEXT_PUBLIC_POSTHOG_KEY) {
        throw new Error(
          "EGMA_TELEMETRY is on, so NEXT_PUBLIC_POSTHOG_KEY must be set where the pages build — " +
            "on means everything reports, and an absent key must never be a quiet no",
        );
      }
      return on ? "on" : "";
    })(),
  },

  async rewrites() {
    return {
      // Ahead of this app's own files, so the API owns these paths outright.
      // `/api/health` is this process's own and is deliberately not among them.
      beforeFiles: [
        { source: "/api/auth/:path*", destination: `${api}/api/auth/:path*` },
        { source: "/api/signup", destination: `${api}/api/signup` },
        {
          source: "/api/signup/:path*",
          destination: `${api}/api/signup/:path*`,
        },
        { source: "/api/me", destination: `${api}/api/me` },
        { source: "/api/sign-out", destination: `${api}/api/sign-out` },
        {
          source: "/api/device/:path*",
          destination: `${api}/api/device/:path*`,
        },
        {
          source: "/api/invitations/:path*",
          destination: `${api}/api/invitations/:path*`,
        },
        // Both halves of getting back in after forgetting a password: asking
        // for a link, and setting the password behind one. Neither is served by
        // this process, and without these rules the pages would post at Next
        // and read its 404 page as egma's refusal.
        {
          source: "/api/password-reset",
          destination: `${api}/api/password-reset`,
        },
        {
          source: "/api/password-reset/:path*",
          destination: `${api}/api/password-reset/:path*`,
        },
        // Forward mock-tool URLs to the API. Agent platforms call these URLs directly
        // and must receive the tool response, not Next's HTML not-found page.
        {
          source: "/mock-tools/:path*",
          destination: `${api}/mock-tools/:path*`,
        },
        // `/api/health` proves only this Next process. The platform deployment
        // waits for the API and its stores directly; it must not depend on a
        // web deployment that has not happened yet.
        { source: "/openapi.json", destination: `${api}/openapi.json` },
        // The complete versioned platform API. The API remains the only routing
        // table; this process only keeps the browser on the page's origin.
        { source: "/v1/:path*", destination: `${api}/v1/:path*` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default config;
