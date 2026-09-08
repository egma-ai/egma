import type { Transaction } from "../client.ts";
import type { UsagePaymentSource } from "../schema/billing.ts";
import type { AllowanceKind } from "./allowance.ts";

/**
 * The two ports billing plugs into, and the answers a deployment with no
 * billing gives.
 *
 * **The open product asks; only the cloud answers differently.** Egma measures
 * every provider request and counts every allowance on every deployment,
 * because that is the product. Whether a customer may start more work, and
 * whether a request costs somebody money, is a question about a plan and a
 * balance — and a self-hoster has neither. So the product calls two small
 * interfaces at the two seams it already has, and the adapters that ship with
 * it answer "yes, unlimited" and throw the numbers away.
 *
 * **Each port is one method's worth of vocabulary and everything else is
 * behind it.** A caller learns "may this organization start this kind of work"
 * and "here is what was spent"; plans, periods, balances, Stripe and the whole
 * of `ee/` sit on the other side. That is what makes the seam worth having:
 * the day billing arrives, no call site moves.
 *
 * **Nothing here asks whether this deployment is the cloud.** The adapter is
 * chosen from the presence of a setting, once, at boot — and the choosing
 * happens one layer out, in `apps/api`, because the cloud adapter lives in the
 * commercially licensed `ee/` package and this package may never import it.
 * See `billingIsConfigured` at the foot of this file, and ADR-0024.
 */

/** One allowance an organization has spent, and when it comes back. */
export type AllowanceRefusal = {
  readonly allowance: AllowanceKind;
  /** When this allowance resets, so the refusal can name a date. */
  readonly resetsAt: Date;
  /**
   * The sentence a person is shown, whole.
   *
   * Written where the refusal is decided rather than assembled by the caller,
   * for the reason a run refusal's is: the layer that shows it would have to
   * read the parts to rebuild the sentence, and the prose is the part
   * deliberately left free to improve.
   */
  readonly message: string;
};

/**
 * What is about to begin, asked once for a whole batch of it.
 *
 * The allowances are a set rather than one kind because the two seams that ask
 * are both batch-shaped: a run start knows the one lane its whole suite will
 * run over, and a claim batch can hold several organizations' work across
 * several lanes. Asking per simulation is the thing this shape exists to
 * prevent — see the claim path, where it would be a round trip per
 * conversation on the hot path of the queue.
 */
export type StartRequest = {
  readonly organizationId: string;
  readonly allowances: readonly AllowanceKind[];
};

/**
 * Yes, or which of the asked allowances is spent.
 *
 * A union rather than a possibly-empty list, so a caller cannot forget to look
 * at the length of an array and admit work an adapter refused.
 */
export type StartDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** One entry per refused allowance, in the order they were asked. */
      readonly refusals: readonly AllowanceRefusal[];
    };

/**
 * Whether Egma's own provider key may fund this work.
 *
 * The providers are named by the catalog's own words, and asked together for
 * the reason above: one simulation needs an LLM, a speech-to-text and a
 * text-to-speech provider, and the refusal a person is shown names all of the
 * ones without funding rather than the first.
 */
export type FundingRequest = {
  readonly organizationId: string;
  readonly providers: readonly string[];
};

export type FundingDecision =
  | { readonly funded: true }
  | {
      readonly funded: false;
      /** Which of the asked providers Egma's key may not fund. */
      readonly providers: readonly string[];
      readonly message: string;
    };

/**
 * Whether an organization may start a kind of work, and whether Egma's key may
 * pay for it.
 *
 * Two questions and not one, because they are asked at different moments about
 * different things: the first is about a plan's allowance and is asked before
 * any conversation begins, the second is about a balance and is asked about
 * the providers one piece of work needs.
 */
export type EntitlementSource = {
  mayStart(request: StartRequest): Promise<StartDecision>;
  mayPlatformKeyFund(request: FundingRequest): Promise<FundingDecision>;
};

/**
 * One stored, priced provider request, as the usage sink receives it.
 *
 * **Stored, and that word is load-bearing.** The sink receives what the write
 * durably stored. Notifications are at least once: exact replay retains the
 * same identity and an adapter must tolerate receiving it again.
 *
 * The record's own id travels with it because it is the stable name of this
 * piece of spend: a ledger row keyed on it can be written once and only once.
 */
export type StoredUsageRecord = {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  /** When the provider answered, off the evidence rather than off the write. */
  readonly occurredAt: Date;
  readonly provider: string;
  readonly model: string;
  /** Whose key paid. Only `platform` is anybody's bill but the customer's own. */
  readonly paymentSource: UsagePaymentSource;
  /** What it cost, in millionths of a US dollar, at the rate card. */
  readonly amountMicros: number;
};

