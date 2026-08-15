"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { sendJson, type Refusal } from "../../../../../lib/api.ts";
import {
  graderPath,
  graderUsagePath,
  graderVersionsPath,
  GRADER_REGISTRY_PATH,
  type GraderRegistry,
  type GraderUsage,
  type GraderVersionPage,
  type ListedGrader,
} from "../../../../../lib/graders.ts";
import { asDay } from "../../../../../lib/instants.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import { Badge, Button, ButtonLink } from "../../../../../ui/controls.tsx";
import { Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import {
  ConfigFields,
  EditSection,
  EvidenceFields,
  isConfigUsable,
  LiveFields,
  type ConfigDraft,
} from "../editor.tsx";

/**
 * One grader: what it judges by now, what it judged by before, who asks for it
 * by name, and the two kinds of edit.
 *
 * **The page is built around the split, because the split is what somebody has
 * to understand before they save.** Promoting a warning to a blocker and
 * tightening a rubric look like the same act in a form and are not: one changes
 * what happens next, and the other changes what a check *means*. So the two
 * sections say what saving them does, and each carries its own expectation — the
 * revision for the live half, the version for the content — so that renaming a
 * grader in one tab cannot make a rubric edit somebody is typing in another one
 * stale.
 */
export default function GraderDetailPage() {
  const { projectId, graderId } = useParams<{
    projectId: string;
    graderId: string;
  }>();
  return (
    <AppShell>
      <GraderDetail projectId={projectId} graderId={graderId} />
    </AppShell>
  );
}

function GraderDetail({
  projectId,
  graderId,
}: {
  readonly projectId: string;
  readonly graderId: string;
}) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);

  const { answer, reload } = useProjectRead<ListedGrader>(
    graderPath(graderId),
    projectId,
  );
  const { answer: registry } = useProjectRead<GraderRegistry>(
    GRADER_REGISTRY_PATH,
    projectId,
  );
  const { answer: history, reload: reloadHistory } =
    useProjectRead<GraderVersionPage>(graderVersionsPath(graderId), projectId);
  const { answer: usage, reload: reloadUsage } = useProjectRead<GraderUsage>(
    graderUsagePath(graderId),
    projectId,
  );

  const grader = answer?.status === "ready" ? answer.value : null;

  /**
   * The draft, and the state it was drafted from.
   *
   * The read is reset whenever the project changes, so the draft is reset from
   * whatever the read then answers — which is what stops a form still holding
   * one project's rubric from being saved into another's grader.
   */
  const [draft, setDraft] = useState<{
    readonly graderId: string;
    readonly project: string;
    readonly config: ConfigDraft;
    readonly reads: readonly ListedGrader["reads"][number][];
    readonly modalities: readonly ListedGrader["modalities"][number][];
    readonly name: string;
    readonly description: string;
    readonly priority: ListedGrader["priority"];
    readonly scope: ListedGrader["scope"];
    readonly sampleRate: number;
  } | null>(null);

  useEffect(() => {
    if (grader === null) return;
    setDraft({
      graderId: grader.id,
      project: projectId,
      config: grader.config,
      reads: grader.reads,
      modalities: grader.modalities,
      name: grader.name,
      description: grader.description ?? "",
      priority: grader.priority,
      scope: grader.scope,
      sampleRate: grader.production_sample_rate,
    });
  }, [grader, projectId]);

  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const mayAuthor = role !== null && canAuthor(role);
  const archived = grader !== null && grader.archived_at !== null;

  /** A draft is only ever this grader's, in this project. Anything else is not shown. */
  const editing =
    draft !== null && draft.graderId === graderId && draft.project === projectId
      ? draft
      : null;

  async function write(
    path: string,
    body: Record<string, unknown>,
  ): Promise<ListedGrader | null> {
    setRefused(null);
    setSaving(true);
    const written = await sendJson<ListedGrader>(path, {
      method: path.endsWith("/clone") ||
      path.endsWith("/archive") ||
      path.endsWith("/restore")
        ? "POST"
        : "PATCH",
      project: projectId,
      body,
    });
    setSaving(false);

    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return null;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return null;
    }
    return written.value;
  }

  async function saveLive(): Promise<void> {
    if (editing === null || grader === null) return;
    const written = await write(graderPath(graderId), {
      name: editing.name.trim(),
      description: editing.description.trim() === "" ? null : editing.description.trim(),
      priority: editing.priority,
      scope: editing.scope,
      production_sample_rate: editing.sampleRate,
      // The live half carries the revision alone. Sending the version too would
      // make a rename fail because somebody else tightened a rubric, which is a
      // conflict that never existed.
      expected_revision: grader.revision,
    });
    if (written !== null) reload();
  }

  async function saveContent(): Promise<void> {
    if (editing === null || grader === null) return;
    const written = await write(graderPath(graderId), {
      config: editing.config,
      reads: editing.reads,
      modalities: editing.modalities,
      // And the content half carries the version alone, for the mirror reason.
      expected_version_id: grader.version_id,
    });
    if (written !== null) {
      reload();
      reloadHistory();
    }
  }

  async function clone(): Promise<void> {
    if (grader === null) return;
    const written = await write(`${graderPath(graderId)}/clone`, {
      name: `${grader.name} copy`,
    });
    if (written !== null) {
      router.push(projectPath(projectId, "graders", written.id));
    }
  }

  async function setArchived(next: boolean): Promise<void> {
    if (grader === null) return;
    const written = await write(
      `${graderPath(graderId)}/${next ? "archive" : "restore"}`,
      { expected_revision: grader.revision },
    );
    if (written !== null) {
      reload();
      reloadUsage();
    }
  }

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Graders" title="Grader" />
        <PageBody>
          <Loading what="this grader" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Graders" title="Grader" />
        <PageBody>
          <NotFound
            message={answer.refusal.message}
            action={
              <ButtonLink href={projectPath(projectId, "graders")}>
                Back to graders
              </ButtonLink>
            }
          />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed" || grader === null || editing === null) {
    return (
      <ProductPage>
        <PageHeader eyebrow="Graders" title="Grader" />
        <PageBody>
          {answer.status === "failed" ? (
            <Failure message={answer.refusal.message} onRetry={reload} />
          ) : (
            <Loading what="this grader" />
          )}
        </PageBody>
      </ProductPage>
    );
  }

  const blocking = usage?.status === "ready" ? usage.value.direct_tests : [];
  const whyNot = mayAuthor
    ? undefined
    : `Your ${String(role ?? "")} role cannot change graders. Ask an organization admin to change your role.`;

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Graders"
        title={grader.name}
        lead={
          <>
            {grader.type} · v{grader.version} · changed {asDay(grader.updated_at)}{" "}
            {archived ? <Badge tone="warn">Archived</Badge> : null}
          </>
        }
        action={
          <ButtonLink href={projectPath(projectId, "graders")}>
            Back to graders
          </ButtonLink>
        }
      />
      <PageBody>
        {refused === null ? null : (
          <Failure
            title="Egma did not save this change."
            message={refused.message}
            onRetry={reload}
          />
        )}

        <EditSection
          title="Where it applies, and how loudly"
          effect="Live settings. They take effect everywhere the moment they are saved and change nothing about any verdict already made."
        >
          <LiveFields
            name={editing.name}
            description={editing.description}
            priority={editing.priority}
            scope={editing.scope}
            sampleRate={editing.sampleRate}
            disabled={!mayAuthor}
            onChange={(changes) =>
              setDraft({
                ...editing,
                ...(changes.name === undefined ? {} : { name: changes.name }),
                ...(changes.description === undefined
                  ? {}
                  : { description: changes.description }),
                ...(changes.priority === undefined
                  ? {}
                  : { priority: changes.priority }),
                ...(changes.scope === undefined ? {} : { scope: changes.scope }),
                ...(changes.sampleRate === undefined
                  ? {}
                  : { sampleRate: changes.sampleRate }),
              })
            }
          />
          <Button
            disabled={!mayAuthor || saving || editing.name.trim() === ""}
            onClick={() => void saveLive()}
          >
            Save settings
          </Button>
        </EditSection>

        <EditSection
          title="What it judges by"
          effect="Immutable version content. Saving a change here makes a new version and applies from then on; runs already judged keep meaning what they meant. Saving content that has not changed makes no version at all."
        >
          <ConfigFields
            type={grader.type}
            config={editing.config}
            disabled={!mayAuthor}
            onChange={(config) => setDraft({ ...editing, config })}
          />
          <EvidenceFields
            registry={registry?.status === "ready" ? registry.value : null}
            type={grader.type}
            reads={editing.reads}
            modalities={editing.modalities}
            disabled={!mayAuthor}
            onReads={(reads) => setDraft({ ...editing, reads })}
            onModalities={(modalities) => setDraft({ ...editing, modalities })}
          />
          <Button
            disabled={
              !mayAuthor || saving || !isConfigUsable(grader.type, editing.config)
            }
            onClick={() => void saveContent()}
          >
            Save version
          </Button>
        </EditSection>

        <section aria-label="Version history">
          <h2>Version history</h2>
          {history?.status === "ready" ? (
            <ul>
              {history.value.items.map((version) => (
                <li key={version.id}>
                  v{version.version} · {asDay(version.created_at)} · reads{" "}
                  {version.reads.join(", ")} · scores {version.modalities.join(", ")}
                  {version.version === grader.version ? " · current" : ""}
                </li>
              ))}
            </ul>
          ) : (
            <Loading what="the version history" />
          )}
        </section>

        <section aria-label="Used by">
          <h2>Used by</h2>
          <p>
            This grader applies to every test in the project by default. That is
            not a use that blocks archiving it.
          </p>
          {blocking.length === 0 ? (
            <p>No test adds it directly.</p>
          ) : (
            <>
              <p>
                Added directly by {blocking.length} active{" "}
                {blocking.length === 1 ? "test" : "tests"}. Archiving is refused
                while any of them names it.
              </p>
              <ul>
                {blocking.map((test) => (
                  <li key={test.id}>{test.name}</li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-label="Lifecycle">
          <h2>This grader</h2>
          <Button disabled={!mayAuthor || saving} onClick={() => void clone()}>
            Clone
          </Button>{" "}
          <Button
            disabled={!mayAuthor || saving}
            onClick={() => void setArchived(!archived)}
          >
            {archived ? "Restore" : "Archive"}
          </Button>
          {whyNot === undefined ? null : <p>{whyNot}</p>}
          <p>
            Archiving keeps every version and every verdict. Runs that already
            froze a grading plan keep using it.
          </p>
        </section>
      </PageBody>
    </ProductPage>
  );
}
