"use client";

import { useParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import {
  credentialsIn,
  JUDGE_CREDENTIALS_PATH,
  judgeCredentialArchivePath,
  judgeCredentialPath,
  type JudgeCredential,
  type JudgeCredentialPage,
} from "../../../../../lib/judge.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  ORGANIZATION_PATH,
  type OrganizationSettings,
} from "../../../../../lib/settings.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import {
  Field,
  Form,
  FormActions,
  Help,
  Problem,
  Refused,
} from "../../../../../ui/form.tsx";
import { Empty, Failure, Loading } from "../../../../../ui/page-state.tsx";
import { Section } from "../../../../../ui/section.tsx";
import {
  SettingsLayout,
  settingsPath,
} from "../../../../../ui/settings-nav.tsx";
import {
  useOrganizationRead,
  useUnsavedChanges,
} from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";

/**
 * The customer itself: what it is called, and the judge keys it holds.
 *
 * **Nothing on this page belongs to a project.** The grouped Settings
 * navigation states that scope once and keeps this page focused on the work.
 *
 * **The keys are here rather than beside the judge that spends them.** A judge
 * credential belongs to the organization: one key can serve every project, and
 * replacing it is felt by all of them at once. A project's judge setting is a
 * *choice* among these keys, which is the only half of that arrangement that
 * belongs to a project — so the two are one group apart, and neither page
 * pretends to be the other.
 *
 * **No stored key ever reaches this page**, and that is a property of the API
 * rather than a rule this file follows: the read shape has no field a secret
 * could travel in. What is shown is a label and four characters, which exist
 * for one job — telling two keys apart when deciding which project spends from
 * which.
 */
export default function OrganizationSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <OrganizationSettingsBody projectId={projectId} />
    </AppShell>
  );
}

