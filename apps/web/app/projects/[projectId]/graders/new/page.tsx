"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { sendJson, type Refusal } from "../../../../../lib/api.ts";
import {
  defaultReads,
  GRADER_REGISTRY_PATH,
  GRADERS_PATH,
  TYPE_SUMMARY,
  type GraderRead,
  type GraderRegistry,
  type GraderType,
  type ListedGrader,
  type Modality,
  type Priority,
  type Scope,
} from "../../../../../lib/graders.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import { Button, ButtonLink } from "../../../../../ui/controls.tsx";
import { Failure, Loading } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import {
  ALL_MODALITIES,
  ConfigFields,
  EditSection,
  EvidenceFields,
  emptyConfigFor,
  isConfigUsable,
  LiveFields,
  type ConfigDraft,
} from "../editor.tsx";

/**
 * Writing a grader: choose what kind of judgment it makes, then say what it is
 * made of.
 *
 * **The type is chosen once and never again.** Every version of a grader holds
 * a config that its type shapes, so changing it later would leave the versions
 * behind it holding parameters for a kind of judgment this grader no longer
 * makes — a different grader wearing the old one's history. The page says so
 * here, where the decision is being taken, rather than refusing an edit weeks
 * later.
 */
export default function NewGraderPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <NewGrader projectId={projectId} />
    </AppShell>
  );
}

const TYPES: readonly GraderType[] = [
  "llm_rubric",
  "metric_threshold",
  "tool_calls",
  "phrase_match",
];

function NewGrader({ projectId }: { readonly projectId: string }) {
  const router = useRouter();
  const { me } = useShellSession();
  // Null until the session read answers. Claiming nothing is what stops an
  // admin being told their role cannot do something it can.
  const role = me === null ? null : roleOf(me);

  const { answer: registry, reload } = useProjectRead<GraderRegistry>(
    GRADER_REGISTRY_PATH,
    projectId,
  );

  const [type, setType] = useState<GraderType>("llm_rubric");
  const [config, setConfig] = useState<ConfigDraft>(() =>
    emptyConfigFor("llm_rubric"),
  );
  const [reads, setReads] = useState<readonly GraderRead[]>(["transcript"]);
  const [modalities, setModalities] =
    useState<readonly Modality[]>(ALL_MODALITIES);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("P0");
  const [scope, setScope] = useState<Scope>("simulations");
  const [sampleRate, setSampleRate] = useState(100);

  const [saving, setSaving] = useState(false);
  /** Why the save did not land, kept until somebody tries again. */
  const [refused, setRefused] = useState<Refusal | null>(null);

  const settledRegistry = registry?.status === "ready" ? registry.value : null;

  // Changing the type changes what a judgment is made of, so the fields under
  // it start again — and the reads go back to what that type reads, because a
  // set carried over from the last type would be one the server refuses.
  function chooseType(next: GraderType): void {
    setType(next);
    setConfig(emptyConfigFor(next));
    setReads(defaultReads(settledRegistry, next));
  }

  useEffect(() => {
    if (settledRegistry !== null) setReads(defaultReads(settledRegistry, type));
    // The type is the only thing that decides this, and it is set by the
    // handler above; this catches the registry arriving after the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledRegistry]);

  const mayAuthor = role !== null && canAuthor(role);
  const complete =
    name.trim() !== "" && isConfigUsable(type, config) && modalities.length > 0;

  async function save(): Promise<void> {
    if (!mayAuthor || !complete || saving) return;

    setRefused(null);
    setSaving(true);

    const written = await sendJson<ListedGrader>(GRADERS_PATH, {
      method: "POST",
      project: projectId,
      body: {
        name: name.trim(),
        ...(description.trim() === "" ? {} : { description: description.trim() }),
        type,
        config,
        priority,
        scope,
        production_sample_rate: sampleRate,
        reads,
        modalities,
      },
    });

    setSaving(false);

    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }

    // A failure says so and offers the way out. Returning quietly would leave
    // somebody pressing a button that has already stopped working.
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return;
    }

    router.push(projectPath(projectId, "graders", written.value.id));
  }

  if (registry === null) {
    return (
      <ProductPage>
        <PageHeader eyebrow="Graders" title="Write a grader" />
        <PageBody>
          <Loading what="the grader types egma knows" />
        </PageBody>
      </ProductPage>
    );
  }

  if (registry.status !== "ready") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Graders" title="Write a grader" />
        <PageBody>
          <Failure
            message={
              registry.status === "signed-out"
                ? "Your session has ended. Sign in and try again."
                : registry.refusal.message
            }
            onRetry={reload}
          />
        </PageBody>
      </ProductPage>
    );
  }

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Graders"
        title="Write a grader"
        lead="A grader judges. Choose what kind of judgment this one makes, then say what it is made of."
        action={
          <ButtonLink href={projectPath(projectId, "graders")}>Back to graders</ButtonLink>
        }
      />
      <PageBody>
        {mayAuthor ? null : (
          <p>
            Your {String(role ?? "")} role cannot write graders. Ask an
            organization admin to change your role.
          </p>
        )}

        <EditSection
          title="What kind of judgment"
          effect="Chosen once. A grader's type can never change, because every version of it holds a config that type shapes — clone it, or write another, to judge a different way."
        >
          <fieldset>
            <legend>Type</legend>
            {TYPES.map((option) => (
              <label key={option} htmlFor={`grader-type-${option}`}>
                <input
                  id={`grader-type-${option}`}
                  type="radio"
                  name="grader-type"
                  value={option}
                  checked={type === option}
                  disabled={!mayAuthor}
                  onChange={() => chooseType(option)}
                />
                {option} — {TYPE_SUMMARY[option]}
              </label>
            ))}
          </fieldset>
        </EditSection>

        <EditSection
          title="What it judges by"
          effect="Immutable version content. Saving a change here makes a new version and applies from then on; runs already judged keep meaning what they meant."
        >
          <ConfigFields
            type={type}
            config={config}
            disabled={!mayAuthor}
            onChange={setConfig}
          />
          <EvidenceFields
            registry={registry.value}
            type={type}
            reads={reads}
            modalities={modalities}
            disabled={!mayAuthor}
            onReads={setReads}
            onModalities={setModalities}
          />
        </EditSection>

        <EditSection
          title="Where it applies, and how loudly"
          effect="Live settings. They take effect everywhere the moment they are saved and change nothing about any verdict already made."
        >
          <LiveFields
            name={name}
            description={description}
            priority={priority}
            scope={scope}
            sampleRate={sampleRate}
            disabled={!mayAuthor}
            onChange={(changes) => {
              if (changes.name !== undefined) setName(changes.name);
              if (changes.description !== undefined) setDescription(changes.description);
              if (changes.priority !== undefined) setPriority(changes.priority);
              if (changes.scope !== undefined) setScope(changes.scope);
              if (changes.sampleRate !== undefined) setSampleRate(changes.sampleRate);
            }}
          />
        </EditSection>

        {refused === null ? null : (
          <Failure
            title="Egma did not write this grader."
            message={refused.message}
            onRetry={() => void save()}
          />
        )}

        <Button
          weight="strong"
          disabled={!mayAuthor || !complete || saving}
          onClick={() => void save()}
        >
          {saving ? "Writing…" : "Write grader"}
        </Button>
      </PageBody>
    </ProductPage>
  );
}
