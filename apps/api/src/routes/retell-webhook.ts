import {
  countRetellWebhookRefusal,
  recordRetellWebhookDelivery,
  resolveRetellWatch,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { RetellCall } from "../retell/normalise.ts";
import {
  RETELL_SIGNATURE_HEADER,
  verifyRetellSignature,
} from "../retell/signature.ts";
import { writeRetellCall } from "../retell/write.ts";

/**
 * The webhook door: where Retell delivers a conversation the moment it ends.
 *
 * **Nobody is authenticated at this door and nobody can be.** There is no egma
 * credential on a Retell delivery — the whole job here is to find out whose
 * conversation this is, and the answer is arrived at in two steps, in this
 * order:
 *
 *  1. **Which connections could this be?** The event names a Retell agent id.
 *     Every switched-on Retell connection naming that agent is a candidate, and
 *     there can legitimately be several — one Retell agent watched from two
 *     projects is two connections, and each stores its own copy into its own
 *     project.
 *  2. **Which of them signed it?** Retell signs the body with the account's own
 *     API key, so the candidate whose sealed key verifies the raw bytes is one
 *     this delivery actually belongs to. A candidate whose key does not verify
 *     is not, and no other part of the delivery is believed about whose it is.
 *
 * Everything that fails either step is **refused and counted, never stored**:
 * an agent no connection names, a connection whose switch is off, and a body
 * nobody's key signed. And only `call_ended` writes — a conversation lands
 * complete or not at all, so `call_started` is acknowledged and dropped, and
 * `call_analyzed` is deliberately ignored, because Retell's analysis is
 * Retell's judgment and judgment in egma belongs to graders.
 *
 * **Every answer is 200, refusals included.** A provider retries a non-2xx, and
 * there is nothing for Retell to usefully retry about a delivery egma has
 * decided is not its business: a 4xx here would buy a retry storm and an alert
 * on the customer's side about a door working exactly as intended. What was
 * refused is on egma's own counter, where somebody debugging can read it.
 */

/** The address Retell delivers to, and the one registration points at. */
export const RETELL_WEBHOOK_PATH = "/api/webhooks/retell";

/**
 * The largest delivery egma reads.
 *
 * A Retell call object carries a whole transcript with its tool calls, which is
 * tens of kilobytes on a long conversation. A megabyte is generous against
 * that and small enough that an unauthenticated door cannot be made to hold
 * much.
 */
const MAXIMUM_BODY_BYTES = 1024 * 1024;

/** The one event kind that writes. Every other kind is acknowledged and dropped. */
const WRITES = "call_ended";

function objectIn(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const held = (value as Record<string, unknown>)[key];
  return typeof held === "object" && held !== null && !Array.isArray(held)
    ? (held as Record<string, unknown>)
    : undefined;
}

function textIn(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const held = (value as Record<string, unknown>)[key];
  return typeof held === "string" ? held : "";
}

export async function retellWebhookRoutes(app: FastifyInstance): Promise<void> {
  // The body reaches the handler as the bytes that were sent, because the
  // signature is over those bytes: a parsed-and-reserialised body can mean the
  // same thing and hash differently. Registered inside this plugin's scope,
  // which is what keeps every other route's parser intact.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: MAXIMUM_BODY_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post(RETELL_WEBHOOK_PATH, async (request, reply) => {
    const acknowledged = (stored: boolean) =>
      reply.code(200).send({ received: true, stored });

    const raw = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }

    const call = objectIn(body, "call") as RetellCall | undefined;
    const retellAgentId = call === undefined ? "" : textIn(call, "agent_id");

    // Every Retell connection on the deployment naming this agent, switched on
    // or not — read in one pass, because "switched off" and "never heard of it"
    // are two different refusals and both have to be countable.
    const named =
      retellAgentId === ""
        ? []
        : (await resolveRetellWatch({ everyConnection: true })).filter(
            (target) => target.retellAgentId === retellAgentId,
          );

    if (named.length === 0) {
      await countRetellWebhookRefusal("unknown_agent");
      return acknowledged(false);
    }

    const candidates = named.filter((target) => target.watching);
    if (candidates.length === 0) {
      await countRetellWebhookRefusal("switched_off");
      return acknowledged(false);
    }

    const offered = request.headers[RETELL_SIGNATURE_HEADER];
    const signature = Array.isArray(offered) ? offered[0] : offered;
    const signed = candidates.filter((target) =>
      verifyRetellSignature(raw, target.apiKey, signature),
    );

    if (signed.length === 0) {
      await countRetellWebhookRefusal("bad_signature");
      return acknowledged(false);
    }

    // A delivery that verified is a delivery that arrived, whatever kind it is,
    // so the cadence drops even on the kinds egma does not write. That is the
    // honest reading of it: webhooks are flowing, and the poller is the safety
    // net rather than the transport.
    for (const target of signed) {
      await recordRetellWebhookDelivery(target.auth, target.connectionId);
    }

    if (textIn(body, "event") !== WRITES || call === undefined) {
      await countRetellWebhookRefusal("other_kind");
      return acknowledged(false);
    }

    let stored = 0;
    for (const target of signed) {
      const outcome = await writeRetellCall(target, call, "webhook");
      if (outcome.kind === "written") stored += 1;
    }

    return acknowledged(stored > 0);
  });
}
