"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import { agentsQuery, type AgentPage } from "../../../../../lib/agents.ts";
import { personasPath, type PersonaPage } from "../../../../../lib/personas.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  behaviorsAreUsable,
  CAPABILITIES_PATH,
  whyBehaviorsRefuse,
  type CapabilityCatalog,
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
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import {
  Behaviors,
  CapabilityChoices,
  NamedChoices,
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

  const { answer: agents } = useProjectRead<AgentPage>(agentsQuery({}), projectId);
  const { answer: personas } = useProjectRead<PersonaPage>(
    personasPath(false),
    projectId,
  );
  const { answer: catalog } = useProjectRead<CapabilityCatalog>(
    CAPABILITIES_PATH,
    projectId,
  );

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scenario, setScenario] = useState("");
  const [behaviors, setBehaviors] = useState<readonly ExpectedBehavior[]>([""]);
  const [chosenAgents, setChosenAgents] = useState<readonly string[]>([]);
  const [chosenPersonas, setChosenPersonas] = useState<readonly string[]>([]);
  const [capabilities, setCapabilities] = useState<readonly string[]>([]);

  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

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
    setCapabilities([]);
    setRefused(null);
  }, [projectId]);

  const activeAgents =
    agents?.status === "ready"
      ? agents.value.items.filter((one) => one.archived_at === null)
      : [];
  const activePersonas =
    personas?.status === "ready"
      ? personas.value.items.filter((one) => one.archived_at === null)
      : [];

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
        required_capabilities: [...capabilities],
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
        lead="The situation to put an agent in, who calls about it, and what should happen."
        action={
          <ButtonLink href={projectPath(projectId, "tests")}>
            Back to tests
          </ButtonLink>
        }
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
            lead="Statements about the agent's conduct, in order. Every one has to hold, and a test keeps at least one — a test that cannot fail is not a test."
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
            <NamedChoices
              legend="Applicable agents"
              available={activeAgents.map((one) => ({
                id: one.id,
                name: one.name,
                archived_at: one.archived_at,
              }))}
              chosen={chosenAgents}
              disabled={!mayAuthor}
              onChange={setChosenAgents}
            />
            {activeAgents.length === 0 ? (
              <Problem>
                This project has no active agent, so it can hold no test. Register
                an agent first.
              </Problem>
            ) : null}
            {activeAgents.length > 0 && chosenAgents.length === 0 ? (
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
            <NamedChoices
              legend="Personas"
              available={activePersonas.map((one) => ({
                id: one.id,
                name: one.name,
                archived_at: one.archived_at,
              }))}
              chosen={chosenPersonas}
              disabled={!mayAuthor}
              onChange={setChosenPersonas}
            />
          </Section>

          <Section
            title="What a connection has to be able to do"
            lead="A connection that cannot do one of these skips this test with a reason, rather than failing it."
          >
            <CapabilityChoices
              catalog={catalog?.status === "ready" ? catalog.value.items : []}
              chosen={capabilities}
              disabled={!mayAuthor}
              onChange={setCapabilities}
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
