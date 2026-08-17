"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { readJson, writeJson, type Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  describedTraits,
  draftOf,
  PERSONA_FORM_PATH,
  personaPath,
  personaVersionsPath,
  personasPath,
  traitsFrom,
  type Persona,
  type PersonaForm,
  type PersonaPage,
  type PersonaVersion,
  type PersonaVersionPage,
  type TraitsDraft,
} from "../../../../../lib/personas.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  Badge,
  Button,
  Facts,
  Field,
  Form,
  FormActions,
  Refused,
  Select,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import {
  Failure,
  Loading,
  NotFound,
} from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  RelativeInstant,
  useMinuteClock,
} from "../../../../../ui/relative-time.tsx";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import styles from "../../../../../ui/system.module.css";
import personaStyles from "./persona.module.css";
import { TraitFields } from "../traits-editor.tsx";

/**
 * One persona: who they are now and who they have been.
 *
 * **The page is arranged around the one distinction that decides everything
 * else.** Name and description are *live*: they are how a team finds this
 * person in a list, and rewriting them changes nothing about any simulation
 * that ever ran. Traits are *versioned*: a run pinned the exact traits it used,
 * so an edit mints a new version and leaves every old one where it is. The two
 * are separate forms with separate save controls, and each names its own
 * expectation, because a page that saved both at once could not tell somebody
 * which half of their work lost a race.
 *
 * Archive and Restore live here rather than on the list, because both are
 * decisions somebody makes about a persona they are looking at — and because
 * archiving the project's default takes a replacement, which is a question this
 * page has the room to ask.
 */
export default function PersonaPage() {
  const { projectId, personaId } = useParams<{
    projectId: string;
    personaId: string;
  }>();
  return (
    <AppShell>
      <PersonaDetail projectId={projectId} personaId={personaId} />
    </AppShell>
  );
}

/** What the two editors on this page are holding, between reads and writes. */
type Draft = {
  readonly personaId: string;
  readonly name: string;
  readonly description: string;
  readonly traits: TraitsDraft;
};

/**
 * What a write actually put in its body, and the values it put there.
 *
 * A field is present here only if the request carried it. That is the whole
 * distinction the adoption below turns on, so it is a shape rather than a
 * convention: a save that forgets to declare a field it sent cannot silently
 * get that field adopted, and a save that declares one it did not send cannot
 * exist.
 */
type Submitted = {
  readonly personaId: string;
  readonly name?: string;
  readonly description?: string;
  readonly traits?: TraitsDraft;
};

/**
 * The server's answer, taken into the draft.
 *
 * **The invariant, stated once: adoption may touch exactly the fields the
 * request carried, and among those, only where the draft still holds what was
 * sent.** Everything outside the submitted set is left alone, always.
 *
 * Both halves are load-bearing and each was learned the hard way.
 *
 * - *Only the submitted fields.* This page has two forms with two saves. A
 *   reply carries the whole persona, but for a field the request never
 *   mentioned that value is a **stale read, not an answer** — so adopting it
 *   would quietly undo an edit sitting unsaved in the other form.
 * - *Only where the draft still holds what was sent.* A save takes a moment,
 *   and somebody typing during that moment has written something the server
 *   has never seen. Its reply cannot speak for text it never saw.
 *
 * What is left is the case adoption exists for: a field this request sent,
 * untouched since, which egma stored in a form of its own — a trimmed trait,
 * a dropped blank — and which the author should be looking at rather than
 * their own draft of it.
 *
 * The traits are walked by key rather than listed, so a trait added later is
 * covered without anybody remembering to come back.
 */
