"use client";

import { useEffect, useRef, useState } from "react";
import { getSimulationRecording } from "@egma/platform-api/client";

import { platformAnswer, platformClient } from "../lib/platform-client.ts";
import { offersNothing } from "../lib/recording-refusals.ts";
import { Notice } from "./ui.tsx";

/**
 * Shared recording playback for simulation results and transcript views.
 * Resolve signed links on demand, retry playback once, and restore position.
 * Call load() on replacement even if the URL is unchanged.
 *
 * Callers provide surface-specific labels and whether a recording is known
 * to exist. The refusal policy distinguishes expected absence from failures.
 */

export type RecordingWords = {
  /** The section's name, for a reader who cannot see it. */
  readonly label: string;
  /** What this audio is and who is on which channel — said beside it, always. */
  readonly caption: string;
  /** For a browser that cannot play the element at all. */
  readonly fallback: string;
  /** When a player that was already on screen stops working. */
  readonly unplayable: string;
  /** When egma itself could not be asked. */
  readonly unreachable: string;
  /**
   * When egma answered, but with neither a link nor a sentence of its own — a
   * proxy's own page, most likely, since every refusal this route writes
   * carries a message and that message is shown instead of this.
   */
  readonly refused: (status: number) => string;
};

/**
 * Keep link-resolution failure separate from playback failure after resolution.
 * The latter must stay visible once the user has a player to operate.
 */
type Playable =
  | { readonly status: "resolving" }
  | { readonly status: "ready"; readonly url: string }
  | {
      readonly status: "unresolved";
      readonly why: string;
      /**
       * egma's own refusal code, or nothing for an answer that was not egma's.
       * `offersNothing` reads it; see `lib/recording-refusals.ts` for why it is
       * the code and never the status.
       */
      readonly code: string | undefined;
    }
  | { readonly status: "unplayable" };

export type RecordingPlayerProps = {
  readonly simulationId: string;
  readonly words: RecordingWords;
  /**
   * When true, a missing link contradicts the caller's recording metadata and
   * should be shown. When false, initial lookup can silently confirm expected
   * absence. Actual faults and failures after successful playback remain visible.
   */
  readonly knownToExist: boolean;
  /**
   * Project context for recording lookup. Both simulation evidence and transcript
   * pages pass their project so a session default cannot select the wrong one.
   */
  readonly project?: string | undefined;
};

/**
 * Resolve short-lived signed URLs when needed instead of storing them in
 * shareable page URLs. The browser fetches audio and seek ranges from storage.
 */
