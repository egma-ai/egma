import {
  authorize,
  deleteGrader,
  editGrader,
  listGraders,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  UnknownGraderLibraryEntryError,
  UnprocessableInputError,
  useLibraryEntry,
  type FilledInForm,
  type Grader,
  type GraderModel,
} from "@egma/db";
import { isId } from "@egma/ids";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import {
  invalid,
  notFound,
  notPermitted,
  unprocessable,
} from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, projectNamed, text } from "../http/reading.ts";

/**
 * The running graders: the copies a project actually judges with, the act that
 * makes another — pressing **Use** on a library entry — and the two that keep
 * pressing Use from being a one-way door.
 *
 * **Four verbs, and what is still missing is the product decision.** There is
 * no create taking a type and criteria, because a grader is always a copy *of*
 * something: the entry decides what kind of judgment it is and what the form
 * asks for, and the copy holds the answers. The custom-grader authoring surface
 * that the grading effort designed stays shelved — the machinery behind it
 * stays, versioning and all, and hosts egma's own two entries — so a team meets
 * a small shelf of graders that already work rather than a blank form on their
 * first day.
 *
 * **An edit is two different acts wearing one verb, and the difference is
 * whether a verdict already written is being rewritten.** A name, a
 * description, `required`, a scope and a sampling rate say where a copy applies
 * and how loudly, and none of them rewrites a row — so they are written in
 * place and are true everywhere the moment they return. The filled-in values
 * are what a judgment is *made of*, so changing one mints the next version and
 * leaves the one behind it exactly where it was: last week's verdict still
 * names the values it was decided by. Both rules live in the factory rather
 * than here, and this door hands the whole body down in one call so no client
 * has to know which of them it just tripped.
 *
 * **`required` is the one live setting that reaches a page about the past, and
 * a client should say so.** It rewrites no verdict; it moves this copy's rows
 * between the lane that decides a run and the lane that only reports, and the
 * fold runs at read time — so a run that failed on this grader alone reads as
 * passed from the moment the flag turns. That is what the flag is for. The
 * honest sentence is "the verdicts are unchanged and what they add up to is
 * not", and a surface that shortens it to "nothing already judged changes" is
 * telling somebody the opposite of what they are about to see.
 *
 * **Deleting is switching off, and it is the only off switch there is.** There
 * is no enable flag and no `none` scope: a copy either exists and judges
 * everything in its scope, or it is deleted and judges nothing from that moment
 * on. It is a soft delete, and that is not an implementation detail — the rows
 * it already wrote stay readable and stay interpretable, because their versions
 * outlive it, so an old run keeps its own meaning rather than quietly losing a
 * grader's worth of evidence.
 *
 * **Delete is not part of that authoring surface, and it took a wave to notice
 * that it was being treated as though it were.** ADR-0009 shelved *defining*
 * graders; it made switching one off the plainest act in the area — "dormant is
 * no copy at all; there is no enable switch and no `none` value". The data
 * access module has said so since the redesign landed, the start-up backfill is
 * built around a person having taken that decision, and the door that would let
 * anybody take it was never registered. So a product whose only loudness
 * control is delete had no delete, and the screens that displayed the running
 * copies could only display them. It is a verb here now. Edit is still absent,
 * because editing a copy's values is the authoring surface, and that is what
 * was shelved.
 *
 * **A copy's definition never crosses this door.** What a read answers is the
 * pointer, the filled-in values, and where the grader applies. The judge prompt
 * is on the library entry and is read from `/api/grader-library`, which is the
 * same place the engine reads it at judging time — so the words on screen and
 * the words a model is sent are one row.
 *
 * The addresses follow the standing rule: nothing is rooted at a project and
 * the organization is never in a path. A write may name a project in its body
 * and a read may filter by one; neither has to, and in a single-project
 * organization nothing ever does.
 */

export type GraderRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const GRADERS_PATH = "/api/graders";
export const GRADER_PATH = "/api/graders/:graderId";

type Body = Record<string, unknown>;

type Query = {
  readonly project?: string;
  readonly cursor?: string;
};

const USE_KEYS = [
  "library_id",
  "params",
  "model",
  "name",
  "description",
  "required",
  "scope",
  "production_sample_rate",
  "project",
] as const;

