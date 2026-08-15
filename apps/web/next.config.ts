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
        // The platform's public identity, forwarded because the CLI reads it at
        // the origin a self-hoster was given — which is this process, not the
        // API's own port. Without this rule a bound repository could never
        // verify the platform it is bound to.
        { source: "/api/platform", destination: `${api}/api/platform` },
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
        { source: "/api/agents", destination: `${api}/api/agents` },
        {
          source: "/api/agents/:path*",
          destination: `${api}/api/agents/:path*`,
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
        { source: "/api/tests", destination: `${api}/api/tests` },
        { source: "/api/tests/:path*", destination: `${api}/api/tests/:path*` },
        {
          source: "/api/test-versions/:path*",
          destination: `${api}/api/test-versions/:path*`,
        },
        { source: "/api/runs", destination: `${api}/api/runs` },
        { source: "/api/runs/:path*", destination: `${api}/api/runs/:path*` },
        // One conversation's own paths — today, resolving its recording into a
        // link the browser then fetches from the object store directly. Without
        // this rule the request lands on this process's own file routing and
        // comes back as Next's 404 page, which is not JSON and carries no
        // sentence: the run results would show "Egma answered 404" for a
        // recording that is sitting in the store, and nothing would say why.
        {
          source: "/api/simulations/:path*",
          destination: `${api}/api/simulations/:path*`,
        },
        // The public v1 contract, forwarded whole rather than read-endpoint by
        // read-endpoint. `/v1/traces` is one path answering two things — the
        // OTLP door on POST, the list on GET — and a proxy forwards paths, not
        // methods; carving out the verbs here would put a second, quieter copy
        // of the API's routing table in a file that cannot enforce it. Nothing
        // is widened by this: it is the same API, reached on the origin a
        // browser already has a session for, and every one of these routes
        // authenticates for itself.
        //
        // One rule and not two: `:path*` matches zero segments, so this also
        // matches the bare `/v1/traces` and forwards it to exactly that, with
        // no trailing slash for the API to have an opinion about.
        { source: "/v1/traces/:path*", destination: `${api}/v1/traces/:path*` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default config;
