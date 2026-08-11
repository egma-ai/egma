"use client";

import { useEffect, useRef, useState } from "react";

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
 */

export type RecordingWords = {
  /** The section's name, for a reader who cannot see it. */
  readonly label: string;
  /** What this audio is and who is on which channel — said beside it, always. */
  readonly caption: string;
  /** The band it was measured at, where the conversation reported one. */
  readonly band: (hertz: number) => string;
  /** When a player that was already on screen stops working. */
  readonly unplayable: string;
};

/**
 * What a recording resolves to, or why it did not.
 *
 * There is no "idle": this component is only mounted once somebody could hear
 * something, which is the moment they asked.
 *
 * **The two failures are separate states because they are separate facts.**
 * `unresolved` is egma declining to hand over a link — which on a transcript is
 * an ordinary answer meaning there is nothing to hear, and shows nothing at
 * all. `unplayable` is a link that resolved and a store that then would not
 * serve it twice running: by then a player is already on screen, somebody has
 * pressed play, and a control that silently vanished would be worse than the
 * error it was hiding. So that one is always said out loud, on both surfaces.
 */
type Playable =
  | { readonly status: "resolving" }
  | {
      readonly status: "ready";
      readonly url: string;
      readonly band: number | null;
    }
  | { readonly status: "unresolved"; readonly why: string }
  | { readonly status: "unplayable" };

export type RecordingPlayerProps = {
  readonly simulationId: string;
  readonly words: RecordingWords;
  /**
   * Whether the surface already knows there is a recording to hear.
   *
   * A run's results do: the run's own answer says which conversations have one,
   * so this is mounted only where there is, and a link that will not resolve is
   * a genuine fault worth a sentence.
   *
   * A transcript does not. It holds a trace identifier, which says which
   * simulation this is and nothing about whether that simulation recorded
   * anything — a chat never can, and a voice conversation whose call never
   * connected did not. So asking *is* how it finds out, every refusal is an
   * answer rather than a fault, and the honest thing to show for one is
   * nothing at all: not a disabled control, not an error, and not even the line
   * saying a recording is being looked for, because each of those implies audio
   * that does not exist.
   */
  readonly knownToExist: boolean;
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
          `/api/simulations/${encodeURIComponent(simulationId)}/recording`,
          { headers: { accept: "application/json" }, cache: "no-store" },
        );
        if (stopped) return;
        if (!answer.ok) {
          const said = (await answer.json().catch(() => ({}))) as {
            message?: string;
          };
          return setPlayable({
            status: "unresolved",
            why:
              said.message ??
              `Egma answered ${String(answer.status)} for this recording.`,
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
            why: "Egma could not be reached for this recording.",
          });
        }
      }
    };

    void resolve();
    return () => {
      stopped = true;
    };
  }, [simulationId, asked]);

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
    return knownToExist ? (
      <p className={styles.runTally}>Finding the recording…</p>
    ) : null;
  }
  if (playable.status === "unresolved") {
    return knownToExist ? <Notice tone="error">{playable.why}</Notice> : null;
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
        Your browser cannot play audio.
      </audio>
      <p>
        {words.caption}
        {playable.band === null ? "" : ` ${words.band(playable.band)}`}
      </p>
    </section>
  );
}