/**
 * What an edit may carry: everything Use takes except the pointer, which is the
 * one thing about a copy that can never move.
 */
const EDIT_KEYS = USE_KEYS.filter((key) => key !== "library_id");

/**
 * The unknown-key gate, the agent group's for the agent group's reason — and
 * with one more of its own here: every key in this body decides what a project
 * is judged by or how loudly, so a typo quietly ignored would be a grader
 * somebody believes they configured and did not.
 */
function unknownKeyIn(
  body: Body,
  door: string,
  keys: readonly string[],
): string | undefined {
  for (const key of Object.keys(body)) {
    if (keys.includes(key)) continue;
    return `${door} takes no key "${key}"; it takes ${keys.join(", ")}`;
  }
  return undefined;
}

/**
 * The one key an edit refuses in its own words rather than as an unknown one.
 *
 * `library_id` is not a key an edit forgot to support — it is the pointer, and
 * every version behind this copy holds values shaped by the type that pointer
 * decided. A copy that could be moved to another entry would be a different
 * grader wearing the old one's history, and its verdicts would name assertion
 * keys nothing on the new shelf can read. Saying so beats "no such key",
 * because somebody sending it wants a copy of the other entry and Use makes one.
 */
function repointing(body: Body): string | undefined {
  if (!("library_id" in body)) return undefined;
  return (
    "a grader cannot be moved to another library entry: its type came from " +
    "the entry it is a copy of, and every version behind it holds values that " +
    "type shapes. Press Use on the entry you want, which makes a second copy " +
    "and leaves this one's history saying what it always said."
  );
}

/**
 * One running copy as every read of one describes it.
 *
 * `library_id` rides at the front because it is what this row *is*: everything
 * a person wants to know about how it judges is read through it. The config is
 * the copy's own filled-in values and nothing else — no prompt, no criteria,
 * because those are the entry's and are never written down here.
 */
function described(one: Grader): Record<string, unknown> {
  return {
    id: one.id,
    library_id: one.libraryId,
    project_id: one.projectId,
    name: one.name,
    description: one.description,
    type: one.type,
    required: one.required,
    scope: one.scope,
    production_sample_rate: one.productionSampleRate,
    version: one.version,
    version_id: one.versionId,
    config: one.config,
    /**
     * This grader's own LLM selection, or `null` for one still on the
     * compatibility path — where the project's judge configuration decides,
     * exactly as it did before the model catalog existed.
     *
     * There is no credential field beside it and there never will be: the key
     * behind the selection is the organization's, resolved when the grading
     * claim is prepared, and a grader that named one would put a secret inside
     * authored content a run then pins forever.
     */
    model: one.graderModel,
    created_at: one.createdAt.toISOString(),
    updated_at: one.updatedAt.toISOString(),
  };
}

/**
 * The LLM selection a body carries, as the factory takes it.
 *
 * The envelope only: that `model` is an object naming a provider and a model
 * id, and that it holds nothing a secret could travel in. Which providers do
 * LLM work and what an id may be are the factory's rules, and a second opinion
 * here could come to disagree with the one that decides.
 *
 * `null` is a real answer and means *go back to the compatibility path* — the
 * project's judge configuration decides again. It is told apart from absent,
 * which means keep what is stored.
 */
type WrittenGraderModel =
  | { readonly value: GraderModel | null | undefined }
  | { readonly refusal: string };

function modelIn(body: Body): WrittenGraderModel {
  if (!("model" in body)) return { value: undefined };
  const written = body.model;
  if (written === null) return { value: null };
  if (
    typeof written !== "object" ||
    Array.isArray(written)
  ) {
    return {
      refusal:
        "a grader's model names the provider and the model id it judges with, " +
        "as an object — or null to go back to the project's judge setting.",
    };
  }
  const held = written as Body;
  for (const forbidden of ["key", "credential", "credential_id"]) {
    if (forbidden in held) {
      return {
        refusal:
          `a grader's model holds no "${forbidden}". Who pays for a judgment ` +
          "is the organization's model access, under Model providers — a " +
          "grader names a provider and never a secret.",
      };
    }
  }
  return {
    value: {
      provider: held.provider as GraderModel["provider"],
      model: text(held.model),
    } as GraderModel,
  };
}

