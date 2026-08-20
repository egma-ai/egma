"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  BLANK_TRAITS,
  modelsDraftOf,
  modelsFrom,
  PERSONA_FORM_PATH,
  PERSONAS_PATH,
  sameModelsDraft,
  traitsFrom,
  type ModelsDraft,
  type Persona,
  type PersonaForm,
  type TraitsDraft,
} from "../../../../../lib/personas.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  Button,
  Field,
  Form,
  FormActions,
  Refused,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import { Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import { TraitFields } from "../traits-editor.tsx";
import { ModelFields } from "../models-editor.tsx";

/**
 * Authoring a persona.
 *
 * **The form is arranged around one sentence: who they are, never what they
 * want.** The identity fields name them for the people who will pick them off
 * a list; personality describes the person the simulator brings to life. A
 * scenario belongs to a test, and a persona carrying one would stop being
 * reusable the moment somebody wrote it down.
 *
 * A refusal is shown as it arrived, above a form that still holds everything
 * typed into it.
 */
export default function NewPersonaPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <NewPersona projectId={projectId} />
    </AppShell>
  );
}

function NewPersona({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers, and never guessed at.
  const role = me === null ? null : roleOf(me);
  const router = useRouter();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [traits, setTraits] = useState<TraitsDraft>(BLANK_TRAITS);
  const [models, setModels] = useState<ModelsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const { answer: form, reload: reloadForm } = useProjectRead<PersonaForm>(
    PERSONA_FORM_PATH,
    projectId,
  );

  useEffect(() => {
    setModels(null);
  }, [projectId]);

  useEffect(() => {
    if (form?.status !== "ready") return;
    setModels((held) => held ?? modelsDraftOf(form.value.recommended_models));
  }, [form]);

  useEffect(() => {
    if (form?.status === "signed-out") window.location.replace("/sign-in");
  }, [form]);

  const changed =
    name !== "" ||
    description !== "" ||
    Object.entries(traits).some(
      ([key, value]) => value !== BLANK_TRAITS[key as keyof TraitsDraft],
    ) ||
    (models !== null &&
      form?.status === "ready" &&
      !sameModelsDraft(models, modelsDraftOf(form.value.recommended_models)));
  useUnsavedChanges(changed && !saving, saving);

  const mayAuthor =
    role !== null &&
    canAuthor(role) &&
    form?.status === "ready" &&
    models !== null;
  const whyNot =
    role === null
      ? undefined
      : `Your ${role} role cannot author personas. Ask an organization admin to change your role.`;

  async function save(): Promise<void> {
    if (!mayAuthor || saving || models === null) return;
    setSaving(true);
    setRefusal(null);

    const answer = await writeJson<Persona>(PERSONAS_PATH, {
      method: "POST",
      body: {
        project: projectId,
        name,
        description,
        traits: traitsFrom(traits),
        models: modelsFrom(models),
      },
    });

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

    router.push(projectPath(projectId, "personas", answer.value.id));
  }

  function content() {
    if (form === null || form.status === "signed-out") {
      return <Loading what="the supported persona models" />;
    }
    if (form.status === "missing") {
      return <NotFound message={form.refusal.message} />;
    }
    if (form.status === "failed") {
      return <Failure message={form.refusal.message} onRetry={reloadForm} />;
    }
    if (models === null) {
      return <Loading what="the supported persona models" />;
    }

    return (
      <>
        {refusal === null ? null : <Refused message={refusal.message} />}

        <Form onSubmit={() => void save()}>
          <Field
            label="Name"
            htmlFor="persona-name"
            hint="What your team will call them in a list. Names are not unique."
          >
            <TextInput
              id="persona-name"
              value={name}
              placeholder="Impatient Rita"
              onChange={setName}
            />
          </Field>

          <Field
            label="Description"
            htmlFor="persona-description"
            hint="Optional. One line for the people who select this persona."
          >
            <TextInput
              id="persona-description"
              value={description}
              placeholder="A recurring support persona"
              onChange={setDescription}
            />
          </Field>

          <TraitFields draft={traits} onChange={setTraits} />
          <ModelFields draft={models} form={form.value} onChange={setModels} />

          <FormActions>
            <Button
              weight="strong"
              type="submit"
              disabled={!mayAuthor || saving}
              {...(mayAuthor || whyNot === undefined ? {} : { why: whyNot })}
            >
              {saving ? "Creating…" : "Create persona"}
            </Button>
          </FormActions>
        </Form>
      </>
    );
  }

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Personas"
        title="New persona"
        breadcrumbs={[
          { label: "Personas", href: projectPath(projectId, "personas") },
          { label: "New persona" },
        ]}
        lead="Who speaks with the agent, and how they behave. What they want in one simulation belongs to the test."
      />
      <PageBody>{content()}</PageBody>
    </ProductPage>
  );
}