export function RecordingPlayer({
  simulationId,
  words,
  knownToExist,
  project,
}: RecordingPlayerProps) {
  const [playable, setPlayable] = useState<Playable>({ status: "resolving" });
  // Counts how many times the link has been asked for. Bumping it re-runs the
  // effect, which is how a link that went stale is replaced by a fresh one.
  const [asked, setAsked] = useState(0);
  const player = useRef<HTMLAudioElement | null>(null);
  /** Where the listener was, to be put back after a link is replaced. */
  const resumeAt = useRef(0);
  /** Whether this link is already the answer to a failure. See `onError`. */
  const isASecondTry = useRef(false);

  useEffect(() => {
    let stopped = false;

    const resolve = async (): Promise<void> => {
      try {
        const answer = await platformAnswer(
          getSimulationRecording(
            { simulationId, projectId: project },
            { client: platformClient },
          ),
        );
        if (stopped) return;
        if (answer.status !== "ready") {
          // The **code**, which is what egma promises never to change, and the
          // sentence, which it improves. Anything that is not egma answering —
          // a proxy's own page for a path it stopped forwarding, a body that
          // will not parse — carries neither, and is a broken deployment rather
          // than a conversation with no audio.
          return setPlayable({
            status: "unresolved",
            why:
              answer.status === "signed-out"
                ? words.refused(401)
                : answer.refusal.message,
            code:
              answer.status === "signed-out"
                ? undefined
                : answer.refusal.error,
          });
        }
        // `expiresAt` comes back with this and is deliberately not read. It is
        // there for a client that *keeps* a link — the terminal, anything that
        // caches one — and these pages keep none. Branching on it here would
        // mean comparing a server's timestamp to this browser's clock, and a
        // browser a few minutes slow would decide a dead link was still good
        // and never ask again, which is the dead scrubber this whole path
        // exists to prevent. What replaces a link here is a failure, not a
        // clock.
        setPlayable({ status: "ready", url: answer.value.url });
      } catch {
        if (!stopped) {
          setPlayable({
            status: "unresolved",
            why: words.unreachable,
            // Nothing answered at all, so egma said nothing about this
            // conversation. An egma that cannot be reached is a fault.
            code: undefined,
          });
        }
      }
    };

    void resolve();
    return () => {
      stopped = true;
    };
    // `words` is deliberately not a dependency. It is one constant per surface,
    // and depending on an object would make a caller that built it inline
    // re-ask for a link on every render — a fetch loop dressed as correctness.
  }, [simulationId, project, asked]);

  /**
   * Call load() on retries even if src is unchanged: signatures issued in the
   * same second may produce identical URLs. Skip it on initial resolution to
   * avoid a duplicate load.
   */
  useEffect(() => {
    if (playable.status !== "ready" || asked === 0) return;
    player.current?.load();
  }, [playable, asked]);

  if (playable.status === "resolving") {
    // Only where something is known to be coming. On a transcript this line
    // would appear above every simulation's turns for as long as the ask takes,
    // including the ones that recorded nothing, which is a promise of audio
    // being made and then withdrawn.
    return knownToExist ? (
      <p className="my-4 text-sm text-muted-foreground">
        Finding the recording…
      </p>
    ) : null;
  }
  if (playable.status === "unresolved") {
    // The rule itself is in `lib/recording-refusals.ts`, tested there. A retry
    // only ever happens from the element's own `onError`, so `asked > 0` is
    // exactly "a link had already resolved and a player was already on screen".
    const nothing = offersNothing(
      { code: playable.code },
      { knownToExist, afterOneWorked: asked > 0 },
    );
    return nothing ? null : <Said>{playable.why}</Said>;
  }
  if (playable.status === "unplayable") {
    return <Said>{words.unplayable}</Said>;
  }

  return (
    <section className="my-4" aria-label={words.label}>
      {/*
        `preload="metadata"` rather than `none`: the browser fetches enough to
        know how long the recording is, which is what makes the scrubber a
        scrubber rather than a line nobody can aim at. It is also why the link
        lives a quarter of an hour — every seek is a fresh request against it.
      */}
      <audio
        ref={player}
        className="block h-10 w-full max-w-[520px]"
        controls
        preload="metadata"
        src={playable.url}
        data-recording="true"
        // Retry once after a playback error without relying on the browser clock to
        // diagnose expiry. Set the retry flag before requesting; reset it only after
        // a successful load so repeated failures cannot loop.
        onError={() => {
          if (isASecondTry.current) {
            return setPlayable({ status: "unplayable" });
          }
          isASecondTry.current = true;
          // Kept before the source is replaced, because replacing it sends the
          // element back to the beginning — and being thrown to the start of a
          // recording you were four minutes into is its own small betrayal.
          resumeAt.current = player.current?.currentTime ?? 0;
          setAsked((again) => again + 1);
        }}
        // A link that loads is a link that works, so the next expiry — hours
        // later, on a page nobody reloaded — gets its own retry rather than
        // being treated as the second failure of a problem long since over.
        onLoadedMetadata={() => {
          isASecondTry.current = false;
          if (resumeAt.current > 0 && player.current !== null) {
            player.current.currentTime = resumeAt.current;
            resumeAt.current = 0;
          }
        }}
      >
        {words.fallback}
      </audio>
      <p className="mt-2 mb-0 text-sm text-muted-foreground">{words.caption}</p>
    </section>
  );
}

/**
 * Keep refusal spacing consistent with the player section, independent of
 * which facts or grades precede it.
 */
function Said({ children }: { readonly children: string }) {
  return (
    <div className="mt-4">
      <Notice tone="error">{children}</Notice>
    </div>
  );
}
