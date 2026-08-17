"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { deleteJson, writeJson, type Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  credentialsIn,
  jobsOfProvider,
  labelOfProvider,
  modelProviderCredentialPath,
  providersIn,
  JOB_LABEL,
  MODE_LABEL,
  MODEL_ACCESS_PATH,
  MODEL_CATALOG_PATH,
  MODEL_PROVIDER_CREDENTIALS_PATH,
  type ModelAccess,
  type ModelCatalog,
  type ModelProviderCredential,
} from "../../../../../lib/model-access.ts";
import {
  Badge,
  Button,
  Field,
  Form,
  FormActions,
  Help,
  Section,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Failure, Loading } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { SettingsLayout } from "../../../../../ui/settings-nav.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";

/**
 * Who supplies the keys this organization's model traffic spends, and — where
 * the organization supplies them — the keys themselves.
 *
 * **No stored key ever reaches this page**, and that is a property of the API
 * rather than a rule this file follows: the read shape has no field a secret
 * could travel in. What a person sees is a provider and four characters —
 * enough to tell two keys apart, and not enough to be one. Replacing a key is
 * typing a new one; it is never reading the old one first, and there is no
 * route that would let them.
 *
 * **One row for each supported provider, and one form under the table.** The
 * table is the list of what is configured; the form belongs to whichever row
 * asked for it, so exactly one labelled secret field is open at a time rather
 * than one per provider sitting open at once. That is the arrangement the
 * organization's judge keys already use, one screen over, for the same reason.
 *
 * **Nothing here is a readiness checklist.** A provider with no key is shown as
 * "Not configured", which is a state and not a fault: an organization mid-setup
 * is the ordinary organization, and a page that refused to let somebody leave
 * until every row was filled would be the blocked feeling this whole area
 * removes. What a missing key actually costs arrives per simulation, named,
 * with a link back to this page.
 *
 * **Saving calls no provider.** A key is sealed and stored; whether it works is
 * reported when it is used, where the report can name the simulation it
 * stopped. Anything else would make saving depend on the provider being up and
 * would still not be true a minute later.
 *
 * **Removing one is confirmed and named.** It is write-only and there is no way
 * to read a stored key back, so a stray click is unrecoverable in the product —
 * and it stops every later simulation and grading job that selects the
 * provider. So it sits behind a dialog that names the provider and says what
 * stops, apart from the save action rather than beside it.
 *
 * Model providers are administration: the credentials are the organization's
 * and the mode commits its account, so only an admin may change either. The
 * page is readable to everybody, because somebody looking at a persona's models
 * has to be able to see who pays for them.
 */
export default function ModelProvidersSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <ModelProviders projectId={projectId} />
    </AppShell>
  );
}

/** One provider's row, as the table draws it. */
type ProviderRow = {
  readonly provider: string;
  readonly label: string;
  readonly jobs: readonly ("llm" | "stt" | "tts")[];
  readonly credential: ModelProviderCredential | undefined;
};

