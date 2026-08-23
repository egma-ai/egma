"use client";

import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { getPersonaUsage, listPersonas } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { Refusal } from "../../../../lib/api.ts";
import {
  ownerSaid,
  type Persona,
  type PersonaUsage,
} from "../../../../lib/personas.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { Dialog } from "../../../../ui/dialog.tsx";
import { Field, Refused } from "../../../../ui/form.tsx";

/**
 * Archiving one persona, and the two questions it can raise (`BEM-0`,
 * `BMT-0`).
 *
 * **The replacement is part of the Archive, not a step after it.** A project
 * always has a default persona — a test authored naming nobody is given it —
 * so archiving the one a project points at without saying who replaces them
 * would break the commonest create there is, later, for somebody who did
 * nothing wrong. The server writes both in one transaction; this is where the
 * question gets asked.
 *
 * **The tests that name them are read before the confirmation is offered.**
 * The write refuses a persona an active test still names, and it refuses by
 * naming test *ids* — which is the right answer for an API and a useless one
 * for a person deciding. So the names are read here and said in the sentence
 * that disables the button. The server's refusal is still the authority and is
 * still rendered exactly as it arrives: this only moves the news earlier.
 *
 * For a persona that is neither the default nor in use, the panel is a plain
 * confirmation that says what archiving does and what it does not.
 */
export function ArchiveDialog({
  persona,
  projectId,
  busy,
  refusal,
  onClose,
  onArchive,
}: {
  readonly persona: Persona;
  readonly projectId: string;
  readonly busy: boolean;
  readonly refusal: Refusal | null;
  readonly onClose: () => void;
  readonly onArchive: (replacement: string | undefined) => void;
}) {
  const [others, setOthers] = useState<readonly Persona[] | null>(null);
  const [chosen, setChosen] = useState("");
  /**
   * Why the replacements could not be read, until somebody asks again.
   *
   * **A read that fails silently here takes the default persona out of the
   * product.** The choice never arrives, the control stays disabled, nothing
   * says why, and the one persona a project cannot do without becomes the one
   * persona nobody can archive. So the failure is said out loud, asking again
   * is a deliberate act, and an expired session goes where every expired
   * session in this application goes.
   */
  const [unread, setUnread] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** Which tests name them: `null` until the read answers or gives up. */
  const [usage, setUsage] = useState<PersonaUsage | "unknown" | null>(null);

  useEffect(() => {
    if (!persona.isDefault) return undefined;
    let current = true;
    setUnread(null);

    void platformAnswer(
      listPersonas({ projectId }, { client: platformClient }),
    ).then((answer) => {
      if (!current) return;

      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (answer.status !== "ready") {
        setUnread(answer.refusal);
        return;
      }

      const rest = answer.value.personas.filter((one) => one.id !== persona.id);
      setOthers(rest);
      setChosen(rest[0]?.id ?? "");
    });

    return () => {
      current = false;
    };
  }, [persona.id, persona.isDefault, projectId, attempt]);

  useEffect(() => {
    let current = true;
    setUsage(null);

    void platformAnswer(
      getPersonaUsage(
        { personaId: persona.id, projectId },
        { client: platformClient },
      ),
    ).then((answer) => {
      if (!current) return;
      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      /*
       * A usage read that fails does **not** take Archive out of the product.
       * The server refuses a persona an active test names, whatever a browser
       * did or did not manage to read first, so an unknown answer hands the
       * decision back to the one place that is authoritative about it.
       */
      setUsage(answer.status === "ready" ? answer.value : "unknown");
    });

    return () => {
      current = false;
    };
  }, [persona.id, projectId]);

  const inUse =
    usage !== null && usage !== "unknown" && usage.tests.length > 0
      ? usage.tests
      : null;

  const nobodyToTakeIt =
    persona.isDefault && others !== null && others.length === 0;
  /** Nothing may be archived until a default has somebody to hand the pointer to. */
  const cannotChoose =
    persona.isDefault &&
    (unread !== null || others === null || nobodyToTakeIt);

  return (
    <Dialog title={`Archive ${persona.name}?`} onClose={onClose}>
      {(dismiss) => (
        <>
          {/*
           * The hairline the boards draw under a confirmation's title
           * (`BJZ-0`). It is here rather than on the shared `DialogHeader`
           * because a route ticket does not restyle a shared component; the
           * wish is recorded on the ticket instead.
           */}
          <Separator />

          <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
            They leave the list your team authors from. Every version stays
            where it is, and every run that used one stays readable. Restore is
            one click away in the archived list.
          </p>

          {persona.isDefault ? (
            <Field
              label="Replacement default persona"
              htmlFor="persona-replacement"
              hint="This project points at them, so a test naming nobody is given them. Somebody has to take that."
            >
              {unread !== null ? (
                <Refused
                  message={unread.message}
                  action={
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setAttempt((one) => one + 1)}
                    >
                      Try again
                    </Button>
                  }
                />
              ) : others === null ? (
                <p className="m-0 text-sm text-faint">
                  Reading this project&apos;s personas…
                </p>
              ) : nobodyToTakeIt ? (
                <p className="m-0 text-sm text-faint">
                  There is no other active persona in this project to take it.
                  Create one first.
                </p>
              ) : (
                <Select
                  id="persona-replacement"
                  value={chosen}
                  onChange={(event) => setChosen(event.target.value)}
                >
                  {others.map((one) => (
                    <option key={one.id} value={one.id}>
                      {one.name} · {ownerSaid(one.owner)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}

          {usage === null ? (
            <p className="m-0 text-sm text-faint">
              Reading which tests name them…
            </p>
          ) : inUse !== null ? (
            <p className="m-0 flex items-start gap-2 text-sm text-warning">
              <TriangleAlertIcon
                aria-hidden="true"
                className="mt-0.5 size-3.5 flex-none"
                strokeWidth={1.5}
              />
              <span>
                {inUse.length === 1
                  ? "1 active test names them"
                  : `${String(inUse.length)} active tests name them`}
                : {inUse.map((test) => test.name).join(", ")}. Select another
                persona on those tests first. Until then, Archive is refused.
              </span>
            </p>
          ) : usage === "unknown" ? null : (
            <p className="m-0 flex items-start gap-2 text-sm text-success">
              <CheckIcon
                aria-hidden="true"
                className="mt-0.5 size-3.5 flex-none"
                strokeWidth={1.75}
              />
              <span>No active test names them. Nothing else changes.</span>
            </p>
          )}

          {refusal === null ? null : <Refused message={refusal.message} />}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="lg"
              variant="destructive"
              busy={busy}
              disabled={
                busy ||
                cannotChoose ||
                usage === null ||
                inUse !== null ||
                (persona.isDefault && chosen === "")
              }
              {...(cannotChoose
                ? {
                    why: "Egma has not been able to read this project's personas, so there is nobody to hand the default pointer to yet.",
                  }
                : {})}
              onClick={() => onArchive(persona.isDefault ? chosen : undefined)}
            >
              {busy ? "Archiving…" : "Archive persona"}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="secondary"
              disabled={busy}
              onClick={dismiss}
            >
              Cancel
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
