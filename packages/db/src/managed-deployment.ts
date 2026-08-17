import { createHmac } from "node:crypto";

/**
 * The three facts about *this deployment* that managed model access needs, and
 * the one place they are held.
 *
 * They arrive through `connect()`, the same door the database URL and the
 * master key do, and for the same reason: work-order preparation and grading
 * preparation both read them, they live in two different processes, and a value
 * each process read out of its own environment separately is a value the two
 * can disagree about. One door, one holder, one answer.
 *
 * **What is here is deployment configuration and never a customer's.** Which
 * kind of deployment this is, where the Egma model gateway answers, and — on
 * hosted Egma — the key its own connections are signed with. No organization's
 * anything is in this file.
 */

export type ManagedDeployment = {
  /**
   * Whether this is hosted Egma, which is the deployment that operates the
   * gateway and owns the inference keys.
   *
   * **One flag, and it decides three things.** A new organization starts on
   * managed access rather than customer-owned; managed work is authorized by
   * the internal gateway credential rather than by a pasted inference key; and
   * inference keys can be created here at all. A self-hosted deployment does
   * none of the three, which is exactly what "hosted users paste nothing and
   * self-hosted users paste one key" means when it is written down as code.
   */
  readonly hosted: boolean;
  /**
   * Where the Egma model gateway answers, with no trailing slash — the address
   * a managed work order carries and a grader's judge is pointed at.
   *
   * `undefined` on a deployment that has not been told one, which is every
   * self-hosted deployment that has not connected managed access and is a
   * misconfiguration on a hosted one. Absent is a visible infrastructure error
   * at the claim that needed it, never a fallback to calling a provider
   * directly: a simulation quietly conducted on somebody else's account is
   * worse than one that failed with a reason.
   */
  readonly gatewayAddress: string | undefined;
  /**
   * The key this deployment signs its own gateway credentials with. Hosted
   * Egma's only; a self-hosted deployment presents its pasted inference key
   * instead and holds nothing here.
   */
  readonly internalGatewayKey: string | undefined;
};

const UNCONFIGURED: ManagedDeployment = {
  hosted: false,
  gatewayAddress: undefined,
  internalGatewayKey: undefined,
};

let held: ManagedDeployment = UNCONFIGURED;

/** Called by `connect()`. Nothing else sets this. */
export function holdManagedDeployment(deployment: ManagedDeployment): void {
  held = {
    hosted: deployment.hosted,
    gatewayAddress: deployment.gatewayAddress?.replace(/\/+$/, ""),
    internalGatewayKey: deployment.internalGatewayKey,
  };
}

/** Called by `disconnect()`, so a closed process holds nothing. */
export function releaseManagedDeployment(): void {
  held = UNCONFIGURED;
}

export function managedDeployment(): ManagedDeployment {
  return held;
}

/**
 * The static prefix every internal gateway credential starts with.
 *
 * It exists for the reason `egma_sk_` does: a value with a fixed shape can be
 * recognised in a log, a paste or a scan. It also tells the gateway's verifier
 * which of its two authentication stories a credential belongs to before it
 * spends a network round trip finding out.
 */
export const INTERNAL_GATEWAY_CREDENTIAL_PREFIX = "egma_ig_";

/**
 * How long one internal gateway credential is good for.
 *
 * **Bounded, and the bound is the whole reason it carries a time at all.** An
 * organization-scoped credential with no expiry is one that authorizes that
 * organization's model traffic forever if a work order is ever read by somebody
 * who should not have — and a work order is the one place it appears. Twelve
 * hours is far longer than any simulation this carries, so nothing in flight
 * can be cut off by it, and far shorter than forever.
 */
export const INTERNAL_GATEWAY_CREDENTIAL_SECONDS = 12 * 60 * 60;

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * The credential hosted Egma's own work orders carry: **the organization, and a
 * signature over it made with a key only this deployment and the gateway
 * hold.**
 *
 * `egma_ig_<payload>.<signature>`, where the payload names the organization and
 * the moment the credential stops being good.
 *
 * **The organization travels inside the signature and that is what makes it not
 * a caller's to choose.** The rule managed access rests on is that a header, a
 * query value, a path or a body can never say which organization a connection
 * acts for. This does not break it: what the caller presents is one opaque
 * credential, and the gateway reads an organization out of it only after the
 * signature has proved that this deployment wrote it. A caller who edits the
 * organization invalidates the signature, and a caller who cannot make a
 * signature cannot name an organization at all.
 *
 * **It is minted, never exchanged.** Nothing calls anything to get one — this
 * is a hash, computed where the work order is assembled — so there is no
 * per-simulation grant round trip, and no provider credential comes back
 * because none is asked for. It authenticates the gateway connection and does
 * nothing else.
 */
