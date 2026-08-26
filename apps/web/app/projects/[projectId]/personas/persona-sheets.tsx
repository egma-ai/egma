"use client";

import { EllipsisVerticalIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  createPersona,
  deletePersona,
  getPersona,
  listPersonaVersions,
  updatePersona,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Answer, Refusal } from "../../../../lib/api.ts";
import {
  behaviorDraftOf,
  BLANK_BEHAVIOR,
  modelSaid,
  modelsDraftOf,
  modelsFrom,
  ownerSaid,
  sameBehaviorDraft,
  sameModelsDraft,
  type BehaviorDraft,
  type ModelsDraft,
  type Persona,
  type PersonaForm,
  type PersonaModels,
  type PersonaVersion,
  type PersonaVersionPage,
} from "../../../../lib/personas.ts";
import {
  platformAnswer,
  platformClient,
  type PlatformRequest,
} from "../../../../lib/platform-client.ts";
import { Dialog } from "../../../../ui/dialog.tsx";
import { useDraftNavigation } from "../../../../ui/draft-navigation.tsx";
import { Refused } from "../../../../ui/form.tsx";
import { Menu, MenuDivider, MenuItem } from "../../../../ui/menu.tsx";
import { Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { ListInstant, RelativeInstant, useMinuteClock } from "../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../ui/settings-read.ts";
import {
  BehaviorFields,
  ModelFields,
  NameFields,
} from "./persona-fields.tsx";
import { Reads, SheetSection, StateChip, Versions, type Read } from "./sheet-parts.tsx";

/**
 * A persona, created, read and edited in the panel the boards put it in.
 *
 * **The list stays on screen behind it, and the address never moves.** Create,
 * read and edit are three things this one panel is showing, not three places
 * anybody is — so none of them is a route. Somebody who opens a persona,
 * changes their mind and presses Escape is back where they were, with the list
 * they were reading still scrolled where they left it, and no step in the
 * browser's history that says nothing about where they are.
 *
 * **The distinction the whole panel is arranged around** is which half of a
 * persona a save touches: the team `name` and the description are *live* —
 * rewriting them changes nothing about any simulation that ever ran — and the
 * identity name, the personality, the language and the models are *versioned*,
 * because a run pinned the exact set it used. The one line under the name block
 * says so, and it is the only version arithmetic left on this surface.
 *
 * **A Predefined persona is a read and one action.** No editor, no footer, no
 * history, and Fork alone in its ⋮ — the shared catalog cannot be broken by any
 * project, and a panel offering controls that would all refuse is a panel that
 * wastes somebody's time to tell them so.
 */

/** The words this surface repeats, written once. */
const COPY = {
  nameNote:
    "Name and description save in place. They do not make a new version.",
} as const;

/** What the simulator brings that person to life with, one item per line. */
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
      label: "Speech-to-text",
      value: modelSaid(form?.modelCatalog, "stt", models.stt),
    },
    {
      label: "Text-to-speech",
      value: modelSaid(form?.modelCatalog, "tts", models.tts),
    },
    { label: "Speech rate", value: `${String(models.tts.speed)}×`, mono: true },
    { label: "Voice", value: models.tts.voiceId, mono: true },
  ];
}

/** Who they are, one item per line, in the order the boards read them back. */
function behaviorReads(
  behavior: BehaviorDraft,
  description: ReactNode,
): readonly Read[] {
  return [
    ...(description === null ? [] : [{ label: "Description", value: description }]),
    { label: "Identity name", value: behavior.identityName },
    { label: "Personality", value: behavior.personality },
    { label: "Language", value: behavior.language },
  ];
}

/** A description that is not there says so, rather than leaving a blank line. */
function describedAs(description: string | null): ReactNode {
  return description === null || description === "" ? (
    <span className="text-faint">No description</span>
  ) : (
    description
  );
}

