"use client";

import { useId } from "react";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import type { PersonaModels } from "@/lib/personas.ts";

import { PersonaActions } from "./persona-parts.tsx";

/** One model in the pipeline a card names. */
function PipelineStep({ children }: { readonly children: string }) {
  return <span className="bg-surface-soft px-3 py-2 text-base text-foreground">{children}</span>;
}

/** The direction glyph between two steps. It carries no meaning a reader needs. */
function Glyph({ children }: { readonly children: string }) {
  return (
    <span className="text-base text-faint" aria-hidden="true">
      {children}
    </span>
  );
}

const CHOICES = [
  {
    mode: "separate" as const,
    title: "Cascaded pipeline",
    detail: "Choose separate models for listening, reasoning, and speaking.",
  },
  {
    mode: "live" as const,
    title: "Realtime voice",
    detail: "Choose one live model that listens and speaks directly.",
  },
];

/** The first step of creating a persona: choose its agent architecture. */
export function ArchitectureSetup({
  mode,
  onMode,
  onNext,
  onCancel,
}: {
  readonly mode: PersonaModels["mode"];
  readonly onMode: (mode: PersonaModels["mode"]) => void;
  readonly onNext: () => void;
  readonly onCancel: () => void;
}) {
  const named = useId();

  return (
    <div className="flex w-full max-w-(--persona-form-width) flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="m-0 text-base font-medium text-foreground">
          Choose Persona&apos;s Agent Architecture
        </h2>
        <p className="m-0 text-sm text-faint">How should this persona listen and respond?</p>
      </div>
      {/*
       * The card is the whole target: the label wraps the radio, so a press
       * anywhere inside it chooses. The radio is the shared one, named by the
       * card title alone rather than by the description and chips under it.
       */}
      <RadioGroup
        className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1"
        aria-label="Agent architecture"
        value={mode}
        /*
         * Radix reports the chosen value as a `string`; every item below was
         * given one of `CHOICES`, so the narrowing is a fact about this group.
         */
        onValueChange={(chosen) => onMode(chosen as PersonaModels["mode"])}
      >
        {CHOICES.map((choice) => {
          const selected = choice.mode === mode;
          const titleId = `${named}-${choice.mode}`;
          return (
            <label
              key={choice.mode}
              className={cn(
                "relative flex cursor-pointer flex-col gap-4 border-t-2 bg-surface p-6",
                /* The chosen card's two-pixel Ember line, on the edge read first. */
                selected ? "border-brand" : "border-border",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              )}
            >
              <span className="flex items-center justify-between">
                <span className="text-base font-medium text-foreground" id={titleId}>
                  {choice.title}
                </span>
                <RadioGroupItem value={choice.mode} aria-labelledby={titleId} />
              </span>
              <span className="min-h-10 text-base text-faint">{choice.detail}</span>
              <span className="flex items-center gap-3 pt-2">
                {choice.mode === "separate" ? (
                  <>
                    <PipelineStep>STT</PipelineStep>
                    <Glyph>→</Glyph>
                    <PipelineStep>LLM</PipelineStep>
                    <Glyph>→</Glyph>
                    <PipelineStep>TTS</PipelineStep>
                  </>
                ) : (
                  <>
                    <span className="text-base text-faint">Audio</span>
                    <Glyph>↔</Glyph>
                    <PipelineStep>Live model</PipelineStep>
                  </>
                )}
              </span>
            </label>
          );
        })}
      </RadioGroup>
      <PersonaActions label="Next" onPrimary={onNext} onCancel={onCancel} />
    </div>
  );
}