/**
 * Where priced usage records go after they are stored.
 *
 * **It must not throw, and the caller guards anyway.** A record is a durable
 * row before the sink sees it, so a sink that failed has lost a delivery and
 * not a fact — everything it would have done can be rebuilt from the rows. A
 * sink that could fail a write, on the other hand, would turn a billing outage
 * into a simulator that cannot record what it spent.
 */
export type UsageSink = {
  receive(records: readonly StoredUsageRecord[]): Promise<void>;
};

/** Both ports, as one deployment holds them. */
export type BillingPlugIn = {
  readonly entitlements: EntitlementSource;
  readonly usage: UsageSink;
  organizationCreated(on: Transaction, organizationId: string): Promise<void>;
  /** A shared pricing failure makes billing facts unreliable until collection recovers. */
  pricingUnavailable?(): Promise<void>;
};

/**
 * The entitlement source of a deployment that does not bill: everything is
 * allowed and Egma's key funds everything.
 *
 * It is a real adapter and not a stub. A self-hoster runs on it forever, and
 * ADR-0024 requires that the open build resolve to a plan whose every limit is
 * unlimited rather than to a special case in the product.
 */
export function openEntitlementSource(): EntitlementSource {
  return {
    mayStart: () => Promise.resolve({ allowed: true }),
    mayPlatformKeyFund: () => Promise.resolve({ funded: true }),
  };
}

/**
 * The usage sink of a deployment that does not bill: the records are already
 * stored, and there is nothing else to do with them.
 */
export function discardingUsageSink(): UsageSink {
  return { receive: () => Promise.resolve() };
}

/** The plug-in a deployment with no billing runs on. */
export function openBillingPlugIn(): BillingPlugIn {
  return { entitlements: openEntitlementSource(), usage: discardingUsageSink(), organizationCreated: () => Promise.resolve() };
}

/**
 * Which plug-in a deployment with no Stripe secret runs on: the open one.
 *
 * **The selection itself is not here, and that is the point.** Naming a Stripe
 * secret selects the cloud adapter, which lives in the commercially licensed
 * `ee/` package — and this package is shared code, which may never import
 * `ee/`. So the choice is made one layer out, in `apps/api`, where a dynamic
 * import is taken only when the secret is set and the open product never loads
 * a line of the other package.
 *
 * What stays here is the half that belongs to everybody: with no secret named,
 * the plug-in is the open one, every allowance unlimited and every usage
 * record discarded. Nothing in this decision derives from whether this
 * deployment is Egma Cloud — a self-hoster who names the same secret gets the
 * same billing (ADR-0024).
 */
export type BillingSettings = {
  readonly stripeSecretKey?: string | undefined;
};

/** Whether these settings name a Stripe secret at all. */
export function billingIsConfigured(settings: BillingSettings): boolean {
  return (settings.stripeSecretKey?.trim() ?? "") !== "";
}

/**
 * The plug-in this process runs on.
 *
 * A module-level holder, like the Postgres pool one file over, and for the
 * same reason: it is chosen once at boot, every caller wants the same one, and
 * threading it through `startRun` and the record write from the process that
 * booted would mean a billing argument on every function between here and
 * there. It starts as the open plug-in, so a process that installs nothing —
 * a test, a self-hoster, a script — behaves exactly as it did before billing
 * existed.
 */
let installed: BillingPlugIn = openBillingPlugIn();

/**
 * Put a plug-in in place, and take back the way to undo it.
 *
 * The undo is what a test uses to put the deployment back the way it found it.
 * Boot calls this once and never calls what it returns.
 */
export function installBillingPlugIn(plugIn: BillingPlugIn): () => void {
  const previous = installed;
  installed = { ...plugIn, entitlements: faultTolerantEntitlements(plugIn.entitlements) };
  return () => {
    installed = previous;
  };
}

/**
 * The installed plug-in. Internal: the product reaches billing through the two
 * seams that ask it something, and a caller that could fetch the plug-in could
 * ask it anything from anywhere.
 */
export function billing(): BillingPlugIn {
  return installed;
}

/** Isolate adapter faults at the work-admission boundary. */
export function faultTolerantEntitlements(source: EntitlementSource): EntitlementSource {
  return {
    async mayStart(request) {
      try { return await source.mayStart(request); }
      catch (fault) {
        console.error("Billing admission failed; customer work continues", fault);
        return { allowed: true };
      }
    },
    async mayPlatformKeyFund(request) {
      try { return await source.mayPlatformKeyFund(request); }
      catch (fault) {
        console.error("Billing funding check failed; customer work continues", fault);
        return { funded: true };
      }
    },
  };
}
