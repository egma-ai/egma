import { ROLES, type Role } from "../schema/columns.ts";

/**
 * Who is asking, which customer, which project, what role.
 *
 * Every function this module exports that reads or writes a customer's data
 * takes one of these, and the module builds the tenancy predicates from it. A
 * caller cannot forget the filter because a caller cannot call without the
 * context, and cannot widen it because no exported function accepts one.
 *
 * The organization is resolved from the credential — the person's membership,
 * or the API key's own row — and never from a request payload, so a buggy or
 * malicious client cannot ask for another customer's data by asking nicely.
 *
 * Deliberately store-neutral. When the ClickHouse client arrives behind this
 * same boundary it takes this same context on the same terms.
 */
export type AuthContext = {
  /** egma's own user id. */
  readonly userId: string;
  readonly organizationId: string;
  /**
   * The project the caller is acting in, or **absent** — which is what an
   * organization-scoped credential means and is not the same as a default.
   *
   * A key is organization-scoped unless it names a project, and one that names
   * none is for the whole customer. Pointing it at *some* project instead —
   * the oldest, say — reads as harmless while every table is scoped by the
   * organization, and stops being harmless the moment a table is scoped by the
   * project: the key would then see one product area rather than the customer
   * it was minted for, silently, with nothing in the request to say so.
   *
   * It is `string | undefined` rather than optional so that the absence is a
   * case every construction site states and every reader has to answer. A
   * missing property would let a caller not think about it, which is the bug
   * this shape exists to prevent.
   */
  readonly projectId: string | undefined;
  readonly role: Role;
  readonly via: Via;
};

/**
 * How the caller proved who they are.
 *
 * `engine` is egma's own grading service, and it is one of the two values that
 * name no person. It proved nothing, because there is nobody for it to be: it
 * holds a grading claim — a work order egma issued to itself, naming the
 * organization and the project of one finished conversation — and
 * `claimGradingJobs` builds the context from that claim and from nothing the
 * service said. The word exists so that a context which came from a claim
 * rather than from a credential says so on its face, wherever it is read.
 *
 * `simulator` is its sibling for egma's own conductor of simulations, on
 * exactly the same terms: `claimSimulations` builds one per claimed row, from
 * the row's own tenancy and from nothing the service said. It exists as its
 * own word rather than reusing `engine` because the two services are answered
 * different capabilities — connection credentials open only to `simulator`,
 * while `engine` may write grading results — and one shared service identity
 * would make either boundary wider than its work.
 *
 * `monitoring` is the third of them, for background production ingestion.
 * `claimDueRetellMonitoringAgent` builds one from the project-owned Monitoring
 * setup and selected Retell agent, never from a simulation connection and
 * never from a caller-supplied customer identifier.
 *
 * It is its own word so that a context which came from claimed Monitoring work
 * says so wherever it is read, and so that it opens neither of the other two
 * services' capabilities: `resolveSimulationConnection` admits `simulator`,
 * and this is not it.
 *
 * The Retell key is opened only while a due selected agent is claimed. That
 * internal claim takes no customer identifier, so a caller cannot use a
 * context to open another project's Monitoring credential.
 */
export const VIA = [
  "session",
  "api_key",
  "engine",
  "simulator",
  "monitoring",
] as const;
export type Via = (typeof VIA)[number];

/**
 * The three roles, and the whole list. Every new person is an `admin`, so v1
 * behaves as though roles do not exist; what each one may do is `permissions.ts`.
 *
 * A role is never resolved from a credential. It is read from the person's
 * membership at the moment the context is built, which is what makes a demotion
 * reach every key that person ever minted on their next request.
 */
export { ROLES };
export type { Role };
