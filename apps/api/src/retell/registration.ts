import {
  recordRetellWebhookRegistration,
  resolveRetellWatch,
  type AuthContext,
} from "@egma/db";

import { RETELL_WEBHOOK_PATH } from "../routes/retell-webhook.ts";
import { setAgentWebhook, type RetellReach } from "./api.ts";

/**
 * Automatic registration: at switch-on egma points the agent's webhook at
 * itself, and at switch-off it takes it away again.
 *
 * **A deployment with no public address is not a deployment with a problem.**
 * egma self-hosts, and a laptop behind NAT can never receive a webhook — so
 * pull is the transport there, watching works exactly as well, and switch-on
 * completes silently. There is no warning, because there is nothing wrong: a
 * warning dressed as an error would tell a self-hoster their setup is broken
 * when it is the setup this product was shaped around.
 *
 * Registration failing is the same kind of event. The switch is already on and
 * the poller is already the floor, so a Retell that would not take the update
 * costs the seconds a webhook would have saved and nothing else. It is logged
 * and it is not raised: nobody's conversations are lost by it.
 *
 * **The escape hatch is documented rather than built.** A deployment that has
 * a public address egma cannot work out for itself pastes the endpoint into
 * Retell's own dashboard, and the receiving endpoint behaves identically —
 * because the endpoint has no idea which of the two put it there.
 */

/**
 * The hosts a deployment is reached at from inside itself, and from nowhere
 * else.
 *
 * Retell has to be able to reach the address, so these are exactly the ones
 * that cannot be registered. Everything else is taken at its word: whether a
 * host on somebody's own network is reachable from Retell is a question about
 * their network, and egma guessing at it would refuse deployments that work.
 */
const UNREACHABLE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** Private ranges, which no provider on the internet can deliver to. */
const PRIVATE_HOST =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u;

/**
 * Where Retell would deliver, or `undefined` when this deployment has no
 * address a provider could reach.
 *
 * Worked out from the origin egma is already configured with rather than from a
 * setting of its own. The platform-address effort — written, unbuilt — is what
 * will one day answer this properly for a deployment behind a tunnel; until it
 * lands, this is the honest answer from what the deployment already knows, and
 * the dependency is one-way and graceful.
 */
export function publicWebhookAddress(baseUrl: string): string | undefined {
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    return undefined;
  }

  const host = origin.hostname.toLowerCase();
  if (UNREACHABLE_HOSTS.has(host) || PRIVATE_HOST.test(host)) return undefined;
  // A bare hostname with no dot in it is a name on somebody's own network —
  // `egma`, a container name, a Kubernetes service — and not one Retell could
  // resolve.
  if (!host.includes(".")) return undefined;

  return `${origin.origin}${RETELL_WEBHOOK_PATH}`;
}

export type RegistrationOutcome =
  /** The webhook now points at this deployment. */
  | { readonly kind: "registered"; readonly url: string }
  /** It no longer does. */
  | { readonly kind: "deregistered" }
  /** No public address, so pull is the transport. Nothing is wrong. */
  | { readonly kind: "pull-only" }
  /** Retell would not take the change. The switch stands; pull is the floor. */
  | { readonly kind: "not-taken"; readonly reason: string };

/**
 * Bring the provider's webhook into line with the switch that was just
 * flipped.
 *
 * It reads the connection back through the watch resolver rather than being
 * handed a key, because that resolver is the one door to a watched
 * connection's plaintext credential and there is no reason to open a second.
 */
export async function reconcileRetellWebhook(
  auth: AuthContext,
  connectionId: string,
  watching: boolean,
  baseUrl: string,
  reach: RetellReach = {},
): Promise<RegistrationOutcome> {
  const [target] = await resolveRetellWatch({ connectionId });
  if (target === undefined) return { kind: "pull-only" };

  if (!watching) {
    const answer = await setAgentWebhook(
      target.apiKey,
      target.retellAgentId,
      null,
      reach,
    );
    // The stamp was already cleared by the switch-off itself, so there is
    // nothing to write here — the row and the provider now agree.
    return answer.kind === "registered"
      ? { kind: "deregistered" }
      : {
          kind: "not-taken",
          reason: answer.kind === "invalid-key" ? "the key was refused" : answer.reason,
        };
  }

  const url = publicWebhookAddress(baseUrl);
  if (url === undefined) return { kind: "pull-only" };

  const answer = await setAgentWebhook(
    target.apiKey,
    target.retellAgentId,
    url,
    reach,
  );
  if (answer.kind !== "registered") {
    return {
      kind: "not-taken",
      reason: answer.kind === "invalid-key" ? "the key was refused" : answer.reason,
    };
  }

  await recordRetellWebhookRegistration(auth, connectionId, new Date());
  return { kind: "registered", url };
}
