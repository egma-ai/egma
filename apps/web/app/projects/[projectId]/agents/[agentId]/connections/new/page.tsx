"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { readJson, writeJson, type Refusal } from "../../../../../../../lib/api.ts";
import {
  connectionsPath,
  type ListedConnection,
} from "../../../../../../../lib/agents.ts";
import {
  CONNECTION_TYPES_PATH,
  typeNamed,
  type ConnectionTypeCatalog,
  type ConnectionVariant,
} from "../../../../../../../lib/connection-types.ts";
import { roleOf } from "../../../../../../../lib/me.ts";
import { projectPath } from "../../../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../../../lib/roles.ts";
import {
  Actions,
  Button,
  ButtonLink,
  Field,
  Problem,
  Select,
  TextInput,
} from "../../../../../../../ui/controls.tsx";
import { Failure, Loading, NotFound } from "../../../../../../../ui/page-state.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../../../ui/shell.tsx";
import { ConnectionFields, type Draft } from "../fields.tsx";

/**
 * Adding a way for egma to reach an agent.
 *
 * **Every field on this form comes from the server.** Which config keys a shape
 * holds, which modalities the type speaks, and whether a credential is
 * required, forbidden or optional are the connection registry's to decide; a
 * second handwritten copy in this application would be a second opinion able to
 * disagree with the gate, and the disagreement would show up as a form that
 * asks for the wrong things and a create that then refuses for a reason the
 * form cannot explain.
 *
 * The type and the shape are chosen once and are then fixed for the life of the
 * connection. Changing either is a new connection rather than an edit, because
 * the two shapes of a type hold different config keys and different credentials
 * — and because the credential rule a Restore is held to is read from the shape
 * the row stores.
 */
export default function NewConnectionPage() {
  const { projectId, agentId } = useParams<{
    projectId: string;
    agentId: string;
  }>();
  return (
    <AppShell>
      <NewConnection projectId={projectId} agentId={agentId} />
    </AppShell>
  );
}

