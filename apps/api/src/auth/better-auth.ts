import { identityId, identityStore } from "@egma/db";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";

import type { EmailSender } from "./email.ts";
import { currentIntent } from "./intent.ts";
import {
  SignupRefusedError,
  type ExternalIdentity,
  type IdentityHooks,
  type SessionIdentityProvider,
} from "./seam.ts";
import type { WebHandler } from "../http/web-handler.ts";

/**
 * The auth provider, wired against egma's own tables.
 *
 * This file and the one that binds the identity tables are the only two that
 * name the provider's package, and a build rule keeps it that way. Everything
 * else in the codebase sees `SessionIdentityProvider` and egma's own types.
 *
 * What is adopted: `user`, `session`, `account` and `verification`, password
 * hashing, and the session cookie. What is not, and these are settled rather
 * than open:
 *
 * **The organization plugin is not enabled.** egma owns `organization` and
 * `membership`. The provider's authorization is organization-scoped and
 * resource-blind — it never receives a resource id — so egma writes a real
 * authorization layer regardless, and having the provider also perform half the
 * checks means every request runs two kinds of check against two role tables.
 *
 * **`team` is not repurposed as the project.** The provider's team is a group of
 * *people* inside an organization; egma's project is a scope over *resources*.
 * The blocker is structural: `teamMember` is the one table in the plugin that
 * does not accept additional fields, so per-project roles are impossible in it.
 *
 * **The api-key plugin is not used.** egma mints, hashes and verifies keys
 * against its own table, so a request carrying one runs no provider code at
 * all. That asymmetry is deliberate: the programmatic path is the high-volume
 * one and the one a migration would hurt on, and it is provider-free.
 *
 * **Its migrator is not wired up.** egma writes the DDL for all five identity
 * tables in its own numbered `.sql` files. The provider reads and writes those
 * tables and cannot alter them.
 */

export type IdentityOptions = {
  /** The origin the pages and the API are both served from. */
  readonly baseUrl: string;
  /** Where the provider's own endpoints live under that origin. */
  readonly basePath: string;
  readonly secret: string;
  readonly emailSender: EmailSender;
  /** Where the provider's own diagnostics go, so there is one log and not two. */
  readonly log: (
    level: "info" | "warn" | "error" | "debug",
    message: string,
    details: readonly unknown[],
  ) => void;
  /**
   * The hooks that are registered today. `onSsoLogin` is named in the seam and
   * has no implementation until enterprise single sign-on does.
   */
  readonly hooks: Pick<IdentityHooks, "admitIdentity" | "onIdentityCreated">;
};

export type Identity = {
  /** The provider's HTTP surface, for the Fastify adapter to mount. */
  readonly handler: WebHandler;
  readonly provider: SessionIdentityProvider;
};

/**
 * egma's refusals, said in the transport's own words.
 *
 * The hooks run inside the provider's request handling, so a plain throw
 * becomes a 500 and a person who typed a name somebody already has is told the
 * server broke. Translating here — in the one file that is allowed to know the
 * provider at all — is what keeps `SignupRefusedError` egma's own type
 * everywhere else.
 */
async function refusalsBecomeAnswers<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof SignupRefusedError) {
      throw new APIError(cause.status, {
        message: cause.message,
        code: cause.code,
      });
    }
    throw cause;
  }
}

export function createIdentity(options: IdentityOptions): Identity {
  const auth = betterAuth({
    appName: "egma",
    baseURL: options.baseUrl,
    basePath: options.basePath,
    secret: options.secret,
    // The pages and the API share one origin in every deployment, so this is
    // the only origin a browser ever posts from.
    trustedOrigins: [options.baseUrl],
    // An open-source product does not phone home from a self-hoster's network.
    telemetry: { enabled: false },

    logger: {
      log: (level, message, ...details) => {
        options.log(level, message, details);
      },
    },

    database: identityStore(),

    advanced: {
      // The cookie a person can see in their own browser says egma, not the
      // name of the library that happens to set it. A provider swap must not
      // be visible in a cookie name.
      cookiePrefix: "egma",

      database: {
        // One generator for every table, egma's and the provider's alike. An
        // identifier reaches customers' scripts, bookmarked URLs and every
        // referencing row, so two formats would be two formats forever.
        generateId: ({ model }) => identityId(model),
      },
    },

    emailAndPassword: {
      enabled: true,
      // Required only when a message would actually arrive. With no SMTP
      // configured, signup completes and verification is not a step.
      requireEmailVerification: options.emailSender.delivers,
      autoSignIn: true,
    },

    emailVerification: {
      sendOnSignUp: options.emailSender.delivers,
      sendVerificationEmail: async ({ user, url }) => {
        await options.emailSender.send({
          to: user.email,
          subject: "Confirm your email address for egma",
          body: `Confirm your email address to finish setting up egma: ${url}`,
        });
      },
    },

    databaseHooks: {
      user: {
        create: {
          /**
           * Before the row exists, so a refusal leaves nothing behind. This is
           * where open signup closes on a self-hosted instance, and it is here
           * rather than in egma's signup route so that posting straight at the
           * provider's endpoint is refused the same way.
           */
          before: async (user) => {
            await refusalsBecomeAnswers(() =>
              options.hooks.admitIdentity(user.email),
            );
            return undefined;
          },

          /**
           * A person now exists, so give them somewhere to be. The provider
           * runs this after its own write has committed, which is what lets
           * provisioning open a transaction of its own and see the user row it
           * is provisioning for.
           *
           * If provisioning cannot finish, the identity written moments ago is
           * taken back out. Signup fully succeeds or fully fails: nobody is
           * left holding an account with no organization, no project and no way
           * forward — and no email address is quietly consumed by an account
           * that was never usable.
           */
          after: async (user) => {
            await refusalsBecomeAnswers(async () => {
              try {
                await options.hooks.onIdentityCreated(
                  { externalIdentityId: user.id, email: user.email },
                  currentIntent(),
                );
              } catch (cause) {
                try {
                  const context = await auth.$context;
                  await context.internalAdapter.deleteUser(user.id);
                } catch (undoFailed) {
                  // Whatever went wrong first is what the person needs to hear
                  // about, so this is recorded and the original is rethrown.
                  options.log(
                    "error",
                    `an identity was created and could not be taken back out after provisioning failed: ${user.id}`,
                    [undoFailed],
                  );
                }
                throw cause;
              }
            });
          },
        },
      },
    },
  });

  return {
    handler: (request) => auth.handler(request),

    provider: {
      async resolveIdentity(request): Promise<ExternalIdentity | null> {
        const session = await auth.api.getSession({
          headers: request.headers,
        });
        if (session === null) return null;
        return {
          externalIdentityId: session.user.id,
          email: session.user.email,
        };
      },

      async revokeSession(token): Promise<void> {
        const context = await auth.$context;
        await context.internalAdapter.deleteSession(token);
      },
    },
  };
}