/**
 * What a caller is told about a grader that is not there.
 *
 * One sentence for three situations — never made, already switched off, or
 * somebody else's — because from where this caller stands those are the same
 * thing, and telling them apart would answer a question about another project.
 */
function noSuchGrader(graderId: string): string {
  return (
    `${graderId} is not a grader running on this project. It may never have ` +
    `existed, or it may have been switched off — read the running graders to ` +
    `see what is judging here now.`
  );
}

/** The filled-in values a body sent, or a refusal saying what shape they take. */
type WrittenParams =
  | { readonly params: FilledInForm | undefined }
  | { readonly refusal: string };

function paramsIn(body: Body): WrittenParams {
  if (!("params" in body) || body.params === undefined || body.params === null) {
    return { params: undefined };
  }
  const params = body.params;
  if (typeof params !== "object" || Array.isArray(params)) {
    return {
      refusal:
        "params is what the library entry's form asked for, filled in — an " +
        'object like {"metric": "turn_response_latency", "bound": 2000}. Read ' +
        "the library entry to see what it asks for; some ask for nothing.",
    };
  }
  return { params: params as FilledInForm };
}

/** A flag a body sent, refused rather than coerced: `"false"` is not false. */
type WrittenFlag =
  | { readonly value: boolean | undefined }
  | { readonly refusal: string };

function requiredIn(body: Body): WrittenFlag {
  if (!("required" in body) || body.required === undefined) {
    return { value: undefined };
  }
  if (typeof body.required !== "boolean") {
    return {
      refusal:
        "required says whether a test can pass while this grader does not: " +
        "true blocks, false makes it a diagnostic that reports and never " +
        `fails anything. Send it as true or false, and this request sent ${typeof body.required}.`,
    };
  }
  return { value: body.required };
}

/** A number a body sent, refused rather than dropped: `"10"` is not 10. */
type WrittenRate =
  | { readonly value: number | undefined }
  | { readonly refusal: string };

/**
 * How much production traffic this grader judges, as a body sends it.
 *
 * **Refused rather than ignored**, on the unknown-key gate's exact terms and
 * for a worse version of its reason. A rate that arrived as text and was
 * quietly dropped leaves the copy judging *all* of production while the team
 * that sent `"10"` believes it judges a tenth — every live conversation asked
 * of a model, and billed, on a setting somebody thinks they chose. The shape is
 * checked here; whether the number is a whole percentage is the factory's rule,
 * refused in the factory's own words, because this door has no business holding
 * a second opinion about that.
 */
function sampleRateIn(body: Body): WrittenRate {
  if (
    !("production_sample_rate" in body) ||
    body.production_sample_rate === undefined
  ) {
    return { value: undefined };
  }
  if (typeof body.production_sample_rate !== "number") {
    return {
      refusal:
        "production_sample_rate is what share of live traffic this grader " +
        "judges, as a whole percentage between 0 and 100. Send it as a " +
        `number, and this request sent ${typeof body.production_sample_rate}.`,
    };
  }
  return { value: body.production_sample_rate };
}

/**
 * What a body actually sent, for a refusal that has to name it.
 *
 * `typeof null` is `"object"` and `typeof []` is `"object"` too, and neither
 * tells the person reading the sentence anything they can act on — which is the
 * whole job of these refusals.
 */
function sortOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value;
}

/** Text a body sent, refused rather than read as silence: `123` is not a name. */
type WrittenText =
  | { readonly value: string | undefined }
  | { readonly refusal: string };

/**
 * A word this door takes, as a body sends it.
 *
 * **Refused rather than read as absent, which is the trap this replaces.** A
 * key that arrived as a number used to be trimmed into the empty string and
 * then read as though nobody had sent it — so `{"scope": 123}` answered 200
 * with the copy still judging simulations, and the developer who thinks they
 * pointed it at live traffic finds out when nothing is ever judged there. It is
 * `production_sample_rate: "10"` again, one field along: quietly ignoring a key
 * is how a project comes to be configured differently from what somebody wrote
 * down, and this group's unknown-key gate exists to refuse exactly that.
 *
 * **Absent stays absent**, because that is what makes an edit partial. Only a
 * key that is *there* and is not text is refused.
 *
 * The shape is checked here and the meaning is not: an empty name and a scope
 * egma has never heard of are the factory's rules, refused in the factory's own
 * words, on `sampleRateIn`'s exact terms.
 */