/** The ⋮ a sheet carries for the record it is showing. */
function SheetMenu({
  label,
  children,
}: {
  readonly label: string;
  readonly children: (close: () => void) => ReactNode;
}) {
  return (
    <Menu
      label={label}
      placement="below-end"
      trigger={
        <EllipsisVerticalIcon
          aria-hidden="true"
          className="size-3.5"
          strokeWidth={1.75}
        />
      }
      triggerClassName={[
        "inline-flex size-(--control-lg) flex-none cursor-pointer",
        "items-center justify-center rounded-button border border-transparent",
        "bg-transparent text-muted-foreground",
        "transition-[color,background-color] duration-(--duration-hover) ease-out",
        "pointer-hover:bg-surface-soft pointer-hover:text-foreground",
      ].join(" ")}
      openClassName="bg-surface-soft text-foreground"
    >
      {children}
    </Menu>
  );
}

/** One destructive item, at the foot of a menu, in the failure colour. */
function DeleteItem({
  disabled,
  onClick,
}: {
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <>
      <MenuDivider />
      <MenuItem disabled={disabled} onClick={onClick}>
        <span className="text-failure">Delete</span>
      </MenuItem>
    </>
  );
}

export function CreatePersonaSheet({
  projectId,
  open,
  form,
  reloadForm,
  role,
  mayAuthor,
  whyNot,
  onClose,
  onCreated,
}: {
  readonly projectId: string;
  readonly open: boolean;
  /** The authoring choices, read once by the screen and lent to every sheet. */
  readonly form: Answer<PersonaForm> | null;
  readonly reloadForm: () => void;
  readonly role: string | null;
  readonly mayAuthor: boolean;
  readonly whyNot: string | undefined;
  readonly onClose: () => void;
  readonly onCreated: (persona: Persona) => void;
}) {
  const draftNavigation = useDraftNavigation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [behavior, setBehavior] = useState<BehaviorDraft>(BLANK_BEHAVIOR);
  const [models, setModels] = useState<ModelsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const choices = form?.status === "ready" ? form.value : null;

  /**
   * A sheet that opens again opens empty.
   *
   * It is not remounted between one persona and the next — the panel has to
   * stay in the tree long enough to finish leaving — so what is in the fields
   * is cleared on the way in rather than on the way out.
   */
  /*
   * The catalog, readable from the opening without making the opening depend
   * on it. A reset that listed `choices` as a dependency would empty the fields
   * again every time that read answered — including a refresh landing while
   * somebody is part-way through typing into them.
   */
  const catalog = useRef(choices);
  catalog.current = choices;
  const wasOpen = useRef(open);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setName("");
    setDescription("");
    setBehavior(BLANK_BEHAVIOR);
    /*
     * Back to the release defaults rather than to nothing. Emptying this and
     * waiting for the catalog effect below to fill it again only works the
     * first time: the catalog has already answered by the second opening, so
     * that effect does not run and the panel would wait for a read that has
     * already happened.
     */
    const known = catalog.current;
    setModels(known === null ? null : modelsDraftOf(known.recommendedModels));
    setSaving(false);
    setRefusal(null);
  }, [open]);

  /**
   * The release defaults, filled in as soon as the catalog answers.
   *
   * Every model field is prefilled so authoring a first persona is three things
   * typed and nothing chosen: nobody should have to pick a speech vendor to
   * test a scenario.
   */
  useEffect(() => {
    if (choices === null) return;
    setModels((already) => already ?? modelsDraftOf(choices.recommendedModels));
  }, [choices]);

  const changed =
    name !== "" ||
    description !== "" ||
    !sameBehaviorDraft(behavior, BLANK_BEHAVIOR) ||
    (models !== null &&
      choices !== null &&
      !sameModelsDraft(models, modelsDraftOf(choices.recommendedModels)));
  useUnsavedChanges(open && changed && !saving, saving);

  function leave(): void {
    draftNavigation.request(() => onClose());
  }

  async function save(): Promise<void> {
    if (models === null || saving || !mayAuthor) return;
    setSaving(true);
    setRefusal(null);

    const written = await platformAnswer(
      createPersona(
        {
          projectId,
          name,
          ...(description === "" ? {} : { description }),
          identityName: behavior.identityName,
          personality: behavior.personality,
          language: behavior.language,
          models: modelsFrom(models),
        },
        { client: platformClient },
      ),
    );

    setSaving(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      // Everything typed stays where it is, and the refusal's own sentence
      // says what to do next.
      setRefusal(written.refusal);
      return;
    }
    onCreated(written.value);
  }

  function content(): ReactNode {
    if (role === null) return <SheetBody><Loading what="your role" /></SheetBody>;
    if (form === null || form.status === "signed-out") {
      return (
        <SheetBody>
          <Loading what="the supported persona models" />
        </SheetBody>
      );
    }
    if (form.status !== "ready") {
      return (
        <SheetBody>
          <Failure message={form.refusal.message} onRetry={reloadForm} />
        </SheetBody>
      );
    }
    if (models === null) {
      return (
        <SheetBody>
          <Loading what="the supported persona models" />
        </SheetBody>
      );
    }

    return (
      <form
        className="flex min-h-0 flex-1 flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <SheetBody>
          {refusal === null ? null : <Refused message={refusal.message} />}
          <NameFields
            prefix="new-persona"
            name={name}
            description={description}
            disabled={saving}
            onName={setName}
            onDescription={setDescription}
          />
          <BehaviorFields
            prefix="new-persona"
            draft={behavior}
            disabled={saving}
            onChange={setBehavior}
          />
          <ModelFields
            prefix="new-persona"
            draft={models}
            form={form.value}
            disabled={saving}
            onChange={setModels}
          />
        </SheetBody>
        <SheetFooter>
          <Button
            type="submit"
            size="lg"
            busy={saving}
            disabled={!mayAuthor || saving}
            {...(mayAuthor || whyNot === undefined ? {} : { why: whyNot })}
          >
            {saving ? "Creating…" : "Create persona"}
          </Button>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            disabled={saving}
            onClick={leave}
          >
            Cancel
          </Button>
        </SheetFooter>
      </form>
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) leave();
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>New persona</SheetTitle>
        </SheetHeader>
        {content()}
      </SheetContent>
    </Sheet>
  );
}

