"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  BLANK_TRAITS,
  PERSONAS_PATH,
  traitsFrom,
  type Persona,
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
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import { PersonalityField } from "../traits-editor.tsx";

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
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const changed =
    name !== "" ||
    description !== "" ||
    Object.entries(traits).some(
      ([key, value]) => value !== BLANK_TRAITS[key as keyof TraitsDraft],
    );
  useUnsavedChanges(changed && !saving, saving);

  const mayAuthor = role !== null && canAuthor(role);
  const whyNot =
    role === null
      ? undefined
      : `Your ${role} role cannot author personas. Ask an organization admin to change your role.`;

  async function save(): Promise<void> {
    if (!mayAuthor || saving) return;
    setSaving(true);
    setRefusal(null);

    const answer = await writeJson<Persona>(PERSONAS_PATH, {
      method: "POST",
      body: {
        project: projectId,
        name,
        description,
        traits: traitsFrom(traits),
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

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Personas"
        title="New persona"
        breadcrumbs={[
          { label: "Personas", href: projectPath(projectId, "personas") },
          { label: "New persona" },
        ]}
        lead="Who calls, and how they behave — never what they want on a given occasion, which is the test's."
      />
      <PageBody>
        {refusal === null ? null : <Refused message={refusal.message} />}

        <Form onSubmit={() => void save()}>
          <Field
            label="Name"
            htmlFor="persona-name"
            hint="What your team will call them in a list. Names are not unique, so two callers can share one."
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
            hint="Optional. One line, for whoever is picking a persona off a list."
          >
            <TextInput
              id="persona-description"
              value={description}
              placeholder="A recurring support persona"
              onChange={setDescription}
            />
          </Field>

          <PersonalityField draft={traits} onChange={setTraits} />

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
      </PageBody>
    </ProductPage>
  );
}
