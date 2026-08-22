"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  createTest,
  getTestSuite,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  suitePagePath,
  type TestSuite,
} from "../../../../../lib/test-suites.ts";
import {
  behaviorsAreUsable,
  whyBehaviorsRefuse,
  type ExpectedBehavior,
} from "../../../../../lib/tests.ts";
import {
  Field,
  Form,
  FormActions,
  FormRow,
  Help,
  Problem,
  Refused,
} from "../../../../../ui/form.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { Section } from "../../../../../ui/section.tsx";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import { Behaviors, NamedSelector } from "../editor.tsx";

export default function NewTestPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const suiteId = useSearchParams().get("suite");
  return (
    <AppShell>
      <NewTest projectId={projectId} suiteId={suiteId} />
    </AppShell>
  );
}

function NewTest({
  projectId,
  suiteId,
}: {
  readonly projectId: string;
  readonly suiteId: string | null;
}) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);
  const { answer: suite, reload } = useProjectRead<TestSuite>(
    (projectId) =>
      platformAnswer(
        getTestSuite(
          { suiteId: suiteId ?? "", projectId },
          { client: platformClient },
        ),
      ),
    suiteId === null ? null : projectId,
    suiteId ?? "",
  );

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scenario, setScenario] = useState("");
  const [behaviors, setBehaviors] = useState<readonly ExpectedBehavior[]>([""]);
  const [chosenPersonas, setChosenPersonas] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  const changed =
    name !== "" ||
    description !== "" ||
    scenario !== "" ||
    behaviors.length !== 1 ||
    behaviors[0] !== "" ||
    chosenPersonas.length > 0;
  useUnsavedChanges(changed && !saving, saving);

  useEffect(() => {
    setName("");
    setDescription("");
    setScenario("");
    setBehaviors([""]);
    setChosenPersonas([]);
    setRefused(null);
  }, [projectId, suiteId]);

  useEffect(() => {
    if (suite?.status === "signed-out") window.location.replace("/sign-in");
  }, [suite]);

  const behaviorProblem = whyBehaviorsRefuse(behaviors);
  const usable =
    suiteId !== null &&
    suite?.status === "ready" &&
    name.trim() !== "" &&
    scenario.trim() !== "" &&
    behaviorsAreUsable(behaviors);

  async function write(): Promise<void> {
    if (suiteId === null || !usable) return;
    setRefused(null);
    setSaving(true);
    const written = await platformAnswer(
      createTest(
        {
        projectId,
        suiteId,
        name: name.trim(),
        ...(description.trim() === "" ? {} : { description: description.trim() }),
        scenario: scenario.trim(),
        expectedBehaviors: behaviors
          .map((one) => one.trim())
          .filter((one) => one !== ""),
        personas: [...chosenPersonas],
        },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return;
    }
    router.push(
      `/projects/${encodeURIComponent(projectId)}/tests/${encodeURIComponent(written.value.id)}`,
    );
  }

  if (suiteId === null) {
    return (
      <ProductPage>
        <PageHeader title="Write a test" eyebrow="Tests" />
        <PageBody>
          <Empty
            title="Choose a test suite first"
            lead="Every test belongs to one suite for its full lifetime. Open a suite, then write the test there."
            action={
              <Button asChild variant="secondary">
                <Link href={`/projects/${encodeURIComponent(projectId)}/tests`}>
                  Open test suites
                </Link>
              </Button>
            }
          />
        </PageBody>
      </ProductPage>
    );
  }

  if (suite === null || suite.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader title="Write a test" eyebrow="Tests" />
        <PageBody><Loading what="test suite" /></PageBody>
      </ProductPage>
    );
  }
  if (suite.status === "missing") {
    return (
      <ProductPage>
        <PageHeader title="Write a test" eyebrow="Tests" />
        <PageBody><NotFound message={suite.refusal.message} /></PageBody>
      </ProductPage>
    );
  }
  if (suite.status === "failed") {
    return (
      <ProductPage>
        <PageHeader title="Write a test" eyebrow="Tests" />
        <PageBody><Failure message={suite.refusal.message} onRetry={reload} /></PageBody>
      </ProductPage>
    );
  }

  return (
    <ProductPage>
      <PageHeader
        title="Write a test"
        breadcrumbs={[
          { label: "Tests", href: `/projects/${encodeURIComponent(projectId)}/tests` },
          { label: suite.value.name, href: suitePagePath(projectId, suiteId) },
          { label: "New test" },
        ]}
        lead={`This test will stay in ${suite.value.name}.`}
      />
      <PageBody>
        {refused === null ? null : <Refused message={refused.message} />}
        <Form onSubmit={() => void write()}>
          <Section
            title="What it is"
            lead="A name somebody will recognise in a list, and a line about why it exists."
          >
            <FormRow>
              <Field label="Name" htmlFor="test-name">
                <Input
                  id="test-name"
                  value={name}
                  placeholder="Reschedules a booked appointment"
                  disabled={!mayAuthor}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field label="Description" htmlFor="test-description">
                <Input
                  id="test-description"
                  value={description}
                  placeholder="The bread-and-butter front-desk call"
                  disabled={!mayAuthor}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
            </FormRow>
          </Section>

          <Section
            title="The situation"
            lead="What the caller wants, and the circumstances. Not what should happen — that is the next section."
          >
            <Field label="Scenario" htmlFor="test-scenario">
              <Textarea
                id="test-scenario"
                value={scenario}
                rows={5}
                placeholder="Their cleaning is booked for Thursday morning and has to move to any afternoon next week."
                disabled={!mayAuthor}
                onChange={(event) => setScenario(event.target.value)}
              />
            </Field>
          </Section>

          <Section
            title="What should happen"
            lead="Every statement has to hold. Keep at least one so the test can fail."
          >
            <Behaviors behaviors={behaviors} disabled={!mayAuthor} onChange={setBehaviors} />
            {behaviorProblem === null ? null : <Problem>{behaviorProblem}</Problem>}
            <Help>
              The expected-behaviors grader grades every simulation against this list. A test does not choose its own grader.
            </Help>
          </Section>

          <Section
            title="Who calls"
            lead="Choose none and Egma uses the project's default persona."
          >
            <NamedSelector
              label="Personas"
              resource="personas"
              project={projectId}
              chosen={chosenPersonas}
              disabled={!mayAuthor}
              onChange={setChosenPersonas}
            />
          </Section>

          <FormActions>
            <Button
              type="submit"
              disabled={!mayAuthor || saving || !usable}
              why={
                mayAuthor
                  ? undefined
                  : `Your ${String(role ?? "")} role cannot write tests. Ask an organization admin to change your role.`
              }
            >
              {saving ? "Writing…" : "Write the test"}
            </Button>
            <Button asChild variant="secondary">
              <Link href={suitePagePath(projectId, suiteId)}>Cancel</Link>
            </Button>
          </FormActions>
        </Form>
      </PageBody>
    </ProductPage>
  );
}
