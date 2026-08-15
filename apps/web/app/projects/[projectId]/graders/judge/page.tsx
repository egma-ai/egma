"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { sendJson, type Refusal } from "../../../../../lib/api.ts";
import {
  credentialLabel,
  credentialsFor,
  credentialsIn,
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
  const { answer: registry, reload: reloadRegistry } =
    useProjectRead<JudgeRegistry>(JUDGE_REGISTRY_PATH, projectId);

  const held = credentialsIn(
    credentials?.status === "ready" ? credentials.value : undefined,
  );
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

  /**
   * What egma knows about the deployment's own judge — and **"could not ask" is
   * not "asked, and there is none".**
   *
   * A read that failed is not a fact. This is the same refusal the product
   * makes everywhere else: `skipped` is never collapsed into `failed`, and a
   * connection whose capabilities egma could not check is `unknown` rather than
   * unsupported. Treating a network blip as "this deployment has no judge"
   * would quietly take the way back to the platform judge off the page, and
   * take it off silently — the admin would see a select that looked complete
   * and simply lacked the option they came for.
   *
   * So there are three answers and the page renders all three: it is there, it
   * is not there, and egma could not ask.
   */
  const registryUnreadable =
    registry !== null &&
    (registry.status === "failed" || registry.status === "missing");
  const platformJudge =
    registry?.status === "ready" && registry.value.platform_judge_available;
  const complete =
    !registryUnreadable && isChoiceComplete({ provider, model, source });

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

          <Field label="Model" htmlFor="judge-model">
            <TextInput id="judge-model" value={model} onChange={setModel} />
          </Field>

          {registryUnreadable ? (
            /*
             * Both remaining controls are the registry's — which providers egma
             * can ask, and whether the deployment's own judge is one of the
             * keys on offer — so neither is drawn while that answer is missing.
             * A select rendered here would be a claim about what may be chosen,
             * made out of a read that failed.
             */
            <Failure
              title="Egma could not say which judges this project may use."
              message={registry.refusal.message}
              onRetry={reloadRegistry}
            />
          ) : (
            <>
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
              {/*
                * Offered when **the deployment has a judge**, and never when
                * the project happens to be using one. Reading it off the
                * project's current choice would make moving to a key of your
                * own a one-way door — the option would vanish the moment you
                * stopped using it, and the way back would be unreachable from
                * the one page that exists to take it. The registry answers
                * this because it is the deployment's fact to state.
                */}
              {platformJudge ? (
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
            </>
          )}

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
}: {
  readonly credentials: readonly JudgeCredential[];
  readonly projectId: string;
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
        project: projectId,
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
