"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { writeJson, type Refusal } from "../../lib/api.ts";
import { roleOf } from "../../lib/me.ts";
import { projectLanding } from "../../lib/project-context.ts";
import { PROJECTS_PATH, type ProjectSettings } from "../../lib/settings.ts";
import { Button, TextArea, TextInput } from "../../ui/controls.tsx";
import { Section } from "../../ui/section.tsx";
import {
  Field,
  Form,
  FormActions,
  Help,
  Problem,
  Refused,
} from "../../ui/form.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../ui/shell.tsx";
import { useUnsavedChanges } from "../../ui/settings-read.ts";

/**
 * Where a project comes from.
 *
 * **This address names no project, deliberately, because it is the one page an
 * organization with none can reach.** Signup provisions the first project, so
 * that state is rare — but an organization whose only project was never made,
 * or whose admin is standing in front of an empty product shell, has to have
 * somewhere to go. Every other Settings page lives under a project and could
 * not serve this.
 *
 * It is `/new-project` and deliberately not `/projects/new`, which would read
 * better and would be wrong: the shell reads the project out of the address, so
 * the second form would have the selector announcing a project called `new` and
 * the navigation linking into one. An address that lies to the shell is worse
 * than an address that reads a little flatter.
 *
 * **A name is all it asks for.** The slug is derived from the name on the
 * server and numbered past whatever is already there, so nobody has to think
 * about slugs to make a project — and the numbering is deterministic, so two
 * admins racing get `outbound` and `outbound-2` rather than a suffix neither
 * could have guessed. An admin who wants a particular word changes it
 * afterwards in project Settings.
 *
 * What is created is the whole thing: the project, the persona a first test
 * gets when it names none, and this deployment's judge where it has one. That
 * is the server's business and not this page's — but it is why this page can
 * send somebody straight into the new project rather than to a checklist.
 */
export default function NewProjectPage() {
  return (
    <AppShell>
      <NewProject />
    </AppShell>
  );
}

function NewProject() {
  const router = useRouter();
  const {
    me,
    settled,
    refresh: refreshSession,
    includeProject,
  } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAdminister = role === "admin";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  useUnsavedChanges((name !== "" || description !== "") && !creating, creating);

  const named = name.trim() !== "";

  async function create(): Promise<void> {
    if (!mayAdminister || !named || creating) return;
    setRefused(null);
    setCreating(true);

    const written = await writeJson<ProjectSettings>(PROJECTS_PATH, {
      method: "POST",
      body: { name: name.trim(), description: description.trim() },
    });

    setCreating(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return;
    }

    // Straight into the new project, at the landing every project has. It is
    // usable from this moment: it has a default persona and, where the
    // deployment has one, a judge.
    includeProject(written.value);
    await refreshSession();
    router.push(projectLanding(written.value.id));
  }

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Settings"
        title="New project"
        lead="A project holds its own agents, tests, personas, graders and runs. Everybody in the organization can work in every one of them."
      />
      <PageBody>
        <Section title="Name it">
          {/*
            * Said before the form rather than instead of it. A viewer or a
            * member sees exactly this page with the controls disabled, so the
            * sentence explains a page they can read rather than replacing it
            * with a refusal they cannot act on.
            */}
          {mayAdminister || !settled ? null : (
            <Help>
              Your {String(role ?? "")} role cannot create a project. Ask an
              organization admin to make one, or to change your role.
            </Help>
          )}

          {refused === null ? null : <Refused message={refused.message} />}

          <Form onSubmit={() => void create()}>
            <Field
              label="Name"
              htmlFor="new-project-name"
              hint="Egma works the address out from this, and numbers it if another project already has the same one."
            >
              <TextInput
                id="new-project-name"
                value={name}
                disabled={!mayAdminister}
                invalid={!named && refused !== null}
                onChange={setName}
              />
            </Field>

            <Field
              label="Description"
              htmlFor="new-project-description"
              hint="Optional. What this project is for."
            >
              <TextArea
                id="new-project-description"
                value={description}
                disabled={!mayAdminister}
                onChange={setDescription}
              />
            </Field>

            {named ? null : <Problem>A project needs a name.</Problem>}

            <FormActions>
              <Button
                weight="strong"
                type="submit"
                disabled={!mayAdminister || !named || creating}
                why={
                  mayAdminister || role === null
                    ? undefined
                    : `Your ${role} role cannot create a project. Ask an organization admin.`
                }
              >
                {creating ? "Creating…" : "Create project"}
              </Button>
            </FormActions>
          </Form>
        </Section>
      </PageBody>
    </ProductPage>
  );
}