function adopted(
  current: Draft | null,
  submitted: Submitted | undefined,
  fromServer: Persona,
): Draft | null {
  if (current === null) return current;
  // A write that carried none of these fields — a clone, an Archive, a
  // Restore — has nothing to adopt, because it asked about none of them.
  if (submitted === undefined || submitted.personaId !== current.personaId) {
    return current;
  }

  /** Sent, and untouched since. The only fields an answer may land on. */
  const answered = <T,>(mine: T, sent: T | undefined, theirs: T): T =>
    sent !== undefined && mine === sent ? theirs : mine;

  const theirs = draftOf(fromServer.traits);
  const traits = { ...current.traits };
  if (submitted.traits !== undefined) {
    for (const trait of Object.keys(current.traits) as (keyof TraitsDraft)[]) {
      traits[trait] = answered(
        current.traits[trait],
        submitted.traits[trait],
        theirs[trait],
      );
    }
  }

  return {
    personaId: current.personaId,
    name: answered(current.name, submitted.name, fromServer.name),
    description: answered(
      current.description,
      submitted.description,
      fromServer.description ?? "",
    ),
    traits,
  };
}

function PersonaDetail({
  projectId,
  personaId,
}: {
  readonly projectId: string;
  readonly personaId: string;
}) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would tell an
  // admin their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);
  const router = useRouter();
  const now = useMinuteClock();

  const { answer, reload } = useProjectRead<Persona>(
    personaPath(personaId),
    projectId,
  );
  const { answer: history, reload: reloadHistory } =
    useProjectRead<PersonaVersionPage>(
      personaVersionsPath(personaId),
      projectId,
    );
  const { answer: form } = useProjectRead<PersonaForm>(
    PERSONA_FORM_PATH,
    projectId,
  );
  const voiceProviders =
    form?.status === "ready" ? form.value.voice_providers : null;

  /**
   * What the two forms are holding.
   *
   * **They are filled from the read once and never overwritten by a later
   * one.** A reload that reset the fields would throw away work somebody is
   * part-way through typing — which is exactly what happens after a conflict,
   * at the moment they most need to keep it.
   */
  const [held, setHeld] = useState<Draft | null>(null);

  useEffect(() => {
    setHeld(null);
  }, [personaId, projectId]);

  useEffect(() => {
    if (answer?.status !== "ready") return;
    const persona = answer.value;
    setHeld((already) =>
      already !== null && already.personaId === persona.id
        ? already
        : {
            personaId: persona.id,
            name: persona.name,
            description: persona.description ?? "",
            traits: draftOf(persona.traits),
          },
    );
  }, [answer]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const [saving, setSaving] = useState<"identity" | "traits" | "lifecycle" | null>(
    null,
  );
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [reading, setReading] = useState<PersonaVersion | null>(null);
  const [archiving, setArchiving] = useState(false);

  const persona = answer?.status === "ready" ? answer.value : null;
  const changed =
    held !== null &&
    persona !== null &&
    held.personaId === persona.id &&
    (held.name !== persona.name ||
      held.description !== (persona.description ?? "") ||
      JSON.stringify(held.traits) !== JSON.stringify(draftOf(persona.traits)));
  useUnsavedChanges(changed && saving === null, saving !== null);

  /**
   * Whether this page may offer an authoring control at all, and whether the
   * one it offers is available.
   *
   * **Three states, because there are three.** An admin whose session read has
   * not answered yet is not a viewer, and a form disabled while egma works out
   * who they are is a form that lies about what they may do — quietly, which
   * unknown there is no control and no field to disable: the page waits.
   */
  const settled = role !== null;
  const mayAuthor = settled && canAuthor(role);
  const whyNot = settled
    ? `Your ${role} role cannot author personas. Ask an organization admin to change your role.`
    : undefined;

  /**
   * Which persona this view is editing, readable from inside an await.
   *
   * Opening another persona does not remount this page — it is the same route
   * with another identifier in it — so a write still in flight comes back into
   * a view that has moved on. A refusal about persona A rendered over persona
   * B's fields is a sentence about work nobody can see, on a page it does not
   * describe. The list page carries the project with its data for the same
   * reason; this is that rule on the write path.
   */
  const editing = useRef({ projectId, personaId });

  useEffect(() => {
    editing.current = { projectId, personaId };
  }, [projectId, personaId]);

  /**
   * One write, and the three things that can come back instead of a persona.
   *
   * `submitted` is what this request put in its body — declared by the caller
   * rather than read off the draft, because the draft holds fields the request
   * did not carry and the reply cannot answer for those. Left out entirely by
   * a write that carries none of the editable fields.
   */
  async function write(
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
    what: "identity" | "traits" | "lifecycle",
    submitted?: Submitted,
  ): Promise<Persona | null> {
    const asked = { projectId, personaId };
    setSaving(what);
    setRefusal(null);

    const written = await writeJson<Persona>(path, {
      method,
      body: { project: asked.projectId, ...body },
    });

    // Whatever came back is not this view's to show if the view has moved.
    if (
      editing.current.projectId !== asked.projectId ||
      editing.current.personaId !== asked.personaId
    ) {
      return null;
    }

    setSaving(null);

    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return null;
    }
    if (written.status !== "ready") {
      // Everything typed stays where it is, and the refusal's own sentence
      // says what to do next. A conflict is recovered by reading the persona
      // again — which is a control below, not a lost afternoon.
      setRefusal(written.refusal);
      return null;
    }

    /**
     * **What the server kept is what the editor shows — field by field.**
     *
     * egma trims a described trait and drops one that is only whitespace, so
     * `"  calm  "` is stored as `"calm"`, and a draft left as it was typed
     * would put the author in front of text the system did not accept. So the
     * reply is adopted.
     *
     * **But only where the draft still holds what was sent.** A save takes a
     * moment, and somebody typing in the next field during that moment has
     * written something the server has never seen — so the reply says nothing
     * about it, and overwriting it would eat keystrokes to fix a trim. Each
     * field is decided on its own: unchanged since it was submitted, take the
     * server's; changed since, keep theirs.
     */
    setHeld((current) => adopted(current, submitted, written.value));

    reload();
    reloadHistory();
    return written.value;
  }

  function body() {
    if (answer === null || answer.status === "signed-out") {
      return <Loading what="this persona" />;
    }

    if (answer.status === "missing") {
      return (
        <NotFound message={answer.refusal.message} />
      );
    }

    if (answer.status === "failed") {
      return <Failure message={answer.refusal.message} onRetry={reload} />;
    }

    // The read has answered and the forms have not been filled from it yet,
    // which is one render. Checked *after* the three refusals above, so a
    // persona that is not there says so rather than loading forever.
    if (held === null) return <Loading what="this persona" />;

    const one = answer.value;
    const archived = one.archived_at !== null;

    return (
      <>
        {refusal === null || archiving ? null : (
          // While the Archive dialog is open it shows the refusal itself, in
          // front of the choice that caused it. Two copies of one sentence on
          // one screen is one sentence too many.
          <Refused
            message={refusal.message}
            action={
              <Button onClick={reload}>Read this persona again</Button>
            }
          />
        )}

        <div className={personaStyles.layout}>
          <div className={personaStyles.editorSurface}>
            <section
              className={personaStyles.editorSection}
              aria-labelledby="persona-identity-title"
            >
              <header className={personaStyles.sectionHeader}>
                <h2 id="persona-identity-title">Name and description</h2>
                <p>
                  These fields are live. Changing them does not change a past
                  simulation.
                </p>
              </header>
              {/*
                **No editor at all until egma knows who is reading.** A
                disabled field is a claim — *this is not yours to change* — and
                while the session read is in flight there is nobody to make
                that claim about.
              */}
              {settled ? (
                <Form onSubmit={() => void saveIdentity()}>
                  <Field label="Name" htmlFor="persona-name">
                    <TextInput
                      id="persona-name"
                      value={held.name}
                      disabled={!mayAuthor}
                      onChange={(name) => setHeld({ ...held, name })}
                    />
                  </Field>
                  <Field label="Description" htmlFor="persona-description">
                    <TextInput
                      id="persona-description"
                      value={held.description}
                      disabled={!mayAuthor}
                      onChange={(description) =>
                        setHeld({ ...held, description })
                      }
                    />
                  </Field>
                  <FormActions>
                    <Button
                      weight="strong"
                      type="submit"
                      disabled={!mayAuthor || saving !== null}
                      {...(mayAuthor || whyNot === undefined
                        ? {}
                        : { why: whyNot })}
                    >
                      {saving === "identity" ? "Saving…" : "Save name"}
                    </Button>
                  </FormActions>
                </Form>
              ) : (
                <>
                  <Facts
                    facts={[
                      { label: "Name", value: one.name },
                      {
                        label: "Description",
                        value: one.description ?? "—",
                      },
                    ]}
                  />
                  <Loading what="what your role may edit" />
                </>
              )}
            </section>

            <section
              className={personaStyles.editorSection}
              aria-labelledby="persona-behavior-title"
            >
              <header className={personaStyles.sectionHeader}>
                <h2 id="persona-behavior-title">Behavior and voice</h2>
                <p>
                  Saving a change makes a new version. Past simulations keep
                  the version they used.
                </p>
              </header>
              {settled ? (
                <Form onSubmit={() => void saveTraits()}>
                  <TraitFields
                    draft={held.traits}
                    voiceProviders={voiceProviders}
                    disabled={!mayAuthor}
                    onChange={(traits) => setHeld({ ...held, traits })}
                  />
                  <FormActions>
                    <Button
                      weight="strong"
                      type="submit"
                      disabled={!mayAuthor || saving !== null}
                      {...(mayAuthor || whyNot === undefined
                        ? {}
                        : { why: whyNot })}
                    >
                      {saving === "traits"
                        ? "Saving…"
                        : "Save behavior and voice"}
                    </Button>
                  </FormActions>
                </Form>
              ) : (
                <>
                  <Facts
                    facts={[
                      {
                        label: "Personality",
                        value: one.traits.personality,
                      },
                      { label: "Language", value: one.traits.language },
                      {
                        label: "Voice",
                        value: `${one.traits.voice.provider} · ${one.traits.voice.voiceId}`,
                      },
                      {
                        label: "Speech rate",
                        value: `${one.traits.voice.speed}×`,
                      },
                      ...describedTraits(one.traits).map((trait) => ({
                        label: trait.label,
                        value: trait.value,
                      })),
                    ]}
                  />
                  <Loading what="what your role may edit" />
                </>
              )}
            </section>
          </div>

          <aside
            className={personaStyles.historyRail}
            aria-labelledby="persona-history-title"
          >
            <header className={personaStyles.historyHeader}>
              <h2 id="persona-history-title">Version history</h2>
              <p>Newest first. Every past version stays readable.</p>
            </header>
            {history === null ? (
              <div className={personaStyles.historyState}>
                <Loading what="this persona's history" />
              </div>
            ) : history.status === "ready" ? (
              <ol className={personaStyles.versionList}>
                {history.value.items.map((version) => {
                  const current = version.id === one.version_id;
                  return (
                    <li
                      className={`${personaStyles.versionRow} ${
                        current ? personaStyles.versionRowCurrent : ""
                      }`}
                      key={version.id}
                    >
                      <div className={personaStyles.versionIdentity}>
                        <span className={personaStyles.versionNumber}>
                          v{version.version}
                        </span>
                        {current ? (
                          <span className={personaStyles.currentVersion}>
                            Current
                          </span>
                        ) : null}
                      </div>
                      <span className={personaStyles.versionTime}>
                        <RelativeInstant instant={version.created_at} now={now} />
                      </span>
                      <Button onClick={() => setReading(version)}>Read</Button>
                    </li>
                  );
                })}
              </ol>
            ) : history.status === "signed-out" ? (
              <div className={personaStyles.historyState}>
                <Loading what="this persona's history" />
              </div>
            ) : (
              <div className={personaStyles.historyState}>
                <Failure
                  message={history.refusal.message}
                  onRetry={reloadHistory}
                />
              </div>
            )}
          </aside>
        </div>

        {reading === null ? null : (
          <Dialog
            title={`Version ${reading.version}`}
            onClose={() => setReading(null)}
          >
            <Facts
              facts={[
                {
                  label: "Written",
                  value: (
                    <RelativeInstant instant={reading.created_at} now={now} />
                  ),
                },
                { label: "Personality", value: reading.traits.personality },
                { label: "Language", value: reading.traits.language },
                {
                  label: "Voice",
                  value: `${reading.traits.voice.provider} · ${reading.traits.voice.voiceId}`,
                },
                { label: "Speech rate", value: `${reading.traits.voice.speed}×` },
                ...describedTraits(reading.traits).map((trait) => ({
                  label: trait.label,
                  value: trait.value,
                })),
              ]}
            />
          </Dialog>
        )}

        {archiving ? (
          <ArchiveDialog
            persona={one}
            projectId={projectId}
            busy={saving === "lifecycle"}
            refusal={refusal}
            onClose={() => setArchiving(false)}
            onArchive={(replacement) => void archive(replacement)}
          />
        ) : null}

      </>
    );

    async function saveIdentity(): Promise<void> {
      if (held === null || !mayAuthor || saving !== null) return;
      await write(
        personaPath(one.id),
        "PATCH",
        {
          expected_revision: one.revision,
          name: held.name,
          description: held.description,
        },
        "identity",
        // The two fields this body carries, and no others: an unsaved trait
        // sitting in the form below is not this request's to answer for.
        {
          personaId: one.id,
          name: held.name,
          description: held.description,
        },
      );
    }

    async function saveTraits(): Promise<void> {
      if (held === null || !mayAuthor || saving !== null) return;
      await write(
        personaPath(one.id),
        "PATCH",
        {
          expected_revision: one.revision,
          expected_version_id: one.version_id,
          traits: traitsFrom(held.traits),
        },
        "traits",
        // The traits and nothing else: a name half-retyped in the form above
        // is not this request's to answer for either.
        { personaId: one.id, traits: held.traits },
      );
    }

    async function archive(replacement: string | undefined): Promise<void> {
      const done = await write(
        `${personaPath(one.id)}/archive`,
        "POST",
        {
          expected_revision: one.revision,
          ...(replacement === undefined
            ? {}
            : { replacement_persona_id: replacement }),
        },
        "lifecycle",
      );
      if (done !== null) setArchiving(false);
    }
  }

  async function restore(): Promise<void> {
    if (persona === null) return;
    await write(
      `${personaPath(persona.id)}/restore`,
      "POST",
      { expected_revision: persona.revision },
      "lifecycle",
    );
  }

  async function clone(): Promise<void> {
    if (persona === null) return;
    const made = await write(
      `${personaPath(persona.id)}/clone`,
      "POST",
      {},
      "lifecycle",
    );
    if (made !== null) {
      router.push(projectPath(projectId, "personas", made.id));
    }
  }

  const archived = persona?.archived_at != null;

  const actions =
    persona === null || role === null ? undefined : (
      <>
        <Button
          disabled={!mayAuthor || saving !== null}
          {...(mayAuthor || whyNot === undefined ? {} : { why: whyNot })}
          onClick={() => void clone()}
        >
          Clone
        </Button>
        {archived ? (
          <Button
            weight="strong"
            disabled={!mayAuthor || saving !== null}
            {...(mayAuthor || whyNot === undefined ? {} : { why: whyNot })}
            onClick={() => void restore()}
          >
            Restore
          </Button>
        ) : (
          <Button
            disabled={!mayAuthor || saving !== null}
            {...(mayAuthor || whyNot === undefined ? {} : { why: whyNot })}
            onClick={() => setArchiving(true)}
          >
            Archive
          </Button>
        )}
      </>
    );

  return (
    <ProductPage wide>
      <PageHeader
        title={persona?.name ?? "Persona"}
        breadcrumbs={[
          { label: "Personas", href: projectPath(projectId, "personas") },
          { label: persona?.name ?? "Persona" },
        ]}
        lead={
          persona === null ? undefined : (
            <span className={personaStyles.headerSummary}>
              <span className={personaStyles.headerDescription}>
                {persona.description ?? "Who they are and how they behave."}
              </span>
              {persona.is_default ? <Badge>Project default</Badge> : null}
              {archived ? <Badge tone="warn">Archived</Badge> : null}
              <span className={personaStyles.headerMeta}>
                v{persona.version}
              </span>
              <span className={personaStyles.headerMeta}>
                Updated <RelativeInstant instant={persona.updated_at} now={now} />
              </span>
            </span>
          )
        }
        action={actions}
      />
      <PageBody>{body()}</PageBody>
    </ProductPage>
  );
}

