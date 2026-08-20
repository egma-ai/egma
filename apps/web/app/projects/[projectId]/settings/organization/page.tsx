"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  ORGANIZATION_PATH,
  type OrganizationSettings,
} from "../../../../../lib/settings.ts";
import {
  Button,
  Field,
  Form,
  FormActions,
  Help,
  Problem,
  Refused,
  Section,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { Failure, Loading } from "../../../../../ui/page-state.tsx";
import {
  SettingsLayout,
  settingsPath,
} from "../../../../../ui/settings-nav.tsx";
import {
  useOrganizationRead,
  useUnsavedChanges,
} from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";

/** Organization-wide details. Model choices and credentials do not live here. */
export default function OrganizationSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <OrganizationSettingsBody projectId={projectId} />
    </AppShell>
  );
}

function OrganizationSettingsBody({ projectId }: { readonly projectId: string }) {
  const { me, refresh: refreshSession } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const { answer, reload } = useOrganizationRead<OrganizationSettings>(
    ORGANIZATION_PATH,
  );
  const settled = answer?.status === "ready" ? answer.value : null;
  const mayAdminister = settled?.may_manage_organization === true;

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const editVersion = useRef(0);
  const confirmingSave = useRef<number | null>(null);
  const [confirmingRead, setConfirmingRead] = useState(false);

  useEffect(() => {
    if (settled === null) return;

    const confirming = confirmingSave.current;
    confirmingSave.current = null;
    setConfirmingRead(false);
    if (confirming !== null && editVersion.current !== confirming) return;
    setName(settled.name);
  }, [settled]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const named = name.trim() !== "";
  const changed = settled !== null && name.trim() !== settled.name;
  const confirming = confirmingSave.current;
  const changedWhileConfirming =
    confirmingRead &&
    confirming !== null &&
    editVersion.current !== confirming;
  useUnsavedChanges((changed || changedWhileConfirming) && !saving, saving);

  async function save(): Promise<void> {
    if (!mayAdminister || !named || !changed || saving) return;
    const submittedEditVersion = editVersion.current;
    setRefused(null);
    setSaved(false);
    setSaving(true);

    const written = await writeJson<OrganizationSettings>(ORGANIZATION_PATH, {
      method: "PATCH",
      body: { name: name.trim() },
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
    confirmingSave.current = submittedEditVersion;
    setConfirmingRead(true);
    setSaved(editVersion.current === submittedEditVersion);
    refreshSession();
    reload();
  }

  if (answer === null) {
    return (
      <ProductPage viewport>
        <PageHeader
          eyebrow="Settings"
          title="Organization"
          breadcrumbs={[
            { label: "Settings", href: settingsPath(projectId) },
            { label: "Organization" },
          ]}
        />
        <PageBody>
          <SettingsLayout projectId={projectId} current="organization">
            <Loading what="this organization" />
          </SettingsLayout>
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status !== "ready") {
    return (
      <ProductPage viewport>
        <PageHeader
          eyebrow="Settings"
          title="Organization"
          breadcrumbs={[
            { label: "Settings", href: settingsPath(projectId) },
            { label: "Organization" },
          ]}
        />
        <PageBody>
          <SettingsLayout projectId={projectId} current="organization">
            <Failure
              message={
                answer.status === "signed-out"
                  ? "Your session has ended. Sign in and try again."
                  : answer.refusal.message
              }
              onRetry={reload}
            />
          </SettingsLayout>
        </PageBody>
      </ProductPage>
    );
  }

  return (
    <ProductPage viewport>
      <PageHeader
        eyebrow="Settings"
        title="Organization"
        breadcrumbs={[
          { label: "Settings", href: settingsPath(projectId) },
          { label: "Organization" },
        ]}
        lead="The customer every project below belongs to."
      />
      <PageBody>
        <SettingsLayout projectId={projectId} current="organization">
          <Section title="Details">
            {refused === null ? null : <Refused message={refused.message} />}

            <Form onSubmit={() => void save()}>
              <Field
                label="Name"
                htmlFor="organization-name"
                hint="What Egma calls your organization. Changing it breaks no link and no invitation."
              >
                <TextInput
                  id="organization-name"
                  value={name}
                  disabled={!mayAdminister}
                  invalid={!named}
                  onChange={(next) => {
                    editVersion.current += 1;
                    setName(next);
                    setSaved(false);
                  }}
                />
              </Field>

              {named ? null : <Problem>An organization needs a name.</Problem>}
              {saved && refused === null ? <Help>Saved.</Help> : null}

              <FormActions>
                <Button
                  weight="strong"
                  type="submit"
                  disabled={!mayAdminister || !named || !changed || saving}
                  why={
                    mayAdminister || role === null
                      ? undefined
                      : `Your ${role} role cannot change organization settings. Ask an organization admin.`
                  }
                >
                  {saving ? "Saving…" : "Save organization"}
                </Button>
              </FormActions>
            </Form>
          </Section>
        </SettingsLayout>
      </PageBody>
    </ProductPage>
  );
}
