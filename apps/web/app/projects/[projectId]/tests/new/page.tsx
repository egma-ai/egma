"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  behaviorsAreUsable,
  whyBehaviorsRefuse,
  type ExpectedBehavior,
  type ListedTest,
} from "../../../../../lib/tests.ts";
import {
  Button,
  ButtonLink,
  Field,
  Form,
  FormActions,
  FormRow,
  Help,
  Problem,
  Refused,
  Section,
  TextArea,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import {
  Behaviors,
  NamedSelector,
} from "../editor.tsx";

/**
 * Writing a test.
 *
 * **The form asks for a target, because a test has to have one.** A
 * specification nothing can be executed against is one nobody can act on, and
 * the platform refuses it — so the choice is on the form rather than a refusal
 * afterwards. It is the only field here whose absence stops the save, alongside
 * the expected behaviors, which are what make the test able to fail at all.
 *
 * Everything a test is made of goes in one write, because until it is written
 * there is nothing to version: the split between live identity, versioned
 * content and applicable agents starts on the detail page, where each of the
 * three has something to be stale against.
 */
export default function NewTestPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <NewTest projectId={projectId} />
    </AppShell>
  );
}

function NewTest({ projectId }: { readonly projectId: string }) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scenario, setScenario] = useState("");
  const [behaviors, setBehaviors] = useState<readonly ExpectedBehavior[]>([""]);
  const [chosenAgents, setChosenAgents] = useState<readonly string[]>([]);
  const [chosenPersonas, setChosenPersonas] = useState<readonly string[]>([]);

  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  const changed =
    name !== "" ||
    description !== "" ||
    scenario !== "" ||
    behaviors.length !== 1 ||
    behaviors[0] !== "" ||
    chosenAgents.length > 0 ||
    chosenPersonas.length > 0;
  useUnsavedChanges(changed && !saving, saving);

  /**
   * Everything typed belongs to this project's form, so a project change starts
   * a new one. The alternative is a scenario written for Outbound landing in
   * Support because the selector moved while somebody was typing.
   */
  useEffect(() => {
    setName("");
    setDescription("");
    setScenario("");
    setBehaviors([""]);
    setChosenAgents([]);
    setChosenPersonas([]);
    setRefused(null);
  }, [projectId]);

  const behaviorProblem = whyBehaviorsRefuse(behaviors);
  const usable =
    name.trim() !== "" &&
    scenario.trim() !== "" &&
    chosenAgents.length > 0 &&
    behaviorsAreUsable(behaviors);

  async function write(): Promise<void> {
    setRefused(null);
    setSaving(true);
    const written = await writeJson<ListedTest>("/api/tests", {
      method: "POST",
      project: projectId,
      body: {
        name: name.trim(),
        ...(description.trim() === "" ? {} : { description: description.trim() }),
        scenario: scenario.trim(),
        expected_behaviors: behaviors
          .map((one) => one.trim())
          .filter((one) => one !== ""),
        personas: [...chosenPersonas],
        agents: [...chosenAgents],
      },
    });
    setSaving(false);

    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      // The refusal's own sentence, shown unchanged above the form — and the
      // form keeps everything typed into it, because retyping an afternoon's
      // work to find out whether it fails the same way is how a person learns
      // to stop trying.
      setRefused(written.refusal);
      return;
    }
    router.push(projectPath(projectId, "tests", written.value.id));
  }

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Tests"
        title="Write a test"
        breadcrumbs={[
          { label: "Tests", href: projectPath(projectId, "tests") },
          { label: "New test" },
        ]}
        lead="The situation to put an agent in, who calls about it, and what should happen."
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
                <TextInput
                  id="test-name"
                  value={name}
                  placeholder="Reschedules a booked appointment"
                  disabled={!mayAuthor}
                  onChange={setName}
                />
              </Field>
              <Field label="Description" htmlFor="test-description">
                <TextInput
                  id="test-description"
                  value={description}
                  placeholder="The bread-and-butter front-desk call"
                  disabled={!mayAuthor}
                  onChange={setDescription}
                />
              </Field>
            </FormRow>
          </Section>

          <Section
            title="The situation"
            lead="What the caller wants, and the circumstances. Not what should happen — that is the next section."
          >
            <Field label="Scenario" htmlFor="test-scenario">
              <TextArea
                id="test-scenario"
                value={scenario}
                rows={5}
                placeholder="Their cleaning is booked for Thursday morning and has to move to any afternoon next week."
                disabled={!mayAuthor}
                onChange={setScenario}
              />
            </Field>
          </Section>

          <Section
            title="What should happen"
            lead="Statements about the agent's conduct. Every one has to hold, and a test keeps at least one — a test that cannot fail is not a test."
          >
            <Behaviors
              behaviors={behaviors}
              disabled={!mayAuthor}
              onChange={setBehaviors}
            />
            {behaviorProblem === null ? null : (
              <Problem>{behaviorProblem}</Problem>
            )}
            <Help>
              The expected-behaviors grader judges every simulation against this
              list. It is a predefined grader, and every project starts with a
              running copy of it switched on — a test never names its own.
            </Help>
          </Section>

          <Section
            title="Which agents it applies to"
            lead="The targets a run may execute this test against. At least one, and every one active in this project."
          >
            <NamedSelector
              label="Agents"
              resource="agents"
              project={projectId}
              chosen={chosenAgents}
              emptyMessage="This project has no active agent. Register an agent first."
              disabled={!mayAuthor}
              onChange={setChosenAgents}
            />
            {chosenAgents.length === 0 ? (
              <Problem>
                Every test must apply to at least one active agent. Select an
                active agent and save the test again.
              </Problem>
            ) : null}
          </Section>

          <Section
            title="Who calls"
            lead="Choose none and Egma takes the project's default persona, so a first test never waits on authoring a caller."
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
              weight="strong"
              disabled={!mayAuthor || saving || !usable}
              why={
                mayAuthor
                  ? undefined
                  : `Your ${String(role ?? "")} role cannot write tests. Ask an organization admin to change your role.`
              }
            >
              {saving ? "Writing…" : "Write the test"}
            </Button>
            <ButtonLink href={projectPath(projectId, "tests")}>Cancel</ButtonLink>
          </FormActions>
        </Form>
      </PageBody>
    </ProductPage>
  );
}
