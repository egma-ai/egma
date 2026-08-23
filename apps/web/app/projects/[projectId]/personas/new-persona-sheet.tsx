"use client";

import { useEffect, useState } from "react";
import { createPersona } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Answer, Refusal } from "../../../../lib/api.ts";
import {
  BLANK_TRAITS,
  modelsDraftOf,
  modelsFrom,
  sameModelsDraft,
  traitsFrom,
  type ModelsDraft,
  type Persona,
  type PersonaForm,
  type TraitsDraft,
} from "../../../../lib/personas.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { Field, Refused } from "../../../../ui/form.tsx";
import { Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { useUnsavedChanges } from "../../../../ui/settings-read.ts";
import { ModelFields } from "./models-editor.tsx";
import { NotePanel, SheetSection } from "./sheet-parts.tsx";
import { TraitFields } from "./traits-editor.tsx";

/**
 * Authoring a persona, in the panel the list stays visible behind (`B0A-0`).
 *
 * **The form is arranged around one sentence: who they are, never what they
 * want.** The identity fields name them for the people who will pick them off
 * the list behind this panel; personality describes the person the simulator
 * brings to life. A scenario belongs to a test, and a persona carrying one
 * would stop being reusable the moment somebody wrote it down.
 *
 * The sub-line under the title says the three things a person cannot see from
 * the fields: this is a Custom persona, it is being made in *this* project,
 * and it starts as nobody's default. All three are facts about what pressing
 * Create will produce, which is what a form's purpose statement is for.
 *
 * A refusal is shown as it arrived, above a form that still holds everything
 * typed into it.
 */
export function NewPersonaSheet({
  projectId,
  projectName,
  form,
  reloadForm,
  role,
  mayAuthor,
  whyNot,
  onCreated,
  onClose,
}: {
  readonly projectId: string;
  readonly projectName: string | null;
  /** The authoring choices, read once by the screen and lent to this panel. */
  readonly form: Answer<PersonaForm> | null;
  readonly reloadForm: () => void;
  readonly role: string | null;
  readonly mayAuthor: boolean;
  readonly whyNot: string | undefined;
  readonly onCreated: (persona: Persona) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [traits, setTraits] = useState<TraitsDraft>(BLANK_TRAITS);
  const [models, setModels] = useState<ModelsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    setModels(null);
  }, [projectId]);

  useEffect(() => {
    if (form?.status !== "ready") return;
    setModels((held) => held ?? modelsDraftOf(form.value.recommendedModels));
  }, [form]);

  const changed =
    name !== "" ||
    description !== "" ||
    Object.entries(traits).some(
      ([key, value]) => value !== BLANK_TRAITS[key as keyof TraitsDraft],
    ) ||
    (models !== null &&
      form?.status === "ready" &&
      !sameModelsDraft(models, modelsDraftOf(form.value.recommendedModels)));
  useUnsavedChanges(changed && !saving, saving);

  const ready = form?.status === "ready" && models !== null;
  const mayCreate = mayAuthor && ready;

  async function save(): Promise<void> {
    if (!mayCreate || saving || models === null) return;
    setSaving(true);
    setRefusal(null);

    const answer = await platformAnswer(
      createPersona(
        {
          projectId,
          name,
          description,
          traits: traitsFrom(traits),
          models: modelsFrom(models),
        },
        { client: platformClient },
      ),
    );

    setSaving(false);

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      // Everything typed stays exactly where it is. A refusal that cleared the
      // form would make somebody retype it to find out whether the second
      // attempt fails the same way.
      setRefusal(answer.refusal);
      return;
    }

    onCreated(answer.value);
  }

  function content() {
    if (form === null || form.status === "signed-out") {
      return (
        <SheetBody>
          <Loading what="the supported persona models" />
        </SheetBody>
      );
    }
    if (form.status === "missing") {
      return (
        <SheetBody>
          <NotFound message={form.refusal.message} />
        </SheetBody>
      );
    }
    if (form.status === "failed") {
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

          <div className="flex flex-col gap-4">
            <Field label="Name" htmlFor="persona-name">
              <Input
                id="persona-name"
                value={name}
                placeholder="What your team will call them. Names are not unique."
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>

            <Field
              label="Description"
              htmlFor="persona-description"
              hint="Optional. One line for the people who select this persona."
            >
              <Input
                id="persona-description"
                value={description}
                placeholder="A recurring support persona"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </div>

          <SheetSection label="Who they are">
            <div className="flex flex-col gap-4">
              <TraitFields draft={traits} onChange={setTraits} />
            </div>
          </SheetSection>

          <SheetSection label="Models">
            <div className="flex flex-col gap-4">
              <ModelFields
                draft={models}
                form={form.value}
                onChange={setModels}
                note={
                  <NotePanel>
                    These model choices are the release defaults. They are part
                    of v1. Provider keys belong to the Egma deployment and never
                    become persona data.
                  </NotePanel>
                }
              />
            </div>
          </SheetSection>
        </SheetBody>

        {role === null ? null : (
          <SheetFooter>
            <Button
              type="submit"
              size="lg"
              busy={saving}
              disabled={!mayCreate || saving}
              {...(mayAuthor || whyNot === undefined ? {} : { why: whyNot })}
            >
              {saving ? "Creating…" : "Create persona"}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="secondary"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </Button>
          </SheetFooter>
        )}
      </form>
    );
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New persona</SheetTitle>
          <SheetDescription>
            A Custom persona for {projectName ?? "this project"}. Starts at v1
            and is nobody&apos;s default.
          </SheetDescription>
        </SheetHeader>
        {content()}
      </SheetContent>
    </Sheet>
  );
}
