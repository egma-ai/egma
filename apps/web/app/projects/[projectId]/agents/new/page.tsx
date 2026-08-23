"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { registerAgent } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { platformAnswer, platformClient } from "../../../../../lib/platform-client.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import { Field, Form, FormActions, Problem } from "../../../../../ui/form.tsx";
import { NotFound } from "../../../../../ui/page-state.tsx";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import { AgentOnboardingProgress } from "../onboarding-progress.tsx";

/**
 * Registering an agent: its name in egma, and what it is for.
 *
 * **Two fields, and the shortness is the decision.** Prompt, model and tools
 * live at the provider, where the customer configures them and where egma
 * cannot freeze them. Putting them in this form would make egma a second place
 * to configure an agent, with no rule to say which of the two is right — so
 * what egma owns is the identity that results accumulate against, and that is
 * a name and a sentence about what it does.
 *
 * A way to reach the agent is the next step rather than part of this one. An
 * agent with no connection is a legal, ordinary thing — it is what every agent
 * is for the minute between registering it and wiring it — and asking for a
 * provider key before the agent exists would make the first form in the product
 * the longest one in it.
 */
export default function RegisterAgentPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <RegisterAgent projectId={projectId} />
    </AppShell>
  );
}

function RegisterAgent({ projectId }: { readonly projectId: string }) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  /** What egma said, or what this form worked out before asking egma. */
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);

  useUnsavedChanges(name !== "" && !saving, saving);

  const back = projectPath(projectId, "agents");

  /**
   * A viewer sees the form and cannot submit it, rather than being sent
   * somewhere else. The page they followed a link to is the page they get, and
   * the control that would change data is genuinely disabled — the server
   * refuses their write either way, which is where the boundary actually is.
   *
   * **Nothing is claimed while the role is unknown.** A disabled control would
   * have to say why, and every sentence it could say would be about somebody
   * egma has not identified yet.
   */
  const mayRegister = role !== null && canAuthor(role);

  async function register(): Promise<void> {
    if (!mayRegister || saving) return;

    const wanted = name.trim();
    if (wanted === "") {
      // Checked here so somebody is not made to wait for a round trip to learn
      // a field is empty. The server checks it again, and the server is what
      // decides.
      setNameProblem("An agent needs a name, so that a list can tell it apart.");
      return;
    }

    setNameProblem(null);
    setRefused(null);
    setSaving(true);

    // The named operation keeps the project's query spelling in the generated
    // contract instead of asking this page to build the address itself.
    const answer = await platformAnswer(
      registerAgent(
        {
          projectId,
          name: wanted,
        },
        { client: platformClient },
      ),
    );

    setSaving(false);

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }

    // Never silent. A refusal keeps everything that was typed and says what
    // egma said, so the fix is an edit rather than typing it all again.
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }

    router.push(
      `${projectPath(
        projectId,
        "agents",
        answer.value.agent.id,
        "connections",
        "new",
      )}?onboarding=connection`,
    );
  }

  if (role !== null && !canAuthor(role)) {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Agents"
          title="Register an agent"
          breadcrumbs={[
            { label: "Agents", href: back },
            { label: "New agent" },
          ]}
          lead="Give Egma the agent you want to test."
        />
        <PageBody>
          <NotFound
            message={`Your ${role} role cannot register agents. Ask an organization admin to change your role, then try again.`}
          />
        </PageBody>
      </ProductPage>
    );
  }

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Agents"
        title="Register an agent"
        breadcrumbs={[
          { label: "Agents", href: back },
          { label: "New agent" },
        ]}
        lead="Its name in Egma. Its prompt, model and tools stay where you configure them."
      />
      <PageBody>
        <AgentOnboardingProgress current="agent" />
        <Form onSubmit={() => void register()}>
          <Field label="Name" htmlFor="agent-name">
            <Input
              id="agent-name"
              value={name}
              placeholder="Front desk"
              aria-invalid={nameProblem !== null ? true : undefined}
              aria-describedby={
                nameProblem === null ? undefined : "agent-name-problem"
              }
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setName(event.target.value);
                if (nameProblem !== null) setNameProblem(null);
              }}
            />
            {nameProblem === null ? null : (
              <Problem id="agent-name-problem">{nameProblem}</Problem>
            )}
          </Field>

          {refused === null ? null : <Problem>{refused.message}</Problem>}

          <FormActions>
            <Button type="submit" disabled={saving || !mayRegister}>
              {saving ? "Registering…" : "Register agent"}
            </Button>
            <Button asChild variant="secondary">
              <Link href={back}>Cancel</Link>
            </Button>
          </FormActions>
        </Form>
      </PageBody>
    </ProductPage>
  );
}
