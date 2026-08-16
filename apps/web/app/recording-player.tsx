"use client";

import { useEffect, useRef, useState } from "react";

import { offersNothing } from "../lib/recording-refusals.ts";
import { Notice, styles } from "./ui.tsx";

/**
 * The audio egma recorded of one voice conversation, wherever somebody is
 * reading about it.
 *
 * **One component and not two, because the awkward parts are not the markup.**
 * Two surfaces want this: a run's results, where somebody found the conversation
 * whose transcript looks wrong, and one transcript, where somebody is already
 * looking at the turn they doubt. What they share is everything that took a bug
 * to learn — fetching a link rather than carrying one, retrying once when a link
 * has gone stale, saying `load()` out loud because a same-second retry mints a
 * byte-identical URL, and putting the listener back where they were. A second
 * copy of that would drift from the fixes, and the fixes are the file.
 *
 * **What the two surfaces do not share is words**, so words are handed in. A
 * run's results name the persona who called, because that page is about a run
 * and names the persona of every conversation on it. A transcript may be a
 * production exchange nobody simulated, so `persona` names nothing there and the
 * page speaks the transcript's own vocabulary — `human` and `agent` — which is
 * held against the banned list in one file. One sentence for two surfaces would
 * have to be wrong on one of them.
 *
 * Every string this can render comes from those words, with exactly one
 * exception: the line saying a link is being fetched, which is behind
 * `knownToExist` and therefore cannot reach a transcript at all. That is what
 * keeps the transcript surface's copy checkable in one file — any word that
 * could appear there belongs in `RecordingWords`, including the ones only a
 * broken deployment would ever show.
 *
 * A refusal egma writes is shown as its own sentence, which is a **wire**
 * sentence rather than page copy — the same way a run's results have shown one
 * since ticket 02, and the reason a client is given a stable code to branch on
 * and a sentence that improves. Which refusals reach a screen at all is decided
 * by `offersNothing`; the one that says `conversation` out loud is the chat
 * refusal, and a chat is an absence, so it is never one of them.
 */

export type RecordingWords = {
  /** The section's name, for a reader who cannot see it. */
  readonly label: string;
  /** What this audio is and who is on which channel — said beside it, always. */
  readonly caption: string;
  /** The band it was measured at, where the conversation reported one. */
  readonly band: (hertz: number) => string;
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
 * What a recording resolves to, or why it did not.
 *
 * There is no "idle": this component is only mounted once somebody could hear
 * something, which is the moment they asked.
 *
 * **The two failures are separate states because they are separate facts.**
 * `unresolved` is egma declining to hand over a link at all. `unplayable` is a
 * link that resolved and a store that then would not serve it twice running:
 * by then a player is on screen, somebody has pressed play, and a control that
 * silently vanished would be worse than the error it was hiding — so that one
 * is always said out loud, on both surfaces.
 */
type Playable =
  | { readonly status: "resolving" }
  | {
      readonly status: "ready";
      readonly url: string;
      readonly band: number | null;
    }
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
   * Whether the surface already knows there is a recording to hear.
   *
   * A run's results do: the run's own answer says which conversations have one,
   * so this is mounted only where there is, and a refusal there contradicts
   * what the same page was just told — worth a sentence, whatever it says.
   *
   * A transcript does not. It holds a trace identifier, which says which
   * simulation this is and nothing about whether that simulation recorded
   * anything — a chat never can, and a voice conversation whose call never
   * connected did not. So asking *is* how it finds out, an answer about this
   * conversation is an answer rather than a fault, and the honest thing to show
   * for one is nothing at all: not a disabled control, not an error, and not
   * even the line saying a recording is being looked for, because each of those
   * implies audio that does not exist.
   *
   * It buys silence for that one case and no other. A fault is still said, and
   * so is a refusal of a link that had already worked — see `hidden` below.
   */
  readonly knownToExist: boolean;
  /**
   * The project this conversation is in, where the surface is inside one.
   *
   * **A run's evidence page names it and a transcript does not**, which is the
   * same split `knownToExist` draws and for the same reason: one surface is a
   * page inside a project and the other is the organization's. The recording
   * route narrows by the acting project, and a session's acting project is the
   * organization's *first* — so a run in any other project asked for its audio,
   * was told there is no such conversation, and showed a page with a transcript
   * on it and no player. The evidence page had loaded perfectly, because its
   * own read does name the project.
   */
  readonly project?: string | undefined;
};

