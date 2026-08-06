/**
 * The terminal's half of the device flow: ask to be let in, then collect.
 *
 * A short code goes on the screen, a browser opens on it, somebody approves it
 * where they can see who they are and what they are approving, and this end
 * exchanges the code it was given for a key. No secret is ever typed into the
 * terminal, and nothing rides on a URL.
 *
 * Everything here speaks the public HTTP API and nothing else, which is what
 * lets the whole of login run against a fixture of that API in CI and against a
 * real instance unchanged.
 */

/** The one client egma issues device codes to, and the name it says. */
export const DEVICE_CLIENT_ID = "egma-cli";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export type DeviceGrant = {
  readonly deviceCode: string;
  readonly userCode: string;
  /** The address to approve at, with the code already in it. */
  readonly approveUrl: string;
  /** How long the code is worth approving, in seconds. */
  readonly expiresInSeconds: number;
  /** How long to leave between two collections, in seconds. */
  readonly intervalSeconds: number;
};

/** What one attempt to collect a key came back with. */
export type Collection =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "waiting" }
  | { readonly kind: "slow-down" }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" }
  | { readonly kind: "refused"; readonly reason: string };

/** The one thing this module needs from the world, so a test can stand in. */
export type Caller = typeof fetch;

/** A message a developer can act on, from a failure they cannot read. */
export class PlatformUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(
      `egma at ${url} did not answer. Check the address, and that the instance is running.`,
      { cause },
    );
    this.name = "PlatformUnreachableError";
  }
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function seconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/**
 * Start. Asks for a pair of codes and the address to send somebody to.
 *
 * The address comes back from the instance rather than being built here, so a
 * self-hosted egma sends people to itself and never to an address egma runs.
 */
export async function startDeviceAuthorization(
  url: string,
  call: Caller = fetch,
): Promise<DeviceGrant> {
  let response: Response;
  try {
    response = await call(`${url}/api/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
    });
  } catch (cause) {
    throw new PlatformUnreachableError(url, cause);
  }

  if (!response.ok) {
    const said = text((await bodyOf(response)).message);
    throw new Error(
      `egma at ${url} refused to start a login${said === "" ? "" : `: ${said}`}`,
    );
  }

  const body = await bodyOf(response);
  const deviceCode = text(body.device_code);
  const userCode = text(body.user_code);
  const approveUrl =
    text(body.verification_uri_complete) || text(body.verification_uri);

  if (deviceCode === "" || userCode === "" || approveUrl === "") {
    throw new Error(
      `egma at ${url} answered a login request without a code to approve`,
    );
  }

  return {
    deviceCode,
    userCode,
    approveUrl,
    expiresInSeconds: seconds(body.expires_in, 900),
    intervalSeconds: seconds(body.interval, 5),
  };
}

/**
 * Collect. Exchanges the device code for a key, or says what it is waiting on.
 *
 * The refusals are the protocol's own vocabulary, and each one means something
 * different to the person at the terminal: still waiting, polling too fast,
 * told no, and out of time are four outcomes and not one failure.
 */
export async function collectKey(
  url: string,
  deviceCode: string,
  call: Caller = fetch,
): Promise<Collection> {
  let response: Response;
  try {
    response = await call(`${url}/api/device/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
        client_id: DEVICE_CLIENT_ID,
      }).toString(),
    });
  } catch (cause) {
    throw new PlatformUnreachableError(url, cause);
  }

  const body = await bodyOf(response);

  if (response.ok) {
    const key = text(body.access_token);
    if (key === "") {
      return { kind: "refused", reason: "egma minted no key for this login" };
    }
    return { kind: "key", key };
  }

  switch (text(body.error)) {
    case "authorization_pending":
      return { kind: "waiting" };
    case "slow_down":
      return { kind: "slow-down" };
    case "access_denied":
      return { kind: "denied" };
    case "expired_token":
      return { kind: "expired" };
    default: {
      const said = text(body.error_description) || text(body.message);
      return {
        kind: "refused",
        reason: said === "" ? `egma refused this login (${response.status})` : said,
      };
    }
  }
}

/**
 * A code as the instance stored it.
 *
 * People read these off one screen and type or paste them into another, so a
 * hyphen, a space or a lower-case letter is a thing that happens rather than a
 * thing to refuse. This is the edge that takes the typing, so this is where it
 * is tidied up.
 */
export function normalizeUserCode(userCode: string): string {
  return userCode.replaceAll(/[^0-9A-Za-z]/gu, "").toUpperCase();
}

/**
 * The code inside whatever somebody pasted back, or `null` when there is none.
 *
 * On a machine with no browser of its own — a devbox, anything over SSH — the
 * address goes to a browser elsewhere, and what comes back to the terminal is
 * whatever was easiest to select over there. That is a whole address, or the
 * query part of one, or the eight characters read off the screen. All three
 * carry the same fact, so all three are accepted rather than one being called
 * the right one.
 */
export function codeFromPaste(pasted: string): string | null {
  const trimmed = pasted.trim();
  if (trimmed === "") return null;

  const query = trimmed.includes("?")
    ? trimmed.slice(trimmed.indexOf("?") + 1)
    : trimmed;
  const named = new URLSearchParams(query).get("user_code");
  if (named !== null) {
    const code = normalizeUserCode(named);
    return code === "" ? null : code;
  }

  // Nothing named a code, so what is left has to be the code itself: a few
  // groups of letters and digits, split the way a code is written down or read
  // out. An address that carried no code is not a code, and neither is a
  // sentence — both reach here, and both have to be turned away.
  if (!/^[0-9A-Za-z]{2,10}(?:[- ][0-9A-Za-z]{2,10}){0,3}$/u.test(trimmed)) return null;

  const code = normalizeUserCode(trimmed);
  return code.length < 4 || code.length > 32 ? null : code;
}
