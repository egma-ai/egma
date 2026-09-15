"use client";

import { CopyIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  getPersona,
  getPersonaCapabilities,
  getPersonaForm,
  type GetPersonaCapabilitiesResponse,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { roleOf } from "@/lib/me.ts";
import {
  backgroundSaid,
  controlsOfPersona,
  interruptionSaid,
  languageLabel,
  modelSaid,
  modelsOfPersona,
  personaClonePath,
  personasPath,
  providerSaid,
  type Persona,
  type PersonaForm,
  type PersonaModels,
} from "@/lib/personas.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { canAuthor } from "@/lib/roles.ts";
import { Failure, Loading, NotFound } from "@/ui/page-state.tsx";
import { useProjectRead } from "@/ui/resource.ts";
import {
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "@/ui/shell.tsx";

import {
  PersonaGroupLabel,
  PersonaReadRows,
  PersonaSubsection,
  PersonaTypePlate,
  type PersonaReadRow,
} from "./persona-parts.tsx";

/**
 * The persona read page, off Paper page 12 — boards 05 and 07 for a cascaded
 * persona, 06 and 08 for a realtime one.
 *
 * Three caps groups, Metadata then Who they are then Settings, with a hairline
 * only between groups; plain subsection headers under Settings with no toggle;
 * and one fact per row, its label in a fixed lane at the left and its value
 * beside it. Nothing here is editable: a persona is changed by cloning it.
 */

/**
 * The voice's name, the way the boards print it.
 *
 * A persona holds the voice id alone, so ask the platform which voices this
 * combination offers and read the name out of that answer. The id stands in
 * while the read is in flight and if it is refused: the page never waits on
 * it, and never shows less than it already knows.
 */
function useVoiceName(
  projectId: string,
  models: PersonaModels,
  language: string,
): string {
  const [capabilities, setCapabilities] =
    useState<GetPersonaCapabilitiesResponse | null>(null);
  const mode = models.mode;
  const voiceId = mode === "live" ? models.live.voiceId : models.tts.voiceId;
  const liveProvider = mode === "live" ? models.live.provider : "";
  const liveModel = mode === "live" ? models.live.model : "";
  const ttsProvider = mode === "separate" ? models.tts.provider : "";
  const ttsModel = mode === "separate" ? models.tts.model : "";
  const sttProvider = mode === "separate" ? models.stt.provider : "";
  const sttModel = mode === "separate" ? models.stt.model : "";

  useEffect(() => {
    let current = true;
    setCapabilities(null);
    void platformAnswer(
      getPersonaCapabilities(
        mode === "live"
          ? { projectId, mode, liveProvider, liveModel, language, voiceId }
          : {
              projectId,
              mode,
              ttsProvider,
              ttsModel,
              sttProvider,
              sttModel,
              language,
              voiceId,
            },
        { client: platformClient },
      ),
    ).then((answer) => {
      if (current && answer.status === "ready") setCapabilities(answer.value);
    });
    return () => {
      current = false;
    };
  }, [
    projectId,
    mode,
    liveProvider,
    liveModel,
    ttsProvider,
    ttsModel,
    sttProvider,
    sttModel,
    language,
    voiceId,
  ]);

  const voices = capabilities?.voices;
  return (
    voices?.choices?.find((voice) => voice.id === voiceId)?.name ??
    voices?.value?.name ??
    voiceId
  );
}

function PersonaRead({
  projectId,
  persona,
  form,
}: {
  readonly projectId: string;
  readonly persona: Persona;
  readonly form?: PersonaForm;
}) {
  const models = modelsOfPersona(persona);
  const controls = controlsOfPersona(persona);
  const voiceName = useVoiceName(projectId, models, controls.language);

  const advanced: PersonaReadRow[] = [
    { label: "Background sound", value: backgroundSaid(controls.backgroundSoundId) },
  ];
  /* The API keeps no interruption level for a realtime persona. */
  if (models.mode === "separate" && "interruptionLevel" in controls) {
    advanced.push({
      label: "Interruptions",
      value: interruptionSaid(controls.interruptionLevel),
    });
  }

  return (
    <div
      className="flex w-full max-w-(--persona-read-width) flex-col gap-4"
      data-slot="persona-read"
    >
      <PersonaGroupLabel surface="read">Metadata</PersonaGroupLabel>
      <PersonaReadRows
        rows={[
          { label: "Name", value: persona.name },
          { label: "Type", value: <PersonaTypePlate owner={persona.owner} /> },
          {
            label: "Description",
            value:
              persona.description === null || persona.description === ""
                ? "No description"
                : persona.description,
          },
        ]}
      />

      <PersonaGroupLabel surface="read" divider>
        Who they are
      </PersonaGroupLabel>
      <PersonaReadRows
        rows={[
          { label: "Identity name", value: persona.identityName },
          { label: "Personality prompt", value: persona.personality },
        ]}
      />

      <PersonaGroupLabel surface="read" divider>
        Settings
      </PersonaGroupLabel>

      <PersonaSubsection label="Language" surface="read">
        <PersonaReadRows
          rows={[{ label: "Language", value: languageLabel(controls.language) }]}
        />
      </PersonaSubsection>

      {models.mode === "separate" ? (
        <>
          <PersonaSubsection label="Text-to-speech" surface="read">
            <PersonaReadRows
              rows={[
                {
                  label: "Provider",
                  value: providerSaid(form?.modelCatalog, "tts", models.tts.provider, models.tts.model),
                },
                {
                  label: "Model",
                  value: modelSaid(form?.modelCatalog, "tts", models.tts.provider, models.tts.model),
                },
                { label: "Voice", value: voiceName },
              ]}
            />
          </PersonaSubsection>
          <PersonaSubsection label="Speech-to-text" surface="read">
            <PersonaReadRows
              rows={[
                {
                  label: "Provider",
                  value: providerSaid(form?.modelCatalog, "stt", models.stt.provider, models.stt.model),
                },
                {
                  label: "Model",
                  value: modelSaid(form?.modelCatalog, "stt", models.stt.provider, models.stt.model),
                },
              ]}
            />
          </PersonaSubsection>
          <PersonaSubsection label="LLM" surface="read">
            <PersonaReadRows
              rows={[
                {
                  label: "Provider",
                  value: providerSaid(form?.modelCatalog, "llm", models.llm.provider, models.llm.model),
                },
                {
                  label: "Model",
                  value: modelSaid(form?.modelCatalog, "llm", models.llm.provider, models.llm.model),
                },
              ]}
            />
          </PersonaSubsection>
        </>
      ) : (
        <PersonaSubsection label="Realtime LLM" surface="read">
          <PersonaReadRows
            rows={[
              {
                label: "Provider",
                value: providerSaid(form?.modelCatalog, "live", models.live.provider, models.live.model),
              },
              {
                label: "Model",
                value: modelSaid(form?.modelCatalog, "live", models.live.provider, models.live.model),
              },
              { label: "Voice", value: voiceName },
              {
                label: "Reasoning LLM",
                value: modelSaid(form?.modelCatalog, "llm", models.llm.provider, models.llm.model),
              },
            ]}
          />
        </PersonaSubsection>
      )}

      <PersonaSubsection label="Advanced" surface="read">
        <PersonaReadRows rows={advanced} />
      </PersonaSubsection>
    </div>
  );
}

export function PersonaReadScreen({
  projectId,
  personaId,
}: {
  readonly projectId: string;
  readonly personaId: string;
}) {
  const { me } = useShellSession();
  const { answer, reload } = useProjectRead<Persona>(
    (project) =>
      platformAnswer(
        getPersona({ projectId: project, personaId }, { client: platformClient }),
      ),
    projectId,
    personaId,
  );
  const { answer: form } = useProjectRead<PersonaForm>(
    (project) =>
      platformAnswer(
        getPersonaForm({ projectId: project }, { client: platformClient }),
      ),
    projectId,
  );

  useEffect(() => {
    if (answer?.status === "signed-out" || form?.status === "signed-out") {
      window.location.replace("/sign-in");
    }
  }, [answer, form]);

  const persona = answer?.status === "ready" ? answer.value : null;
  /* Cloning is how a persona is changed, so the action goes to an author. */
  const mayClone = me !== null && canAuthor(roleOf(me));

  let body: ReactNode;
  if (answer === null || answer.status === "signed-out") {
    body = <Loading what="persona" />;
  } else if (answer.status === "missing") {
    body = <NotFound message={answer.refusal.message} />;
  } else if (answer.status === "failed") {
    body = <Failure message={answer.refusal.message} onRetry={reload} />;
  } else {
    body = (
      <PersonaRead
        projectId={projectId}
        persona={answer.value}
        form={form?.status === "ready" ? form.value : undefined}
      />
    );
  }

  return (
    <ProductPage>
      <PageHeader
        title={persona?.name ?? "Persona"}
        breadcrumbs={[
          { label: "Personas", href: personasPath(projectId) },
          { label: persona?.name ?? "Persona" },
        ]}
        topbarAction={
          persona === null || !mayClone ? undefined : (
            <Button
              asChild
              variant="default"
              size="default"
              className="gap-2 border-transparent"
            >
              <Link href={personaClonePath(projectId, persona.id)}>
                <CopyIcon className="size-4" strokeWidth={1.7} aria-hidden="true" />
                Clone
              </Link>
            </Button>
          )
        }
      />
      <PageBody>{body}</PageBody>
    </ProductPage>
  );
}
