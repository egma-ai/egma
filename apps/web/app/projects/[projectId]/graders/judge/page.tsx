"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { sendJson, type Refusal } from "../../../../../lib/api.ts";
import {
  credentialLabel,
  credentialsFor,
  isChoiceComplete,
  JUDGE_CREDENTIALS_PATH,
  JUDGE_PATH,
  JUDGE_REGISTRY_PATH,
  judgeCredentialPath,
  PLATFORM_SOURCE,
  type JudgeCredential,
  type JudgeCredentialPage,
  type JudgeRegistry,
  type ProjectJudge,
} from "../../../../../lib/judge.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { Badge, Button, ButtonLink, Field, TextInput } from "../../../../../ui/controls.tsx";
import { Failure, Loading } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";

/**
 * Which model judges here, and which of the organization's keys it is asked
 * with.
 *
 * **No stored key ever reaches this page**, and that is a property of the API
 * rather than a rule this file follows: the read shape has no field a secret
 * could travel in. What a person sees is a label and four characters — enough
 * to tell two keys apart when deciding which project spends from which, and not
 * enough to be one. Replacing a key is typing a new one; it is never reading
 * the old one first, and there is no route that would let them.
 *
 * **`needs_setup` is a state, said plainly.** A project without a judge still
 * runs every deterministic grader it has; what it cannot do is ask a model
 * anything — and the built-in expected-behaviors grader asks a model, so a run
 * started this way would come back with errored verdicts after real calls had
 * been paid for. A page that showed an empty form would hide that.
 *
 * Judge settings are administration: the credentials are the organization's and
 * the choice commits its account, so only an admin may change either. The page
 * is readable to everybody, because somebody looking at a project's grading has
 * to be able to see which judge decided it.
 */
export default function JudgeSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <JudgeSettings projectId={projectId} />
    </AppShell>
  );
}

function JudgeSettings({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. An unsettled session is neither an
  // admin nor a viewer, and claiming either would be a guess shown as a fact.
  const role = me === null ? null : roleOf(me);
  const mayAdminister = role === "admin";

  const { answer: judge, reload: reloadJudge } = useProjectRead<ProjectJudge>(
    JUDGE_PATH,
    projectId,
  );
  const { answer: credentials, reload: reloadCredentials } =
    useProjectRead<JudgeCredentialPage>(JUDGE_CREDENTIALS_PATH, projectId);
  const { answer: registry } = useProjectRead<JudgeRegistry>(
    JUDGE_REGISTRY_PATH,
    projectId,
  );

  const held = credentials?.status === "ready" ? credentials.value.items : [];
  const settled = judge?.status === "ready" ? judge.value : null;

  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [source, setSource] = useState("");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  useEffect(() => {
    if (settled === null) return;
    if (settled.state === "configured") {
      setProvider(settled.provider);
      setModel(settled.model);
      setSource(
        settled.source === PLATFORM_SOURCE
          ? PLATFORM_SOURCE
          : (settled.credential_id ?? ""),
      );
    }
  }, [settled]);

  useEffect(() => {
    if (judge?.status === "signed-out") window.location.replace("/sign-in");
  }, [judge]);

  const choosable = credentialsFor(held, provider);
  const complete = isChoiceComplete({ provider, model, source });

  async function saveChoice(): Promise<void> {
    if (!mayAdminister || !complete || saving) return;
    setRefused(null);
    setSaving(true);

    const written = await sendJson<ProjectJudge>(JUDGE_PATH, {
      method: "PUT",
      project: projectId,
      body: { provider, model: model.trim(), source },
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
    reloadJudge();
  }

  if (judge === null) {
    return (
      <ProductPage>
        <PageHeader eyebrow="Graders" title="Judge settings" />
        <PageBody>
          <Loading what="the judge" />
        </PageBody>
      </ProductPage>
    );
  }

  if (judge.status !== "ready") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Graders" title="Judge settings" />
        <PageBody>
          <Failure
            message={
              judge.status === "signed-out"
                ? "Your session has ended. Sign in and try again."
                : judge.refusal.message
            }
            onRetry={reloadJudge}
          />
        </PageBody>
      </ProductPage>
    );
  }

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Graders"
        title="Judge settings"
        lead="The model that decides an LLM judgment in this project, and the organization key it is asked with."
        action={
          <ButtonLink href={projectPath(projectId, "graders")}>
            Back to graders
          </ButtonLink>
        }
      />
      <PageBody>
        <section aria-label="This project's judge">
          <h2>This project</h2>
          {judge.value.state === "needs_setup" ? (
            <p>
              <Badge tone="warn">Needs setup</Badge> This project has no judge, so
              LLM grading is unavailable — including the built-in
              expected-behaviors grader, which every test relies on. Add a judge
              credential below and choose it, and grading works from the next run.
            </p>
          ) : (
            <p>
              Judging with {judge.value.provider} {judge.value.model}
              {judge.value.source === PLATFORM_SOURCE ? (
                <>
                  {" "}
                  on <strong>this deployment&apos;s own key</strong>. It belongs to
                  whoever runs this platform: there is nothing here to rotate and
                  no key to see.
                </>
              ) : (
                <>
                  {" "}
                  on the organization credential{" "}
                  {judge.value.hint === null ? "" : `ending …${judge.value.hint}`}.
                </>
              )}
            </p>
          )}

          {mayAdminister ? null : (
            <p>
              Your {String(role ?? "")} role cannot change judge settings. Ask an
              organization admin.
            </p>
          )}

          <Field label="Provider" htmlFor="judge-provider">
            <select
              id="judge-provider"
              value={provider}
              disabled={!mayAdminister}
              onChange={(event) => {
                setProvider(event.target.value);
                // A credential of the old provider cannot answer for the new
                // one, so the choice is cleared rather than left pointing at
                // something the server would refuse.
                setSource("");
              }}
            >
              {(registry?.status === "ready" ? registry.value.providers : []).map(
                (one) => (
                  <option key={one.provider} value={one.provider}>
                    {one.provider}
                  </option>
                ),
              )}
            </select>
          </Field>

          <Field label="Model" htmlFor="judge-model">
            <TextInput id="judge-model" value={model} onChange={setModel} />
          </Field>

          <Field label="Key" htmlFor="judge-source">
            <select
              id="judge-source"
              value={source}
              disabled={!mayAdminister}
              onChange={(event) => setSource(event.target.value)}
            >
              <option value="">Choose a key</option>
              {choosable.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credentialLabel(credential)}
                </option>
              ))}
              {judge.value.state === "configured" &&
              judge.value.source === PLATFORM_SOURCE ? (
                <option value={PLATFORM_SOURCE}>
                  This deployment&apos;s own judge
                </option>
              ) : null}
            </select>
            {choosable.length === 0 ? (
              <small>
                This organization holds no {provider} key yet. Add one below.
              </small>
            ) : null}
          </Field>

          {refused === null ? null : (
            <Failure
              title="Egma did not save the judge."
              message={refused.message}
              onRetry={() => void saveChoice()}
            />
          )}

          <Button
            weight="strong"
            disabled={!mayAdminister || !complete || saving}
            onClick={() => void saveChoice()}
          >
            {saving ? "Saving…" : "Save judge"}
          </Button>
        </section>

        <Credentials
          credentials={held}
          projectId={projectId}
          mayAdminister={mayAdminister}
          onChanged={reloadCredentials}
          onFailure={setRefused}
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
 * There is no Archive here on purpose. Removing a credential has to be refused
 * while a project points at it and while frozen grading work still needs it,
 * and frozen grading plans arrive with run planning. A control with none of
 * that behind it would strand work mid-flight.
 */