function textIn(body: Body, key: string, takes: string): WrittenText {
  if (!(key in body) || body[key] === undefined) return { value: undefined };
  if (typeof body[key] !== "string") {
    return {
      refusal: `${key} ${takes}. Send it as text, and this request sent ${sortOf(body[key])}.`,
    };
  }
  return { value: body[key].trim() };
}

/**
 * The note on a copy, which is the one field here that can be emptied.
 *
 * **Three answers rather than two, because "there is no note" is a thing
 * somebody means.** Leaving the key out keeps whatever is there; sending `null`
 * or an empty string clears it, both of them, because a form submitting a blank
 * box and a client sending JSON's own word for nothing mean the same thing and
 * a door that took one and refused the other would be arbitrary. Anything else
 * present is refused — a number here used to erase the note and answer 200,
 * which is this group's only write that ever destroyed something a person had
 * typed.
 */
type WrittenNote =
  | { readonly value: string | null | undefined }
  | { readonly refusal: string };

function descriptionIn(body: Body): WrittenNote {
  if (!("description" in body) || body.description === undefined) {
    return { value: undefined };
  }
  if (body.description === null) return { value: null };
  if (typeof body.description !== "string") {
    return {
      refusal:
        "description is a note your team leaves on this grader, saying why it " +
        "is switched on. Send it as text, send null or an empty string to " +
        `clear it, or leave it out to keep it — and this request sent ${sortOf(body.description)}.`,
    };
  }
  const said = body.description.trim();
  return { value: said === "" ? null : said };
}

/** What each of the three text fields takes, said once for both verbs. */
const NAME_TAKES = "is what this project calls its copy of the grader";
const SCOPE_TAKES =
  "is where this grader judges — one of simulations, production or both";
const PROJECT_TAKES =
  "names the project this is about, as its prj_ identifier; leave it out to " +
  "use the one this credential already acts in";

