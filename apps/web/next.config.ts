import type { NextConfig } from "next";

/**
 * The API is reached through this process, not around it.
 *
 * The pages and the API answer on one origin in every deployment, so the
 * session cookie is valid for both and there is no cross-origin cookie handling
 * anywhere. The browser only ever talks to the instance it loaded the page
 * from, which is also what makes a self-hoster's login depend on nothing they
 * do not run.
 *
 * `EGMA_API_ORIGIN` is read when the site is built rather than when it starts,
 * because Next resolves rewrites into the build. In Compose that is the API
 * service; running the two processes by hand it is localhost. Neither is a
 * value a self-hoster has to choose.
 */
const api = process.env.EGMA_API_ORIGIN ?? "http://127.0.0.1:3100";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,

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
        {
          source: "/api/device/:path*",
          destination: `${api}/api/device/:path*`,
        },
        { source: "/api/keys", destination: `${api}/api/keys` },
        { source: "/api/keys/:path*", destination: `${api}/api/keys/:path*` },
        { source: "/api/members", destination: `${api}/api/members` },
        {
          source: "/api/members/:path*",
          destination: `${api}/api/members/:path*`,
        },
        { source: "/api/invitations", destination: `${api}/api/invitations` },
        {
          source: "/api/invitations/:path*",
          destination: `${api}/api/invitations/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default config;
