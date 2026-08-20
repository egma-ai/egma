"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

import { Field, Form, FormActions, Help } from "../../../../../ui/form.tsx";
import { Section } from "../../../../../ui/section.tsx";
import { Failure, Loading } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  SettingsLayout,
  settingsPath,
} from "../../../../../ui/settings-nav.tsx";
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
 * runs every grader it has that is computed rather than judged; what it cannot
 * do is ask a model anything — and the predefined expected-behaviors grader,
 * which every project starts with, asks a model. A run whose plan holds one of
 * those is refused rather than dialed and then reported as errored verdicts
 * after real simulations had been paid for. A page that showed an empty form
 * would hide that.
 *
 * **It is a state and not a fault, and the difference grew teeth in wave two.**
 * Every grader is a deletable running copy now, so a project judging only by
 * computation — or by nothing at all — needs no judge and starts its runs
 * without one. `needs_setup` therefore describes what this project cannot ask
 * for rather than a run door closed to it.
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

  /** The local draft captured by the write whose confirming read is next. */
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

    if (settled.state === "configured") {
      setProvider(settled.provider);
      setModel(settled.model);
      setSource(
        settled.source === PLATFORM_SOURCE
          ? PLATFORM_SOURCE
          : (settled.credential_id ?? ""),
      );
    }
  }, [projectId, settled]);

  useEffect(() => {
    if (
      judge?.status === "signed-out" ||
      credentials?.status === "signed-out" ||
      registry?.status === "signed-out"
    ) {
      window.location.replace("/sign-in");
    }
  }, [credentials, judge, registry]);

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
  const registryUnreadable = registry !== null && registry.status !== "ready";
  const credentialsUnreadable =
    credentials !== null && credentials.status !== "ready";
  const platformJudge =
    registry?.status === "ready" && registry.value.platform_judge_available;
  const settledSource =
    settled?.state === "configured"
      ? settled.source === PLATFORM_SOURCE
        ? PLATFORM_SOURCE
        : (settled.credential_id ?? "")
      : "";
  const changed =
    settled !== null &&
    (settled.state === "needs_setup"
      ? provider !== "openai" || model.trim() !== "" || source !== ""
      : provider !== settled.provider ||
        model.trim() !== settled.model ||
        source !== settledSource);
  const complete =
    registry?.status === "ready" &&
    credentials?.status === "ready" &&
    isChoiceComplete({ provider, model, source });
  const confirming = confirmingSave.current;
  const changedWhileConfirming =
    confirmingRead &&
    confirming?.projectId === projectId &&
    editVersion.current !== confirming.editVersion;
  useUnsavedChanges((changed || changedWhileConfirming) && !saving, saving);

  async function saveChoice(): Promise<void> {
    if (!mayAdminister || !complete || !changed || saving) return;
    const submittedEditVersion = editVersion.current;
    setRefused(null);
    setSaving(true);

    const written = await writeJson<ProjectJudge>(JUDGE_PATH, {
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
    confirmingSave.current = {
      projectId,
      editVersion: submittedEditVersion,
    };
    setConfirmingRead(true);
    reloadJudge();
  }

  if (judge === null) {
    return (
      <ProductPage viewport>
        <PageHeader
          eyebrow="Settings"
          title="Judge"
          breadcrumbs={[
            { label: "Settings", href: settingsPath(projectId) },
            { label: "Judge" },
          ]}
        />
        <PageBody>
          <SettingsLayout projectId={projectId} current="judge">
            <Loading what="the judge" />
          </SettingsLayout>
        </PageBody>
      </ProductPage>
    );
  }

  if (judge.status !== "ready") {
    return (
      <ProductPage viewport>
        <PageHeader
          eyebrow="Settings"
          title="Judge"
          breadcrumbs={[
            { label: "Settings", href: settingsPath(projectId) },
            { label: "Judge" },
          ]}
        />
        <PageBody>
          <SettingsLayout projectId={projectId} current="judge">
            <Failure
              message={
                judge.status === "signed-out"
                  ? "Your session has ended. Sign in and try again."
                  : judge.refusal.message
              }
              onRetry={reloadJudge}
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
        title="Judge"
        breadcrumbs={[
          { label: "Settings", href: settingsPath(projectId) },
          { label: "Judge" },
        ]}
        lead="The model that decides an LLM judgment in this project, and the organization key it is asked with."
      />
      <PageBody>
        <SettingsLayout projectId={projectId} current="judge">
          <Section
            title="This project"
            lead="Choose the model and organization key used when a grader asks a model for a judgment."
          >
            {judge.value.state === "needs_setup" ? (
              <Help>
                <Badge variant="warning">Needs setup</Badge> This project has no judge, so
                a grader that judges by asking a model cannot run — the predefined
                expected-behaviors grader among them, which every project starts
                with. Add a judge credential under Organization settings, then
                choose it here, and grading works from the next run. A project
                running no such grader needs no judge and starts its runs without
                one.
              </Help>
            ) : (
              <Help>
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
              </Help>
            )}

            {role === null || mayAdminister ? null : (
              <Help>
                Your {String(role ?? "")} role cannot change judge settings. Ask an
                organization admin.
              </Help>
            )}

            <Form onSubmit={() => void saveChoice()}>
              <Field label="Model" htmlFor="judge-model">
                <Input
                  id="judge-model"
                  value={model}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!mayAdminister}
                  onChange={(event) => {
                    editVersion.current += 1;
                    setModel(event.target.value);
                  }}
                />
              </Field>

              {registry === null ? (
                <Loading what="the available judges" />
              ) : registryUnreadable ? (
                /*
                 * Both remaining controls are the registry's — which providers egma
                 * can ask, and whether the deployment's own judge is one of the
                 * keys on offer — so neither is drawn while that answer is missing.
                 * A select rendered here would be a claim about what may be chosen,
                 * made out of a read that failed.
                 */
                <Failure
                  title="Egma could not say which judges this project may use."
                  message={
                    registry.status === "signed-out"
                      ? "Your session has ended. Sign in and try again."
                      : registry.refusal.message
                  }
                  onRetry={reloadRegistry}
                />
              ) : (
                <>
                  <Field label="Provider" htmlFor="judge-provider">
                    <Select
                      id="judge-provider"
                      value={provider}
                      disabled={!mayAdminister}
                      onChange={(event) => {
                        editVersion.current += 1;
                        setProvider(event.target.value);
                        // A credential of the old provider cannot answer for the
                        // new one, so the choice is cleared rather than left
                        // pointing at something the server would refuse.
                        setSource("");
                      }}
                    >
                      {registry.value.providers.map((one) => (
                        <option key={one.provider} value={one.provider}>
                          {one.provider}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  {credentials === null ? (
                    <Loading what="the organization's judge keys" />
                  ) : credentialsUnreadable ? (
                    <Failure
                      title="Egma could not list this organization's judge keys."
                      message={
                        credentials.status === "signed-out"
                          ? "Your session has ended. Sign in and try again."
                          : credentials.refusal.message
                      }
                      onRetry={reloadCredentials}
                    />
                  ) : (
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
                        disabled={!mayAdminister}
                        onChange={(event) => {
                          editVersion.current += 1;
                          setSource(event.target.value);
                        }}
                      >
                        <option value="">Choose a key</option>
                        {choosable.map((credential) => (
                          <option key={credential.id} value={credential.id}>
                            {credentialLabel(credential)}
                          </option>
                        ))}
                        {/*
                          The deployment's own judge is offered when **the
                          deployment has one**, and never when the project
                          happens to be using it. Reading it off the project's
                          current choice would make moving to a key of your own
                          a one-way door — the option would vanish the moment
                          you stopped using it, and the way back would be
                          unreachable from the one page that exists to take it.
                          The registry answers this because it is the
                          deployment's fact to state.
                        */}
                        {platformJudge ? (
                          <option value={PLATFORM_SOURCE}>
                            This deployment&apos;s own judge
                          </option>
                        ) : null}
                      </Select>
                    </Field>
                  )}
                </>
              )}

              {refused === null ? null : (
                <Failure
                  title="Egma did not save the judge."
                  message={refused.message}
                  onRetry={() => void saveChoice()}
                />
              )}

              <FormActions>
                <Button
                  type="submit"
                  disabled={!mayAdminister || !complete || !changed || saving}
                >
                  {saving ? "Saving…" : "Save judge"}
                </Button>
              </FormActions>
            </Form>
          </Section>

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
              <Button asChild variant="secondary">
                <Link href={settingsPath(projectId, "organization")}>
                  Organization settings
                </Link>
              </Button>
              .
            </Help>
          </Section>
        </SettingsLayout>
      </PageBody>
    </ProductPage>
  );
}
