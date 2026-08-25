"use client";

import { useEffect, useRef, useState } from "react";
import {
  getPersona,
  getPersonaUsage,
  listPersonaVersions,
  updatePersona,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Refusal } from "../../../../lib/api.ts";
import {
  draftOf,
  modelSaid,
  modelsDraftOf,
  modelsFrom,
  ownerSaid,
  sameModelsDraft,
  sameTraitsDraft,
  traitsFrom,
  type ModelsDraft,
  type Persona,
  type PersonaForm,
  type PersonaModels,
  type PersonaTraits,
  type PersonaUsage,
  type PersonaVersion,
  type PersonaVersionPage,
  type TraitsDraft,
} from "../../../../lib/personas.ts";
import {
  platformAnswer,
  platformClient,
  type PlatformRequest,
} from "../../../../lib/platform-client.ts";
import { projectPath } from "../../../../lib/project-context.ts";
import { Field, Help, Refused } from "../../../../ui/form.tsx";
import { Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import {
  RelativeInstant,
  useMinuteClock,
} from "../../../../ui/relative-time.tsx";
import { useUnsavedChanges } from "../../../../ui/settings-read.ts";
import { ModelFields } from "./models-editor.tsx";
import {
  NotePanel,
  Reads,
  SheetSection,
  SheetTimestamps,
  StateChip,
  Versions,
  type Read,
} from "./sheet-parts.tsx";
import { TraitFields } from "./traits-editor.tsx";

/**
 * One persona, read and edited in the panel the boards put it in.
 *
 * **The list stays on screen behind it**, which is the whole reason the record
 * moved off a page of its own: somebody comparing four personas is comparing
 * rows, and a full-page detail made every comparison a journey. `DESIGN.md`
 * records the choice for agents, connections, personas and tests alike.
 *
 * **The panel is one sheet in three modes, not three sheets.** Read (`9L1-0`),
 * edit (`AEZ-0`) and one frozen version (`CSE-0`) are the same address with a
 * different thing in view, so none of them is a route: opening an older
 * version and coming back does not put a step in the browser's history that
 * says nothing about where anybody is.
 *
 * **The distinction the whole panel is arranged around** is the one the page
 * before it was: name and description are *live* — rewriting them changes
 * nothing about any simulation that ever ran — and personality and models are
 * *versioned*, because a run pinned the exact pair it used. So a save of the
 * first is a save, a save of the second mints a version, and the note at the
 * end of `MODELS` says so before anybody presses anything.
 *
 * An Egma-provided persona (`CDO-0`) has no editor at all and offers Fork; an
 * archived one (`CM9-0`) offers Restore. Both are read views with a different
 * footer, because both are the same facts.
 */

/** What the editor in this sheet is holding, between reads and writes. */
type Draft = {
  readonly personaId: string;
  readonly name: string;
  readonly description: string;
  readonly traits: TraitsDraft;
  readonly models: ModelsDraft;
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
  readonly models?: ModelsDraft;
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
 * - *Only the submitted fields.* One save sends only fields that changed. A
 *   reply carries the whole persona, but for a field the request never
 *   mentioned that value is a **stale read, not an answer**.
 * - *Only where the draft still holds what was sent.* A save takes a moment,
 *   and somebody typing during that moment has written something the server
 *   has never seen. Its reply cannot speak for text it never saw.
 *
 * What is left is the case adoption exists for: a field this request sent,
 * untouched since, which egma stored in a form of its own — such as trimmed
 * text — and which the author should be looking at rather than their own
 * draft of it.
 */
function adopted(
  current: Draft | null,
  submitted: Submitted | undefined,
  fromServer: Persona,
): Draft | null {
  if (current === null) return current;
  // A write that carried none of these fields has nothing to adopt, because it
  // asked about none of them.
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

  const theirModels = modelsDraftOf(fromServer.models);
  const models = { ...current.models };
  if (submitted.models !== undefined) {
    for (const field of Object.keys(current.models) as (keyof ModelsDraft)[]) {
      models[field] = answered(
        current.models[field],
        submitted.models[field],
        theirModels[field],
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
    models,
  };
}

/**
 * Who they are, in the order and the grouping the boards read them back in.
 *
 * An optional trait nobody wrote is left out rather than shown empty: a label
 * over nothing is a fact about the form, not about the person.
 */
function traitReads(traits: PersonaTraits): readonly Read[] {
  const pair = (label: string, value: string | undefined): readonly Read[] =>
    value === undefined || value.trim() === "" ? [] : [{ label, value }];

  return [
    { label: "Personality", value: traits.personality, wide: true },
    { label: "Language", value: traits.language, wide: true },
    ...pair("Accent", traits.accent),
    ...pair("Background noise", traits.backgroundNoise),
  ];
}

/** What the simulator brings that person to life with. */
function modelReads(
  models: PersonaModels,
  form: PersonaForm | null,
): readonly Read[] {
  return [
    {
      label: "Language model",
      value: modelSaid(form?.modelCatalog, "llm", models.llm),
    },
    {
      label: "Speech-to-text model",
      value: modelSaid(form?.modelCatalog, "stt", models.stt),
    },
    {
      label: "Text-to-speech model",
      value: modelSaid(form?.modelCatalog, "tts", models.tts),
    },
    { label: "Speech rate", value: `${String(models.tts.speed)}×`, mono: true },
    { label: "Voice", value: models.tts.voiceId, mono: true, wide: true },
  ];
}

export function PersonaSheet({
  projectId,
  personaId,
  form,
  role,
  mayAuthor,
  whyNot,
  editing,
  writtenAt,
  focusName,
  busy,
  onEdit,
  onRead,
  onFork,
  onMakeDefault,
  onRestore,
  onArchive,
  onWritten,
  onClose,
}: {
  readonly projectId: string;
  readonly personaId: string;
  /** The authoring choices, read once by the screen and lent to every sheet. */
  readonly form: PersonaForm | null;
  readonly role: string | null;
  readonly mayAuthor: boolean;
  readonly whyNot: string | undefined;
  readonly editing: boolean;
  /**
   * Bumped by the screen every time one of its own writes lands, so a panel
   * showing that persona reads it again.
   */
  readonly writtenAt: number;
  /** A fork lands here with its copied name selected, ready to be replaced. */
  readonly focusName: boolean;
  /** A write the screen is running for this persona: fork, default, restore. */
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onRead: () => void;
  readonly onFork: (persona: Persona) => void;
  readonly onMakeDefault: (persona: Persona) => void;
  readonly onRestore: (persona: Persona) => void;
  readonly onArchive: (persona: Persona) => void;
  /** The list behind this panel is now out of date. */
  readonly onWritten: () => void;
  readonly onClose: () => void;
}) {
  const now = useMinuteClock();
  const nameField = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const {
    answer,
    reload,
    refresh: refreshPersona,
  } = useProjectRead<Persona>(
    (project) =>
      platformAnswer(
        getPersona({ personaId, projectId: project }, { client: platformClient }),
      ),
    projectId,
    personaId,
  );
  const {
    answer: history,
    reload: reloadHistory,
    refresh: refreshHistory,
  } = useProjectRead<PersonaVersionPage>(
      (project) =>
        platformAnswer(
          listPersonaVersions(
            { personaId, projectId: project },
            { client: platformClient },
          ),
        ),
      projectId,
      personaId,
    );
  /**
   * Which tests name this persona — **one read when the panel opens, and never
   * one per row.**
   *
   * The list operation carries no usage count, so painting it in the table
   * would be a request for every row on every load. The two places it decides
   * something are here and the archive confirmation, and both are one persona
   * at a time.
   */
  const { answer: usage, reload: reloadUsage } = useProjectRead<PersonaUsage>(
    (project) =>
      platformAnswer(
        getPersonaUsage(
          { personaId, projectId: project },
          { client: platformClient },
        ),
      ),
    projectId,
    personaId,
  );

  const [held, setHeld] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  /** The frozen version this panel is reading instead of the current one. */
  const [reading, setReading] = useState<PersonaVersion | null>(null);
  const editVersion = useRef(0);

  /**
   * Another persona, and nothing of the last one carried over.
   *
   * **`saving` goes with the rest, and that is not tidiness.** A write still in
   * flight for the persona this panel has just left is dropped when it lands —
   * `holding` below is what drops it — so a `saving` left standing would leave
   * every control on the *new* persona inert waiting for an answer that will
   * never be shown.
   */
  useEffect(() => {
    setHeld(null);
    setSaved(false);
    setReading(null);
    setRefusal(null);
    setSaving(false);
    editVersion.current = 0;
  }, [personaId, projectId]);

  /**
   * A write the screen ran on this persona — a fork, the default pointer, a
   * restore — read back into the panel that is showing it.
   *
   * The screen owns those four because the row menu offers them too, so the
   * panel is told rather than asked. It is a quiet re-read: replacing the
   * panel with a loading state after a press that already worked would be a
   * flash of nothing to say a thing had happened.
   */
  const firstToken = useRef(writtenAt);
  useEffect(() => {
    if (writtenAt === firstToken.current) return;
    refreshPersona();
    refreshHistory();
  }, [writtenAt, refreshPersona, refreshHistory]);

  /**
   * The editor is filled from the read once and never overwritten by a later
   * one. A reload that reset the fields would throw away work somebody is
   * part-way through typing — which is exactly what happens after a conflict,
   * at the moment they most need to keep it.
   */
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
            models: modelsDraftOf(persona.models),
          },
    );
  }, [answer]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  /**
   * A fork arrives with the copied name in hand.
   *
   * `forkPersona` copies the name verbatim, so a fork of "Impatient Rita" is a
   * second row also called "Impatient Rita" — and the API takes no name to
   * fork under. Selecting the field is what makes renaming the next keystroke
   * rather than a thing somebody has to notice.
   */
  /**
   * A panel that starts showing something else starts at the top of it.
   *
   * The body is one scrolling column and the three modes are the same column
   * with other content in it, so without this, pressing *Read* on a version
   * somebody had to scroll down to reach leaves them looking at the middle of
   * the frozen version they asked for.
   */
  useEffect(() => {
    const scroller = bodyRef.current;
    if (scroller !== null) scroller.scrollTop = 0;
  }, [reading, editing, personaId]);

  const filled = held !== null;
  useEffect(() => {
    if (!focusName || !editing || !filled) return;
    const field = nameField.current;
    if (field === null) return;
    field.focus();
    field.select();
  }, [focusName, editing, filled]);

  const persona = answer?.status === "ready" ? answer.value : null;
  const changed =
    held !== null &&
    persona !== null &&
    held.personaId === persona.id &&
    (held.name !== persona.name ||
      held.description !== (persona.description ?? "") ||
      !sameTraitsDraft(held.traits, draftOf(persona.traits)) ||
      !sameModelsDraft(held.models, modelsDraftOf(persona.models)));
  useUnsavedChanges(editing && changed && !saving, saving);

  /**
   * Which persona this panel is holding, readable from inside an await.
   *
   * Opening another persona does not remount the screen — it is the same route
   * with another identifier in it — so a write still in flight comes back into
   * a view that has moved on. A refusal about persona A drawn over persona B's
   * fields is a sentence about work nobody can see.
   */
  const holding = useRef({ projectId, personaId });
  useEffect(() => {
    holding.current = { projectId, personaId };
  }, [projectId, personaId]);

  async function write(
    request: PlatformRequest<Persona>,
    submitted?: Submitted,
  ): Promise<Persona | null> {
    const asked = { projectId, personaId };
    setSaving(true);
    setRefusal(null);

    const written = await platformAnswer(request);

    if (
      holding.current.projectId !== asked.projectId ||
      holding.current.personaId !== asked.personaId
    ) {
      return null;
    }

    setSaving(false);

    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return null;
    }
    if (written.status !== "ready") {
      // Everything typed stays where it is, and the refusal's own sentence
      // says what to do next.
      setRefusal(written.refusal);
      return null;
    }

    setHeld((current) => adopted(current, submitted, written.value));
    reload();
    reloadHistory();
    onWritten();
    return written.value;
  }

  async function saveChanges(): Promise<void> {
    if (
      held === null ||
      persona === null ||
      !mayAuthor ||
      persona.owner !== "organization" ||
      saving
    ) {
      return;
    }

    const nameChanged = held.name !== persona.name;
    const descriptionChanged =
      held.description !== (persona.description ?? "");
    const traitsChanged = !sameTraitsDraft(
      held.traits,
      draftOf(persona.traits),
    );
    const modelsChanged = !sameModelsDraft(
      held.models,
      modelsDraftOf(persona.models),
    );
    if (
      !nameChanged &&
      !descriptionChanged &&
      !traitsChanged &&
      !modelsChanged
    ) {
      return;
    }

    const submittedEditVersion = editVersion.current;
    const written = await write(
      updatePersona(
        {
          personaId: persona.id,
          projectId,
          expectedRevision: persona.revision,
          ...(nameChanged ? { name: held.name } : {}),
          ...(descriptionChanged ? { description: held.description } : {}),
          ...(traitsChanged || modelsChanged
            ? { expectedVersionId: persona.versionId }
            : {}),
          ...(traitsChanged ? { traits: traitsFrom(held.traits) } : {}),
          ...(modelsChanged ? { models: modelsFrom(held.models) } : {}),
        },
        { client: platformClient },
      ),
      {
        personaId: persona.id,
        ...(nameChanged ? { name: held.name } : {}),
        ...(descriptionChanged ? { description: held.description } : {}),
        ...(traitsChanged ? { traits: held.traits } : {}),
        ...(modelsChanged ? { models: held.models } : {}),
      },
    );
    if (written !== null && editVersion.current === submittedEditVersion) {
      setSaved(true);
    }
  }

  /**
   * An older version, written again as the newest one.
   *
   * **It needs no operation of its own**: a version is exactly its traits and
   * its models, so writing those back through the ordinary update is what
   * "use this again" means — and it arrives as a *new* version rather than as
   * a rewind, so every run that pinned the old one still reads the old one.
   * Both expectations travel with it, because this is a content change like
   * any other and the same two things can have moved under it.
   */
  async function useAsNewVersion(version: PersonaVersion): Promise<void> {
    if (persona === null || !mayAuthor || saving) return;
    const written = await write(
      updatePersona(
        {
          personaId: persona.id,
          projectId,
          expectedRevision: persona.revision,
          expectedVersionId: persona.versionId,
          traits: version.traits,
          // Reusing history authors a new version under today's model policy.
          models: modelsFrom(modelsDraftOf(version.models)),
        },
        { client: platformClient },
      ),
    );
    if (written !== null) {
      setHeld({
        personaId: written.id,
        name: written.name,
        description: written.description ?? "",
        traits: draftOf(written.traits),
        models: modelsDraftOf(written.models),
      });
      setReading(null);
    }
  }

  function edit(next: Draft): void {
    editVersion.current += 1;
    setSaved(false);
    setHeld(next);
  }

  const versions = history?.status === "ready" ? history.value.versions : [];
  const archivedAt = persona?.archivedAt ?? null;
  const archived = archivedAt !== null;
  const egmaProvided = persona?.owner === "egma";
  const totalVersions = Math.max(versions.length, persona?.version ?? 0);
  /**
   * Whether this panel is drawing an editor, which is four things at once and
   * not one: somebody asked for it, the persona is the project's own, it is
   * not archived, egma knows whose panel this is, and the authoring choices
   * have arrived. Computed here so the body and the footer can never disagree
   * about which of the two they are drawing.
   */
  const editable =
    editing &&
    persona?.owner === "organization" &&
    !archived &&
    role !== null &&
    form !== null;

  /** The head of the panel: the name, and what kind of record it is. */
  function meta(): string {
    if (persona === null) return "";
    const kind = ownerSaid(persona.owner);
    if (reading !== null) {
      return `${kind} · v${String(reading.version)} of ${String(totalVersions)}`;
    }
    if (editing) return `${kind} · v${String(persona.version)} · Editing`;
    return `${kind} · v${String(persona.version)}`;
  }

  function versionRows() {
    return versions.map((version) => ({
      id: version.id,
      version: version.version,
      written: <RelativeInstant instant={version.createdAt} now={now} />,
      current: version.id === persona?.versionId,
      reading: reading?.id === version.id,
      ...(version.id === persona?.versionId
        ? {}
        : { onRead: () => setReading(version) }),
    }));
  }

  /**
   * Which tests name this persona, in whichever state that read is in.
   *
   * **A read still in flight and a read that failed are not an empty list.**
   * "No active test names them" is the sentence somebody checks before they
   * archive, so printing it over an unanswered read would be a false all-clear
   * about the one thing this section exists to say. Only a ready answer with
   * nothing in it is allowed to say it; the other two say what happened, and
   * the failed one offers the read again.
   *
   * A signed-out answer is drawn as the wait it is. The panel is already
   * sending the browser to the sign-in page, and a failure box on the way out
   * would blame this read for an expired session.
   */
  function usedBySection() {
    return <SheetSection label="Used by">{usedByBody()}</SheetSection>;
  }

  function usedByBody() {
    if (usage === null || usage.status === "signed-out") {
      return (
        <p className="m-0 text-sm text-faint">Reading which tests name them…</p>
      );
    }
    if (usage.status !== "ready") {
      return (
        <Failure
          title="Egma could not read which tests name them."
          message={usage.refusal.message}
          onRetry={reloadUsage}
        />
      );
    }

    const usedBy = usage.value.tests;
    if (usedBy.length === 0) {
      return (
        <p className="m-0 text-sm text-muted-foreground">
          No active test names them.
        </p>
      );
    }
    return (
      <p className="m-0 flex flex-wrap gap-x-5 gap-y-2">
        {usedBy.map((test) => (
          <a
            className="text-sm text-foreground underline underline-offset-[3px] pointer-hover:text-primary"
            href={projectPath(projectId, "tests", test.id)}
            key={test.id}
          >
            {test.name}
          </a>
        ))}
      </p>
    );
  }

  /** The read view, which every mode except editing is a shape of. */
  function readBody(one: Persona) {
    const shown = reading;
    const traits = shown?.traits ?? one.traits;
    const models = shown?.models ?? one.models;

    return (
      <>
        <SheetSection label="Who they are">
          <Reads
            reads={[
              /*
               * A frozen version carries no name and no description — identity
               * is live — so printing today's description under "this version
               * is frozen" would be a sentence that is not true of it.
               */
              ...(shown === null
                ? [
                    {
                      label: "Description",
                      value:
                        one.description === null || one.description === "" ? (
                          <span className="text-faint">No description</span>
                        ) : (
                          one.description
                        ),
                      wide: true,
                    } satisfies Read,
                  ]
                : []),
              ...traitReads(traits),
            ]}
          />
        </SheetSection>

        <SheetSection label="Models">
          <Reads reads={modelReads(models, form)} />
        </SheetSection>

        {history === null ? (
          <Loading what="this persona's history" />
        ) : history.status === "ready" ? (
          <SheetSection label="Versions">
            <Versions rows={versionRows()} />
          </SheetSection>
        ) : history.status === "signed-out" ? (
          <Loading what="this persona's history" />
        ) : (
          <Failure message={history.refusal.message} onRetry={reloadHistory} />
        )}

        {usedBySection()}

        <SheetTimestamps>
          {shown !== null ? (
            "This version is frozen. Runs that used it read exactly this."
          ) : egmaProvided ? (
            "Provided by Egma · Shared with every project"
          ) : archivedAt !== null ? (
            <>
              Created <RelativeInstant instant={one.createdAt} now={now} /> ·
              Archived <RelativeInstant instant={archivedAt} now={now} />
            </>
          ) : (
            <>
              Created <RelativeInstant instant={one.createdAt} now={now} /> ·
              Updated <RelativeInstant instant={one.updatedAt} now={now} />
            </>
          )}
        </SheetTimestamps>
      </>
    );
  }

  /** The editor, which only a Custom persona and only an author ever sees. */
  function editBody(one: Persona, draft: Draft, choices: PersonaForm) {
    return (
      <>
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="persona-name">
            <Input
              id="persona-name"
              ref={nameField}
              value={draft.name}
              placeholder="What your team will call them. Names are not unique."
              autoComplete="off"
              spellCheck={false}
              onChange={(event) =>
                edit({ ...draft, name: event.target.value })
              }
            />
          </Field>
          <Field
            label="Description"
            htmlFor="persona-description"
            hint="Optional. One line for the people who select this persona."
          >
            <Input
              id="persona-description"
              value={draft.description}
              placeholder="A recurring support persona"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) =>
                edit({ ...draft, description: event.target.value })
              }
            />
          </Field>
          <Help>
            Name and description save in place. They do not make a new version.
          </Help>
        </div>

        <SheetSection label="Who they are">
          <div className="flex flex-col gap-4">
            <TraitFields
              draft={draft.traits}
              onChange={(traits) => edit({ ...draft, traits })}
            />
          </div>
        </SheetSection>

        <SheetSection label="Models">
          <div className="flex flex-col gap-4">
            <ModelFields
              draft={draft.models}
              form={choices}
              onChange={(models) => edit({ ...draft, models })}
              note={
                <NotePanel>
                  Saving a change to who they are or to their models makes v
                  {String(one.version + 1)}. Runs that used v
                  {String(one.version)} keep v{String(one.version)}. A save with
                  nothing changed makes no version.
                </NotePanel>
              }
            />
          </div>
        </SheetSection>
      </>
    );
  }

  function footer(one: Persona) {
    /*
     * **While the role is unknown there is no control at all.** A disabled one
     * would have to say why, and every sentence it could say would be a claim
     * about somebody egma has not identified yet.
     */
    if (role === null) return null;
    const why = mayAuthor || whyNot === undefined ? {} : { why: whyNot };
    const inert = !mayAuthor || saving || busy;

    if (reading !== null) {
      const frozen = reading;
      return (
        <SheetFooter
          destructive={
            <span className="text-sm text-faint">
              Writes v{String(frozen.version)} as v
              {String(one.version + 1)}.
            </span>
          }
        >
          <Button
            type="button"
            size="lg"
            busy={saving}
            disabled={inert}
            {...why}
            onClick={() => void useAsNewVersion(frozen)}
          >
            {saving ? "Saving…" : "Use as new version"}
          </Button>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            onClick={() => setReading(null)}
          >
            Back to v{String(one.version)}
          </Button>
        </SheetFooter>
      );
    }

    if (editable) {
      return (
        <SheetFooter>
          <Button
            type="submit"
            size="lg"
            busy={saving}
            disabled={!mayAuthor || !changed || saving}
            {...why}
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            disabled={saving}
            onClick={onRead}
          >
            Cancel
          </Button>
        </SheetFooter>
      );
    }

    if (egmaProvided) {
      return (
        <SheetFooter
          destructive={
            <span className="text-sm text-faint">
              Read-only. Fork makes an editable copy.
            </span>
          }
        >
          <Button
            type="button"
            size="lg"
            disabled={inert}
            {...why}
            onClick={() => onFork(one)}
          >
            Fork
          </Button>
        </SheetFooter>
      );
    }

    if (archived) {
      return (
        <SheetFooter>
          <Button
            type="button"
            size="lg"
            disabled={inert}
            {...why}
            onClick={() => onRestore(one)}
          >
            Restore
          </Button>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            disabled={inert}
            {...why}
            onClick={() => onFork(one)}
          >
            Fork
          </Button>
        </SheetFooter>
      );
    }

    return (
      <SheetFooter
        destructive={
          <Button
            type="button"
            size="lg"
            variant="ghost"
            className="text-failure"
            disabled={inert}
            {...why}
            onClick={() => onArchive(one)}
          >
            Archive
          </Button>
        }
      >
        <Button
          type="button"
          size="lg"
          disabled={inert}
          {...why}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          type="button"
          size="lg"
          variant="secondary"
          disabled={inert}
          {...why}
          onClick={() => onFork(one)}
        >
          Fork
        </Button>
      </SheetFooter>
    );
  }

  function body() {
    if (answer === null || answer.status === "signed-out") {
      return (
        <SheetBody ref={bodyRef}>
          <Loading what="this persona" />
        </SheetBody>
      );
    }
    if (answer.status === "missing") {
      return (
        <SheetBody ref={bodyRef}>
          <NotFound message={answer.refusal.message} />
        </SheetBody>
      );
    }
    if (answer.status === "failed") {
      return (
        <SheetBody ref={bodyRef}>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </SheetBody>
      );
    }

    const one = answer.value;
    // The read has answered and the editor has not been filled from it yet,
    // which is one render. Checked after the three refusals above, so a
    // persona that is not there says so rather than loading forever.
    if (held === null) {
      return (
        <SheetBody ref={bodyRef}>
          <Loading what="this persona" />
        </SheetBody>
      );
    }

    if (
      editing &&
      one.owner === "organization" &&
      !archived &&
      role !== null &&
      form === null
    ) {
      return (
        <SheetBody ref={bodyRef}>
          <Loading what="the supported persona models" />
        </SheetBody>
      );
    }

    return (
      <form
        className="flex min-h-0 flex-1 flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void saveChanges();
        }}
      >
        <SheetBody ref={bodyRef}>
          {refusal === null ? null : (
            <Refused
              message={refusal.message}
              action={
                <Button type="button" variant="secondary" onClick={reload}>
                  Read this persona again
                </Button>
              }
            />
          )}
          {editable && form !== null ? editBody(one, held, form) : readBody(one)}
          {saved && refusal === null ? <Help>Saved.</Help> : null}
        </SheetBody>
        {footer(one)}
      </form>
    );
  }

  const title = persona?.name ?? "Persona";

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {persona === null ? null : (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-faint">{meta()}</span>
              {reading !== null ? (
                <StateChip>Older version</StateChip>
              ) : archivedAt !== null ? (
                <StateChip>
                  Archived <RelativeInstant instant={archivedAt} now={now} />
                </StateChip>
              ) : persona.isDefault ? (
                <StateChip tone="current">Project default</StateChip>
              ) : role === null ? null : (
                <Button
                  className="h-auto min-h-0 p-0 text-primary underline underline-offset-[3px]"
                  type="button"
                  variant="link"
                  disabled={!mayAuthor || busy || saving}
                  {...(mayAuthor || whyNot === undefined
                    ? {}
                    : { why: whyNot })}
                  onClick={() => onMakeDefault(persona)}
                >
                  Make project default
                </Button>
              )}
            </span>
          )}
        </SheetHeader>
        {body()}
      </SheetContent>
    </Sheet>
  );
}