/** What the editor in this sheet is holding, between reads and writes. */
type Draft = {
  readonly personaId: string;
  readonly name: string;
  readonly description: string;
  readonly behavior: BehaviorDraft;
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
  readonly behavior?: BehaviorDraft;
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

  const theirs = behaviorDraftOf(fromServer);
  const behavior = { ...current.behavior };
  if (submitted.behavior !== undefined) {
    for (const key of Object.keys(
      current.behavior,
    ) as (keyof BehaviorDraft)[]) {
      behavior[key] = answered(
        current.behavior[key],
        submitted.behavior[key],
        theirs[key],
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
    behavior,
    models,
  };
}

export function PersonaSheet({
  projectId,
  personaId,
  open,
  form,
  role,
  mayAuthor,
  whyNot,
  startEditing = false,
  focusName = false,
  busy,
  onClose,
  onWritten,
  onFork,
  onDelete,
}: {
  readonly projectId: string;
  readonly personaId: string;
  readonly open: boolean;
  /** The authoring choices, read once by the screen and lent to every sheet. */
  readonly form: PersonaForm | null;
  readonly role: string | null;
  readonly mayAuthor: boolean;
  readonly whyNot: string | undefined;
  /** A fork lands in the editor with its copied name ready to be replaced. */
  readonly startEditing?: boolean;
  readonly focusName?: boolean;
  /** A write the screen is running for this persona. */
  readonly busy: boolean;
  readonly onClose: () => void;
  /** The list behind this panel is now out of date. */
  readonly onWritten: () => void;
  readonly onFork: (persona: Persona) => void;
  readonly onDelete: (persona: Persona) => void;
}) {
  const now = useMinuteClock();
  const draftNavigation = useDraftNavigation();
  const nameField = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const { answer, reload } = useProjectRead<Persona>(
    (project) =>
      platformAnswer(
        getPersona(
          { personaId, projectId: project },
          { client: platformClient },
        ),
      ),
    projectId,
    personaId,
  );
  const {
    answer: history,
    reload: reloadHistory,
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

  const [held, setHeld] = useState<Draft | null>(null);
  const [editing, setEditing] = useState(startEditing);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  /** The frozen version this panel is reading instead of the current one. */
  const [reading, setReading] = useState<PersonaVersion | null>(null);

  /**
   * The editor is filled from the read once and never overwritten by a later
   * one. A reload that reset the fields would throw away work somebody is
   * part-way through typing — which is exactly what happens after a refusal,
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
            behavior: behaviorDraftOf(persona),
            models: modelsDraftOf(persona.models),
          },
    );
  }, [answer]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  /**
   * A panel that opens again opens on the record, not on what was left over.
   *
   * The panel is not remounted between one opening and the next — it has to
   * stay in the tree long enough to finish leaving, and the same persona keeps
   * the same key — so somebody who closes the sheet mid-edit and opens it again
   * would otherwise land straight back in the editor, over a draft they thought
   * they had left.
   */
  const wasOpen = useRef(open);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setEditing(startEditing);
    setReading(null);
    setRefusal(null);
  }, [open, startEditing]);

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
  }, [reading, editing]);

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
      !sameBehaviorDraft(held.behavior, behaviorDraftOf(persona)) ||
      !sameModelsDraft(held.models, modelsDraftOf(persona.models)));
  useUnsavedChanges(open && editing && changed && !saving, saving);

  /**
   * Which persona this panel is holding, readable from inside an await.
   *
   * A write still in flight for the persona this panel has just left is dropped
   * when it lands: a refusal about persona A drawn over persona B's fields is a
   * sentence about work nobody can see.
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

    const stored = behaviorDraftOf(persona);
    const nameChanged = held.name !== persona.name;
    const descriptionChanged =
      held.description !== (persona.description ?? "");
    const behaviorChanged = !sameBehaviorDraft(held.behavior, stored);
    const modelsChanged = !sameModelsDraft(
      held.models,
      modelsDraftOf(persona.models),
    );
    if (
      !nameChanged &&
      !descriptionChanged &&
      !behaviorChanged &&
      !modelsChanged
    ) {
      return;
    }

    const written = await write(
      updatePersona(
        {
          personaId: persona.id,
          projectId,
          ...(nameChanged ? { name: held.name } : {}),
          ...(descriptionChanged ? { description: held.description } : {}),
          ...(behaviorChanged
            ? {
                identityName: held.behavior.identityName,
                personality: held.behavior.personality,
                language: held.behavior.language,
              }
            : {}),
          ...(modelsChanged ? { models: modelsFrom(held.models) } : {}),
        },
        { client: platformClient },
      ),
      {
        personaId: persona.id,
        ...(nameChanged ? { name: held.name } : {}),
        ...(descriptionChanged ? { description: held.description } : {}),
        ...(behaviorChanged ? { behavior: held.behavior } : {}),
        ...(modelsChanged ? { models: held.models } : {}),
      },
    );
    if (written !== null) setEditing(false);
  }

  /**
   * An older version, written again as the newest one.
   *
   * **It needs no operation of its own**: a version is exactly its identity
   * name, its personality, its language and its models, so writing those back
   * through the ordinary update is what "use this again" means — and it arrives
   * as a *new* version rather than as a rewind, so every run that pinned the
   * old one still reads the old one.
   */
  async function useAsNewVersion(version: PersonaVersion): Promise<void> {
    if (persona === null || !mayAuthor || saving) return;
    const written = await write(
      updatePersona(
        {
          personaId: persona.id,
          projectId,
          identityName: version.identityName,
          personality: version.personality,
          language: version.language,
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
        behavior: behaviorDraftOf(written),
        models: modelsDraftOf(written.models),
      });
      setReading(null);
    }
  }

  function edit(next: Draft): void {
    setHeld(next);
  }

  /** Leaving the editor, or the panel, with a question if there is one to ask. */
  function leaveEditor(): void {
    draftNavigation.request(() => {
      setRefusal(null);
      setEditing(false);
      if (persona !== null && held !== null && held.personaId === persona.id) {
        setHeld({
          personaId: persona.id,
          name: persona.name,
          description: persona.description ?? "",
          behavior: behaviorDraftOf(persona),
          models: modelsDraftOf(persona.models),
        });
      }
    });
  }

  function leave(): void {
    draftNavigation.request(() => onClose());
  }

  const versions = history?.status === "ready" ? history.value.versions : [];
  const predefined = persona?.owner === "egma";
  const totalVersions = Math.max(versions.length, persona?.version ?? 0);
  /**
   * Whether this panel is drawing an editor, which is four things at once and
   * not one: somebody asked for it, the persona is the project's own, egma
   * knows whose panel this is, and the authoring choices have arrived.
   */
  const editable =
    editing && persona?.owner === "organization" && role !== null && form !== null;

  /** The head of the panel: what kind of record it is, and which version. */
  function meta(): string {
    if (persona === null) return "";
    const kind = ownerSaid(persona.owner);
    if (reading !== null) {
      return `${kind} · v${String(reading.version)} of ${String(totalVersions)}`;
    }
    if (editing && persona.owner === "organization") {
      return `${kind} · v${String(persona.version)} · Editing`;
    }
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

  /** The read view, which every mode except editing is a shape of. */
  function readBody(one: Persona) {
    const shown = reading;
    const behavior = shown === null ? behaviorDraftOf(one) : behaviorDraftOf(shown);
    const models = shown?.models ?? one.models;

    return (
      <>
        <SheetSection label="Who they are">
          <Reads
            reads={behaviorReads(
              behavior,
              /*
               * A frozen version carries no name and no description — identity
               * is live — so printing today's description under "this version
               * is frozen" would be a sentence that is not true of it.
               */
              shown === null ? describedAs(one.description) : null,
            )}
          />
        </SheetSection>

        <SheetSection label="Models">
          <Reads reads={modelReads(models, form)} />
        </SheetSection>

        {/*
         * **A Predefined persona's panel ends here.** It has one version that
         * is never going to become two, and it belongs to Egma rather than to
         * this project — so the dates a project would read its own record by,
         * and the history behind them, are facts about nothing anybody here can
         * change. The boards draw the panel ending at the voice.
         */}
        {predefined ? null : (
          <>
            <Reads
              reads={[
                {
                  label: "Created",
                  value: <ListInstant instant={one.createdAt} />,
                },
                {
                  label: "Updated",
                  value: <ListInstant instant={one.updatedAt} />,
                },
              ]}
            />

            {history === null || history.status === "signed-out" ? (
              <Loading what="this persona's history" />
            ) : history.status === "ready" ? (
              <SheetSection label="Versions">
                <Versions rows={versionRows()} />
              </SheetSection>
            ) : (
              <Failure
                message={history.refusal.message}
                onRetry={reloadHistory}
              />
            )}
          </>
        )}
      </>
    );
  }

  /** The editor, which only a Custom persona and only an author ever sees. */
  function editBody(draft: Draft, choices: PersonaForm) {
    return (
      <>
        <NameFields
          prefix="persona"
          name={draft.name}
          description={draft.description}
          disabled={saving}
          note={COPY.nameNote}
          onName={(name) => edit({ ...draft, name })}
          onDescription={(description) => edit({ ...draft, description })}
        />
        <BehaviorFields
          prefix="persona"
          draft={draft.behavior}
          disabled={saving}
          onChange={(behavior) => edit({ ...draft, behavior })}
        />
        <ModelFields
          prefix="persona"
          draft={draft.models}
          form={choices}
          disabled={saving}
          onChange={(models) => edit({ ...draft, models })}
        />
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
              Writes v{String(frozen.version)} as v{String(one.version + 1)}.
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
            onClick={leaveEditor}
          >
            Cancel
          </Button>
        </SheetFooter>
      );
    }

    /*
     * **A Predefined persona has no footer at all**, which is the boards'
     * drawing and the honest one: every control it could offer is Fork, and
     * Fork is in the ⋮ with the rest of what a record's panel can do.
     */
    return null;
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

    if (editing && one.owner === "organization" && role !== null && form === null) {
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
          {editable && form !== null ? editBody(held, form) : readBody(one)}
        </SheetBody>
        {footer(one)}
      </form>
    );
  }

  /**
   * The record's own actions, in the head beside the close.
   *
   * **Every one of a record's actions is in one menu**, which is what makes a
   * sheet's head the same shape on every surface in the product. A Predefined
   * persona's menu holds Fork alone: it cannot be edited and it cannot be
   * deleted, and offering either would be offering a refusal.
   */
  function actions(one: Persona): ReactNode {
    if (role === null || editing || reading !== null) return undefined;
    const inert = !mayAuthor || saving || busy;
    return (
      <SheetMenu label={`Actions for ${one.name}`}>
        {(close) => (
          <>
            {predefined ? null : (
              <MenuItem
                disabled={inert}
                onClick={() => {
                  close();
                  setEditing(true);
                }}
              >
                Edit
              </MenuItem>
            )}
            <MenuItem
              disabled={inert}
              onClick={() => {
                close();
                onFork(one);
              }}
            >
              Fork
            </MenuItem>
            {predefined ? null : (
              <DeleteItem
                disabled={inert}
                onClick={() => {
                  close();
                  onDelete(one);
                }}
              />
            )}
          </>
        )}
      </SheetMenu>
    );
  }

  const title = persona?.name ?? "Persona";

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) leave();
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <SheetHeader
          {...(persona === null ? {} : { actions: actions(persona) })}
        >
          <SheetTitle>{title}</SheetTitle>
          {persona === null ? null : (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-faint">{meta()}</span>
              {reading === null ? null : <StateChip>Older version</StateChip>}
            </span>
          )}
        </SheetHeader>
        {body()}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Deleting one persona, and the one question it asks.
 *
 * **Delete is the product's word and the confirmation names who it is about.**
 * Underneath, the row is stamped rather than removed, so every simulation that
 * pinned this persona still reads exactly what it heard — but that is storage,
 * not something a person authoring a test is asked to hold in their head. What
 * they are told is what actually changes for them: the persona leaves every
 * list and picker, and a test that still names them has to name somebody else
 * before it can be written or run again.
 */
export function DeletePersonaDialog({
  persona,
  projectId,
  onClose,
  onDeleted,
}: {
  readonly persona: Persona;
  readonly projectId: string;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setRefused(null);

    const answer = await platformAnswer(
      deletePersona(
        { personaId: persona.id, projectId },
        { client: platformClient },
      ),
    );

    setBusy(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onDeleted();
  }

  return (
    <Dialog title={`Delete ${persona.name}?`} onClose={onClose}>
      {(dismiss) => (
        <>
          <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
            They leave every list and picker your team authors from. Runs that
            already used them stay readable exactly as they were. A test that
            still names them has to name somebody else before it can be written
            or run again.
          </p>
          {refused === null ? null : <Refused message={refused.message} />}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="lg"
              variant="destructive"
              busy={busy}
              onClick={() => void remove()}
            >
              {busy ? "Deleting…" : "Delete persona"}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="secondary"
              disabled={busy}
              onClick={() => dismiss()}
            >
              Cancel
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
