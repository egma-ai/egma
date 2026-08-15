"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { sendJson, writeJson, type Refusal } from "../../../../../lib/api.ts";
import {
  credentialsIn,
  JUDGE_CREDENTIALS_PATH,
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
              hint="What egma calls your organization. Changing it breaks no link and no invitation."
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
          role={role}
          onChanged={reloadCredentials}
        />
      </PageBody>
    </ProductPage>
  );
}

/**
 * The organization's judge keys: what each is called, four characters of it,
 * and a way to replace one whole.
 *
 * **Rotation is a write and never a read.** The form has one field, it is
 * empty, and nothing fills it in from what is stored — because nothing can. The
 * identity survives, so every project pointing at this credential keeps
 * pointing at it and pending grading picks the new key up when it claims.
 *
 * There is no Archive here on purpose. Removing a credential has to be refused
 * while a project points at it and while frozen grading work still needs it,
 * and frozen grading plans arrive with run planning. A control with none of
 * that behind it would strand work mid-flight.
 */
function Credentials({
  credentials,
  unreadable,
  mayAdminister,
  role,
  onChanged,
}: {
  readonly credentials: readonly JudgeCredential[];
  /** Why the list is not on screen, when egma could not answer for it. */
  readonly unreadable: string | null;
  readonly mayAdminister: boolean;
  readonly role: string | null;
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
   * A failure has to report the thing that failed. Sending it up to the page
   * put "Egma did not save the organization" on screen when adding a key had
   * failed, beside a Try again that saved something else — a different action
   * from the one somebody had just been refused, which is worse than no retry.
   */
  const [failed, setFailed] = useState<{
    readonly what: string;
    readonly refusal: Refusal;
    readonly again: () => void;
  } | null>(null);

  /**
   * Which credential's replacement form is open — **and the two pieces of state
   * that belong to it rather than to the page.**
   *
   * The form is drawn once, for whichever row is open, so `replacement` and
   * `failed` are shared by every row while meaning *the open one's*. Leaving
   * either behind when a different row opens is a silent cross-row write, and
   * it is a write of a secret:
   *
   * - A key typed for A, left in the field when B opens, is saved to B — so B
   *   starts spending on a key nobody chose for it and A keeps the one it was
   *   supposed to lose.
   * - Worse, a *failed* rotation leaves a Try again bound to A while reading
   *   the field as it stands when pressed. Open B, type B's key, press it, and
   *   B's key is written to A and reported as success for a credential nobody
   *   is looking at. Clearing only the field does not close this, because the
   *   retry survives the form being closed.
   *
   * So opening or closing a row clears both, always, through this one door.
   */
  function openRotation(credentialId: string | null): void {
    setRotating(credentialId);
    setReplacement("");
    setFailed(null);
  }

  const why =
    mayAdminister || role === null
      ? undefined
      : `Your ${role} role cannot manage judge credentials. Ask an organization admin.`;

  async function add(): Promise<void> {
    if (!mayAdminister || busy || label.trim() === "" || key.trim() === "") return;
    setFailed(null);
    setBusy(true);
    const written = await sendJson<JudgeCredential>(JUDGE_CREDENTIALS_PATH, {
      method: "POST",
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

  async function rotate(credential: JudgeCredential): Promise<void> {
    if (!mayAdminister || busy || replacement.trim() === "") return;
    setFailed(null);
    setBusy(true);
    const written = await sendJson<JudgeCredential>(
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
    openRotation(null);
    onChanged();
  }

  return (
    <section aria-label="Judge credentials">
      <h2>Judge keys</h2>
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
        <ul>
          {credentials.map((credential) => (
            <li key={credential.id}>
              {credential.label} · {credential.provider} · ends …{credential.hint}{" "}
              <Button
                disabled={!mayAdminister || busy}
                why={why}
                onClick={() =>
                  openRotation(rotating === credential.id ? null : credential.id)
                }
              >
                Replace key
              </Button>
              {rotating === credential.id ? (
                <>
                  <Field label="New key" htmlFor={`rotate-${credential.id}`}>
                    <TextInput
                      id={`rotate-${credential.id}`}
                      value={replacement}
                      secret
                      disabled={!mayAdminister || busy}
                      onChange={setReplacement}
                    />
                  </Field>
                  <Help>
                    Replaces the stored key whole. You do not need the old one,
                    and egma will not show it to you.
                  </Help>
                  <Button
                    weight="strong"
                    disabled={!mayAdminister || busy || replacement.trim() === ""}
                    onClick={() => void rotate(credential)}
                  >
                    Save new key
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
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
        why={why}
        onClick={() => void add()}
      >
        Add key
      </Button>
    </section>
  );
}
