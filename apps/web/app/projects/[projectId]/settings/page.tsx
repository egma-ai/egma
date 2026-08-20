"use client";

import { useParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { IDENTITY_CONFLICT, writeJson, type Refusal } from "../../../../lib/api.ts";
import { roleOf } from "../../../../lib/me.ts";
import {
  projectSettingsPath,
  type ProjectSettings,
} from "../../../../lib/settings.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  Field,
  Form,
  FormActions,
  Help,
  Problem,
  Refused,
  Section,
  TextArea,
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
 * What this project is called and what it is for.
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
  const { me, refresh: refreshSession } = useShellSession();
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

  /*
   * The id of the sentence saying why Save is not available.
   *
   * The base button is a `<button>` and draws nothing beside itself, so the
   * page writes the sentence and names it. A disabled control cannot take
   * focus, which is exactly why the reason may not live in a `title` alone:
   * that is a reason only a pointer can reach.
   */
  const whyNotSave = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  /**
   * Which local draft a successful write captured.
   *
   * The fields stay editable while the request is active. If somebody types
   * again after pressing Save, the confirming read must update `settled`
   * without copying its older values over that newer draft. A number records
   * the edit rather than comparing text, because typing and then returning to
   * the same text still clears Saved and is still a new local action.
   */
  const editVersion = useRef(0);
  const confirmingSave = useRef<{
    readonly projectId: string;
    readonly editVersion: number;
  } | null>(null);
  const [confirmingRead, setConfirmingRead] = useState(false);

  useEffect(() => {
    if (settled === null) return;

    const confirming = confirmingSave.current;
    confirmingSave.current = null;
    setConfirmingRead(false);
    if (
      confirming?.projectId === projectId &&
      editVersion.current !== confirming.editVersion
    ) {
      return;
    }

    setName(settled.name);
    setDescription(settled.description ?? "");
  }, [projectId, settled]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const named = name.trim() !== "";
  /** Said only to somebody the server would refuse, and only once it has said so. */
  const whyNot =
    mayAdminister || role === null
      ? undefined
      : `Your ${role} role cannot change project settings. Ask an organization admin.`;
  const changed =
    settled !== null &&
    (name.trim() !== settled.name ||
      description.trim() !== (settled.description ?? ""));
  const confirming = confirmingSave.current;
  const changedWhileConfirming =
    confirmingRead &&
    confirming?.projectId === projectId &&
    editVersion.current !== confirming.editVersion;
  useUnsavedChanges((changed || changedWhileConfirming) && !saving, saving);

  async function save(): Promise<void> {
    if (!mayAdminister || settled === null || !named || !changed || saving) return;
    const submittedEditVersion = editVersion.current;
    setRefused(null);
    setSaved(false);
    setSaving(true);

    const written = await writeJson<ProjectSettings>(
      projectSettingsPath(projectId),
      {
        method: "PATCH",
        body: {
          name: name.trim(),
          // The slug remains part of the server contract and existing links.
          // It is not an authoring choice on this screen, so every save sends
          // back the exact value that was read instead of inventing or clearing
          // one from hidden form state.
          slug: settled.slug,
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
    confirmingSave.current = {
      projectId,
      editVersion: submittedEditVersion,
    };
    setConfirmingRead(true);
    setSaved(editVersion.current === submittedEditVersion);
    refreshSession();
    reload();
  }

  if (answer === null) {
    return (
      <ProductPage viewport>
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
      <ProductPage viewport>
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
    <ProductPage viewport>
      <PageHeader
        eyebrow="Settings"
        title="Project"
        lead="What this product area is called, and what it is for."
      />
      <PageBody>
        <SettingsLayout projectId={projectId} current="project">
          <Section title="Details">
            {refused === null ? null : (
              <Refused
                message={refused.message}
                action={
                  refused.error === IDENTITY_CONFLICT ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={reload}
                    >
                      Read this project again
                    </Button>
                  ) : undefined
                }
              />
            )}

            <Form onSubmit={() => void save()}>
              <Field label="Name" htmlFor="project-name">
                <Input
                  id="project-name"
                  value={name}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!mayAdminister}
                  aria-invalid={name.trim() === "" ? true : undefined}
                  onChange={(event) => {
                    editVersion.current += 1;
                    setName(event.target.value);
                    setSaved(false);
                  }}
                />
              </Field>

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
                    editVersion.current += 1;
                    setDescription(next);
                    setSaved(false);
                  }}
                />
              </Field>

              {named ? null : (
                <Problem>A project needs a name.</Problem>
              )}
              {saved && refused === null ? (
                <Help>Saved. Everybody in this organization sees the new name.</Help>
              ) : null}

              <FormActions>
                <Button
                  type="submit"
                  disabled={!mayAdminister || !named || !changed || saving}
                  title={whyNot}
                  aria-describedby={whyNot === undefined ? undefined : whyNotSave}
                >
                  {saving ? "Saving…" : "Save project"}
                </Button>
                {whyNot === undefined ? null : (
                  <span
                    className="max-w-[56ch] text-sm leading-(--line-normal) text-muted-foreground"
                    id={whyNotSave}
                  >
                    {whyNot}
                  </span>
                )}
              </FormActions>
            </Form>
          </Section>
        </SettingsLayout>
      </PageBody>
    </ProductPage>
  );
}