export function signInternalGatewayCredential(
  organizationId: string,
  key: string,
  now: Date = new Date(),
): string {
  const payload = JSON.stringify({
    o: organizationId,
    x: Math.floor(now.getTime() / 1000) + INTERNAL_GATEWAY_CREDENTIAL_SECONDS,
  });
  const encoded = base64url(payload);
  const signature = base64url(
    createHmac("sha256", key).update(encoded, "utf8").digest(),
  );
  return `${INTERNAL_GATEWAY_CREDENTIAL_PREFIX}${encoded}.${signature}`;
}

/**
 * The three names a deployment answers, read once and in one place.
 *
 * **One reader rather than one per service**, because the control plane and the
 * grading engine both prepare managed work and a name spelled differently in
 * two `config.ts` files is a deployment where the grader and the simulator
 * disagree about who Egma is. `EGMA_GATEWAY_INTERNAL_KEY` is deliberately the
 * same name the gateway itself reads: it is one secret, shared by the two ends
 * of one wire, and two names for it would be two things to rotate.
 */
export function managedDeploymentFrom(
  environment: Readonly<Record<string, string | undefined>>,
): ManagedDeployment {
  const said = (environment["EGMA_HOSTED"] ?? "").trim().toLowerCase();
  const hosted = said === "true" || said === "1" || said === "yes";
  const address = environment["EGMA_MODEL_GATEWAY_URL"]?.trim();
  const internal = environment["EGMA_GATEWAY_INTERNAL_KEY"]?.trim();

  /**
   * **A hosted deployment with no signing key refuses to start.**
   *
   * The two are one setting wearing two names: hosted Egma authorizes its own
   * managed work by signing a credential, and a hosted deployment that lost
   * the key it signs with would come up looking healthy, provision every new
   * organization onto Managed by Egma, and fail every one of their claims. The
   * shape of that failure is the reason it is loud here: a missing signing key
   * reads downstream as "this deployment was never told where its gateway is",
   * which sends an operator to the wrong setting.
   *
   * Loud at boot rather than at the first claim, on the master key's exact
   * terms one file over.
   */
  if (hosted && (internal === undefined || internal === "")) {
    throw new Error(
      "EGMA_HOSTED is on and EGMA_GATEWAY_INTERNAL_KEY is not set. A hosted deployment authorizes its own managed model traffic by signing a credential with that key, so without it every organization it creates starts on Managed by Egma and every one of their simulations fails at the gateway. Set it, or turn EGMA_HOSTED off.",
    );
  }

  return {
    hosted,
    gatewayAddress:
      address === undefined || address === ""
        ? undefined
        : securely("EGMA_MODEL_GATEWAY_URL", address),
    internalGatewayKey:
      internal === undefined || internal === "" ? undefined : internal,
  };
}

/**
 * An address managed traffic may be sent to, or a refusal.
 *
 * **`https:` unless it is loopback**, and both halves are deliberate. Managed
 * traffic carries a credential that authorizes Egma's provider accounts, and a
 * plain-text address puts that credential on the wire for anybody on the path;
 * a deployment that fell back to `http:` by a typo would leak it silently
 * rather than fail. Loopback is carved out because the deterministic suite runs
 * a real gateway on `127.0.0.1` over real sockets — and a test that had to be
 * given a certificate to prove a relay would be proving TLS setup instead.
 */
export function securely(name: string, address: string): string {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new Error(`${name} must be an absolute address, and "${address}" is not`);
  }
  if (parsed.protocol === "https:") return address;
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return address;
  throw new Error(
    `${name} must be an https address — it carries a credential that authorizes Egma's provider accounts, and a plain-text one puts that credential on the wire. Only a loopback address may be http:, which is what the deterministic suite uses.`,
  );
}

/**
 * The one place `http:` is allowed.
 *
 * **Anchored at both ends, and that is not pedantry.** A prefix test on
 * `127.` calls `127.0.0.1.attacker.example` loopback, and a host somebody else
 * controls would then be a legal plain-text destination for a credential that
 * authorizes Egma's provider accounts. So the whole hostname has to be the
 * loopback name or a complete loopback address, and nothing that merely starts
 * like one.
 */
export function isLoopback(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return (
    bare === "localhost" ||
    bare === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
  );
}
