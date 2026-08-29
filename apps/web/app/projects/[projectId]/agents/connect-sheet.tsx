"use client";

import { Button } from "@/components/ui/button";
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

export type ConnectAgentGoal = "simulation" | "monitoring" | "both";
export type ConnectAgentPlatform = "retell" | "livekit";

type ConnectAgentSheetProps = {
  readonly mayAuthor: boolean;
  readonly role: string | null;
  readonly onClose: () => void;
};

const SHARED_HANDOFF =
  "Start by running `egma` if available or `npx --yes @egma/cli` otherwise. " +
  "Follow the coding-agent handoff. Use existing credentials. " +
  "Ask the developer only for browser authorization, a missing credential, " +
  "a choice that cannot be safely inferred, an unsafe conflict, or approval " +
  "before a real phone run that may cost money.";

export const SIMULATION_AGENT_PROMPT =
  "Set up Egma simulation testing for this repository's voice agent end to end. " +
  SHARED_HANDOFF;

export const MONITORING_AGENT_PROMPT =
  "Set up Egma production monitoring for this repository's voice agent end to end. " +
  SHARED_HANDOFF;

export const BOTH_AGENT_PROMPT =
  "Set up Egma simulation testing and production monitoring for this " +
  "repository's voice agent end to end. " +
  SHARED_HANDOFF;

const PROMPTS = [
  {
    id: "simulation",
    title: "Simulation",
    value: SIMULATION_AGENT_PROMPT,
  },
  {
    id: "monitoring",
    title: "Monitoring",
    value: MONITORING_AGENT_PROMPT,
  },
  {
    id: "both",
    title: "Both",
    value: BOTH_AGENT_PROMPT,
  },
] as const;

/**
 * Hand setup to the coding agent that already owns the repository.
 *
 * Old links can still select this sheet, but their query values do not narrow
 * the handoff: all three outcomes stay visible, and the coding agent discovers
 * the platform and existing credentials from the repository; this sheet
 * performs no platform operation itself.
 */
export function ConnectAgentSheet({
  mayAuthor,
  role,
  onClose,
}: ConnectAgentSheetProps) {
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
          {role === null ? (
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
                {PROMPTS.map((prompt) => (
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
