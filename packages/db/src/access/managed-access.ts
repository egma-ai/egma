import { db } from "../client.ts";
import {
  managedDeployment,
  signInternalGatewayCredential,
} from "../managed-deployment.ts";
import { managedAccessKey } from "../schema/models.ts";
import { openCredentials, sealCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import {
  ManagedAccessBoundElsewhereError,
  ManagedAccessNotConnectedError,
  ManagedAccessUnavailableError,
  UnprocessableInputError,
} from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { within } from "./within.ts";

/**
 * How this organization reaches the Egma model gateway, and the one door that
 * opens the credential for the services that use it.
 *
 * Two deployments, two answers, one seam:
 *
 * - **hosted Egma** signs an organization-scoped credential with a key only it
 *   and the gateway hold. Nothing is stored per organization, nothing is
 *   pasted, and there is nothing an administrator has to do — which is exactly
 *   what "a hosted user pastes nothing" has to mean in code.
 * - **a self-hosted deployment** presents the one inference key its
 *   administrator connected, sealed in its own Postgres and opened only here.
 *
 * **Neither answer is ever a provider credential.** Egma's own provider keys
 * live inside the gateway and this module has no way to reach one, which is the
 * property the whole arrangement exists to hold: the simulator and the grader
 * authenticate to the gateway, and the gateway authenticates to the provider.
 */

/** What a person may see about a self-hosted organization's connection. */
export type ManagedAccessConnection = {
  /** Whether an inference key is connected at all. */
  readonly connected: boolean;
  /** The last characters of the connected key, or null where none is. */
  readonly hint: string | null;
  /** The Egma Cloud organization this deployment is bound to, or null. */
  readonly cloudOrganizationId: string | null;
  readonly updatedAt: Date | null;
};

const NOT_CONNECTED: ManagedAccessConnection = {
  connected: false,
  hint: null,
  cloudOrganizationId: null,
  updatedAt: null,
};

/**
 * The organization's managed-access connection, as anybody in it reads it.
 *
 * **Connected, a hint, and the binding. Never the key.** The shape has no field
 * a secret could travel in — the sealed envelope is not selected and not
 * returned — so a page, a log or a serializer has nothing to leak. Readable at
 * every role for the reason the access mode is: which of two words is on this
 * row is not a secret, and somebody looking at a persona's models has to be
 * able to see who supplies the credential behind them.
 */
export async function readManagedAccessConnection(
  auth: AuthContext,
): Promise<ManagedAccessConnection> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select({
      hint: managedAccessKey.credentialsHint,
      cloudOrganizationId: managedAccessKey.cloudOrganizationId,
      updatedAt: managedAccessKey.updatedAt,
    })
    .from(managedAccessKey)
    .where(within(auth, managedAccessKey))
    .limit(1);

  return row === undefined
    ? NOT_CONNECTED
    : {
        connected: true,
        hint: row.hint,
        cloudOrganizationId: row.cloudOrganizationId,
        updatedAt: row.updatedAt,
      };
}

/** Enough of the tail to tell two keys apart in a list, and no more. */
const HINT_LENGTH = 4;

export type ConnectManagedAccess = {
  /** The inference key, in the clear, on its way into the envelope. */
  readonly key: string;
  /**
   * Which Egma Cloud organization validation said owns this key.
   *
   * **Answered by Egma Cloud and never by whoever pasted the key.** The caller
   * has already made the one content-free validation request and is passing on
   * what came back; this module writes it down so that the *next* key has
   * something to be checked against.
   */
  readonly cloudOrganizationId: string;
};

/**
 * Connect an inference key, or replace the one already connected.
 *
 * **Only an `admin`**, on the same row of the permission table that names model
 * access and provider credentials: this decides whose provider account every
 * simulation in the organization spends from.
 *
 * **The binding is enforced here and is the reason the cloud organization is
 * stored.** A deployment that has connected one Egma Cloud organization's key
 * refuses another organization's outright rather than switching to it. Managed
 * traffic silently moving onto a different customer's provider account is not a
 * thing an accidental paste should be able to do, so the way to change it is to
 * disconnect first — a deliberate act, on its own, with its own confirmation.
 *
 * Replacing a key from the *same* Egma Cloud organization is ordinary rotation
 * and lands without ceremony: that is the second half of "rotation can overlap
 * safely", the first half being that Egma Cloud keeps the old key working until
 * somebody revokes it.
 */
export async function connectManagedAccess(
  auth: AuthContext,
  input: ConnectManagedAccess,
): Promise<ManagedAccessConnection> {
  authorize(auth, "manage_organization", here(auth));

  const key = input.key.trim();
  if (key === "") {
    throw new UnprocessableInputError(
      "connecting managed access needs the inference key Egma Cloud showed you when you created it",
    );
  }

  const [existing] = await db()
    .select({ cloudOrganizationId: managedAccessKey.cloudOrganizationId })
    .from(managedAccessKey)
    .where(within(auth, managedAccessKey))
    .limit(1);

  if (
    existing !== undefined &&
    existing.cloudOrganizationId !== input.cloudOrganizationId
  ) {
    throw new ManagedAccessBoundElsewhereError(existing.cloudOrganizationId);
  }

  const now = new Date();
  const [row] = await db()
    .insert(managedAccessKey)
    .values({
      organizationId: auth.organizationId,
      cloudOrganizationId: input.cloudOrganizationId,
      credentials: sealCredentials({ key }),
      credentialsHint: key.slice(-HINT_LENGTH),
      connectedBy: auth.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: managedAccessKey.organizationId,
      set: {
        cloudOrganizationId: input.cloudOrganizationId,
        credentials: sealCredentials({ key }),
        credentialsHint: key.slice(-HINT_LENGTH),
        connectedBy: auth.userId,
        updatedAt: now,
      },
    })
    .returning({
      hint: managedAccessKey.credentialsHint,
      cloudOrganizationId: managedAccessKey.cloudOrganizationId,
      updatedAt: managedAccessKey.updatedAt,
    });

  if (row === undefined) {
    throw new Error("the organization's managed-access key was not written");
  }
  return {
    connected: true,
    hint: row.hint,
    cloudOrganizationId: row.cloudOrganizationId,
    updatedAt: row.updatedAt,
  };
}