/**
 * Asking who takes the project's default pointer.
 *
 * **The replacement is part of the Archive, not a step after it.** A project
 * always has a default persona — a test authored naming nobody is given it —
 * so archiving the one a project points at without saying who replaces them
 * would break the commonest create there is, later, for somebody who did
 * nothing wrong. The server writes both in one transaction; this is where the
 * question gets asked.
 *
 * For a persona that is not the default there is nothing to choose, and the
 * dialog is a plain confirmation.
 */
function ArchiveDialog({
  persona,
  projectId,
  busy,
  refusal,
  onClose,
  onArchive,
}: {
  readonly persona: Persona;
  readonly projectId: string;
  readonly busy: boolean;
  readonly refusal: Refusal | null;
  readonly onClose: () => void;
  readonly onArchive: (replacement: string | undefined) => void;
}) {
  const [others, setOthers] = useState<readonly Persona[] | null>(null);
  const [chosen, setChosen] = useState("");
  useUnsavedChanges(chosen !== "" && !busy, busy);
  /**
   * Why the replacements could not be read, until somebody asks again.
   *
   * **A read that fails silently here takes the default persona out of the
   * product.** The choice never arrives, the control stays disabled, nothing
   * says why, and the one persona a project cannot do without becomes the one
   * persona nobody can archive. So the failure is said out loud, asking again
   * is a deliberate act, and an expired session goes where every expired
   * session in this application goes.
   */
  const [unread, setUnread] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!persona.is_default) return undefined;
    let current = true;
    setUnread(null);

    void readJson<PersonaPage>(personasPath(false), { project: projectId }).then(
      (answer) => {
        if (!current) return;

        if (answer.status === "signed-out") {
          window.location.replace("/sign-in");
          return;
        }
        if (answer.status !== "ready") {
          setUnread(answer.refusal);
          return;
        }

        const rest = answer.value.items.filter((one) => one.id !== persona.id);
        setOthers(rest);
        setChosen(rest[0]?.id ?? "");
      },
    );

    return () => {
      current = false;
    };
  }, [persona.id, persona.is_default, projectId, attempt]);

  const nobodyToTakeIt = persona.is_default && others !== null && others.length === 0;
  /** Nothing may be archived until a default has somebody to hand the pointer to. */
  const cannotChoose =
    persona.is_default && (unread !== null || others === null || nobodyToTakeIt);

  return (
    <Dialog title={`Archive ${persona.name}?`} onClose={onClose}>
      {(dismiss) => (
        <>
          <p className={styles.stateLead}>
            They leave the list your team authors from. Every version stays exactly
            where it is, every run that pinned one stays readable, and Restore is on
            this page.
          </p>

          {persona.is_default ? (
            <Field
              label="Replacement default persona"
              htmlFor="persona-replacement"
              hint="This project points at them, so a test naming nobody is given them. Somebody has to take that."
            >
              {unread !== null ? (
                <Refused
                  message={unread.message}
                  action={
                    <Button onClick={() => setAttempt((one) => one + 1)}>
                      Try again
                    </Button>
                  }
                />
              ) : others === null ? (
                <p className={styles.fieldHint}>Reading this project's personas…</p>
              ) : nobodyToTakeIt ? (
                <p className={styles.fieldHint}>
                  There is no other active persona in this project to take it.
                  Create one first.
                </p>
              ) : (
                <Select
                  id="persona-replacement"
                  value={chosen}
                  options={others.map((one) => ({ value: one.id, label: one.name }))}
                  onChange={setChosen}
                />
              )}
            </Field>
          ) : null}

          {refusal === null ? null : <Refused message={refusal.message} />}

          <FormActions>
            <Button
              tone="destructive"
              disabled={busy || cannotChoose || (persona.is_default && chosen === "")}
              {...(cannotChoose
                ? {
                    why: "Egma has not been able to read this project's personas, so there is nobody to hand the default pointer to yet.",
                  }
                : {})}
              onClick={() =>
                onArchive(persona.is_default ? chosen : undefined)
              }
            >
              {busy ? "Archiving…" : "Archive persona"}
            </Button>
            <Button disabled={busy} onClick={dismiss}>
              Cancel
            </Button>
          </FormActions>
        </>
      )}
    </Dialog>
  );
}
