import { identityId, identityStore } from "@egma/db";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import {
  bearer,
  deviceAuthorization,
  type TimeString,
} from "better-auth/plugins";

import { DEVICE_CLIENT_ID } from "./device.ts";
import type { EmailSender } from "./email.ts";
import { currentIntent } from "./intent.ts";
import {
  passwordResetLink,
  sealResetLink,
  PASSWORD_RESET_LIFETIME_MINUTES,
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
 * Better Auth implements the IdentityProvider interface over Egma-owned
 * identity tables. It handles passwords and sessions; Egma handles
 * organizations, projects, membership, permissions, invitations, and API keys.
 * Device authorization and bearer plugins support CLI login. The granted
 * session is consumed for identity, then deleted before issuing an Egma key.
 * Schema changes use Egma migrations, not the provider's migrator.
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
  /**
   * A test platform can remove the device-flow pace while keeping the real
   * provider and the real terminal flow. Production leaves this absent and
   * uses the provider's five-second RFC 8628 default.
   */
  readonly deviceAuthorizationInterval?: TimeString;
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
 * Extract the session token and a cookie-expiration header for sign-out.
 * Handle both ordinary and __Secure- cookie names and strip the signature.
 * This parses the cookie; it does not authenticate the session.
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
 * Map device-authorization errors to Egma polling states. Treat invalid_grant
 * as expired because the code is no longer available; propagate unknown faults.
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
    appName: "Egma",
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
        ...(options.deviceAuthorizationInterval === undefined
          ? {}
          : { interval: options.deviceAuthorizationInterval }),
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
       * Do not await provider background tasks: SMTP latency on password reset
       * could expose whether an email address exists. The provider attaches its
       * error handling before passing the promise to this handler.
       */
      backgroundTasks: {
        handler: () => {},
      },
    },

    emailAndPassword: {
      enabled: true,
      // Required only when a message would actually arrive. With no SMTP
      // configured, signup completes and verification is not a step.
      requireEmailVerification: options.emailSender.delivers,
      autoSignIn: true,

      // The same hour the link says, in the seconds this option is written in.
      // **One number and not two**: the seal on a link is signed rather than
      // encrypted, so the provider's raw token reads straight out of any link,
      // and the provider's whole surface is served under this instance's
      // origin. A provider deadline longer than the stated one would be a way
      // in past the hour egma names — so there is no longer one to find. See
      // `password-reset.ts`.
      resetPasswordTokenExpiresIn: PASSWORD_RESET_LIFETIME_MINUTES * 60,

      /**
       * Send Egma's signed reset link with the provider token and expiration.
       * Carry the validated return path from Egma's request header so a device-login
       * flow can resume after reset. The EmailSender controls delivery.
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
          subject: "Reset your Egma password",
          body:
            `Somebody asked to set a new password for your Egma account. ` +
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
          subject: "Confirm your email address for Egma",
          body: `Confirm your email address to finish setting up Egma: ${url}`,
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
           * Provision after the user insert commits so the new transaction can see it.
           * If provisioning fails, attempt to delete the identity and log cleanup
           * failure; this compensation is not atomic with the insert.
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
       * Resolve the approver from the granted session and delete that session in
       * finally. CLI login issues an Egma API key instead of retaining the session.
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