function OrganizationSettingsBody({ projectId }: { readonly projectId: string }) {
  const { me, refresh: refreshSession } = useShellSession();
  // Null until the session read answers. An unsettled session is neither an
  // admin nor a viewer, and claiming either would be a guess shown as a fact.
  const role = me === null ? null : roleOf(me);

  const { answer, reload } = useOrganizationRead<OrganizationSettings>(
    ORGANIZATION_PATH,
  );
  const { answer: credentials, reload: reloadCredentials } =
    useOrganizationRead<JudgeCredentialPage>(JUDGE_CREDENTIALS_PATH);

  const settled = answer?.status === "ready" ? answer.value : null;
  /**
   * Read off the answer rather than off the role, because the answer is the
   * one that came from the server. They agree, and when they ever disagree the
   * server is right.
   */
  const mayAdminister = settled?.may_manage_organization === true;

  /* The hint, and the sentence saying why Save is not available. The base
     input and the base button both read nothing they are not given, so this
     page names both and cannot leave either unpointed-at. */
  const nameHint = useId();
  const whyNotSave = useId();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  /** The local draft captured by the write whose confirming read is next. */
  const editVersion = useRef(0);
  const confirmingSave = useRef<number | null>(null);
  const [confirmingRead, setConfirmingRead] = useState(false);

  useEffect(() => {
    if (settled === null) return;

    const confirming = confirmingSave.current;
    confirmingSave.current = null;
    setConfirmingRead(false);
    if (confirming !== null && editVersion.current !== confirming) return;

    setName(settled.name);
  }, [settled]);

  useEffect(() => {
    if (
      answer?.status === "signed-out" ||
      credentials?.status === "signed-out"
    ) {
      window.location.replace("/sign-in");
    }
  }, [answer, credentials]);

  const named = name.trim() !== "";
  /** Said only to somebody the server would refuse, and only once it has said so. */
  const whyNot =
    mayAdminister || role === null
      ? undefined
      : `Your ${role} role cannot change organization settings. Ask an organization admin.`;
  const changed = settled !== null && name.trim() !== settled.name;
  const confirming = confirmingSave.current;
  const changedWhileConfirming =
    confirmingRead &&
    confirming !== null &&
    editVersion.current !== confirming;
  useUnsavedChanges((changed || changedWhileConfirming) && !saving, saving);

  async function save(): Promise<void> {
    if (!mayAdminister || !named || !changed || saving) return;
    const submittedEditVersion = editVersion.current;
    setRefused(null);
    setSaved(false);
    setSaving(true);

    const written = await writeJson<OrganizationSettings>(ORGANIZATION_PATH, {
      method: "PATCH",
      body: { name: name.trim() },
    });

    setSaving(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return;
    }
    confirmingSave.current = submittedEditVersion;
    setConfirmingRead(true);
    setSaved(editVersion.current === submittedEditVersion);
    refreshSession();
    reload();
  }

  if (answer === null) {
    return (
      <ProductPage viewport>
        <PageHeader
          eyebrow="Settings"
          title="Organization"
          breadcrumbs={[
            { label: "Settings", href: settingsPath(projectId) },
            { label: "Organization" },
          ]}
        />
        <PageBody>
          <SettingsLayout projectId={projectId} current="organization">
            <Loading what="this organization" />
          </SettingsLayout>
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status !== "ready") {
    return (
      <ProductPage viewport>
        <PageHeader
          eyebrow="Settings"
          title="Organization"
          breadcrumbs={[
            { label: "Settings", href: settingsPath(projectId) },
            { label: "Organization" },
          ]}
        />
        <PageBody>
          <SettingsLayout projectId={projectId} current="organization">
            <Failure
              message={
                answer.status === "signed-out"
                  ? "Your session has ended. Sign in and try again."
                  : answer.refusal.message
              }
              onRetry={reload}
            />
          </SettingsLayout>
        </PageBody>
      </ProductPage>
    );
  }

  return (
    <ProductPage viewport>
      <PageHeader
        eyebrow="Settings"
        title="Organization"
        breadcrumbs={[
          { label: "Settings", href: settingsPath(projectId) },
          { label: "Organization" },
        ]}
        lead="The customer every project below belongs to."
      />
      <PageBody>
        <SettingsLayout projectId={projectId} current="organization">
          <Section title="Details">
            {refused === null ? null : <Refused message={refused.message} />}

            <Form onSubmit={() => void save()}>
              <Field label="Name" htmlFor="organization-name">
                <Input
                  id="organization-name"
                  value={name}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!mayAdminister}
                  aria-invalid={named ? undefined : true}
                  aria-describedby={nameHint}
                  onChange={(event) => {
                    editVersion.current += 1;
                    setName(event.target.value);
                    setSaved(false);
                  }}
                />
                <p className="m-0 text-sm leading-(--line-normal) text-faint" id={nameHint}>
                  What Egma calls your organization. Changing it breaks no link
                  and no invitation.
                </p>
              </Field>

              {named ? null : <Problem>An organization needs a name.</Problem>}
              {saved && refused === null ? <Help>Saved.</Help> : null}

              <FormActions>
                <Button
                  type="submit"
                  disabled={!mayAdminister || !named || !changed || saving}
                  title={whyNot}
                  aria-describedby={whyNot === undefined ? undefined : whyNotSave}
                >
                  {saving ? "Saving…" : "Save organization"}
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

          <Credentials
            credentials={
              credentials?.status === "ready"
                ? credentialsIn(credentials.value)
                : null
            }
            unreadable={
              credentials !== null && credentials.status !== "ready"
                ? credentials.status === "signed-out"
                  ? "Your session has ended. Sign in and try again."
                  : credentials.refusal.message
                : null
            }
            mayAdminister={mayAdminister}
            onChanged={reloadCredentials}
          />
        </SettingsLayout>
      </PageBody>
    </ProductPage>
  );
}

/**
 * The organization's keys: what each is called, four characters of it, and a
 * way to replace one whole.
 *
 * **Rotation is a write and never a read.** The form has one field, it is
 * empty, and nothing fills it in from what is stored — because nothing can. The
 * identity survives, so every project pointing at this credential keeps
 * pointing at it and pending grading picks the new key up when it claims.
 *
 * **Archive is here now, and it is refused rather than cascading.** Removing a
 * credential has to be refused while a project points at it, while a run whose
 * frozen grading plan names it still has a conversation moving, and while a
 * grading job is waiting to be judged or already claimed — and frozen grading
 * plans arrived with run planning, which is what made the second and third
 * questions askable at all. The refusal names every blocking use and this page
 * shows that sentence unchanged, because it is the sentence that says what to
 * go and do.
 */