/**
 * Take the connection away.
 *
 * Nothing is scanned first and nothing else is changed — in particular the
 * organization's model access is left exactly as it was. Disconnecting while on
 * managed access leaves an organization whose next claim has no credential to
 * present, and that lands as a visible infrastructure error naming what to
 * reconnect. That is a better answer than this function quietly deciding
 * somebody's access mode for them.
 */
export async function disconnectManagedAccess(
  auth: AuthContext,
): Promise<boolean> {
  authorize(auth, "manage_organization", here(auth));

  const removed = await db()
    .delete(managedAccessKey)
    .where(within(auth, managedAccessKey))
    .returning({ organizationId: managedAccessKey.organizationId });

  return removed.length > 0;
}

/** Where the traffic goes, and what authorizes it. Nothing else. */
export type ResolvedManagedAccess = {
  /** The Egma model gateway's address, with no trailing slash. */
  readonly gatewayAddress: string;
  /**
   * The credential this connection presents: hosted Egma's signed internal
   * credential, or the organization's own inference key.
   *
   * **Never an upstream provider secret.** There is no code path from here to
   * one: Egma's provider credentials are the gateway's deployment secrets and
   * this process cannot read them.
   */
  readonly credential: string;
};

/**
 * The one door to a managed-access credential, and **Egma's own two services
 * are the only things that may knock.**
 *
 * The gate is the model-provider key's, verbatim, and for the same reason: the
 * only things Egma does with a gateway credential are conduct a simulation and
 * judge one, and the only things that do either are the simulator and the
 * grading engine. So the check is on how the caller came to exist rather than
 * on what their role permits — a context built from a simulation claim says
 * `simulator` on its face and one built from a grading claim says `engine`, and
 * every other context in the product, a person's session and an `admin` alike,
 * is refused. There is no product surface that hands anybody this value back,
 * and this is what keeps it that way while roles move around.
 *
 * Two typed refusals rather than one, because they are two different repairs.
 * A deployment with no gateway address is Egma misconfigured; an organization
 * on managed access with nothing connected is an administrator with one thing
 * to paste.
 */
export async function resolveManagedAccess(
  auth: AuthContext,
): Promise<ResolvedManagedAccess> {
  authorize(auth, "read", here(auth));

  if (auth.via !== "simulator" && auth.via !== "engine") {
    throw new Error(
      "a managed-access credential is opened for Egma's simulator or its grading engine and for nothing else, because conducting and judging are the only things Egma does with one",
    );
  }

  const deployment = managedDeployment();
  if (deployment.gatewayAddress === undefined) {
    throw new ManagedAccessUnavailableError();
  }

  if (deployment.hosted) {
    if (deployment.internalGatewayKey === undefined) {
      throw new ManagedAccessUnavailableError();
    }
    return {
      gatewayAddress: deployment.gatewayAddress,
      credential: signInternalGatewayCredential(
        auth.organizationId,
        deployment.internalGatewayKey,
      ),
    };
  }

  const [row] = await db()
    .select({ credentials: managedAccessKey.credentials })
    .from(managedAccessKey)
    .where(within(auth, managedAccessKey))
    .limit(1);

  if (row === undefined) throw new ManagedAccessNotConnectedError();

  return {
    gatewayAddress: deployment.gatewayAddress,
    credential: openedKey(row.credentials),
  };
}

/**
 * One envelope opened, or a fault saying the row is broken.
 *
 * A row that will not open is Egma being broken rather than the customer being
 * unconnected, so it throws rather than reading as "connect a key" — which
 * would tell an administrator to paste something they already pasted.
 */
function openedKey(sealed: string): string {
  const opened = openCredentials(sealed);
  const key =
    typeof opened === "object" && opened !== null && !Array.isArray(opened)
      ? (opened as Record<string, unknown>)["key"]
      : undefined;

  if (typeof key !== "string" || key === "") {
    throw new Error(
      "the organization's managed-access key holds a value in a shape Egma never writes; reconnect managed access under Model providers",
    );
  }
  return key;
}

/**
 * Whether this organization can choose managed access at all right now.
 *
 * **A fact about the deployment and this organization's connection, never about
 * whether anything would work.** Hosted Egma is always available: it operates
 * the gateway and signs its own credentials, so there is nothing to connect. A
 * self-hosted deployment is available once an inference key is connected, and
 * not before — which is what the setting refuses on, so that a form never
 * offers a choice the server will turn down.
 */
export async function managedAccessAvailable(
  auth: AuthContext,
): Promise<boolean> {
  if (managedDeployment().hosted) return true;
  return (await readManagedAccessConnection(auth)).connected;
}
