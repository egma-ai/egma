/**
 * The graders of one project, as `/api/grader-library` and `/api/graders`
 * answer them.
 *
 * **Two levels, and keeping them apart is the whole of this file.** A
 * **grader library** entry is a definition sitting on a shelf: the judge
 * prompt, the kind of judgment, and what pressing **Use** asks for. A
 * **grader** is a running copy of one — the row that actually judges this
 * project, and the row a verdict names. Pressing Use is what turns the first
 * into the second, and deleting the copy is what stops it judging. There is no
 * enable flag anywhere, because a copy that exists is a copy that judges.
 *
 * **Every read here names a project**, like every other product read. A library
 * entry egma ships belongs to nobody in particular, so the shelf reads the same
 * in every project — but a running copy is the project's own, and a screen that
 * asked for "the graders" without saying which project would be a screen that
 * showed one project's judging under another's address.
 *
 * The shape is the API's own, field names included. Renaming its fields on the
 * way in would put a second vocabulary between the contract and the page, and
 * the two would drift the first time the API grew a field.
 */

/**
 * One value an entry's **Use** form asks for, exactly as the entry declares it.
 *
 * **The form is drawn from this and never written by a page.** Latency declares
 * a measure from egma's catalog and a bound; the expected-behaviors entry
 * declares nothing, because its assertions are each test's own sentences. A
 * dropdown whose options were typed into a browser would be a second copy of
 * the measure catalog, wrong the first time a measure joined or left — and the
 * first sign of it would be a write refused for offering exactly what the form
 * offered.
 */
export type GraderParameter = {
  readonly name: string;
  readonly label: string;
  readonly kind: string;
  readonly means: string;
  /** Present on a parameter that is one of a list; absent on one typed into. */
  readonly options?: readonly {
    readonly value: string;
    readonly label: string;
    readonly means: string;
    readonly unit: string;
  }[];
};

/** One entry on the shelf. */
export type LibraryEntry = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** `llm_as_judge` or `code`, as the schema and the API speak it. */
  readonly type: string;
  /** `egma` or `organization`, derived from tenancy and stored nowhere. */
  readonly owner: string;
  /**
   * What pressing Use asks for. Absent on an answer from an older platform,
   * which is an entry whose form asks nothing rather than a page that breaks.
   */
  readonly params?: readonly GraderParameter[];
};

export type LibraryPage = {
  readonly items: readonly LibraryEntry[];
  readonly next_cursor: string | null;
};

/**
 * One running copy: what this project is judged by.
 *
 * `library_id` is what the row *is* — the pointer its definition is read
 * through at judging time — so a renamed copy is still a copy of the same
 * entry. `config` holds the copy's own filled-in values and never a definition:
 * the judge prompt lives on the entry, in one place, and this is not it.
 */
export type RunningGrader = {
  readonly id: string;
  readonly library_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: string;
  /** `false` is a diagnostic: judged, shown, and never able to fail a test. */
  readonly required: boolean;
  /** `simulations`, `production` or `both`. */
  readonly scope: string;
  /** What share of live traffic it judges, as a whole percentage. */
  readonly production_sample_rate: number;
  readonly config: { readonly assertions?: readonly unknown[] } | null;
  /**
   * This copy's own LLM selection, or `null` for one still on the
   * compatibility path — where the project's judge setting decides, exactly as
   * it did before the model catalog existed.
   *
   * **There is no key beside it and there never will be.** The key behind the
   * selection is the organization's, under Model providers, and a grader that
   * named one would put a secret inside authored content a run then pins.
   */
  readonly model: {
    readonly provider: string;
    readonly model: string;
  } | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type RunningPage = {
  readonly items: readonly RunningGrader[];
  readonly next_cursor: string | null;
};

export const GRADER_LIBRARY_PATH = "/api/grader-library";
export const GRADERS_PATH = "/api/graders";

/**
 * One running copy's own address: where an edit changes what it judges by and
 * a delete switches it off.
 */
export function graderPath(graderId: string): string {
  return `${GRADERS_PATH}/${graderId}`;
}

export function libraryAfter(cursor: string): string {
  return `${GRADER_LIBRARY_PATH}?cursor=${encodeURIComponent(cursor)}`;
}

export function gradersAfter(cursor: string): string {
  return `${GRADERS_PATH}?cursor=${encodeURIComponent(cursor)}`;
}

/** Where the two grader screens live inside one project. */
export const GRADERS_SECTION = "graders";
export const RUNNING_GRADERS_STEP = "running";

/**
 * What was typed into a Use form, as the API takes it: text stays text, a
 * number becomes one.
 *
 * **A number is sent as a number.** An input's value is a string, and a bound
 * arriving as `"2000"` is refused by the write door with a message about types
 * — correct, and useless to somebody who typed a perfectly good number. The
 * conversion happens once, here, at the edge that knows the control was
 * numeric.
 *
 * A parameter left blank is left out rather than sent empty, so the refusal a
 * developer reads is the entry's own — "this grader needs a bound" — rather
 * than one about the empty string.
 */
export function filledParams(
  params: readonly GraderParameter[],
  filled: Readonly<Record<string, string>>,
): Record<string, string | number> {
  const written: Record<string, string | number> = {};
  for (const parameter of params) {
    const typed = filled[parameter.name] ?? "";
    if (typed.trim() === "") continue;
    written[parameter.name] =
      parameter.kind === "number" ? Number(typed) : typed.trim();
  }
  return written;
}

/** The first option of each list, which is what a dropdown shows unchosen. */
export function firstChoices(
  params: readonly GraderParameter[],
): Record<string, string> {
  const chosen: Record<string, string> = {};
  for (const parameter of params) {
    const first = parameter.options?.[0];
    if (first !== undefined) chosen[parameter.name] = first.value;
  }
  return chosen;
}

/**
 * The unit a typed value is counted in: the unit of the option that was chosen.
 *
 * **Only where exactly one parameter offers options**, and that restraint is
 * the point. Nothing in an entry's declaration says which typed value belongs
 * to which choice — an entry asking for two measures and two bounds would be
 * four parameters with no link between them — so with more than one list to
 * choose from there is no honest answer and this gives none. Matching any
 * filled value against any parameter's options is a guess that happens to be
 * right while exactly one list exists, and is wrong silently the day a second
 * one arrives.
 */
export function unitOf(
  params: readonly GraderParameter[],
  filled: Readonly<Record<string, string>>,
): string | undefined {
  const listed = params.filter((parameter) => parameter.options !== undefined);
  if (listed.length !== 1) return undefined;
  const only = listed[0];
  if (only === undefined) return undefined;
  return only.options?.find((option) => option.value === filled[only.name])
    ?.unit;
}