function Credentials({
  credentials,
  unreadable,
  mayAdminister,
  onChanged,
}: {
  /** Null until the read answers, rather than a claim that the list is empty. */
  readonly credentials: readonly JudgeCredential[] | null;
  /** Why the list is not on screen, when egma could not answer for it. */
  readonly unreadable: string | null;
  readonly mayAdminister: boolean;
  readonly onChanged: () => void;
}) {
  const replacementHint = useId();
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [rotating, setRotating] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingArchive, setConfirmingArchive] =
    useState<JudgeCredential | null>(null);
  useUnsavedChanges(
    label.trim() !== "" || key.trim() !== "" || replacement.trim() !== "",
    busy,
  );

  /**
   * Why a key could not be saved, **and which action to try again.**
   *
   * Kept here rather than handed up to the judge section, because a failure has
   * to report the thing that failed. Sending it up put "Egma did not save the
   * judge" on screen when adding a key had failed, beside a Try again that
   * saved the judge — a different action from the one somebody had just been
   * refused, which is worse than no retry at all.
   */
  const [failed, setFailed] = useState<{
    readonly what: string;
    readonly refusal: Refusal;
    readonly again: () => void;
  } | null>(null);

  async function add(): Promise<void> {
    if (!mayAdminister || busy || label.trim() === "" || key.trim() === "") return;
    setFailed(null);
    setBusy(true);
    const written = await writeJson<JudgeCredential>(JUDGE_CREDENTIALS_PATH, {
      method: "POST",
      // **No project travels with this**, in the address or anywhere else. A
      // judge credential belongs to the organization, and the route holds four
      // body keys and refuses a fifth — so a project named here was refused as
      // an unknown key rather than ignored.
      body: { label: label.trim(), provider: "openai", key: key.trim() },
    });
    setBusy(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setFailed({
        what: "Egma did not add this key.",
        refusal: written.refusal,
        again: () => void add(),
      });
      return;
    }
    setLabel("");
    // The typed key leaves the page the moment it has been sent. It was never
    // read back and it is not kept around either.
    setKey("");
    onChanged();
  }

  async function archive(credential: JudgeCredential): Promise<void> {
    if (!mayAdminister || busy) return;
    setFailed(null);
    setBusy(true);
    const written = await writeJson<JudgeCredential>(
      judgeCredentialArchivePath(credential.id),
      {
        method: "POST",
        body: { expected_revision: credential.revision },
      },
    );
    setBusy(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setFailed({
        what: `Egma did not archive ${credential.label}.`,
        refusal: written.refusal,
        // Bound to the credential that failed, and cleared the moment a
        // different row opens — the same rule the replacement field is held
        // to, and for the same reason.
        again: () => void archive(credential),
      });
      return;
    }
    // The row leaves the list, so the form that was open on it must close with
    // it rather than sit over a credential that is no longer there.
    if (rotating === credential.id) {
      setRotating(null);
      setReplacement("");
    }
    onChanged();
  }

  async function rotate(credential: JudgeCredential): Promise<void> {
    if (!mayAdminister || busy || replacement.trim() === "") return;
    setFailed(null);
    setBusy(true);
    const written = await writeJson<JudgeCredential>(
      judgeCredentialPath(credential.id),
      {
        method: "PATCH",
        body: {
          key: replacement.trim(),
          expected_revision: credential.revision,
        },
      },
    );
    setBusy(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setFailed({
        what: `Egma did not replace the key for ${credential.label}.`,
        refusal: written.refusal,
        again: () => void rotate(credential),
      });
      return;
    }
    setReplacement("");
    setRotating(null);
    onChanged();
  }

  /** The row whose replacement form is open, if the row is still on the list. */
  const rotatingCredential = credentials?.find(
    (credential) => credential.id === rotating,
  );

  const columns: readonly Column<JudgeCredential>[] = [
    {
      key: "label",
      header: "Key",
      primary: true,
      cell: (credential) => credential.label,
    },
    {
      key: "provider",
      header: "Provider",
      width: "120px",
      cell: (credential) => credential.provider,
    },
    {
      key: "hint",
      header: "Ends",
      mono: true,
      width: "90px",
      cell: (credential) => `…${credential.hint}`,
    },
    {
      key: "archive",
      header: "",
      width: "110px",
      cell: (credential) => (
        <Button
          type="button"
          variant="secondary"
          disabled={!mayAdminister || busy}
          onClick={() => setConfirmingArchive(credential)}
        >
          Archive
        </Button>
      ),
    },
    {
      key: "rotate",
      header: "",
      width: "150px",
      cell: (credential) => (
        <Button
          type="button"
          variant="secondary"
          disabled={!mayAdminister || busy}
          onClick={() => {
            // One form under the table means one `replacement` and one `failed`
            // for every row, so opening a different row has to empty both.
            //
            // `replacement`: a key typed for one credential would stay in the
            // field, and Save would send it to whichever credential is open
            // now — rotating the wrong one to a key its owner never chose.
            //
            // `failed`: worse, because it survives a closed form. Its `again`
            // is bound to the credential that failed, but `rotate` reads the
            // field as it stands when the button is pressed. So a failure on
            // one credential, then opening another and typing its key, leaves
            // a Try again that writes this row's key to the other row — and
            // reports success for a credential nobody was looking at.
            //
            // Both are the same mistake: state that means "for the open row",
            // with nothing making it true. Retyping is the price.
            setReplacement("");
            setFailed(null);
            setRotating(rotating === credential.id ? null : credential.id);
          }}
        >
          Replace key
        </Button>
      ),
    },
  ];

  return (
    <div role="region" aria-label="Judge credentials">
      <Section
        title="Organization keys"
        lead="Shared judge keys for every project. Egma shows only the last four characters, never the key itself."
      >
        {failed === null ? null : (
          <Failure
            title={failed.what}
            message={failed.refusal.message}
            onRetry={failed.again}
          />
        )}

        {unreadable === null ? null : (
          <Failure
            title="Egma could not list this organization's judge keys."
            message={unreadable}
            onRetry={onChanged}
          />
        )}

        {credentials === null ? (
          unreadable === null ? (
            <Loading what="this organization's judge keys" />
          ) : null
        ) : credentials.length === 0 ? (
          <Empty title="No judge credentials yet." />
        ) : (
          <>
            <DataTable
              label="Organization keys"
              columns={columns}
              rows={credentials}
              keyOf={(credential) => credential.id}
            />

            {/*
             * The replacement form is drawn once, under the table, for whichever
             * row asked for it — never inside a cell. This keeps one labelled
             * secret field tied to the row that opened it, instead of making a
             * table cell own a form whose state outlives that cell.
             */}
            {rotatingCredential === undefined ? null : (
              <Form onSubmit={() => void rotate(rotatingCredential)}>
                <Field label="New key" htmlFor={`rotate-${rotatingCredential.id}`}>
                  <Input
                    id={`rotate-${rotatingCredential.id}`}
                    value={replacement}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={!mayAdminister || busy}
                    aria-describedby={replacementHint}
                    onChange={(event) => setReplacement(event.target.value)}
                  />
                  <p className="m-0 text-sm leading-(--line-normal) text-faint" id={replacementHint}>
                    Replaces the stored key whole. You do not need the old one,
                    and Egma will not show it to you.
                  </p>
                </Field>
                <FormActions>
                  <Button
                    type="submit"
                    disabled={!mayAdminister || busy || replacement.trim() === ""}
                  >
                    Save new key
                  </Button>
                </FormActions>
              </Form>
            )}
          </>
        )}
      </Section>

      <Section
        title="Add a key"
        lead="Add a named OpenAI key for projects in this organization to use."
      >
        <Form onSubmit={() => void add()}>
          <Field label="Label" htmlFor="credential-label">
            <Input
              id="credential-label"
              value={label}
              autoComplete="off"
              spellCheck={false}
              disabled={!mayAdminister || busy}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field label="OpenAI key" htmlFor="credential-key">
            <Input
              id="credential-key"
              value={key}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              disabled={!mayAdminister || busy}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <FormActions>
            <Button
              type="submit"
              disabled={!mayAdminister || busy || label.trim() === "" || key.trim() === ""}
            >
              Add key
            </Button>
          </FormActions>
        </Form>
      </Section>

      {confirmingArchive === null ? null : (
        <Dialog
          title={`Archive judge credential “${confirmingArchive.label}”?`}
          onClose={() => setConfirmingArchive(null)}
        >
          {(dismiss) => (
            <>
              <p>
                {confirmingArchive.label} will no longer be available to a project.
                Egma will refuse this action if a project or an active run still uses
                it.
              </p>
              <Button type="button" variant="secondary" onClick={dismiss}>
                Cancel
              </Button>{" "}
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  const credential = confirmingArchive;
                  setConfirmingArchive(null);
                  void archive(credential);
                }}
              >
                Archive
              </Button>
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}
