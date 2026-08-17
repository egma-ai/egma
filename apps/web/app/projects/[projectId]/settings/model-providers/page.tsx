"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { deleteJson, writeJson, type Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  credentialFor,
  credentialsIn,
  jobsOfProvider,
  modelProviderCredentialPath,
  providersIn,
  JOB_LABEL,
  MODE_LABEL,
  MODEL_ACCESS_PATH,
  MODEL_CATALOG_PATH,
  MODEL_PROVIDER_CREDENTIALS_PATH,
  type ModelAccess,
  type ModelAccessMode,
  type ModelCatalog,
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

      {mode !== "customer-owned" ? null : catalog === null ? (
        <Section title="Providers">
          <Loading what="the providers Egma supports" />
        </Section>
      ) : catalog.status !== "ready" ? (
        <Section title="Providers">
          {/*
           * The rows below are the catalog's — which providers Egma can execute
           * and what each one's key is for — so none is drawn while that answer
           * is missing. A row rendered here would be a claim about what may be
           * configured, made out of a read that failed.
           */}
          <Failure
            title="Egma could not say which providers it supports."
            message={
              catalog.status === "signed-out"
                ? "Your session has ended. Sign in and try again."
                : catalog.refusal.message
            }
            onRetry={reloadCatalog}
          />
        </Section>
      ) : (
        <Section
          title="Providers"
          lead="One key for each provider your personas and graders select. A provider with no key stops only the simulations that name it."
        >
          {providersIn(catalog.value).map((provider) => (
            <ProviderRow
              key={provider}
              projectId={projectId}
              provider={provider}
              jobs={jobsOfProvider(catalog.value, provider)}
              credential={credentialFor(held, provider)}
              mayAdminister={mayAdminister}
              onChanged={reloadAccess}
            />
          ))}
        </Section>
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

/**
 * One provider's row: what its key is for, whether one is held, and the two
 * things an admin can do about it.
 *
 * **Add and Replace are one form**, because there is one credential per
 * provider: they are the same request with the same effect, and two forms would
 * differ only in which of them refuses when somebody guessed wrong about what
 * is already stored.
 */
function ProviderRow({
  projectId,
  provider,
  jobs,
  credential,
  mayAdminister,
  onChanged,
}: {
  readonly projectId: string;
  readonly provider: string;
  readonly jobs: readonly ("llm" | "stt" | "tts")[];
  readonly credential:
    | { readonly hint: string; readonly revision: string }
    | undefined;
  readonly mayAdminister: boolean;
  readonly onChanged: () => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const fieldId = `model-provider-${provider}`;

  async function store(): Promise<void> {
    if (!mayAdminister || key.trim() === "" || saving) return;
    setRefused(null);
    setSaving(true);

    const written = await writeJson(MODEL_PROVIDER_CREDENTIALS_PATH, {
      method: "PUT",
      project: projectId,
      body: {
        provider,
        key: key.trim(),
        // What this write was composed against, so an admin replacing a key
        // from a page they left open is told the stored one moved rather than
        // silently landing on top of somebody else's rotation.
        ...(credential === undefined
          ? {}
          : { expected_revision: credential.revision }),
      },
    });

    setSaving(false);
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
    onChanged();
  }

  async function remove(): Promise<void> {
    if (!mayAdminister || credential === undefined || removing) return;
    setRefused(null);
    setRemoving(true);

    const written = await deleteJson(modelProviderCredentialPath(provider), {
      project: projectId,
    });

    setRemoving(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return;
    }
    onChanged();
  }

  return (
    <Section
      title={provider}
      lead={`Used for ${jobs.map((job) => JOB_LABEL[job]).join(", ")}.`}
    >
      <Help>
        {credential === undefined ? (
          <>
            <Badge tone="warn">Not configured</Badge> A simulation or a grader
            that selects {provider} stops with an error naming it, and nothing
            else is affected.
          </>
        ) : (
          <>
            <Badge tone="good">Configured</Badge> Ending …{credential.hint}. The
            stored key is never shown; replacing it is typing a new one.
          </>
        )}
      </Help>

      <Form onSubmit={() => void store()}>
        <Field
          label={credential === undefined ? "Key" : "Replacement key"}
          htmlFor={fieldId}
          hint="Egma seals it and calls no provider. A key that has expired or lacks permission is reported when a simulation uses it."
        >
          <TextInput
            id={fieldId}
            value={key}
            type="password"
            disabled={!mayAdminister}
            onChange={setKey}
          />
        </Field>

        {refused === null ? null : (
          <Failure
            title={`Egma did not change the ${provider} key.`}
            message={refused.message}
            onRetry={() => void store()}
          />
        )}

        <FormActions>
          <Button
            weight="strong"
            type="submit"
            disabled={!mayAdminister || key.trim() === "" || saving}
          >
            {saving
              ? "Saving…"
              : credential === undefined
                ? "Add key"
                : "Replace key"}
          </Button>
          {credential === undefined ? null : (
            <Button
              tone="destructive"
              disabled={!mayAdminister || removing}
              onClick={() => void remove()}
            >
              {removing ? "Removing…" : "Remove key"}
            </Button>
          )}
        </FormActions>
      </Form>
    </Section>
  );
}
