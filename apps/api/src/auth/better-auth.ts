import { identityId, identityStore } from "@egma/db";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, deviceAuthorization } from "better-auth/plugins";

import { DEVICE_CLIENT_ID } from "./device.ts";
import type { EmailSender } from "./email.ts";
import { currentIntent } from "./intent.ts";
import {
  passwordResetLink,
  sealResetLink,
  PASSWORD_RESET_LIFETIME_MINUTES,
  PASSWORD_RESET_PROVIDER_LIFETIME_SECONDS,
  RETURN_TO_HEADER,
} from "./password-reset.ts";
import {
  SignupRefusedError,
  type DeviceGrant,
  type DevicePollOutcome,
  type ExternalIdentity,
  type IdentityHooks,
  type IdentityProvider,
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
 * **Two plugins are enabled.** `deviceAuthorization` is RFC 8628, and it is the
 * only reason a terminal can log in without a secret travelling through a
 * coding agent's chat window. `bearer` is what lets the session the device
 * grant issues be presented as a header — which egma uses once, to ask who
 * approved, before throwing that session away and handing the terminal a key of
 * its own instead.
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
  readonly provider: IdentityProvider;
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

/**
 * The prefix on every cookie the provider sets, as one value rather than as a
 * string in two places that could drift apart.
 */
const COOKIE_PREFIX = "egma";

/** What the provider calls the cookie it carries a session in. */
const SESSION_COOKIE = `${COOKIE_PREFIX}.session_token`;

/** The same cookie on an instance served over https, which the provider marks. */
const SECURE_SESSION_COOKIE = `__Secure-${SESSION_COOKIE}`;

/**
 * What a browser is carrying, in the two strings egma needs in order to end it.
 */
export type BrowserSession = {
  /** The token the session row is keyed on, which is what the seam revokes. */
  readonly token: string;
  /** A `set-cookie` line that takes the cookie back out of the browser. */
  readonly expired: string;
};

/** Percent-decoding a value a stranger sent, without it being able to throw. */
function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The session a browser request is carrying, or nothing.
 *
 * Two of the provider's conventions are needed to read one, and both are known
 * here and nowhere else: it signs the cookie it sets, so the value is the token
 * with an HMAC appended after a dot, and it marks the name `__Secure-` when the
 * instance is served over https. What leaves this file is a token and a header
 * line — egma's own strings — so the seam still takes a token and the route that
 * signs somebody out learns nothing about who set the cookie.
 */
export function browserSessionIn(request: Request): BrowserSession | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;

  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at === -1) continue;

    const name = pair.slice(0, at).trim();
    if (name !== SESSION_COOKIE && name !== SECURE_SESSION_COOKIE) continue;

    // The token itself is alphanumeric, so the first dot is where the signature
    // begins and everything before it is what the row is keyed on.
    const token = decoded(pair.slice(at + 1).trim()).split(".")[0] ?? "";
    if (token === "") return null;

    return {
      token,
      // The same attributes it was set with, which is what a browser matches on
      // — and `Secure` is not optional on a `__Secure-` name.
      expired:
        `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` +
        (name === SECURE_SESSION_COOKIE ? "; Secure" : ""),
    };
  }

  return null;
}

/**
 * What a failed token exchange means, said in egma's four words.
 *
 * RFC 8628 gives the transport six error codes and egma's seam has four
 * answers, because two of the six describe the same thing to a terminal that is
 * waiting. `invalid_grant` is a device code the server does not know, and the
 * row is deleted the moment a code expires, is denied, or is collected — so by
 * far the likeliest reason a code is unknown is that its authorization is over,
 * and `expired` is both the truthful answer and the one a person can act on.
 *
 * Anything else is a fault rather than an outcome, and is left to surface as
 * one rather than being flattened into "keep waiting".
 */