function ModelProviders({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. An unsettled session is neither an
  // admin nor a viewer, and claiming either would be a guess shown as a fact.
  const role = me === null ? null : roleOf(me);
  const mayAdminister = role === "admin";

  const { answer: access, reload: reloadAccess } = useProjectRead<ModelAccess>(
    MODEL_ACCESS_PATH,
    projectId,
  );
  const { answer: catalog, reload: reloadCatalog } =
    useProjectRead<ModelCatalog>(MODEL_CATALOG_PATH, projectId);

  /** The provider whose replacement form is open, by name. */
  const [editing, setEditing] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<ProviderRow | null>(
    null,
  );

  useEffect(() => {
    if (access?.status === "signed-out" || catalog?.status === "signed-out") {
      window.location.replace("/sign-in");
    }
  }, [access, catalog]);

  if (access === null) {
    return (
      <Frame projectId={projectId}>
        <Loading what="this organization's model providers" />
      </Frame>
    );
  }

  if (access.status !== "ready") {
    return (
      <Frame projectId={projectId}>
        <Failure
          message={
            access.status === "signed-out"
              ? "Your session has ended. Sign in and try again."
              : access.refusal.message
          }
          onRetry={reloadAccess}
        />
      </Frame>
    );
  }

  const held = credentialsIn(access.value);
  const mode = access.value.mode;
  const shipped = catalog?.status === "ready" ? catalog.value : undefined;
  const rows: readonly ProviderRow[] = providersIn(shipped).map((provider) => ({
    provider,
    label: labelOfProvider(shipped, provider),
    jobs: jobsOfProvider(shipped, provider),
    credential: held.find((one) => one.provider === provider),
  }));
  const open = rows.find((row) => row.provider === editing);

  /**
   * Opening a different row empties the field and both settled states.
   *
   * One form under the table means one `key`, one `saved` and one `refused` for
   * every row — and each of them means "for the open row" with nothing making
   * it true. A key typed for one provider would otherwise stay in the field and
   * be sent to whichever row is open now, storing a secret against an account
   * nobody chose. Retyping is the price. The judge keys' own form makes exactly
   * this trade, one screen over.
   */
  function openFor(provider: string): void {
    setKey("");
    setSaved(null);
    setRefused(null);
    setEditing(editing === provider ? null : provider);
  }

  async function store(row: ProviderRow): Promise<void> {
    if (!mayAdminister || key.trim() === "" || busy) return;
    setRefused(null);
    setSaved(null);
    setBusy(true);

    const written = await writeJson(MODEL_PROVIDER_CREDENTIALS_PATH, {
      method: "PUT",
      project: projectId,
      body: {
        provider: row.provider,
        key: key.trim(),
        // What this write was composed against, so an admin replacing a key
        // from a page they left open is told the stored one moved rather than
        // silently landing on top of somebody else's rotation.
        ...(row.credential === undefined
          ? {}
          : { expected_revision: row.credential.revision }),
      },
    });

    setBusy(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return;
    }
    // Cleared the moment it lands: what was typed is a secret, and a form that
    // kept it on screen would be the one place in the product that shows one.
    setKey("");
    setEditing(null);
    setSaved(row.label);
    reloadAccess();
  }

  async function remove(row: ProviderRow): Promise<void> {
    if (!mayAdminister || row.credential === undefined || busy) return;
    setRefused(null);
    setSaved(null);
    setBusy(true);

    const written = await deleteJson(
      modelProviderCredentialPath(row.provider),
      { project: projectId },
    );

    setBusy(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return;
    }
    if (editing === row.provider) setEditing(null);
    reloadAccess();
  }

  const columns: readonly Column<ProviderRow>[] = [
    {
      key: "provider",
      header: "Provider",
      primary: true,
      cell: (row) => row.label,
    },
    {
      key: "jobs",
      header: "Used for",
      hideOnMobile: true,
      cell: (row) => row.jobs.map((job) => JOB_LABEL[job]).join(", "),
    },
    {
      key: "state",
      header: "Key",
      width: "180px",
      cell: (row) =>
        row.credential === undefined ? (
          <Badge tone="warn">Not configured</Badge>
        ) : (
          <>
            <Badge tone="good">Configured</Badge>{" "}
            <span>…{row.credential.hint}</span>
          </>
        ),
    },
    {
      key: "replace",
      header: "",
      width: "150px",
      cell: (row) => (
        <Button
          disabled={!mayAdminister || busy}
          ariaExpanded={editing === row.provider}
          onClick={() => openFor(row.provider)}
        >
          {row.credential === undefined ? "Add key" : "Replace key"}
        </Button>
      ),
    },
    {
      key: "remove",
      header: "",
      width: "130px",
      cell: (row) =>
        row.credential === undefined ? null : (
          <Button
            disabled={!mayAdminister || busy}
            onClick={() => setConfirmingRemove(row)}
          >
            Remove key
          </Button>
        ),
    },
  ];

  return (
    <Frame projectId={projectId}>
      <Section
        title="Model access"
        lead="Who supplies the provider keys every persona and grader in this organization spends."
      >
        <Help>
          <Badge tone="neutral">{MODE_LABEL[mode]}</Badge>{" "}
          {mode === "customer-owned"
            ? "This organization uses its own provider accounts. The simulator and the grader call those providers directly, and Egma is not on the path."
            : "This organization uses Egma's provider accounts through the Egma model gateway."}
        </Help>

        {access.value.managed_available ? null : (
          <Help>
            Managed by Egma is not available on this deployment: it sends model
            traffic through the Egma model gateway, and no connection to it has
            been made here. Customer-owned is the only mode that can be chosen.
          </Help>
        )}

        {role === null || mayAdminister ? null : (
          <Help>
            Your {String(role ?? "")} role cannot change model providers. Ask an
            organization admin.
          </Help>
        )}
      </Section>

      {mode !== "customer-owned" ? null : (
        <Section
          title="Providers"
          lead="One key for each provider your personas and graders select. A provider with no key stops only the simulations that name it."
        >
          {catalog === null ? (
            <Loading what="the providers Egma supports" />
          ) : catalog.status !== "ready" ? (
            /*
             * The rows below are the catalog's — which providers Egma can
             * execute and what each one's key is for — so none is drawn while
             * that answer is missing. A row rendered here would be a claim
             * about what may be configured, made out of a read that failed.
             */
            <Failure
              title="Egma could not say which providers it supports."
              message={
                catalog.status === "signed-out"
                  ? "Your session has ended. Sign in and try again."
                  : catalog.refusal.message
              }
              onRetry={reloadCatalog}
            />
          ) : (
            <>
              <DataTable
                label="Model providers"
                columns={columns}
                rows={rows}
                keyOf={(row) => row.provider}
              />

              {/*
               * The replacement form is drawn once, under the table, for
               * whichever row asked for it — never inside a cell. One labelled
               * secret field, tied to the row that opened it, instead of a
               * table cell owning a form whose state outlives that cell.
               */}
              {open === undefined ? null : (
                <Form onSubmit={() => void store(open)}>
                  <Field
                    label={
                      open.credential === undefined
                        ? `Key for ${open.label}`
                        : `Replacement key for ${open.label}`
                    }
                    htmlFor={`model-provider-${open.provider}`}
                    hint="Egma seals it and calls no provider. A key that has expired or lacks permission is reported when a simulation uses it."
                  >
                    <TextInput
                      id={`model-provider-${open.provider}`}
                      value={key}
                      type="password"
                      disabled={!mayAdminister}
                      onChange={setKey}
                    />
                  </Field>

                  {refused === null ? null : (
                    <Failure
                      title={`Egma did not change the ${open.label} key.`}
                      message={refused.message}
                      onRetry={() => void store(open)}
                    />
                  )}

                  <FormActions>
                    <Button
                      weight="strong"
                      type="submit"
                      busy={busy}
                      disabled={!mayAdminister || key.trim() === ""}
                    >
                      {open.credential === undefined ? "Add key" : "Replace key"}
                    </Button>
                    <Button disabled={busy} onClick={() => openFor(open.provider)}>
                      Cancel
                    </Button>
                  </FormActions>
                </Form>
              )}

              {/*
               * The fourth save state, said after the form has closed: a write
               * that landed and left nothing on screen would be
               * indistinguishable from one that never went.
               */}
              {saved === null || refused !== null ? null : (
                <Help>The {saved} key is saved.</Help>
              )}

              {/* A refusal from a row whose form has since closed still has to
                  be readable — a Remove that Egma turned away is the case. */}
              {refused === null || open !== undefined ? null : (
                <Failure
                  title="Egma did not change that key."
                  message={refused.message}
                  onRetry={reloadAccess}
                />
              )}
            </>
          )}
        </Section>
      )}

      {confirmingRemove === null ? null : (
        <Dialog
          title={`Remove the ${confirmingRemove.label} key?`}
          onClose={() => setConfirmingRemove(null)}
        >
          {(dismiss) => (
            <>
              <p>
                Egma will hold no {confirmingRemove.label} key for this
                organization. Every simulation and every grading job that selects{" "}
                {confirmingRemove.label} stops with an error naming it, until
                somebody adds a key again.
              </p>
              <p>
                The stored key cannot be read back, so this cannot be undone from
                here — adding one again means having the key itself.
              </p>
              <Button onClick={dismiss}>Cancel</Button>{" "}
              <Button
                tone="destructive"
                busy={busy}
                onClick={() => {
                  const row = confirmingRemove;
                  setConfirmingRemove(null);
                  void remove(row);
                }}
              >
                Remove key
              </Button>
            </>
          )}
        </Dialog>
      )}
    </Frame>
  );
}

/** The stable frame every state of this page uses, so nothing moves on arrival. */
function Frame({
  projectId,
  children,
}: {
  readonly projectId: string;
  readonly children: React.ReactNode;
}) {
  return (
    <ProductPage>
      <PageHeader
        eyebrow="Settings"
        title="Model providers"
        lead="Who pays for this organization's model traffic, and the keys that authorize it."
      />
      <PageBody>
        <SettingsLayout projectId={projectId} current="model-providers">
          {children}
        </SettingsLayout>
      </PageBody>
    </ProductPage>
  );
}
