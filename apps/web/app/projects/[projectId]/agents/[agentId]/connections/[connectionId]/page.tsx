"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { readJson, writeJson, type Refusal } from "../../../../../../../lib/api.ts";
import {
  connectionActionPath,
  connectionPath,
  NO_ENVIRONMENT,
  type ListedConnection,
} from "../../../../../../../lib/agents.ts";
import {
  CAPABILITIES_PATH,
  capabilityLabel,
  CONNECTION_TYPES_PATH,
  typeNamed,
  variantNamed,
  type CapabilityCatalog,
  type ConnectionTypeCatalog,
  type ConnectionVariant,
} from "../../../../../../../lib/connection-types.ts";
import { asDay } from "../../../../../../../lib/instants.ts";
import { roleOf } from "../../../../../../../lib/me.ts";
import { projectPath } from "../../../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../../../lib/roles.ts";
import {
  Actions,
  Badge,
  Button,
  ButtonLink,
  Choice,
  Fact,
  Facts,
  Field,
  Help,
  Problem,
  Section,
  TextInput,
} from "../../../../../../../ui/controls.tsx";
import { Dialog } from "../../../../../../../ui/dialog.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../../../ui/resource.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../../../ui/shell.tsx";
import { ConnectionFields, type Draft } from "../fields.tsx";

/**
 * One way egma can reach an agent: what it points at, what it is allowed to
 * prove, and what its target turned out to be able to do.
 *
 * **The credential is never on this page and never comes back from the
 * server.** What a read answers is whether one is stored and a hint of which
 * one it is — enough to tell two provider keys apart and to see that a rotation
 * landed, and never enough to be one. Replacing it is a whole new credential
 * rather than an edit to the old one, because editing would mean reading the
 * stored plaintext back out, and the one door to that opens for egma's own
 * simulator.
 *
 * **Unknown capabilities are said as unknown.** A target nobody has measured
 * and a target measured and found bare lead somewhere different — one is a
 * Refresh away from an answer, the other is a settled fact — and a test that
 * requires a capability is skipped for two different reasons with two different
 * fixes.
 */
export default function ConnectionDetailPage() {
  const { projectId, agentId, connectionId } = useParams<{
    projectId: string;
    agentId: string;
    connectionId: string;
  }>();
  return (
    <AppShell>
      <ConnectionDetail
        projectId={projectId}
        agentId={agentId}
        connectionId={connectionId}
      />
    </AppShell>
  );
}

type Answered = { readonly connection: ListedConnection };

