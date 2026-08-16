"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

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
import {
  Button,
  Facts,
  Field,
  Form,
  FormActions,
  Help,
  Problem,
  Refused,
  Section,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Failure, Loading } from "../../../../../ui/page-state.tsx";
import { ScopeNote, SettingsNav } from "../../../../../ui/settings-nav.tsx";
import { useOrganizationRead } from "../../../../../ui/settings-read.ts";
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
 * **Nothing on this page belongs to a project**, and the note under the heading
 * says so out loud. The project selector is still on screen — leaving Settings
 * has to be possible from every page in it — so an organization-wide page that
 * said nothing would be relying on somebody inferring from an absence.
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
  const { me } = useShellSession();
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

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  useEffect(() => {
    if (settled === null) return;
    setName(settled.name);
  }, [settled]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const named = name.trim() !== "";

  async function save(): Promise<void> {
    if (!mayAdminister || !named || saving) return;
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
    setSaved(true);
    reload();
  }

  if (answer === null) {
    return (
      <ProductPage>
        <PageHeader eyebrow="Settings" title="Organization" />
        <PageBody>
          <SettingsNav projectId={projectId} current="organization" />
          <Loading what="this organization" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status !== "ready") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Settings" title="Organization" />
        <PageBody>
          <SettingsNav projectId={projectId} current="organization" />
          <Failure
            message={
              answer.status === "signed-out"
                ? "Your session has ended. Sign in and try again."
                : answer.refusal.message
            }
            onRetry={reload}
          />
        </PageBody>
      </ProductPage>
    );
  }

  const organization = answer.value;

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Settings"
        title="Organization"
        lead="The customer every project below belongs to."
      />
      <PageBody>
        <SettingsNav projectId={projectId} current="organization" />
        <ScopeNote>
          Everything on this page belongs to the whole organization. It applies
          in every project, whichever one the selector above is showing.
        </ScopeNote>

        <Section title="Details">
          {refused === null ? null : <Refused message={refused.message} />}

          <Form onSubmit={() => void save()}>
            <Field
              label="Name"
              htmlFor="organization-name"
              hint="What Egma calls your organization. Changing it breaks no link and no invitation."
            >
              <TextInput
                id="organization-name"
                value={name}
                disabled={!mayAdminister}
                invalid={!named}
                onChange={setName}
              />
            </Field>

            {named ? null : <Problem>An organization needs a name.</Problem>}
            {saved && refused === null ? <Help>Saved.</Help> : null}

            <FormActions>
              <Button
                weight="strong"
                type="submit"
                disabled={!mayAdminister || !named || saving}
                why={
                  mayAdminister || role === null
                    ? undefined
                    : `Your ${role} role cannot change organization settings. Ask an organization admin.`
                }
              >
                {saving ? "Saving…" : "Save organization"}
              </Button>
            </FormActions>
          </Form>

          <Facts
            facts={[
              { label: "Identifier", value: organization.id },
              {
                label: "Short name",
                value: organization.slug,
              },
              {
                label: "Created",
                value: new Date(organization.created_at).toLocaleDateString(),
              },
            ]}
          />
        </Section>

        <Credentials
          credentials={credentialsIn(
            credentials?.status === "ready" ? credentials.value : undefined,
          )}
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
  readonly credentials: readonly JudgeCredential[];
  /** Why the list is not on screen, when egma could not answer for it. */
  readonly unreadable: string | null;
  readonly mayAdminister: boolean;
  readonly onChanged: () => void;
}) {
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [rotating, setRotating] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);

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
  const rotatingCredential = credentials.find(
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
          disabled={!mayAdminister || busy}
          onClick={() => {
            // Archiving is not opening a row, so it does not change which row
            // is open — but it does replace whatever failure was on screen
            // with its own, bound to this credential.
            void archive(credential);
          }}
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
    <section aria-label="Judge credentials">
      <h2>Organization keys</h2>
      <p>
        A key belongs to the organization, not to a project, so one key can serve
        every project. Egma shows the last four characters and never the key
        itself — not here, and not through any other page.
      </p>

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

      {credentials.length === 0 ? (
        <p>No judge credentials yet.</p>
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
           * row asked for it — never inside a cell. A table draws every row
           * twice, once wide and once narrow, so a form living in a cell would
           * be two forms over one piece of state: two fields carrying one
           * value, and whichever the browser focused would be the one somebody
           * could not see.
           */}
          {rotatingCredential === undefined ? null : (
            <>
              <Field
                label="New key"
                htmlFor={`rotate-${rotatingCredential.id}`}
                hint="Replaces the stored key whole. You do not need the old one, and Egma will not show it to you."
              >
                <TextInput
                  id={`rotate-${rotatingCredential.id}`}
                  value={replacement}
                  secret
                  disabled={!mayAdminister || busy}
                  onChange={setReplacement}
                />
              </Field>
              <Button
                weight="strong"
                disabled={!mayAdminister || busy || replacement.trim() === ""}
                onClick={() => void rotate(rotatingCredential)}
              >
                Save new key
              </Button>
            </>
          )}
        </>
      )}

      <h3>Add a key</h3>
      <Field label="Label" htmlFor="credential-label">
        <TextInput
          id="credential-label"
          value={label}
          disabled={!mayAdminister || busy}
          onChange={setLabel}
        />
      </Field>
      <Field label="OpenAI key" htmlFor="credential-key">
        <TextInput
          id="credential-key"
          value={key}
          secret
          disabled={!mayAdminister || busy}
          onChange={setKey}
        />
      </Field>
      <Button
        disabled={!mayAdminister || busy || label.trim() === "" || key.trim() === ""}
        onClick={() => void add()}
      >
        Add key
      </Button>
    </section>
  );
}
