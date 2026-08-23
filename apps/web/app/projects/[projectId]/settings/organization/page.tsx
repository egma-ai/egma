"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getOrganization, updateOrganization } from "@egma/platform-api/client";

import type { Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { platformAnswer, platformClient } from "../../../../../lib/platform-client.ts";
import type { OrganizationSettings } from "../../../../../lib/settings.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  Field,
  Form,
  FormActions,
  Help,
  Problem,
  Refused,
} from "../../../../../ui/form.tsx";
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
    () => platformAnswer(getOrganization({ client: platformClient })),
  );
  const settled = answer?.status === "ready" ? answer.value : null;
  const mayAdminister = settled?.mayManageOrganization === true;

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
  /** Said only to somebody the server would refuse, and only once it has said so. */
  const whyNot =
    mayAdminister || role === null
      ? undefined
      : `Your ${role} role cannot change organization settings. Ask an organization admin.`;
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

    const written = await platformAnswer(
      updateOrganization({ name: name.trim() }, { client: platformClient }),
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
            title="Organization"
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
            title="Organization"
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
        title="Organization"
        lead="The customer every project below belongs to."
      />
      <PageBody>
        <SettingsLayout projectId={projectId} current="organization">
          {/* One form, and the title bar has already named the page. */}
          <div className="flex flex-col gap-4">
            {refused === null ? null : <Refused message={refused.message} />}

            <Form onSubmit={() => void save()}>
              {/*
                * The hint is the field's own rather than a paragraph written
                * beside it. `Field` draws the sentence and hands its id to
                * whatever control it wraps through context, so the
                * `aria-describedby` cannot be dropped by an edit here and the
                * space under the input is the 8px every other field in the
                * product gets. The words and the wiring did not move; a second
                * copy of a shared component's job did.
                */}
              <Field
                label="Name"
                htmlFor="organization-name"
                hint="What Egma calls your organization. Changing it breaks no link and no invitation."
              >
                <Input
                  id="organization-name"
                  value={name}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!mayAdminister}
                  aria-invalid={named ? undefined : true}
                  onChange={(event) => {
                    editVersion.current += 1;
                    setName(event.target.value);
                    setSaved(false);
                  }}
                />
              </Field>

              {named ? null : <Problem>An organization needs a name.</Problem>}
              {saved && refused === null ? <Help>Saved.</Help> : null}

              <FormActions>
                <Button
                  type="submit"
                  disabled={!mayAdminister || !named || !changed}
                  busy={saving}
                  {...(whyNot === undefined ? {} : { why: whyNot })}
                >
                  {saving ? "Saving…" : "Save organization"}
                </Button>
              </FormActions>
            </Form>
          </div>
        </SettingsLayout>
      </PageBody>
    </ProductPage>
  );
}