function ConnectionDetail({
  projectId,
  agentId,
  connectionId,
}: {
  readonly projectId: string;
  readonly agentId: string;
  readonly connectionId: string;
}) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);

  const { answer, reload } = useProjectRead<Answered>(
    connectionPath(agentId, connectionId),
    projectId,
  );

  const [types, setTypes] = useState<ConnectionTypeCatalog | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityCatalog | null>(null);
  /**
   * Why the connection types could not be described, until somebody asks again.
   *
   * **The catalog is not decoration on this page, it is what the page can do.**
   * The shape it names decides which fields an edit shows, which credential a
   * Restore must ask for, and what the credential rule even is — so a read that
   * failed and said nothing left Edit and Restore looking available and opening
   * nothing at all, and Rotate disabled with no reason given. Silence is the
   * worst of the three states this can be in.
   */
  const [typesRefused, setTypesRefused] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [acted, setActed] = useState<Refusal | null>(null);
  const [dialog, setDialog] = useState<"edit" | "rotate" | "archive" | "restore" | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    setTypesRefused(null);

    void readJson<ConnectionTypeCatalog>(CONNECTION_TYPES_PATH).then((one) => {
      if (!current) return;
      if (one.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (one.status !== "ready") {
        setTypesRefused(one.refusal);
        return;
      }
      setTypes(one.value);
    });

    /**
     * The capability catalog is the one read on this page that may fail
     * quietly, and only because its whole job is to turn a stored key into a
     * nicer word. Without it `capabilityLabel` answers the key itself, which is
     * still true and still readable — so a failure costs a label, not a fact,
     * and stopping the page for it would be worse than carrying on.
     */
    void readJson<CapabilityCatalog>(CAPABILITIES_PATH).then((one) => {
      if (current && one.status === "ready") setCapabilities(one.value);
    });

    return () => {
      current = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const agentHome = projectPath(projectId, "agents", agentId);
  const header = (title: string) => (
    <PageHeader eyebrow="Connection" title={title} />
  );

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        {header("Connection")}
        <PageBody>
          <Loading what="this connection" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage>
        {header("Connection")}
        <PageBody>
          <NotFound
            message={answer.refusal.message}
            action={<ButtonLink href={agentHome}>Back to the agent</ButtonLink>}
          />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed") {
    return (
      <ProductPage>
        {header("Connection")}
        <PageBody>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </PageBody>
      </ProductPage>
    );
  }

  const one = answer.value.connection;
  const described = typeNamed(types, one.type);
  const variant = variantNamed(types, one.type, one.variant_id);
  const mayAuthor = role !== null && canAuthor(role);
  const whyNot =
    role === null
      ? undefined
      : `Your ${role} role cannot change connections. Ask an organization admin to change your role.`;

  /**
   * Whether this page knows the shape this connection is in.
   *
   * Edit and Restore are drawn from it — which fields to ask for, and which
   * credential a Restore must demand — so without it neither can be opened.
   * They stay on the page and become genuinely disabled with a reason, which is
   * the house rule: a control that is present and inert is a dead end, and one
   * that silently does nothing when pressed is worse.
   */
  const shapeKnown = variant !== undefined;
  const whyNoShape =
    typesRefused === null
      ? "Egma is still describing this connection's type."
      : "Egma could not describe this connection's type, so its fields and its credential rule are unknown.";

  /** One post, with the busy state, the refusal and the reload all handled once. */
  async function act(what: string, path: string, body: unknown): Promise<void> {
    if (busy !== null) return;
    setActed(null);
    setBusy(what);

    const done = await writeJson<unknown>(path, {
      method: "POST",
      project: projectId,
      body,
    });

    setBusy(null);

    if (done.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    // Never silent, whatever failed. A refresh that could not measure anything
    // says so and leaves the state exactly as it was.
    if (done.status !== "ready") {
      setActed(done.refusal);
      return;
    }
    setDialog(null);
    reload();
  }

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Connection"
        title={one.name}
        lead={`${described?.label ?? one.type} · ${one.modality} · ${one.environment ?? NO_ENVIRONMENT}`}
        action={
          role === null ? undefined : (
            <Actions>
              <Button
                disabled={!mayAuthor || one.archived || !shapeKnown}
                why={shapeKnown ? whyNot : whyNoShape}
                onClick={() => setDialog("edit")}
              >
                Edit
              </Button>
              {one.archived ? (
                <Button
                  weight="strong"
                  disabled={!mayAuthor || !shapeKnown}
                  why={shapeKnown ? whyNot : whyNoShape}
                  onClick={() => setDialog("restore")}
                >
                  Restore
                </Button>
              ) : (
                // Archive needs no shape: it stops the connection being used
                // and asks nothing about what it is made of.
                <Button
                  disabled={!mayAuthor}
                  why={whyNot}
                  onClick={() => setDialog("archive")}
                >
                  Archive
                </Button>
              )}
            </Actions>
          )
        }
      />

      <PageBody>
        {one.archived ? (
          <Empty
            title="This connection is archived"
            lead="Egma will not claim new work over it, and the simulator can no longer resolve its credential. Restoring it asks for whatever its shape's credential rule requires."
          />
        ) : null}

        {role !== null && !mayAuthor ? <Problem>{whyNot}</Problem> : null}
        {acted === null ? null : <Problem>{acted.message}</Problem>}

        {typesRefused === null ? null : (
          <Failure
            title="Egma could not describe this connection's type."
            message={typesRefused.message}
            onRetry={() => setAttempt((one) => one + 1)}
          />
        )}

        <Facts label="What this connection is">
          <Fact name="Identifier" mono>
            {one.id}
          </Fact>
          <Fact name="Type" mono>
            {one.type}
          </Fact>
          <Fact name="Shape" mono>
            {variant?.label ?? one.variant_id}
          </Fact>
          <Fact name="Topology" mono>
            {one.topology}
          </Fact>
          <Fact name="State">
            {one.archived ? <Badge tone="warn">Archived</Badge> : <Badge>Active</Badge>}
          </Fact>
          <Fact name="Added" mono>
            {asDay(one.created_at)}
          </Fact>
        </Facts>

        <Section title="Where it points">
          <Facts label="Connection configuration">
            {Object.entries(one.config).map(([key, value]) => (
              <Fact key={key} name={key} mono>
                {value}
              </Fact>
            ))}
          </Facts>
          {Object.keys(one.config).length === 0 ? (
            <Help>This shape holds no configuration of its own.</Help>
          ) : null}
        </Section>

        <Section
          title="Credential"
          lead="Egma seals what you give it and never answers with it again."
          action={
            role === null ? undefined : (
              <Button
                disabled={
                  !mayAuthor ||
                  one.archived ||
                  !shapeKnown ||
                  variant.credential_rule === "forbidden"
                }
                why={
                  shapeKnown
                    ? variant.credential_rule === "forbidden"
                      ? "This connection takes no customer credential."
                      : whyNot
                    : whyNoShape
                }
                onClick={() => setDialog("rotate")}
              >
                Rotate credential
              </Button>
            )
          }
        >
          <Facts label="Credential state">
            <Fact name="Stored">
              {one.credential_present ? (
                <Badge tone="good">Present</Badge>
              ) : (
                <Badge>None</Badge>
              )}
            </Fact>
            <Fact name="Hint" mono>
              {one.credentials_hint ?? "—"}
            </Fact>
            <Fact name="Rule" mono>
              {variant?.credential_rule ?? "—"}
            </Fact>
          </Facts>
          {variant === undefined ? null : <Help>{variant.credential_help}</Help>}
        </Section>

        <Section
          title="Capabilities"
          lead="What this target was measured to support. A test that needs something the target has not got is skipped with a reason, never failed."
          action={
            role === null ? undefined : (
              <Button
                disabled={
                  !mayAuthor ||
                  one.archived ||
                  described?.capability_discovery !== true ||
                  busy !== null
                }
                why={
                  described?.capability_discovery === true
                    ? whyNot
                    : `Egma ships no capability adapter for a ${described?.label ?? one.type} connection, so there is nothing to ask.`
                }
                onClick={() =>
                  void act(
                    "refresh",
                    connectionActionPath(agentId, connectionId, "capabilities/refresh"),
                    {},
                  )
                }
              >
                {busy === "refresh" ? "Checking…" : "Refresh capabilities"}
              </Button>
            )
          }
        >
          {one.capabilities.state === "known" ? (
            <>
              <Facts label="Measured capabilities">
                <Fact name="Checked" mono>
                  {asDay(one.capabilities.checked_at ?? "")}
                </Fact>
                <Fact name="Measured by" mono>
                  {one.capabilities.source ?? "—"}
                </Fact>
              </Facts>
              {(one.capabilities.supported ?? []).length === 0 ? (
                <Help>
                  This target was checked and supports none of the capabilities
                  in egma&rsquo;s catalog.
                </Help>
              ) : (
                <Actions>
                  {(one.capabilities.supported ?? []).map((key) => (
                    <Badge key={key} tone="good">
                      {capabilityLabel(capabilities, key)}
                    </Badge>
                  ))}
                </Actions>
              )}
            </>
          ) : (
            <Empty
              title="Nobody has measured this target"
              lead="Unknown is not the same as unsupported. Until something measures it, a test that requires a capability is skipped because egma cannot tell, rather than because the target cannot."
            />
          )}
        </Section>
      </PageBody>

      {dialog === "edit" && variant !== undefined ? (
        <EditConnection
          projectId={projectId}
          agentId={agentId}
          connection={one}
          variant={variant}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}

      {dialog === "rotate" && variant !== undefined ? (
        <RotateCredential
          projectId={projectId}
          agentId={agentId}
          connection={one}
          variant={variant}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}

      {dialog === "archive" ? (
        <Dialog title="Archive this connection?" onClose={() => setDialog(null)}>
          <p>
            Egma stops claiming work over it. Queued simulations are canceled
            and conversations already happening are asked to stop; whatever they
            produced stays on the record. The simulator can no longer resolve
            its credential.
          </p>
          {acted === null ? null : <Problem>{acted.message}</Problem>}
          <Actions>
            <Button
              weight="strong"
              disabled={busy !== null}
              onClick={() =>
                void act(
                  "archive",
                  connectionActionPath(agentId, connectionId, "archive"),
                  { expected_revision: one.revision },
                )
              }
            >
              {busy === "archive" ? "Archiving…" : "Archive connection"}
            </Button>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
          </Actions>
        </Dialog>
      ) : null}

      {dialog === "restore" && variant !== undefined ? (
        <RestoreConnection
          projectId={projectId}
          agentId={agentId}
          connection={one}
          variant={variant}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}
    </ProductPage>
  );
}

/**
 * The parts of a connection that can change: its name, its label, and where it
 * points.
 *
 * Type, modality and shape are absent because they are what a connection *is*.
 * Changing one of them would attribute yesterday's chat results to something
 * that is now a phone number, so it is a new connection rather than an edit.
 *
 * **A config change makes the capability record unknown**, and the form says so
 * before the save rather than leaving somebody to notice the badge changed.
 */
function EditConnection({
  projectId,
  agentId,
  connection,
  variant,
  onClose,
  onSaved,
}: {
  readonly projectId: string;
  readonly agentId: string;
  readonly connection: ListedConnection;
  readonly variant: ConnectionVariant;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [name, setName] = useState(connection.name);
  const [environment, setEnvironment] = useState(connection.environment ?? "");
  const [draft, setDraft] = useState<Draft>({
    config: { ...connection.config },
    credentials: {},
  });
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  const configMoved = variant.fields.some(
    (field) =>
      (draft.config[field.key]?.trim() ?? "") !==
      (connection.config[field.key] ?? ""),
  );

  async function save(): Promise<void> {
    if (saving) return;
    setRefused(null);
    setSaving(true);

    const config: Record<string, string> = {};
    for (const field of variant.fields) {
      const written = draft.config[field.key]?.trim() ?? "";
      if (written !== "") config[field.key] = written;
    }

    const answer = await writeJson<Answered>(
      connectionPath(agentId, connection.id),
      {
        method: "PATCH",
        project: projectId,
        body: {
          name: name.trim(),
          environment: environment.trim() === "" ? null : environment.trim(),
          ...(configMoved ? { config } : {}),
          expected_revision: connection.revision,
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
    onSaved();
  }

  return (
    <Dialog title="Edit connection" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Name" htmlFor="edit-connection-name">
          <TextInput id="edit-connection-name" value={name} onChange={setName} />
        </Field>
        <Field label="Environment" htmlFor="edit-connection-environment">
          <TextInput
            id="edit-connection-environment"
            value={environment}
            placeholder="staging, production — a label, and optional"
            onChange={setEnvironment}
          />
        </Field>

        <ConnectionFields
          variant={variant}
          draft={draft}
          onChange={setDraft}
          credentialsEditable={false}
        />

        {configMoved ? (
          <Help>
            Changing where this connection points makes its capabilities
            unknown. A measurement of the old target is not evidence about the
            new one.
          </Help>
        ) : null}

        {refused === null ? null : <Problem>{refused.message}</Problem>}

        <Actions>
          <Button type="submit" weight="strong" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </Actions>
      </form>
    </Dialog>
  );
}

/**
 * Replacing a credential whole.
 *
 * There is no merge and there is no "leave this field as it was", because both
 * would mean reading the stored secret back out. Every field of the new
 * credential is typed, and what egma answers afterwards is the new hint.
 */
function RotateCredential({
  projectId,
  agentId,
  connection,
  variant,
  onClose,
  onSaved,
}: {
  readonly projectId: string;
  readonly agentId: string;
  readonly connection: ListedConnection;
  readonly variant: ConnectionVariant;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({ config: {}, credentials: {} });
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  async function rotate(): Promise<void> {
    if (saving) return;
    setRefused(null);
    setSaving(true);

    const credentials: Record<string, string> = {};
    for (const field of variant.credential_fields) {
      credentials[field.field] = draft.credentials[field.field]?.trim() ?? "";
    }

    const answer = await writeJson<Answered>(
      connectionPath(agentId, connection.id),
      {
        method: "PATCH",
        project: projectId,
        body: { credentials, expected_revision: connection.revision },
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
    onSaved();
  }

  return (
    <Dialog title="Rotate credential" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void rotate();
        }}
      >
        <Help>{variant.credential_help}</Help>
        <ConnectionFields
          variant={{ ...variant, fields: [] }}
          draft={draft}
          onChange={setDraft}
          credentialsEditable
        />
        {refused === null ? null : <Problem>{refused.message}</Problem>}
        <Actions>
          <Button type="submit" weight="strong" disabled={saving}>
            {saving ? "Rotating…" : "Replace credential"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </Actions>
      </form>
    </Dialog>
  );
}

/**
 * Bringing a connection back, on the terms its own shape sets.
 *
 * **The archived credential is never what comes back.** A shape that requires
 * one asks for a new one; a shape that forbids one asks for nothing; a shape
 * where it is optional makes the choice explicit, because leaving the fields
 * empty cannot be told from meaning to drop it and the sealed envelope is
 * sitting right there for the wrong reading to reuse.
 */
function RestoreConnection({
  projectId,
  agentId,
  connection,
  variant,
  onClose,
  onSaved,
}: {
  readonly projectId: string;
  readonly agentId: string;
  readonly connection: ListedConnection;
  readonly variant: ConnectionVariant;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [name, setName] = useState(connection.name);
  const [choice, setChoice] = useState<"replace" | "clear">(
    variant.credential_rule === "required" ? "replace" : "clear",
  );
  const [draft, setDraft] = useState<Draft>({ config: {}, credentials: {} });
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  const rule = variant.credential_rule;
  const replacing = rule === "required" || (rule === "optional" && choice === "replace");

  async function restore(): Promise<void> {
    if (saving) return;
    setRefused(null);
    setSaving(true);

    const credentials: Record<string, string> = {};
    for (const field of variant.credential_fields) {
      credentials[field.field] = draft.credentials[field.field]?.trim() ?? "";
    }

    const answer = await writeJson<Answered>(
      connectionActionPath(agentId, connection.id, "restore"),
      {
        method: "POST",
        project: projectId,
        body: {
          expected_revision: connection.revision,
          ...(name.trim() === connection.name ? {} : { name: name.trim() }),
          ...(rule === "forbidden"
            ? {}
            : {
                credential: replacing
                  ? { choice: "replace", credentials }
                  : { choice: "clear" },
              }),
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
    onSaved();
  }

  return (
    <Dialog title="Restore this connection?" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void restore();
        }}
      >
        <p>
          Restoring needs the parent agent to be active. Egma never brings back
          the credential this connection was archived with.
        </p>

        <Field label="Name" htmlFor="restore-connection-name">
          <TextInput
            id="restore-connection-name"
            value={name}
            onChange={setName}
          />
        </Field>

        {rule === "forbidden" ? (
          <Help>{variant.credential_help}</Help>
        ) : (
          <>
            {rule === "optional" ? (
              <Choice
                label="Credential"
                value={choice}
                options={[
                  { value: "replace", label: "Enter a new credential" },
                  { value: "clear", label: "Store no credential" },
                ]}
                onChange={setChoice}
              />
            ) : null}
            {replacing ? (
              <ConnectionFields
                variant={{ ...variant, fields: [] }}
                draft={draft}
                onChange={setDraft}
                credentialsEditable
              />
            ) : (
              <Help>
                The stored credential is removed. Nothing sealed before can
                become live again.
              </Help>
            )}
          </>
        )}

        {refused === null ? null : <Problem>{refused.message}</Problem>}

        <Actions>
          <Button type="submit" weight="strong" disabled={saving}>
            {saving ? "Restoring…" : "Restore connection"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </Actions>
      </form>
    </Dialog>
  );
}
