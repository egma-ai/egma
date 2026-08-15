/**
 * The wizard's login step: the same flow the headless verb runs, on a screen.
 *
 * Everything the developer sees is pushed at the UI; everything they type is
 * read back from it between polls. The step itself owns no drawing and no
 * keystroke, which is what lets it be one step in the walk and one command at
 * the same time.
 *
 * A new account signs up in the browser page this step opens, and comes back
 * signed in. What egma provisions for them there is egma's business and is
 * never named here — the terminal's job is a code, an address, and a key.
 */

import { openInBrowser } from "../platform/browser.ts";
import type { VerifiedPlatformAccess as ResolvedPlatform } from "../platform/credentials.ts";
import { logIn, type LogInOptions } from "../platform/login.ts";
import type { WizardUI } from "../ui/wizard-ui.ts";
import type { ExitReport } from "./exit-line.ts";
import { stopReport } from "./stop.ts";

/** How the wizard reaches egma, and where the key it gets is kept. */
export type PlatformAccess = ResolvedPlatform & {
  /** Starts a browser. The developer's own opener when omitted. */
  readonly openBrowser?: LogInOptions["openBrowser"];
};

/**
 * Which egma the walk uses, in the two parts the wizard needs it in.
 *
 * The address is here from the start, because the wizard's first screen names
 * it. Who is answering there is asked for by `verify`, which the walk calls
 * once — after the keystroke of consent and never before. That ordering is the
 * whole point of the split: a developer reads which egma their repository is
 * about to talk to before egma has said one word to it.
 */
export type WalkPlatform = {
  readonly url: string;
  /**
   * True when this address came out of `egma/config.yaml` rather than a flag.
   *
   * It decides one sentence on the first screen and nothing else: a bound
   * repository is refused a different `--url`, so the wizard must not offer one
   * there. It is passed in rather than read here, because which egma this is
   * has one answer and one place that works it out.
   */
  readonly bound: boolean;
  verify(): Promise<PlatformAccess>;
};

/**
 * A platform whoever is calling has already asked.
 *
 * Every check that stands its own platform up knows the answer before the walk
 * starts, and so does anything else that resolved a platform for its own
 * reasons. They hand it over through here rather than each writing a `verify`
 * that asks nobody anything.
 */
export function alreadyAsked(access: PlatformAccess): WalkPlatform {
  // Not bound: whoever hands a platform over this way resolved it for their own
  // reasons rather than reading it out of a committed file. The one path where
  // a binding really chose the address builds its own, in `main.ts`, from the
  // resolution that read that file.
  return { url: access.url, bound: false, verify: () => Promise.resolve(access) };
}

/**
 * Logs in, or answers with the line the wizard should close on.
 *
 * `null` means the developer is signed in and the walk carries on. Everything
 * else is an ending, and each ending says which one it was: a denial is not a
 * fault, a code that ran out is not a denial, and an instance that never
 * answered is neither.
 */
export async function logInStep(
  platform: PlatformAccess,
  ui: WizardUI,
  signal: AbortSignal,
): Promise<ExitReport | null> {
  const result = await logIn({
    url: platform.url,
    credentialsFile: platform.credentialsFile,
    signal,
    onPrompt: (prompt) => ui.setLogin(prompt),
    say: (line) => ui.pushStatus(line),
    paste: () => ui.takeLoginPaste(),
    openBrowser:
      platform.openBrowser ??
      ((url) => openInBrowser(url, { instanceUrl: platform.url })),
  });

  ui.setLogin(null);

  switch (result.kind) {
    case "stored":
      ui.pushStatus(`Signed in to ${result.url}.`);
      return null;
    case "already-stored":
      // Nothing was approved and nothing needed to be: this machine already
      // holds a key for this egma, so login is a step that costs no time.
      ui.pushStatus(`Already signed in to ${result.url}.`);
      return null;
    case "denied":
      return { kind: "failed", reason: "the login was denied in the browser." };
    case "expired":
      return {
        kind: "failed",
        reason: "nobody approved the login before the code ran out. Run egma again.",
      };
    case "interrupted":
      return stopReport(signal, null);
    case "unreachable":
    case "refused":
      return { kind: "failed", reason: result.reason };
  }
}