function devicePollOutcome(cause: unknown): DevicePollOutcome {
  const said =
    cause instanceof APIError
      ? (cause.body as { error?: unknown } | undefined)?.error
      : undefined;

  switch (said) {
    case "authorization_pending":
      return "pending";
    case "slow_down":
      return "slow_down";
    case "access_denied":
      return "denied";
    case "expired_token":
    case "invalid_grant":
      return "expired";
    default:
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

    plugins: [
      deviceAuthorization({
        // Relative, so it resolves against the origin this instance is served
        // on. A self-hoster's terminal sends them to their own machine, never
        // to a domain egma runs.
        verificationUri: "/device",
        // egma serves one client, so an unknown one is refused at the door
        // rather than producing an authorization the token exchange would then
        // have to disown.
        validateClient: async (clientId) => clientId === DEVICE_CLIENT_ID,
      }),
      // Only so the session the device grant issues can be presented back as a
      // header, for the one question egma asks it.
      bearer(),
    ],

    advanced: {
      // The cookie a person can see in their own browser says egma, not the
      // name of the library that happens to set it. A provider swap must not
      // be visible in a cookie name.
      cookiePrefix: COOKIE_PREFIX,

      database: {
        // One generator for every table, egma's and the provider's alike. An
        // identifier reaches customers' scripts, bookmarked URLs and every
        // referencing row, so two formats would be two formats forever.
        generateId: ({ model }) => identityId(model),
      },

      /**
       * Work the answer must not wait for, and **the reason it must not is
       * that waiting is itself an answer.**
       *
       * The provider defers exactly the kind of work whose duration gives
       * something away, and with nowhere to defer it to it simply waits
       * instead. Asking for a password reset is the case that matters: for an
       * address nobody holds the provider answers immediately, and for one
       * somebody does it first posts a message — a quarter of a second to reach
       * an SMTP server. The two answers are byte for byte identical and one of
       * them takes twenty times longer, so one unauthenticated request tells a
       * stranger who has an account here. That is the one thing the reset flow
       * promises not to say.
       *
       * So the message is handed over and the answer goes back. What is left on
       * the path is a row read and a row written, which is what the provider
       * already evens out on purpose.
       *
       * Nothing is dropped: the provider hands over a promise that already
       * carries its own failure handling, and a send that fails is written to
       * the log this instance keeps rather than to a person who is waiting.
       */
      backgroundTasks: {
        handler: (task) => {
          void Promise.resolve(task).catch((cause: unknown) => {
            options.log("error", "a background task did not finish", [cause]);
          });
        },
      },
    },

    emailAndPassword: {
      enabled: true,
      // Required only when a message would actually arrive. With no SMTP
      // configured, signup completes and verification is not a step.
      requireEmailVerification: options.emailSender.delivers,
      autoSignIn: true,

      // The provider's own copy of the deadline, and always the later of the
      // two. Egma's travels inside the link and is the one that decides — and
      // the only one anything can reach, because the provider's own reset
      // endpoint is shut at egma's door. What the extra minutes are for is a
      // record that outlives the link: a token the provider still holds is a
      // token nobody spent, which is how a refusal past the deadline knows
      // which of the two true sentences to write. See `password-reset.ts`.
      resetPasswordTokenExpiresIn: PASSWORD_RESET_PROVIDER_LIFETIME_SECONDS,

      /**
       * The reset message, through the one email seam.
       *
       * It sits beside the verification message on purpose: **nothing here
       * decides whether mail is delivered**, because `delivers` on the sender
       * already does. On a platform with SMTP the link is posted; on one
       * without, the same message is written to the log and a self-hoster reads
       * it there. There is no second setting for the two to disagree over.
       *
       * The provider's `url` is not used. It points at the provider's own
       * callback, which would redirect a browser to a page with the raw token
       * on it; egma sends a link to its own page carrying the token and the
       * deadline sealed together, so the refusals behind it can say which of
       * the two things happened.
       *
       * **Where to go afterwards travels on the request egma built**, in a
       * header of egma's own. Somebody who was approving a terminal's login
       * when they discovered they had forgotten their password has to land back
       * on that page, and the message is the one hop nothing else survives: a
       * new tab, minutes later, with no page left holding it. The provider's
       * body has no field for it and widening what egma asks the provider for
       * is the cost this seam exists to avoid — so it travels beside the
       * request, exactly as the names a person chose at signup do.
       */
      sendResetPassword: async ({ user, token }, request) => {
        const link = passwordResetLink(
          options.baseUrl,
          sealResetLink(
            {
              token,
              expiresAt: new Date(
                Date.now() + PASSWORD_RESET_LIFETIME_MINUTES * 60_000,
              ),
            },
            options.secret,
          ),
          request?.headers.get(RETURN_TO_HEADER),
        );

        await options.emailSender.send({
          to: user.email,
          subject: "Reset your egma password",
          body:
            `Somebody asked to set a new password for your egma account. ` +
            `Set one here: ${link}\n\n` +
            `The link works once, and runs out ${PASSWORD_RESET_LIFETIME_MINUTES} ` +
            `minutes after it was asked for. If it was not you, nothing has ` +
            `changed and there is nothing to do.`,
        });
      },
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
              options.hooks.admitIdentity(user.email, currentIntent()),
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

      async startDeviceAuthorization(clientId): Promise<DeviceGrant> {
        const grant = await auth.api.deviceCode({
          body: { client_id: clientId },
        });

        return {
          deviceCode: grant.device_code,
          userCode: grant.user_code,
          verificationUri: grant.verification_uri,
          verificationUriComplete: grant.verification_uri_complete,
          expiresInSeconds: grant.expires_in,
          intervalSeconds: grant.interval,
        };
      },

      /**
       * Who approved this device code, or why nobody has yet.
       *
       * The provider answers by issuing a session, because a session is what it
       * has to give. egma wants none: the terminal is about to be handed an
       * API key, which is egma's own credential against egma's own table, and
       * leaving a live session behind for every login would be a row nobody
       * ever uses and nobody ever cleans up. So the session is created, read
       * once for the name on it, and deleted again — all inside this file, so
       * that the rest of egma never learns one existed.
       */
      async pollDeviceAuthorization(
        deviceCode,
      ): Promise<ExternalIdentity | DevicePollOutcome> {
        let granted: { access_token: string };
        try {
          granted = await auth.api.deviceToken({
            body: {
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: deviceCode,
              client_id: DEVICE_CLIENT_ID,
            },
          });
        } catch (cause) {
          return devicePollOutcome(cause);
        }

        const token = granted.access_token;
        try {
          const session = await auth.api.getSession({
            headers: new Headers({ authorization: `Bearer ${token}` }),
          });
          if (session === null) {
            throw new Error(
              "the device grant issued a session that resolves to nobody",
            );
          }
          return {
            externalIdentityId: session.user.id,
            email: session.user.email,
          };
        } finally {
          const context = await auth.$context;
          await context.internalAdapter.deleteSession(token);
        }
      },
    },
  };
}
