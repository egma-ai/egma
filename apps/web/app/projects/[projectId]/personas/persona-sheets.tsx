"use client";

import { EllipsisVerticalIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  createPersona,
  deletePersona,
  getPersona,
  updatePersona,
  usePersona,
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
  controlsFrom,
  modelSaid,
  modelsDraftOf,
  modelsFrom,
  modelsOfPersona,
  ownerSaid,
  sameBehaviorDraft,
  sameModelsDraft,
  type BehaviorDraft,
  type ModelsDraft,
  type Persona,
  type PersonaForm,
  type PersonaModels,
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
import { useProjectRead } from "../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../ui/settings-read.ts";
import {
  BehaviorFields,
  ModelFields,
  NameFields,
} from "./persona-fields.tsx";
import { Reads, SheetSection, type Read } from "./sheet-parts.tsx";

/**
 * Create, read, and edit a persona in a sheet over the list. Name and
 * description are metadata; identity, personality, and language are versioned
 * behavior. Project settings are editable inline. Egma-provided behavior is
 * read-only; Custom personas also support current-version edits and deletion.
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
  const [settingsValid, setSettingsValid] = useState(true);
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
          models: modelsFrom(models),
          controls: controlsFrom(models),
        } as Parameters<typeof createPersona>[0],
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
            projectId={projectId}
            onValidityChange={setSettingsValid}
          />
        </SheetBody>
        <SheetFooter
          secondary={
            <Button type="button" size="lg" variant="secondary" disabled={saving} onClick={leave}>
              Cancel
            </Button>
          }
        >
          <Button
            type="submit"
            size="lg"
            busy={saving}
            disabled={!mayAuthor || saving || !settingsValid}
            {...(mayAuthor || whyNot === undefined ? {} : { why: whyNot })}
          >
            {saving ? "Creating…" : "Create persona"}
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
  readonly versionId: string;
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
 * Adopt a server value only for a submitted field whose draft still matches
 * what was sent. Preserve unsubmitted fields and edits made while saving.
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

  const theirModels = modelsDraftOf(modelsOfPersona(fromServer), fromServer.settings?.controls);
  const models = submitted.models !== undefined && sameModelsDraft(current.models, submitted.models)
    ? theirModels
    : current.models;

  return {
    personaId: current.personaId,
    versionId: submitted.behavior === undefined ? current.versionId : fromServer.versionId,
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
  reloadForm,
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
  readonly form: Answer<PersonaForm> | null;
  readonly reloadForm: () => void;
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
  const choices = form?.status === "ready" ? form.value : null;
  const draftNavigation = useDraftNavigation();
  const nameField = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const { answer, reload, refresh } = useProjectRead<Persona>(
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
  const [held, setHeld] = useState<Draft | null>(null);
  const [editing, setEditing] = useState(startEditing);
  const [saving, setSaving] = useState(false);
  const [settingsValid, setSettingsValid] = useState(true);
  const [saved, setSaved] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

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
            versionId: persona.versionId,
            name: persona.name,
            description: persona.description ?? "",
            behavior: behaviorDraftOf(persona),
            models: modelsDraftOf(modelsOfPersona(persona), persona.settings?.controls),
          },
    );
  }, [answer]);

  useEffect(() => {
    if (answer?.status === "signed-out" || form?.status === "signed-out") {
      window.location.replace("/sign-in");
    }
  }, [answer, form]);

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
    setSaved(false);
    setRefusal(null);
    if (answer?.status === "ready") {
      const one = answer.value;
      setHeld({
        personaId: one.id,
        versionId: one.versionId,
        name: one.name,
        description: one.description ?? "",
        behavior: behaviorDraftOf(one),
        models: modelsDraftOf(modelsOfPersona(one), one.settings?.controls),
      });
    }
  }, [open, startEditing, answer]);

  /** Opening the custom identity editor starts at its first field. */
  useEffect(() => {
    const scroller = bodyRef.current;
    if (scroller !== null) scroller.scrollTop = 0;
  }, [editing]);

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
      !sameModelsDraft(held.models, modelsDraftOf(modelsOfPersona(persona), persona.settings?.controls)));
  useUnsavedChanges(open && changed && !saving, saving);

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
    setSaved(false);
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
      if (written.refusal.error === "version_conflict") {
        refresh();
      }
      return null;
    }

    setHeld((current) => adopted(current, submitted, written.value));
    reload();
    onWritten();
    return written.value;
  }

  async function saveChanges(): Promise<void> {
    if (
      held === null ||
      persona === null ||
      !mayAuthor ||
      saving ||
      busy
    ) {
      return;
    }

    const stored = behaviorDraftOf(persona);
    const nameChanged = persona.owner === "organization" && held.name !== persona.name;
    const descriptionChanged =
      persona.owner === "organization" && held.description !== (persona.description ?? "");
    const behaviorChanged = persona.owner === "organization" && !sameBehaviorDraft(held.behavior, stored);
    const modelsChanged = !sameModelsDraft(
      held.models,
      modelsDraftOf(modelsOfPersona(persona), persona.settings?.controls),
    );
    if (
      !nameChanged &&
      !descriptionChanged &&
      !behaviorChanged &&
      !modelsChanged && persona.settings !== null
    ) {
      return;
    }

    const written = await write(
      persona.settings === null ? usePersona({ personaId: persona.id, projectId, models: modelsFrom(held.models), controls: controlsFrom(held.models) } as Parameters<typeof usePersona>[0], { client: platformClient }) : updatePersona(
        {
          personaId: persona.id,
          projectId,
          ...(nameChanged ? { name: held.name } : {}),
          ...(descriptionChanged ? { description: held.description } : {}),
          ...(behaviorChanged
            ? {
                expectedVersionId: held.versionId,
                identityName: held.behavior.identityName,
                personality: held.behavior.personality,
              }
            : {}),
          ...(modelsChanged ? { models: modelsFrom(held.models), controls: controlsFrom(held.models) } : {}),
        } as Parameters<typeof updatePersona>[0],
        { client: platformClient },
      ),
      {
        personaId: persona.id,
        ...(nameChanged ? { name: held.name } : {}),
        ...(descriptionChanged ? { description: held.description } : {}),
        ...(behaviorChanged ? { behavior: held.behavior } : {}),
        ...(modelsChanged || persona.settings === null ? { models: held.models } : {}),
      },
    );
    if (written !== null) {
      setSaved(true);
      setEditing(false);
    }
  }

  function edit(next: Draft): void {
    setSaved(false);
    setHeld(next);
  }

  /** Leaving the editor, or the panel, with a question if there is one to ask. */
  function leaveEditor(): void {
    draftNavigation.request(() => {
      setSaved(false);
      setRefusal(null);
      setEditing(false);
      if (persona !== null && held !== null && held.personaId === persona.id) {
        setHeld({
          personaId: persona.id,
          versionId: persona.versionId,
          name: persona.name,
          description: persona.description ?? "",
          behavior: behaviorDraftOf(persona),
          models: modelsDraftOf(modelsOfPersona(persona), persona.settings?.controls),
        });
      }
    });
  }

  function leave(): void {
    draftNavigation.request(() => onClose());
  }

  const predefined = persona?.owner === "egma";
  const settingsReady = persona !== null && role !== null && choices !== null;

  /** The head keeps the current core version visible. */
  function meta(): string {
    if (persona === null) return "";
    const kind = ownerSaid(persona.owner);
    return `${kind} · v${String(persona.version)}${editing ? " · Editing" : ""}`;
  }

  /** Shared identity stays read-only while the settings below it are editable. */
  function readBody(one: Persona) {
    return (
      <SheetSection label="Who they are">
        <Reads
          reads={behaviorReads(behaviorDraftOf(one), describedAs(one.description))}
        />
      </SheetSection>
    );
  }

  function settingsBody(one: Persona, draft: Draft) {
    if (role === null) {
      return (
        <SheetSection label="Settings">
          <Reads reads={modelReads(modelsOfPersona(one), choices)} />
        </SheetSection>
      );
    }
    if (form === null || form.status === "signed-out") {
      return (
        <SheetSection label="Settings">
          <Loading what="the supported persona models" />
        </SheetSection>
      );
    }
    if (form.status !== "ready") {
      return (
        <SheetSection label="Settings">
          <Failure message={form.refusal.message} onRetry={reloadForm} />
        </SheetSection>
      );
    }
    return (
      <ModelFields
        prefix="persona"
        draft={draft.models}
        form={form.value}
        disabled={!mayAuthor || saving || busy}
        onChange={(models) => edit({ ...draft, models })}
        projectId={projectId}
        onValidityChange={setSettingsValid}
      />
    );
  }

  /** Shared personas expose settings; custom personas also expose core fields. */
  function editBody(draft: Draft) {
    return (
      <>
        <NameFields
          prefix="persona"
          name={draft.name}
          description={draft.description}
          disabled={!mayAuthor || saving || busy}
          note={COPY.nameNote}
          onName={(name) => edit({ ...draft, name })}
          onDescription={(description) => edit({ ...draft, description })}
        />
        <BehaviorFields
          prefix="persona"
          draft={draft.behavior}
          disabled={!mayAuthor || saving || busy}
          onChange={(behavior) => edit({ ...draft, behavior })}
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
    if (settingsReady) {
      return (
        <SheetFooter
          secondary={
            <Button
              type="button"
              size="lg"
              variant="secondary"
              disabled={saving}
              onClick={editing ? leaveEditor : leave}
            >
              Cancel
            </Button>
          }
        >
          <Button
            type="submit"
            size="lg"
            busy={saving}
            disabled={!mayAuthor || !settingsValid || (!changed && one.settings !== null) || saving || busy}
            {...why}
          >
            {saving ? "Saving…" : saved && !changed ? "Saved" : one.settings === null ? "Use persona" : "Save changes"}
          </Button>
        </SheetFooter>
      );
    }

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
          {editing && !predefined ? editBody(held) : readBody(one)}
          {settingsBody(one, held)}
        </SheetBody>
        {footer(one)}
      </form>
    );
  }

  /**
   * The record's own actions, in the head beside the close.
   *
   * Custom identity editing, cloning, and deletion remain in the menu.
   * Shared cores stay read-only while settings are edited in the body.
   */
  function actions(one: Persona): ReactNode {
    if (role === null || editing) return undefined;
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
                draftNavigation.request(() => onFork(one));
              }}
            >
              Clone
            </MenuItem>
            {predefined ? null : (
              <DeleteItem
                disabled={inert}
                onClick={() => {
                  close();
                  draftNavigation.request(() => onDelete(one));
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
            </span>
          )}
        </SheetHeader>
        <span className="sr-only" role="status">
          {saved && !changed ? "Persona saved." : ""}
        </span>
        {body()}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Delete removes the persona from lists and pickers while preserving pinned
 * versions for existing simulations. Tests referencing it need another persona
 * before they can be saved or run.
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
