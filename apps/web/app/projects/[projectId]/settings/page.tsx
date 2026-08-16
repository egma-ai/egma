"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { IDENTITY_CONFLICT, writeJson, type Refusal } from "../../../../lib/api.ts";
import { roleOf } from "../../../../lib/me.ts";
import {
  NEW_PROJECT_PATH,
  projectSettingsPath,
  type ProjectSettings,
} from "../../../../lib/settings.ts";
import {
  Button,
  ButtonLink,
  Field,
  Form,
  FormActions,
  FormRow,
  Help,
  Problem,
  Refused,
  Section,
  TextArea,
  TextInput,
} from "../../../../ui/controls.tsx";
import { Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { SettingsLayout } from "../../../../ui/settings-nav.tsx";
import {
  useOrganizationRead,
  useUnsavedChanges,
} from "../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";

/**
 * What this project is called, what it is for, and the word it is known by in
 * an address.
 *
 * **The three live fields of one project, and nothing about the organization.**
 * That separation is the whole shape of this Settings area: what is here
 * changes one product area, and what is under the Organization group changes
 * things every project shares. A page that mixed them would leave an admin
 * unsure which of the two they had just done.
 *
 * **Every save names the revision the form was opened at.** Two admins with
 * this page open in two tabs is ordinary, and the second save is refused rather
 * than silently overwriting the first — with what was typed still on screen, so
 * the fix is to read the project again rather than to retype anything.
 *
 * A viewer and a member see the same page with the same fields and the controls
 * that would change data genuinely disabled. The server refuses their write
 * either way, which is where the boundary actually is; this is a courtesy to a
 * reader, and never a lock.
 */
export default function ProjectSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <ProjectSettingsBody projectId={projectId} />
    </AppShell>
  );
}

function ProjectSettingsBody({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. An unsettled session is neither an
  // admin nor a viewer, and claiming either would be a guess shown as a fact.
  const role = me === null ? null : roleOf(me);

  const { answer, reload } = useOrganizationRead<ProjectSettings>(
    projectSettingsPath(projectId),
  );
  const settled = answer?.status === "ready" ? answer.value : null;

  /**
   * The server's own answer, not this page's reading of a role.
   *
   * `may_manage_projects` travels with the project because the API computed it
   * from `permits(auth, "manage_projects", …)` — the same check that decides
   * whether the write lands. Deriving it here from `role === "admin"` would
   * make this page a second opinion about what `manage_projects` means, and the
   * two would part company the moment the permission moved: either controls
   * withheld from somebody the server would have allowed, or controls offered
   * whose writes it refuses.
   *
   * False until the read answers, which is *not yet known* rather than *no* —
   * the same rule the role above follows, and the reason the disabled controls
   * carry no sentence until there is one to give.
   */
  const mayAdminister = settled?.may_manage_projects ?? false;

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  useEffect(() => {
    if (settled === null) return;
    setName(settled.name);
    setSlug(settled.slug);
    setDescription(settled.description ?? "");
  }, [settled]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const named = name.trim() !== "" && slug.trim() !== "";
  const changed =
    settled !== null &&
    (name.trim() !== settled.name ||
      slug.trim() !== settled.slug ||
      description.trim() !== (settled.description ?? ""));
  useUnsavedChanges(changed && !saving);

  async function save(): Promise<void> {
    if (!mayAdminister || settled === null || !named || !changed || saving) return;
    setRefused(null);
    setSaved(false);
    setSaving(true);

    const written = await writeJson<ProjectSettings>(
      projectSettingsPath(projectId),
      {
        method: "PATCH",
        body: {
          name: name.trim(),
          slug: slug.trim(),
          description: description.trim(),
          expected_revision: settled.revision,
        },
      },
    );

    setSaving(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      // The typing stays exactly where it is. A refusal that cleared the form
      // would make somebody retype their work to find out whether the second
      // attempt fails the same way.
      setRefused(written.refusal);
      return;
    }
    setSaved(true);
    reload();
  }

  if (answer === null) {
    return (
      <ProductPage>
        <PageHeader eyebrow="Settings" title="Project" />
        <PageBody>
          <SettingsLayout projectId={projectId} current="project">
            <Loading what="this project" />
          </SettingsLayout>
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status !== "ready") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Settings" title="Project" />
        <PageBody>
          <SettingsLayout projectId={projectId} current="project">
            {answer.status === "missing" ? (
              <NotFound message={answer.refusal.message} />
            ) : (
              <Failure
                message={
                  answer.status === "signed-out"
                    ? "Your session has ended. Sign in and try again."
                    : answer.refusal.message
                }
                onRetry={reload}
              />
            )}
          </SettingsLayout>
        </PageBody>
      </ProductPage>
    );
  }

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Settings"
        title="Project"
        lead="What this product area is called, and what it is for."
        action={
          <ButtonLink
            href={NEW_PROJECT_PATH}
            disabled={!mayAdminister}
            why={
              role === null
                ? undefined
                : `Your ${role} role cannot create a project. Ask an organization admin.`
            }
          >
            New project
          </ButtonLink>
        }
      />
      <PageBody>
        <SettingsLayout projectId={projectId} current="project">
          <Section
            title="Details"
            lead="Renaming this project or changing its slug does not break existing links."
          >
            {refused === null ? null : (
              <Refused
                message={refused.message}
                action={
                  refused.error === IDENTITY_CONFLICT ? (
                    <Button onClick={reload}>Read this project again</Button>
                  ) : undefined
                }
              />
            )}

            <Form onSubmit={() => void save()}>
              <FormRow>
                <Field label="Name" htmlFor="project-name">
                  <TextInput
                    id="project-name"
                    value={name}
                    disabled={!mayAdminister}
                    invalid={name.trim() === ""}
                    onChange={(next) => {
                      setName(next);
                      setSaved(false);
                    }}
                  />
                </Field>
                <Field
                  label="Slug"
                  htmlFor="project-slug"
                  hint="The short word this project is known by. Changing it does not break existing links."
                >
                  <TextInput
                    id="project-slug"
                    value={slug}
                    disabled={!mayAdminister}
                    invalid={slug.trim() === ""}
                    onChange={(next) => {
                      setSlug(next);
                      setSaved(false);
                    }}
                  />
                </Field>
              </FormRow>

              <Field
                label="Description"
                htmlFor="project-description"
                hint="Optional. What this project is for, for whoever opens the selector next."
              >
                <TextArea
                  id="project-description"
                  value={description}
                  disabled={!mayAdminister}
                  onChange={(next) => {
                    setDescription(next);
                    setSaved(false);
                  }}
                />
              </Field>

              {named ? null : (
                <Problem>A project needs a name and a slug.</Problem>
              )}
              {saved && refused === null ? (
                <Help>Saved. Everybody in this organization sees the new name.</Help>
              ) : null}

              <FormActions>
                <Button
                  weight="strong"
                  type="submit"
                  disabled={!mayAdminister || !named || !changed || saving}
                  why={
                    mayAdminister || role === null
                      ? undefined
                      : `Your ${role} role cannot change project settings. Ask an organization admin.`
                  }
                >
                  {saving ? "Saving…" : "Save project"}
                </Button>
              </FormActions>
            </Form>
          </Section>
        </SettingsLayout>
      </PageBody>
    </ProductPage>
  );
}