/**
 * **The page fetches its own link rather than carrying one**, and that is what
 * keeps both of these addresses shareable. A link to a recording is signed,
 * short-lived and bound to one object; baking one into a page's own answer
 * would put a credential in the address bar, make the page stale a quarter of an
 * hour after it loaded, and mean that a run of two hundred conversations minted
 * two hundred links to serve the one somebody wanted.
 *
 * The audio itself goes from the store straight to this element and never
 * through egma, which is what makes seeking cost nothing: dragging the scrubber
 * is a byte range the store serves.
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
        const answer = await fetch(
          `/api/simulations/${encodeURIComponent(simulationId)}/recording` +
            (project === undefined
              ? ""
              : `?project=${encodeURIComponent(project)}`),
          { headers: { accept: "application/json" }, cache: "no-store" },
        );
        if (stopped) return;
        if (!answer.ok) {
          // The **code**, which is what egma promises never to change, and the
          // sentence, which it improves. Anything that is not egma answering —
          // a proxy's own page for a path it stopped forwarding, a body that
          // will not parse — carries neither, and is a broken deployment rather
          // than a conversation with no audio.
          const said = (await answer.json().catch(() => ({}))) as {
            error?: string;
            message?: string;
          };
          return setPlayable({
            status: "unresolved",
            why: said.message ?? words.refused(answer.status),
            code: said.error,
          });
        }
        // `expires_at` comes back with this and is deliberately not read. It is
        // there for a client that *keeps* a link — the terminal, anything that
        // caches one — and these pages keep none. Branching on it here would
        // mean comparing a server's timestamp to this browser's clock, and a
        // browser a few minutes slow would decide a dead link was still good
        // and never ask again, which is the dead scrubber this whole path
        // exists to prevent. What replaces a link here is a failure, not a
        // clock.
        const resolved = (await answer.json()) as {
          url: string;
          measured_audio_band_hertz: number | null;
        };
        if (stopped) return;
        setPlayable({
          status: "ready",
          url: resolved.url,
          band: resolved.measured_audio_band_hertz,
        });
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
   * A replacement link is loaded because it is a replacement, not because it
   * happens to read differently.
   *
   * A signature is stamped to the second, so a link asked for again inside the
   * same second as the one it replaces comes back **byte for byte identical** —
   * same instant, same expiry, same signature. React then sets `src` to the
   * string it already holds, the DOM does not change, no request is made, and
   * the recovery below quietly does nothing at all. Which is the whole failure
   * it was written to fix, hiding behind a string comparison.
   *
   * So a retry says `load()` out loud. It is skipped on the first resolve,
   * where the element loads on its own and calling this would fetch twice.
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
      <p className={styles.recordingSearching}>Finding the recording…</p>
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
    return nothing ? null : <Notice tone="error">{playable.why}</Notice>;
  }
  if (playable.status === "unplayable") {
    return <Notice tone="error">{words.unplayable}</Notice>;
  }

  return (
    <section className={styles.recording} aria-label={words.label}>
      {/*
        `preload="metadata"` rather than `none`: the browser fetches enough to
        know how long the recording is, which is what makes the scrubber a
        scrubber rather than a line nobody can aim at. It is also why the link
        lives a quarter of an hour — every seek is a fresh request against it.
      */}
      <audio
        ref={player}
        className={styles.recordingPlayer}
        controls
        preload="metadata"
        src={playable.url}
        data-recording="true"
        // A link lives a quarter of an hour and a page left open for an
        // afternoon outlives it: the next seek comes back refused, and what a
        // person sees is a scrubber that stopped for no stated reason.
        //
        // **One retry, asked for unconditionally, and only the second failure
        // is believed.** The obvious version of this compares the link's expiry
        // to `Date.now()` and refreshes only past it — and that is wrong,
        // because `Date.now()` is the *reader's* clock: a browser a few minutes
        // slow decides a dead link is still good and never asks again, which is
        // exactly the failure this is here to fix, now reachable only by people
        // whose laptops are wrong. A link is cheap and a second one settles it,
        // so nothing here reasons about time at all.
        //
        // It cannot loop: the retry flag is set before asking and cleared only
        // by a load that worked, so a store that is genuinely gone costs two
        // requests and then says so.
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
      <p>
        {words.caption}
        {playable.band === null ? "" : ` ${words.band(playable.band)}`}
      </p>
    </section>
  );
}