export async function graderRoutes(
  app: FastifyInstance,
  options: GraderRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * The project's running graders, newest first, one page at a time.
   *
   * `{ items, next_cursor }` is the envelope every list in this API answers
   * with, and the cursor is the last id of the page rather than a count of rows
   * to skip.
   */
  app.get(GRADERS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await actingIn(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cursor = given(query.cursor);
    if (cursor !== undefined && !isId("grd", cursor)) {
      return invalid(
        reply,
        `"${cursor}" is not a cursor this list issued. Send the next_cursor ` +
          `an earlier page answered with, or leave it out to start at the ` +
          `newest grader.`,
      );
    }

    const page = await listGraders(acting.auth, { cursor });

    return reply.send({
      items: page.items.map(described),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this response is an older shape that never had one".
      next_cursor: page.nextCursor ?? null,
    });
  });

  /**
   * **Use**: start judging with a library entry.
   *
   * The copy and its first version land in one transaction, and the values are
   * checked against what the entry actually asks for — so a bound sent for an
   * entry that asks for none, or a measure egma does not compute, is refused
   * here rather than becoming a grader that is `skipped` forever.
   *
   * The role is checked before anything is read, which is the stance the
   * factory takes for the same reason: a viewer is refused for being a viewer,
   * rather than after a read that tells them what is there.
   */
  app.post(GRADERS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Body;

    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    // Everything answerable without reading anything is answered first, so a
    // body that could never be written is refused before it can learn what
    // this project holds.
    const unknown = unknownKeyIn(body, "Use", USE_KEYS);
    if (unknown !== undefined) return invalid(reply, unknown);

    const libraryId = text(body.library_id);
    if (!isId("grl", libraryId)) {
      return invalid(
        reply,
        "library_id names the grader on the shelf to start judging with, as " +
        "its grl_ identifier. Read the library to see what Egma ships.",
      );
    }

    const params = paramsIn(body);
    if ("refusal" in params) return unprocessable(reply, params.refusal);

    const model = modelIn(body);
    if ("refusal" in model) return unprocessable(reply, model.refusal);

    const required = requiredIn(body);
    if ("refusal" in required) return unprocessable(reply, required.refusal);

    const sampleRate = sampleRateIn(body);
    if ("refusal" in sampleRate) return unprocessable(reply, sampleRate.refusal);

    const name = textIn(body, "name", NAME_TAKES);
    if ("refusal" in name) return unprocessable(reply, name.refusal);

    const note = descriptionIn(body);
    if ("refusal" in note) return unprocessable(reply, note.refusal);

    const scope = textIn(body, "scope", SCOPE_TAKES);
    if ("refusal" in scope) return unprocessable(reply, scope.refusal);

    // The type gate first, so a `project` that is not text is refused by name
    // rather than read as absent — then `projectNamed`'s one rule, the query
    // and the body. **Use** is pressed from a page, which names its project in
    // the address.
    const project = textIn(body, "project", PROJECT_TAKES);
    if ("refusal" in project) return unprocessable(reply, project.refusal);

    const acting = await actingIn(auth, projectNamed(query, body));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const created = await useLibraryEntry(acting.auth, {
      libraryId,
      ...(params.params === undefined ? {} : { params: params.params }),
      // Absent leaves the copy named after the entry it is a copy of; an empty
      // one is the factory's refusal to make, in the factory's own words.
      ...(name.value === undefined ? {} : { name: name.value }),
      // Use has nothing to clear, so the two ways of saying "no note" both
      // arrive here as no note at all.
      ...(note.value === undefined || note.value === null
        ? {}
        : { description: note.value }),
      ...(required.value === undefined ? {} : { required: required.value }),
      // Cast rather than checked: `GraderScope` is a closed vocabulary and the
      // factory's `validScope` is the gate — a word egma has never heard of is
      // refused there, naming the three it knows, and this door holds no second
      // opinion about the list. What is checked here is only that a word arrived.
      ...(scope.value === undefined
        ? {}
        : { scope: scope.value as Grader["scope"] }),
      ...(sampleRate.value === undefined
        ? {}
        : { productionSampleRate: sampleRate.value }),
      // Absent leaves the copy on the compatibility path, where the project's
      // judge configuration decides. Egma does not fill in a model on a
      // caller's behalf: a grader silently pointed at a provider nobody chose
      // would spend from an account nobody agreed to.
      ...(model.value === undefined || model.value === null
        ? {}
        : { graderModel: model.value }),
    });

    return reply.code(201).send(described(created));
  });

  /**
   * Change a copy: what it judges by, where it applies, and how loudly.
   *
   * **One verb for both, and the factory decides which happened.** Sending
   * values mints the next version, because they are what a verdict was decided
   * by and last week's has to keep meaning what it meant; sending a scope, a
   * rate, a name or the `required` flag writes in place, because none of them
   * rewrites a verdict already written. A client that had to know which was
   * which would be holding a second copy of a rule it cannot enforce, so it
   * sends the body and reads the version number back.
   *
   * `required` still reaches the past through the fold rather than through the
   * rows — see this group's header — so a client relaying "nothing changed" on
   * the strength of a standing version number would be relaying the wrong half.
   *
   * **`params` is the entry's form filled in, exactly as Use takes it** — the
   * same key, the same shape, checked against the same entry by the same code.
   * That is why a bound the entry never asked for is refused here in the words
   * Use refuses it in, rather than in a second opinion this door invented.
   *
   * What the body leaves out, the copy keeps. A grader this credential cannot
   * see reads exactly as one that is not there, because to this caller those
   * are the same thing.
   */
  app.patch(GRADER_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { graderId } = request.params as { graderId: string };
    const body = (request.body ?? {}) as Body;
    const query = (request.query ?? {}) as Body;

    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    // Everything answerable without reading anything is answered first, so a
    // body that could never be written is refused before it can learn what
    // this project holds.
    const moved = repointing(body);
    if (moved !== undefined) return invalid(reply, moved);

    const unknown = unknownKeyIn(body, "an edit", EDIT_KEYS);
    if (unknown !== undefined) return invalid(reply, unknown);

    const params = paramsIn(body);
    if ("refusal" in params) return unprocessable(reply, params.refusal);

    const model = modelIn(body);
    if ("refusal" in model) return unprocessable(reply, model.refusal);

    const required = requiredIn(body);
    if ("refusal" in required) return unprocessable(reply, required.refusal);

    const sampleRate = sampleRateIn(body);
    if ("refusal" in sampleRate) return unprocessable(reply, sampleRate.refusal);

    const name = textIn(body, "name", NAME_TAKES);
    if ("refusal" in name) return unprocessable(reply, name.refusal);

    const note = descriptionIn(body);
    if ("refusal" in note) return unprocessable(reply, note.refusal);

    const scope = textIn(body, "scope", SCOPE_TAKES);
    if ("refusal" in scope) return unprocessable(reply, scope.refusal);

    // The type gate first, then `projectNamed`'s one rule, exactly as **Use**
    // beside this reads them.
    const project = textIn(body, "project", PROJECT_TAKES);
    if ("refusal" in project) return unprocessable(reply, project.refusal);

    const acting = await actingIn(auth, projectNamed(query, body));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const edited = await editGrader(acting.auth, graderId, {
      ...(params.params === undefined ? {} : { params: params.params }),
      // An empty name is not a rename this door drops — a copy has to be
      // called something, and the factory says so in its own words.
      ...(name.value === undefined ? {} : { name: name.value }),
      // The note is the one field an edit can empty, and `null` is what both
      // ways of saying so arrive as — a different act from leaving the key out.
      ...(note.value === undefined ? {} : { description: note.value }),
      ...(required.value === undefined ? {} : { required: required.value }),
      // Cast rather than checked, on the Use door's terms: `validScope` is the
      // gate, and a word egma has never heard of is refused there.
      ...(scope.value === undefined
        ? {}
        : { scope: scope.value as Grader["scope"] }),
      ...(sampleRate.value === undefined
        ? {}
        : { productionSampleRate: sampleRate.value }),
      // `null` is the one way back to the compatibility path and is a
      // different act from leaving the key out, which keeps what is stored.
      ...(model.value === undefined ? {} : { graderModel: model.value }),
    });

    if (edited === undefined) return notFound(reply, noSuchGrader(graderId));

    return reply.send(described(edited));
  });

  /**
   * Switch a copy off.
   *
   * **Deleting is the switching off**, and it is the only one there is: no
   * enable flag, no `none` scope. From the moment this returns, nothing this
   * project runs is judged by the copy — including the expected-behaviors one
   * every project is created with, whose delete is how a team stops being
   * judged against its own written-down expectations.
   *
   * **And nothing already judged moves.** The row is marked rather than
   * removed, and its versions are not touched at all, so every verdict it wrote
   * is still readable and still says which values decided it. An old run keeps
   * its own meaning, which is the whole reason a soft delete is the right shape
   * here rather than a tidier one.
   *
   * The library entry behind it is **not** released: a switched-off copy still
   * points at its definition, and that definition has to outlive it for the
   * verdicts to stay interpretable. Deleting the entry stays refused, which is
   * what the foreign key underneath says too.
   *
   * **A project may end up judged by nothing at all**, and that is allowed
   * rather than refused. The seeded expected-behaviors copy is an ordinary
   * deletable row, so the last delete can leave a project with no graders: its
   * runs still start, still conduct every simulation, and come back with no
   * verdicts. A copy somebody may switch off cannot also be a thing every run
   * is assumed to carry. The screens say so before the last one goes, because a
   * run that judged nothing and a run where everything passed look the same on
   * a results page with nothing red on it.
   */
  app.delete(GRADER_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { graderId } = request.params as { graderId: string };
    const query = (request.query ?? {}) as Query;

    // The role first, before anything is read — the factory's own stance, so a
    // viewer is refused for being a viewer rather than after a read that tells
    // them what is there.
    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const acting = await actingIn(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const removed = await deleteGrader(acting.auth, graderId);
    if (removed === undefined) return notFound(reply, noSuchGrader(graderId));

    return reply.send({
      id: removed.id,
      name: removed.name,
      deleted_at: removed.deletedAt.toISOString(),
    });
  });

  /**
   * This group's refusals. A body naming an entry that is not on this caller's
   * shelf and a body whose values the entry never asked for are both **422**:
   * nothing about the request is malformed, and what it says cannot be done.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    if (error instanceof UnknownGraderLibraryEntryError) {
      return unprocessable(reply, error.message);
    }
    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }
    if (error instanceof ProjectOutsideOrganizationError) {
      return unprocessable(reply, error.message);
    }
    throw error;
  });
}
