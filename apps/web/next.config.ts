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
        // The platform's public identity, forwarded because the CLI reads it at
        // the origin a self-hoster was given — which is this process, not the
        // API's own port. Without this rule a bound repository could never
        // verify the platform it is bound to.
        { source: "/api/platform", destination: `${api}/api/platform` },
        // What this deployment has been configured with, as its owner reads and
        // changes it. Forwarded because the point of holding these on the
        // platform is that nobody needs shell access to change one: the person
        // who does it is signed in to this origin, and this is the only origin
        // their session is valid for. It is its own rule rather than a
        // `:path*` under the identity above, because that identity is public
        // and this refuses anybody but an owner — two different doors that
        // happen to share a prefix.
        {
          source: "/api/platform/settings",
          destination: `${api}/api/platform/settings`,
        },
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
        { source: "/api/monitoring", destination: `${api}/api/monitoring` },
        {
          source: "/api/monitoring/:path*",
          destination: `${api}/api/monitoring/:path*`,
        },
        // What a connection can be, and what one turned out to be able to do.
        // Both are read by the connection forms rather than posted to.
        {
          source: "/api/connection-options",
          destination: `${api}/api/connection-options`,
        },
        {
          source: "/api/providers/retell/voice-agents",
          destination: `${api}/api/providers/retell/voice-agents`,
        },
        {
          source: "/api/capabilities",
          destination: `${api}/api/capabilities`,
        },
        { source: "/api/persona-form", destination: `${api}/api/persona-form` },
        { source: "/api/personas", destination: `${api}/api/personas` },
        {
          source: "/api/personas/:path*",
          destination: `${api}/api/personas/:path*`,
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
        // The Settings surface: the customer itself, and the product areas
        // inside it. Without these the pages would post at Next, which has no
        // such route, and read its 404 page as egma's refusal.
        { source: "/api/organization", destination: `${api}/api/organization` },
        { source: "/api/projects", destination: `${api}/api/projects` },
        {
          source: "/api/projects/:path*",
          destination: `${api}/api/projects/:path*`,
        },
        // The shelf of grader definitions the Library screen draws itself
        // from. One rule and no `:path*` beside it, because the library is
        // read and never authored: a second address under it would be a
        // forwarding rule for a door that does not exist.
        {
          source: "/api/grader-library",
          destination: `${api}/api/grader-library`,
        },
        // The running copies beside the shelf: the list and Use at the group's
        // own address, and one copy's own address beside it — where an edit
        // changes what it judges by and a delete switches it off. Both rules,
        // for the reason the traces pair below spells out: `:path*` is
        // documented as matching zero segments and on the hosted deployment it
        // did not, so the bare path is named outright rather than left to
        // depend on how a host reads the wildcard.
        { source: "/api/graders", destination: `${api}/api/graders` },
        {
          source: "/api/graders/:path*",
          destination: `${api}/api/graders/:path*`,
        },
        { source: "/api/tests", destination: `${api}/api/tests` },
        { source: "/api/tests/:path*", destination: `${api}/api/tests/:path*` },
        {
          source: "/api/test-versions/:path*",
          destination: `${api}/api/test-versions/:path*`,
        },
        { source: "/api/runs", destination: `${api}/api/runs` },
        // What a run would freeze, read by the builder's review step before
        // anybody starts one. Its own rule because it is not under
        // `/api/runs` — nothing is created and nothing is reserved by asking.
        { source: "/api/run-plan", destination: `${api}/api/run-plan` },
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
        // Two rules, because one does not do it. `:path*` is documented as
        // matching zero segments, and in this process it does — but on the
        // hosted deployment the bare `/v1/traces` fell straight through it to
        // this app's own routing, which has no such page:
        // `POST https://app.egma.ai/v1/traces` answered 404 while the API
        // answered 401 for the same request. An exporter pointed at the pages
        // origin would have posted into a 404 and reported nothing wrong. So
        // the bare path is named outright, rather than left to depend on how a
        // host reads the wildcard.
        { source: "/v1/traces", destination: `${api}/v1/traces` },
        { source: "/v1/traces/:path*", destination: `${api}/v1/traces/:path*` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default config;
