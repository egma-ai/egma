"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createPersona, forkPersona, getPersona, getPersonaForm } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import type { Refusal } from "@/lib/api.ts";
import {
  BLANK_BEHAVIOR,
  controlsFrom,
  controlsOfPersona,
  modelsDraftOf,
  modelsFrom,
  modelsOfPersona,
  personaPath,
  personasPath,
  type BehaviorDraft,
  type ModelsDraft,
  type Persona,
  type PersonaForm,
  type PersonaModels,
} from "@/lib/personas.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { roleOf } from "@/lib/me.ts";
import { canAuthor } from "@/lib/roles.ts";
import { useDraftNavigation } from "@/ui/draft-navigation.tsx";
import { Refused } from "@/ui/form.tsx";
import { Failure, Loading, NotFound } from "@/ui/page-state.tsx";
import { useProjectRead } from "@/ui/resource.ts";
import { useUnsavedChanges } from "@/ui/settings-read.ts";
import {
  PageBody,
  PageFooter,
  PageHeader,
  ProductPage,
  useShellSession,
} from "@/ui/shell.tsx";

import { BehaviorFields, ModelFields, NameFields, type FieldPrefix } from "./persona-fields.tsx";
import { ArchitectureSetup } from "./persona-setup.tsx";

export { PersonaReadScreen } from "./persona-read.tsx";

type FlowKind = "create" | "clone";

function fallbackModels(mode: PersonaModels["mode"], form: PersonaForm): PersonaModels {
  if (form.recommendedModels.mode === mode) return form.recommendedModels;
  const llm = form.recommendedModels.llm;
  if (mode === "live") {
    const live = form.modelCatalog.find((entry) => entry.job === "live");
    return {
      mode: "live",
      llm,
      live: {
        provider: "openai",
        model: "gpt-live-1",
        adapter: "openai_live",
        voiceId: live?.recommendedVoiceId ?? "alloy",
      },
    };
  }
  const stt = form.modelCatalog.find((entry) => entry.job === "stt");
  const tts = form.modelCatalog.find((entry) => entry.job === "tts");
  return {
    mode: "separate",
    llm,
    stt: { provider: stt?.provider ?? "openai", model: stt?.model ?? "gpt-4o-mini-transcribe" },
    tts: {
      provider: tts?.provider ?? "openai",
      model: tts?.model ?? "gpt-4o-mini-tts",
      voiceId: tts?.recommendedVoiceId ?? "alloy",
    },
  };
}

