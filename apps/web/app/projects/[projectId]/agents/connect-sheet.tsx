"use client";

import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Loading, NotFound } from "@/ui/page-state.tsx";

import { CopyBlock } from "./copy-block.tsx";

type ConnectAgentSheetProps = {
  readonly mayAuthor: boolean;
  readonly role: string | null;
  readonly onClose: () => void;
};

function sharedHandoff(platformUrl: string): string {
  return (
  `Use ${platformUrl} as the Egma platform URL. ` +
  "Start by running `egma` if available or `npx --yes @egma/cli` otherwise. " +
  "Follow the coding-agent handoff. Use existing credentials. " +
  "Ask the developer only for browser authorization, a missing credential, " +
  "a choice that cannot be safely inferred, an unsafe conflict, or approval " +
  "before a real phone run that may cost money."
  );
}

export function agentSetupPrompts(platformUrl: string) {
  const handoff = sharedHandoff(platformUrl);
  return [
    {
      id: "simulation",
      title: "Simulation",
      value:
        "Set up Egma simulation testing for this repository's voice agent end to end. " +
        handoff,
    },
    {
      id: "monitoring",
      title: "Monitoring",
      value:
        "Set up Egma production monitoring for this repository's voice agent end to end. " +
        handoff,
    },
    {
      id: "both",
      title: "Both",
      value:
        "Set up Egma simulation testing and production monitoring for this " +
        "repository's voice agent end to end. " +
        handoff,
    },
  ] as const;
}

/**
 * Hand setup to the coding agent that already owns the repository.
 *
 * Old links can still select this sheet, but their query values do not narrow
 * the handoff: all three outcomes stay visible. The prompt carries this
 * platform address, and the coding agent discovers the repository, provider,
 * and existing credential state; this sheet performs no platform operation.
 */
export function ConnectAgentSheet({
  mayAuthor,
  role,
  onClose,
}: ConnectAgentSheetProps) {
  const [platformUrl, setPlatformUrl] = useState<string | null>(null);

  useEffect(() => setPlatformUrl(window.location.origin), []);

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent aria-describedby="connect-agent-description">
        <SheetHeader>
          <SheetTitle>Connect an agent</SheetTitle>
          <SheetDescription id="connect-agent-description">
            Copy one prompt into the coding agent that is working in your
            repository.
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          {role === null || platformUrl === null ? (
            <Loading what="what you can do here" />
          ) : !mayAuthor ? (
            <NotFound
              message={
                "Your " +
                role +
                " role cannot connect agents. Ask an organization admin to change your role, then try again."
              }
            />
          ) : (
            <div className="flex flex-col gap-5">
              <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
                Choose the outcome you want. The coding agent will inspect the
                repository and follow the complete setup.
              </p>

              <div className="flex flex-col gap-4">
                {agentSetupPrompts(platformUrl).map((prompt) => (
                  <section
                    className="flex flex-col gap-3 border border-border p-4"
                    aria-labelledby={`connect-prompt-${prompt.id}`}
                    key={prompt.id}
                  >
                    <h3
                      className="m-0 text-base font-medium text-foreground"
                      id={`connect-prompt-${prompt.id}`}
                    >
                      {prompt.title}
                    </h3>
                    <CopyBlock
                      value={prompt.value}
                      copyLabel={`${prompt.id} prompt`}
                    />
                  </section>
                ))}
              </div>
            </div>
          )}
        </SheetBody>

        <SheetFooter className="border-t border-border pt-5">
          <Button type="button" size="lg" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
