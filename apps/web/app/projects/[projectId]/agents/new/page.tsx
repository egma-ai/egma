"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import { AGENTS_PATH, type ListedAgent } from "../../../../../lib/agents.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  Actions,
  Button,
  ButtonLink,
  Field,
  Problem,
  TextArea,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { NotFound } from "../../../../../ui/page-state.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";

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
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  /** What egma said, or what this form worked out before asking egma. */
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);

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

    /**
     * **The project is in the body, because that is where this door reads
     * it.**
     *
     * `POST /api/agents` takes the project as a body key — the same shape the
     * CLI posts a registration in — while every other write in the agents
     * group reads it from the query. Naming it in the query here was
     * *accepted*: the door found no project named, fell back to the session's
     * own, and that is the organization's **first** project. So registering an
     * agent from any project but the first one wrote it into the first one,
     * answered 201, and sent the browser to a detail page for an agent that is
     * not in the project the address names. Nothing could catch it below this
     * line — the request is well formed and the answer is a real agent.
     */
    const answer = await writeJson<{ readonly agent: ListedAgent }>(
      AGENTS_PATH,
      {
        method: "POST",
        body: {
          project: projectId,
          name: wanted,
          ...(description.trim() === ""
            ? {}
            : { description: description.trim() }),
        },
      },
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

    router.push(projectPath(projectId, "agents", answer.value.agent.id));
  }

  if (role !== null && !canAuthor(role)) {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Agents"
          title="Register an agent"
          lead="Give egma the agent you want to test."
        />
        <PageBody>
          <NotFound
            message={`Your ${role} role cannot register agents. Ask an organization admin to change your role, then try again.`}
            action={<ButtonLink href={back}>Back to agents</ButtonLink>}
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
        lead="Its name and description in egma. Its prompt, model and tools stay where you configure them."
      />
      <PageBody>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void register();
          }}
        >
          <Field label="Name" htmlFor="agent-name">
            <TextInput
              id="agent-name"
              value={name}
              placeholder="Front desk"
              invalid={nameProblem !== null}
              describedBy={nameProblem === null ? undefined : "agent-name-problem"}
              onChange={(next) => {
                setName(next);
                if (nameProblem !== null) setNameProblem(null);
              }}
            />
            {nameProblem === null ? null : (
              <Problem id="agent-name-problem">{nameProblem}</Problem>
            )}
          </Field>

          <Field label="Description" htmlFor="agent-description">
            <TextArea
              id="agent-description"
              value={description}
              rows={3}
              placeholder="What this agent is for, so a teammate opening the list knows."
              onChange={setDescription}
            />
          </Field>

          {refused === null ? null : <Problem>{refused.message}</Problem>}

          <Actions>
            <Button type="submit" weight="strong" disabled={saving || !mayRegister}>
              {saving ? "Registering…" : "Register agent"}
            </Button>
            <ButtonLink href={back}>Cancel</ButtonLink>
          </Actions>
        </form>
      </PageBody>
    </ProductPage>
  );
}
