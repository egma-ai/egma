/**
 * The project's judge, as `GET /api/judge` answers it — and the organization's
 * judge credentials, which are the keys behind it.
 *
 * **Nothing in this file can hold a key**, and that is deliberate rather than
 * incidental: the API's read shape has no field a secret could travel in, so
 * neither does this. What a page ever has is a label, a provider, and four
 * characters — enough to tell two keys apart when deciding which project should
 * spend from which, and not enough to be one.
 *
 * A stored secret goes in one direction only. Replacing a key is sending a new
 * value; it is never reading the old one and writing it back.
 */

export type JudgeSource = "credential" | "platform";

/** The word a project uses to name the deployment's own judge. */
export const PLATFORM_SOURCE = "platform";

export type JudgeCredential = {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  /** The last characters of the key. Never enough of it to use. */
  readonly hint: string;
  readonly revision: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export type JudgeCredentialPage = {
  readonly items: readonly JudgeCredential[];
};

/**
 * What the project's judge is, or the explicit state of having none.
 *
 * `needs_setup` is a state and not a failure: a project in it still runs every
 * deterministic grader it has, and what it cannot do is ask a model anything —
 * which means the built-in expected-behaviors grader cannot judge, and a run
 * started this way would produce errored verdicts after real calls had been
 * paid for. So a page says so plainly rather than showing an empty form.
 */
export type ProjectJudge =
  | {
      readonly state: "needs_setup";
      readonly provider: null;
      readonly model: null;
      readonly source: null;
      readonly credential_id: null;
      readonly hint: null;
    }
  | {
      readonly state: "configured";
      readonly project_id: string;
      readonly provider: string;
      readonly model: string;
      readonly source: JudgeSource;
      readonly credential_id: string | null;
      /** Null for the deployment's own judge, which is not a customer's key. */
      readonly hint: string | null;
      readonly updated_at: string;
    };

export type JudgeRegistry = {
  readonly providers: readonly {
    readonly provider: string;
    readonly model_is_free_text: boolean;
  }[];
  readonly platform_sentinel: string;
  /**
   * Whether this deployment configured a judge of its own, and therefore
   * whether the sentinel may be chosen at all.
   *
   * **A fact about the deployment, never about the project's current choice.**
   * Deciding it from the project — "show the option if the project is already
   * on it" — makes moving to a key of your own a one-way door: the option
   * disappears the moment you stop using it, and the way back is unreachable
   * from the page that exists to take it.
   */
  readonly platform_judge_available: boolean;
};

export const JUDGE_PATH = "/api/judge";
export const JUDGE_REGISTRY_PATH = "/api/judge/registry";
export const JUDGE_CREDENTIALS_PATH = "/api/judge-credentials";

export function judgeCredentialPath(credentialId: string): string {
  return `${JUDGE_CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}`;
}

/**
 * Taking a credential out of use.
 *
 * Its own address rather than a field on the edit, because it is a different
 * kind of decision: a relabel or a rotation always succeeds, and this is
 * refused while a project points at the credential, while a run whose frozen
 * grading plan names it still has a conversation moving, or while a grading job
 * is waiting to be judged or already claimed. The refusal names every blocking
 * use and the page shows it word for word.
 */
export function judgeCredentialArchivePath(credentialId: string): string {
  return `${judgeCredentialPath(credentialId)}/archive`;
}

/**
 * The credentials an answer actually carried, and none at all when it carried
 * something this page cannot read.
 *
 * **A read whose shape is not the expected one is a deployment mid-upgrade, a
 * proxy answering for something else, or a write's own reply arriving where a
 * list was asked for.** The cost of trusting it is not a wrong list — it is
 * `undefined.filter`, which takes the whole settings page down and with it the
 * judge somebody came to change. An empty list renders an honest state; a crash
 * renders nothing at all, which is strictly worse than saying there is nothing.
 */
export function credentialsIn(page: JudgeCredentialPage | undefined): readonly JudgeCredential[] {
  return Array.isArray(page?.items) ? page.items : [];
}

/**
 * Which credentials a judge of this provider may be pointed at.
 *
 * A key issued by one provider cannot answer for a judge configured to ask
 * another, so offering it would be offering a setting the server will refuse.
 * The server refuses it anyway — that is where the boundary is — and this only
 * keeps somebody from choosing it.
 *
 * It tolerates an absent list for the reason above: this is called on every
 * render, from a value an in-flight read can leave in any shape, and a filter
 * that assumed an array would be the one line that decides whether the page
 * exists.
 */
export function credentialsFor(
  credentials: readonly JudgeCredential[] | undefined,
  provider: string,
): readonly JudgeCredential[] {
  if (!Array.isArray(credentials)) return [];
  return credentials.filter((credential) => credential.provider === provider);
}

/**
 * How a credential is named where one has to be chosen: what it is called, and
 * the four characters that tell it from the other one.
 */
export function credentialLabel(credential: JudgeCredential): string {
  return `${credential.label} (…${credential.hint})`;
}

/**
 * Whether this judge is the deployment's own — the one case with no hint, no
 * rotation, and nothing for a customer to manage.
 */
export function isPlatformJudge(judge: ProjectJudge | null): boolean {
  return judge?.state === "configured" && judge.source === PLATFORM_SOURCE;
}

/**
 * Whether a judge choice is complete enough to send.
 *
 * A source is required because a judge with no key behind it is a project that
 * reads as judged and cannot judge — which is the failure `needs_setup` exists
 * to state honestly rather than to hide behind a half-filled form.
 */
export function isChoiceComplete(choice: {
  readonly provider: string;
  readonly model: string;
  readonly source: string;
}): boolean {
  return (
    choice.provider.trim() !== "" &&
    choice.model.trim() !== "" &&
    choice.source.trim() !== ""
  );
}