function Credentials({
  credentials,
  projectId,
  mayAdminister,
  onChanged,
  onFailure,
}: {
  readonly credentials: readonly JudgeCredential[];
  readonly projectId: string;
  readonly mayAdminister: boolean;
  readonly onChanged: () => void;
  readonly onFailure: (refusal: Refusal) => void;
}) {
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [rotating, setRotating] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(): Promise<void> {
    if (!mayAdminister || busy || label.trim() === "" || key.trim() === "") return;
    setBusy(true);
    const written = await sendJson<JudgeCredential>(JUDGE_CREDENTIALS_PATH, {
      method: "POST",
      body: { label: label.trim(), provider: "openai", key: key.trim() },
      project: projectId,
    });
    setBusy(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      onFailure(written.refusal);
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
    setBusy(true);
    const written = await sendJson<JudgeCredential>(
      judgeCredentialPath(credential.id),
      {
        method: "PATCH",
        body: {
          key: replacement.trim(),
          expected_revision: credential.revision,
        },
        project: projectId,
      },
    );
    setBusy(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      onFailure(written.refusal);
      return;
    }
    setReplacement("");
    setRotating(null);
    onChanged();
  }

  return (
    <section aria-label="Judge credentials">
      <h2>Organization keys</h2>
      <p>
        A key belongs to the organization, not to a project, so one key can serve
        every project. Egma shows the last four characters and never the key
        itself — not here, and not through any other page.
      </p>

      {credentials.length === 0 ? (
        <p>No judge credentials yet.</p>
      ) : (
        <ul>
          {credentials.map((credential) => (
            <li key={credential.id}>
              {credential.label} · {credential.provider} · ends …{credential.hint}{" "}
              <Button
                disabled={!mayAdminister || busy}
                onClick={() =>
                  setRotating(rotating === credential.id ? null : credential.id)
                }
              >
                Replace key
              </Button>
              {rotating === credential.id ? (
                <>
                  <Field label="New key" htmlFor={`rotate-${credential.id}`}>
                    <input
                      id={`rotate-${credential.id}`}
                      type="password"
                      value={replacement}
                      autoComplete="off"
                      disabled={!mayAdminister || busy}
                      onChange={(event) => setReplacement(event.target.value)}
                    />
                    <small>
                      Replaces the stored key whole. You do not need the old one,
                      and egma will not show it to you.
                    </small>
                  </Field>
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
        <TextInput id="credential-label" value={label} onChange={setLabel} />
      </Field>
      <Field label="OpenAI key" htmlFor="credential-key">
        <input
          id="credential-key"
          type="password"
          value={key}
          autoComplete="off"
          disabled={!mayAdminister || busy}
          onChange={(event) => setKey(event.target.value)}
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