function NewConnection({
  projectId,
  agentId,
}: {
  readonly projectId: string;
  readonly agentId: string;
}) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);

  const [catalog, setCatalog] = useState<ConnectionTypeCatalog | null>(null);
  const [catalogRefused, setCatalogRefused] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [type, setType] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [modality, setModality] = useState<string>("");
  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState("");
  const [draft, setDraft] = useState<Draft>({ config: {}, credentials: {} });

  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  const back = projectPath(projectId, "agents", agentId);

  useEffect(() => {
    let current = true;
    setCatalog(null);
    setCatalogRefused(null);

    void readJson<ConnectionTypeCatalog>(CONNECTION_TYPES_PATH).then((answer) => {
      if (!current) return;
      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      // A catalog that did not arrive is a form that cannot be drawn. It says
      // so and offers a retry rather than showing an empty type list, which
      // would read as egma supporting nothing.
      if (answer.status !== "ready") {
        setCatalogRefused(answer.refusal);
        return;
      }
      setCatalog(answer.value);
      const first = answer.value.items[0];
      if (first !== undefined) {
        setType(first.type);
        setVariantId(first.variants[0]?.id ?? null);
        setModality(first.modalities[0] ?? "");
      }
    });

    return () => {
      current = false;
    };
  }, [attempt]);

  const described = typeNamed(catalog, type ?? "");
  const variant: ConnectionVariant | undefined = described?.variants.find(
    (one) => one.id === variantId,
  );

  const mayAuthor = role !== null && canAuthor(role);

  function chooseType(next: string): void {
    setType(next);
    const chosen = typeNamed(catalog, next);
    setVariantId(chosen?.variants[0]?.id ?? null);
    setModality(chosen?.modalities[0] ?? "");
    // The keys belong to the shape, so nothing typed under the old one is
    // carried into a form that has no place for it.
    setDraft({ config: {}, credentials: {} });
  }

  function chooseVariant(next: string): void {
    setVariantId(next);
    setDraft({ config: {}, credentials: {} });
  }

  async function add(): Promise<void> {
    if (!mayAuthor || saving || type === null || variant === undefined) return;

    setRefused(null);
    setSaving(true);

    /**
     * Only what was filled in is sent. An empty box means the key was left
     * out, which for an optional key is itself the setting — sending it as an
     * empty string would make egma refuse a value nobody typed.
     */
    const config: Record<string, string> = {};
    for (const field of variant.fields) {
      const written = draft.config[field.key]?.trim() ?? "";
      if (written !== "") config[field.key] = written;
    }

    const credentials: Record<string, string> = {};
    for (const field of variant.credential_fields) {
      const written = draft.credentials[field.field]?.trim() ?? "";
      if (written !== "") credentials[field.field] = written;
    }
    const sending =
      variant.credential_rule === "forbidden" ||
      Object.keys(credentials).length === 0;

    const answer = await writeJson<{ readonly connection: ListedConnection }>(
      connectionsPath(agentId),
      {
        method: "POST",
        project: projectId,
        body: {
          ...(name.trim() === "" ? {} : { name: name.trim() }),
          type,
          modality,
          ...(environment.trim() === ""
            ? {}
            : { environment: environment.trim() }),
          config,
          ...(sending ? {} : { credentials }),
        },
      },
    );

    setSaving(false);

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }

    router.push(
      projectPath(
        projectId,
        "agents",
        agentId,
        "connections",
        answer.value.connection.id,
      ),
    );
  }

  const header = (
    <PageHeader
      eyebrow="Connection"
      title="Add a connection"
      lead="How egma reaches this agent. An agent can have several: a laptop today, a hosted assistant in staging, a phone number in production."
    />
  );

  if (role !== null && !mayAuthor) {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <NotFound
            message={`Your ${role} role cannot add connections. Ask an organization admin to change your role, then try again.`}
            action={<ButtonLink href={back}>Back to the agent</ButtonLink>}
          />
        </PageBody>
      </ProductPage>
    );
  }

  if (catalogRefused !== null) {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <Failure
            title="Egma could not describe the connection types."
            message={catalogRefused.message}
            onRetry={() => setAttempt((one) => one + 1)}
          />
        </PageBody>
      </ProductPage>
    );
  }

  if (catalog === null || described === undefined || variant === undefined) {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <Loading what="the connection types" />
        </PageBody>
      </ProductPage>
    );
  }

  return (
    <ProductPage>
      {header}
      <PageBody>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Field label="Type" htmlFor="connection-type">
            <Select
              id="connection-type"
              value={described.type}
              options={catalog.items.map((one) => ({
                value: one.type,
                label: one.label,
              }))}
              onChange={chooseType}
            />
          </Field>

          {described.variants.length > 1 ? (
            <Field label="Shape" htmlFor="connection-variant">
              <Select
                id="connection-variant"
                value={variant.id}
                options={described.variants.map((one) => ({
                  value: one.id,
                  label: one.label,
                }))}
                onChange={chooseVariant}
              />
            </Field>
          ) : null}

          <Field label="Modality" htmlFor="connection-modality">
            <Select
              id="connection-modality"
              value={modality}
              options={described.modalities.map((one) => ({
                value: one,
                label: one,
              }))}
              onChange={setModality}
            />
          </Field>

          <Field label="Name" htmlFor="connection-name">
            <TextInput
              id="connection-name"
              value={name}
              placeholder="Left empty, egma names it after the type"
              onChange={setName}
            />
          </Field>

          <Field label="Environment" htmlFor="connection-environment">
            <TextInput
              id="connection-environment"
              value={environment}
              placeholder="staging, production — a label, and optional"
              onChange={setEnvironment}
            />
          </Field>

          <ConnectionFields
            variant={variant}
            draft={draft}
            onChange={setDraft}
            credentialsEditable
          />

          {described.simulator_adapter ? null : (
            <Problem>
              Egma has no simulator adapter for a {described.label} connection
              yet, so a run cannot be conducted over it. You can still record it.
            </Problem>
          )}

          {refused === null ? null : <Problem>{refused.message}</Problem>}

          <Actions>
            <Button type="submit" weight="strong" disabled={saving}>
              {saving ? "Adding…" : "Add connection"}
            </Button>
            <ButtonLink href={back}>Cancel</ButtonLink>
          </Actions>
        </form>
      </PageBody>
    </ProductPage>
  );
}
