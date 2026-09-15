"use client";

import { useId } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PersonaModels } from "@/lib/personas.ts";

/** The chip a card's architecture row is built from. */
function Chip({ children }: { readonly children: string }) {
  return <span className="bg-surface-soft px-3 py-2 text-base text-foreground">{children}</span>;
}

/** The direction glyph between two chips. It carries no meaning a reader needs. */
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
       * The card is the whole target: the label wraps the input, so a pointer
       * anywhere inside it chooses. The radio itself stays a real radio and is
       * named by the card title alone, not by the description and chips under it.
       */}
      <fieldset className="m-0 grid grid-cols-2 gap-4 border-0 p-0 max-[900px]:grid-cols-1">
        <legend className="sr-only">Agent architecture</legend>
        {CHOICES.map((choice) => {
          const selected = choice.mode === mode;
          const title = `${named}-${choice.mode}`;
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
                <span className="text-base font-medium text-foreground" id={title}>
                  {choice.title}
                </span>
                <span className="flex flex-none items-center">
                  <input
                    className="sr-only"
                    type="radio"
                    name="persona-mode"
                    value={choice.mode}
                    checked={selected}
                    aria-labelledby={title}
                    onChange={() => onMode(choice.mode)}
                  />
                  {/* The one round shape in the product, drawn beside its own input. */}
                  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                    <circle
                      className={selected ? "stroke-primary" : "stroke-faint"}
                      cx="10"
                      cy="10"
                      r="8"
                      fill="none"
                      strokeWidth={1.5}
                    />
                    {selected ? <circle className="fill-primary" cx="10" cy="10" r="4" /> : null}
                  </svg>
                </span>
              </span>
              <span className="min-h-10 text-base text-faint">{choice.detail}</span>
              <span className="flex items-center gap-3 pt-2">
                {choice.mode === "separate" ? (
                  <>
                    <Chip>STT</Chip>
                    <Glyph>→</Glyph>
                    <Chip>LLM</Chip>
                    <Glyph>→</Glyph>
                    <Chip>TTS</Chip>
                  </>
                ) : (
                  <>
                    <span className="text-base text-faint">Audio</span>
                    <Glyph>↔</Glyph>
                    <Chip>Live model</Chip>
                  </>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="flex justify-end">
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="lg" className="px-3" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="solid" size="lg" className="px-4" onClick={onNext}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
