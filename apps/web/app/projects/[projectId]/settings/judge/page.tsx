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
  PLATFORM_SOURCE,
  type JudgeCredentialPage,
  type JudgeRegistry,
  type ProjectJudge,
} from "../../../../../lib/judge.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import {
  Badge,
  Button,
  ButtonLink,
  Field,
  Help,
  Section,
  Select,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { Failure, Loading } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { SettingsNav, settingsPath } from "../../../../../ui/settings-nav.tsx";
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
  const { answer: credentials } = useProjectRead<JudgeCredentialPage>(
    JUDGE_CREDENTIALS_PATH,
    projectId,
  );
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
        <PageHeader eyebrow="Settings" title="Judge" />
        <PageBody>
          <SettingsNav projectId={projectId} current="judge" />
          <Loading what="the judge" />
        </PageBody>
      </ProductPage>
    );
  }

  if (judge.status !== "ready") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Settings" title="Judge" />
        <PageBody>
          <SettingsNav projectId={projectId} current="judge" />
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
        eyebrow="Settings"
        title="Judge"
        lead="The model that decides an LLM judgment in this project, and the organization key it is asked with."
        action={
          <ButtonLink href={projectPath(projectId, "graders")}>
            Back to graders
          </ButtonLink>
        }
      />
      <PageBody>
        <SettingsNav projectId={projectId} current="judge" />
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
                <Select
                  id="judge-provider"
                  value={provider}
                  options={(registry?.status === "ready"
                    ? registry.value.providers
                    : []
                  ).map((one) => ({ value: one.provider, label: one.provider }))}
                  disabled={!mayAdminister}
                  onChange={(chosen) => {
                    setProvider(chosen);
                    // A credential of the old provider cannot answer for the
                    // new one, so the choice is cleared rather than left
                    // pointing at something the server would refuse.
                    setSource("");
                  }}
                />
              </Field>

              <Field
                label="Key"
                htmlFor="judge-source"
                {...(choosable.length === 0
                  ? {
                      hint: `This organization holds no ${provider} key yet. Add one under Organization settings.`,
                    }
                  : {})}
              >
                <Select
                  id="judge-source"
                  value={source}
                  /*
                   * The deployment's own judge is offered when **the deployment
                   * has one**, and never when the project happens to be using
                   * it. Reading it off the project's current choice would make
                   * moving to a key of your own a one-way door — the option
                   * would vanish the moment you stopped using it, and the way
                   * back would be unreachable from the one page that exists to
                   * take it. The registry answers this because it is the
                   * deployment's fact to state.
                   */
                  options={[
                    { value: "", label: "Choose a key" },
                    ...choosable.map((credential) => ({
                      value: credential.id,
                      label: credentialLabel(credential),
                    })),
                    ...(platformJudge
                      ? [
                          {
                            value: PLATFORM_SOURCE,
                            label: "This deployment's own judge",
                          },
                        ]
                      : []),
                  ]}
                  disabled={!mayAdminister}
                  onChange={setSource}
                />
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

        {/*
          * **Where the keys themselves are is one group over, and that is the
          * separation this whole Settings area is built on.** A judge
          * credential belongs to the organization: one key can serve every
          * project, and rotating it is felt by all of them at once. What is on
          * this page is one project's *choice* among them, which is the only
          * half that belongs to a project.
          */}
        <Section title="Where these keys come from">
          <Help>
            A judge key belongs to the organization rather than to this project,
            so one key can serve every project. Add, label and replace them
            under{" "}
            <ButtonLink href={settingsPath(projectId, "organization")}>
              Organization settings
            </ButtonLink>
            .
          </Help>
        </Section>

      </PageBody>
    </ProductPage>
  );
}