function PersonaDraft({
  kind,
  projectId,
  source,
  form,
}: {
  readonly kind: FlowKind;
  readonly projectId: string;
  readonly source?: Persona;
  readonly form: PersonaForm;
}) {
  const navigation = useDraftNavigation();
  const router = useRouter();
  const [name, setName] = useState(source === undefined ? "" : `${source.name} copy`);
  const [description, setDescription] = useState(source?.description ?? "");
  const [behavior, setBehavior] = useState<BehaviorDraft>(source === undefined ? BLANK_BEHAVIOR : {
    identityName: source.identityName,
    personality: source.personality,
  });
  const [models, setModels] = useState<ModelsDraft>(() =>
    source === undefined
      ? modelsDraftOf(form.recommendedModels)
      : modelsDraftOf(modelsOfPersona(source), controlsOfPersona(source)),
  );
  const [capabilitiesValid, setCapabilitiesValid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const changed = kind === "clone" || name !== "" || description !== "" ||
    behavior.identityName !== "" || behavior.personality !== "" ||
    JSON.stringify(models) !== JSON.stringify(modelsDraftOf(form.recommendedModels));
  useUnsavedChanges(changed && !saving, saving);
  const prefix: FieldPrefix = kind === "create" ? "new-persona" : "clone-persona";
  const valid = name.trim() !== "" && behavior.identityName.trim() !== "" && behavior.personality.trim() !== "" && capabilitiesValid;

  async function submit(): Promise<void> {
    if (!valid || saving) return;
    setSaving(true);
    setRefusal(null);
    const body = {
      projectId,
      name: name.trim(),
      ...(kind === "clone" || description.trim() !== ""
        ? { description: description.trim() }
        : {}),
      identityName: behavior.identityName.trim(),
      personality: behavior.personality.trim(),
      models: modelsFrom(models),
      controls: controlsFrom(models),
    };
    const answer = await platformAnswer(
      kind === "create"
        ? createPersona(body, { client: platformClient })
        : forkPersona({ personaId: source!.id, ...body }, { client: platformClient }),
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefusal(answer.refusal);
      return;
    }
    router.replace(personaPath(projectId, answer.value.id));
  }

  return (
    <>
      <PageBody>
        <div className="min-h-0 flex-1 overflow-y-auto pb-8">
          <form
            className="flex w-full max-w-(--persona-form-width) flex-col gap-4"
            onSubmit={(event) => { event.preventDefault(); void submit(); }}
          >
            {refusal === null ? null : <Refused message={refusal.message} />}
            <NameFields prefix={prefix} name={name} description={description} disabled={saving} onName={setName} onDescription={setDescription} />
            <BehaviorFields prefix={prefix} draft={behavior} disabled={saving} onChange={setBehavior} />
            <ModelFields
              prefix={prefix}
              draft={models}
              form={form}
              disabled={saving}
              projectId={projectId}
              onChange={setModels}
              onValidityChange={setCapabilitiesValid}
            />
            <button className="sr-only" type="submit" disabled={!valid || saving}>Submit persona</button>
          </form>
        </div>
      </PageBody>
      <PageFooter>
        {/* Both flows end in the same act, so both boards print "Create persona". */}
        <div className="flex w-full max-w-(--persona-form-width) justify-end gap-2">
          <Button type="button" variant="ghost" size="lg" className="px-3" disabled={saving} onClick={() => navigation.push(personasPath(projectId))}>Cancel</Button>
          <Button type="button" variant="solid" size="lg" className="px-4" busy={saving} disabled={!valid} onClick={() => void submit()}>
            {saving ? "Creating…" : "Create persona"}
          </Button>
        </div>
      </PageFooter>
    </>
  );
}

export function PersonaCreateScreen({ projectId }: { readonly projectId: string }) {
  const { me, settled } = useShellSession();
  const navigation = useDraftNavigation();
  const role = me === null ? null : roleOf(me);
  const [mode, setMode] = useState<PersonaModels["mode"]>("separate");
  const [chosen, setChosen] = useState(false);
  const { answer, reload } = useProjectRead<PersonaForm>(
    (project) => platformAnswer(getPersonaForm({ projectId: project }, { client: platformClient })),
    projectId,
  );
  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);
  /* One name for the whole flow: the architecture step and the form are one page. */
  const title = "New persona";
  let content: ReactNode;
  if (!settled || role === null) {
    content = <Loading what="your account" />;
  } else if (!canAuthor(role)) {
    content = <Failure title="You cannot author personas." message={`Your ${role} role cannot create personas.`} />;
  } else if (answer === null || answer.status === "signed-out") {
    content = <Loading what="persona choices" />;
  } else if (answer.status === "missing") {
    content = <NotFound message={answer.refusal.message} />;
  } else if (answer.status === "failed") {
    content = <Failure message={answer.refusal.message} onRetry={reload} />;
  } else if (!chosen) {
    content = <ArchitectureSetup mode={mode} onMode={setMode} onNext={() => setChosen(true)} onCancel={() => navigation.push(personasPath(projectId))} />;
  } else {
    const selected = fallbackModels(mode, answer.value);
    content = <PersonaDraft key={mode} kind="create" projectId={projectId} form={{ ...answer.value, recommendedModels: selected }} />;
  }
  return (
    <ProductPage viewport={chosen} desktopViewport={!chosen}>
      <PageHeader title={title} breadcrumbs={[{ label: "Personas", href: personasPath(projectId) }, { label: title }]} />
      {chosen && answer?.status === "ready" ? content : <PageBody>{content}</PageBody>}
    </ProductPage>
  );
}

export function PersonaCloneScreen({ projectId, personaId }: { readonly projectId: string; readonly personaId: string }) {
  const { me, settled } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const { answer: persona, reload: reloadPersona } = useProjectRead<Persona>(
    (project) => platformAnswer(getPersona({ projectId: project, personaId }, { client: platformClient })),
    projectId,
    personaId,
  );
  const { answer: form, reload: reloadForm } = useProjectRead<PersonaForm>(
    (project) => platformAnswer(getPersonaForm({ projectId: project }, { client: platformClient })),
    projectId,
  );
  useEffect(() => {
    if (persona?.status === "signed-out" || form?.status === "signed-out") {
      window.location.replace("/sign-in");
    }
  }, [persona, form]);
  let content: ReactNode;
  if (!settled || role === null) {
    content = <PageBody><Loading what="your account" /></PageBody>;
  } else if (!canAuthor(role)) {
    content = <PageBody><Failure title="You cannot author personas." message={`Your ${role} role cannot clone personas.`} /></PageBody>;
  } else if (persona === null || form === null || persona.status === "signed-out" || form.status === "signed-out") {
    content = <PageBody><Loading what="persona" /></PageBody>;
  } else if (persona.status === "missing") {
    content = <PageBody><NotFound message={persona.refusal.message} /></PageBody>;
  } else if (persona.status === "failed") {
    content = <PageBody><Failure message={persona.refusal.message} onRetry={reloadPersona} /></PageBody>;
  } else if (form.status !== "ready") {
    content = <PageBody><Failure message={form.refusal.message} onRetry={reloadForm} /></PageBody>;
  } else {
    content = <PersonaDraft kind="clone" projectId={projectId} source={persona.value} form={form.value} />;
  }
  return (
    <ProductPage viewport>
      <PageHeader title="Clone persona" breadcrumbs={[{ label: "Personas", href: personasPath(projectId) }, { label: "Clone persona" }]} />
      {content}
    </ProductPage>
  );
}
