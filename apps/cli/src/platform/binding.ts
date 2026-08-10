/**
 * The egma a repository belongs to, and what happens when a command is aimed
 * somewhere else.
 *
 * An agent id, a connection id and a test version id are minted by one platform
 * and exist nowhere else. `egma/config.yaml` therefore commits the platform
 * that minted them: its canonical origin, which a person reads, and the
 * identifier that platform minted for itself, which a command checks. Both are
 * configuration; neither is a credential; the keys stay in the developer's home
 * folder, keyed by the same origin.
 *
 * Four rules, and every one of them is here rather than spread over the verbs:
 *
 * **Ask who it is first, then sign in.** Every command reads the platform's own
 * identity before it says anything to it and before anybody signs in, and the
 * address that read settles is the one address the rest of the command uses —
 * for its requests, for the key it looks up or files, and for the binding it
 * writes. One platform is one string, always.
 *
 * **A bound platform that is unavailable stops the command.** It never falls
 * back to Egma Cloud, because the ids in hand do not exist there and a cloud
 * that answered "no such agent" would look like a broken repository rather than
 * like a stopped container.
 *
 * **A different platform stops the command too.** Rebinding a repository is not
 * part of this decision (ADR-0008), so an explicit address naming another egma
 * is refused with what it would have taken to be right, and nothing is sent.
 *
 * **A platform that will not name itself is still bound to.** By origin alone.
 * A folder holding one platform's ids while naming no platform is exactly the
 * crossing this file exists to prevent, and an older deployment that has no
 * identity endpoint yet must not produce one.
 */

import {
  folderPathsIn,
  readConfig,
  updateConfig,
  type PlatformBinding,
} from "../folder/egma-folder.ts";
import { isWebAddress } from "./address.ts";
import {
  credentialsFileIn,
  normalizePlatformOrigin,
  resolvePlatformUrl,
  type PlatformSource,
} from "./credentials.ts";
import { PlatformUnreachableError, type Fetch } from "./device-flow.ts";

/** Which egma a run signs in to, where its key is kept, and how egma decided. */
export type PlatformAccess = {
  /**
   * The one address this command uses: for every request, for the key it looks
   * up or files, and for the binding it writes. Settled by `reachPlatform`
   * before anything is sent.
   */
  readonly url: string;
  readonly credentialsFile: string;
  /** Which of the four places named this platform. */
  readonly source: PlatformSource;
  /** What this repository is bound to, or `null` when it is bound to nothing. */
  readonly binding: PlatformBinding | null;
  /**
   * Who answered at `url`, or `null` when nobody did or the platform would not
   * say. Read before signing in, because the binding written afterwards is made
   * of it and a repository must never hold ids from a platform it cannot name.
   */
  readonly identity: PlatformIdentity | null;
};

/** What a platform says about itself. */
export type PlatformIdentity = {
  /** The identifier this deployment minted for itself. */
  readonly instance: string;
  /** The origin it believes it is reached on, normalized. */
  readonly origin: string;
};

/**
 * What a repository is bound to, or `null`.
 *
 * A file egma cannot read is read as no binding at all. The verb that goes on
 * to read the same file says what is wrong with it in its own words, and a
 * parse error repeated by two readers is one refusal too many.
 */
export async function readBinding(repository: string): Promise<PlatformBinding | null> {
  try {
    return (await readConfig(folderPathsIn(repository).config)).platform;
  } catch {
    return null;
  }
}

/**
 * Resolved once, in one place, so the wizard and every verb read the same
 * answer from the same four places in the same order. Two copies of this would
 * be two answers to "which egma is this", and the one that is wrong would be
 * the one that wrote the key.
 */
export async function resolvePlatformAccess(choice: {
  readonly env: NodeJS.ProcessEnv;
  /** `--url`, when one was given. */
  readonly flag: string | null;
  /** The repository this command is being run in. */
  readonly cwd: string;
}): Promise<PlatformAccess> {
  const binding = await readBinding(choice.cwd);
  const { url, source } = resolvePlatformUrl({
    flag: choice.flag,
    env: choice.env.EGMA_URL,
    binding: binding?.origin ?? null,
  });
  return {
    url,
    credentialsFile: credentialsFileIn(choice.env),
    source,
    binding,
    // Nobody has asked the platform anything yet. `reachPlatform` does that,
    // before this command signs in or names an identifier.
    identity: null,
  };
}

/** Where a platform says who it is. The one unauthenticated read egma makes. */
const IDENTITY_PATH = "/api/platform";

/**
 * How long egma waits for a platform to say who it is.
 *
 * This one read sits in front of every command, so the wait in front of every
 * command is this. It is a few hundred bytes from an endpoint that touches one
 * row it has already cached, and Node's own default is five minutes — which is
 * five minutes of a terminal that looks hung rather than a platform that is.
 */
const IDENTITY_TIMEOUT_MS = 10_000;

/** The caller's signal, with a bound wait of egma's own around it. */
function withinTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(IDENTITY_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Ask a platform who it is.
 *
 * Nothing is sent but the request: this is the read that happens before a key
 * is held and before any identifier is named, so a platform that turns out to
 * be the wrong one has been told nothing by the time egma stops.
 */
export async function readPlatformIdentity(
  url: string,
  options: { readonly fetchImpl?: Fetch; readonly signal?: AbortSignal } = {},
): Promise<PlatformIdentity> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const at = `${normalizePlatformOrigin(url)}${IDENTITY_PATH}`;

  let response: Response;
  try {
    response = await fetchImpl(at, {
      headers: { accept: "application/json" },
      signal: withinTimeout(options.signal),
    });
  } catch (cause) {
    throw new PlatformUnreachableError(url, cause);
  }

  if (!response.ok) {
    throw new PlatformUnreachableError(
      url,
      new Error(`it answered ${response.status} when asked which egma it is`),
    );
  }

  const body = (await response.json().catch(() => ({}))) as {
    instance_id?: unknown;
    origin?: unknown;
  };
  const instance = plain(body.instance_id);
  if (instance === "") {
    throw new PlatformUnreachableError(
      url,
      new Error("it answered without saying which egma it is"),
    );
  }

  // The origin the platform believes it is reached on, when it is one egma
  // could talk to. A deployment configured with a wrong or empty base address
  // must not put an address nothing answers into a committed file.
  const said = normalizePlatformOrigin(plain(body.origin));
  const origin = said !== "" && isWebAddress(said) ? said : normalizePlatformOrigin(url);
  return { instance, origin };
}

/**
 * A string off the wire with nothing in it a terminal would obey.
 *
 * Both halves of an identity are drawn on a screen and written into a committed
 * file, and a terminal reads a control character as an instruction rather than
 * as text. They are taken out at the one edge that reads the wire, exactly as
 * the device flow does it, so nothing below here has to remember.
 */
function plain(value: unknown): string {
  return typeof value === "string" ? value.replaceAll(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
}

export type SettleOptions = {
  readonly fetchImpl?: Fetch;
  readonly signal?: AbortSignal;
};

/**
 * The address egma will use for the whole of this command, and who answers
 * there — settled before anything is sent and before anybody signs in.
 *
 * **One address, decided once.** What follows uses it for every request, for
 * the key it looks up or files, and for the binding it writes. Two strings for
 * one platform is the bug this exists to make unrepresentable: a key filed
 * under the address a developer typed and a binding written from the address
 * the platform reports leave a repository that signs in successfully and is
 * "not signed in" on the very next command.
 */
export type Reached =
  /** Something answered, and said which egma it is. */
  | {
      readonly kind: "answered";
      /** The address to use from here on, normalized. */
      readonly url: string;
      readonly identity: PlatformIdentity;
      /** One line worth saying out loud, when anything surprising happened. */
      readonly note?: string;
    }
  /** Nothing answered there, or what did would not say which egma it is. */
  | { readonly kind: "silent"; readonly reason: string };

/**
 * Reach the platform this command resolved to, and settle its address.
 *
 * A **bound** repository keeps the address it is bound to, whatever the
 * platform says its own address is. That address is the contract: the key on
 * this machine is filed under it, and every id in the folder was written when
 * it was in use. Only the instance identifier is read, and only to check it.
 *
 * An **unbound** repository is about to write an address into a committed file,
 * so if the platform names a different one for itself, that address is checked
 * before it is believed — it has to answer, and it has to be the same egma.
 * A platform whose configured address is wrong therefore costs a repository
 * nothing: egma keeps the address that worked and says so.
 */
export async function reachPlatform(
  access: PlatformAccess,
  options: SettleOptions = {},
): Promise<Reached> {
  const here = normalizePlatformOrigin(access.url);

  let identity: PlatformIdentity;
  try {
    identity = await readPlatformIdentity(here, options);
  } catch (cause) {
    return { kind: "silent", reason: cause instanceof Error ? cause.message : String(cause) };
  }

  // The address this repository is bound to is the contract — the key on this
  // machine is filed under it and every id in the folder was written while it
  // was in use — so it is kept whatever the platform says its own address is.
  const isTheBoundOne =
    access.binding !== null && normalizePlatformOrigin(access.binding.origin) === here;
  if (isTheBoundOne || identity.origin === here) {
    return { kind: "answered", url: here, identity };
  }

  try {
    const there = await readPlatformIdentity(identity.origin, options);
    if (there.instance === identity.instance) {
      return { kind: "answered", url: identity.origin, identity: there };
    }
  } catch {
    // Falls through to the address that answered, with the note below.
  }
  return {
    kind: "answered",
    url: here,
    identity,
    note:
      `egma at ${here} says it is reached at ${identity.origin}, and that address is not this ` +
      `same egma from here. ${here} is what this repository will use.`,
  };
}

/** How a bound repository's check came out. */
export type Settled =
  /** Nothing stands in the way. */
  | { readonly kind: "ok" }
  /** The platform this repository belongs to did not answer. */
  | { readonly kind: "unreachable"; readonly reason: string }
  /** The address in hand leads to a different egma from the bound one. */
  | { readonly kind: "elsewhere"; readonly reason: string };

/**
 * Hold what answered against what this repository belongs to.
 *
 * An unbound repository is refused nothing: no identifier here belongs
 * anywhere, so any platform is a fair target and a platform that will not name
 * itself is one egma can still work with — it is bound by origin alone, and
 * `reachPlatform` above has already settled which origin that is.
 */
export function settleBinding(access: PlatformAccess, reached: Reached): Settled {
  const bound = access.binding;
  if (reached.kind === "silent") {
    // A repository bound by origin alone is bound to a platform that never
    // named itself, so this read failing is what that platform always does and
    // is not news. The command carries on against the address the binding
    // names — which is the promise being kept — and if that platform is really
    // down the verb says so in its own words.
    return bound === null || bound.instance === null
      ? { kind: "ok" }
      : { kind: "unreachable", reason: `${reached.reason}\n\n${boundPlatformLine(bound)}` };
  }
  if (bound === null || bound.instance === null || bound.instance === reached.identity.instance) {
    return { kind: "ok" };
  }
  return {
    kind: "elsewhere",
    reason: differentPlatformRefusal(access, bound, reached.identity),
  };
}

/**
 * The platform as it stands after being reached: the settled address, and who
 * answered there when anybody did.
 */
export function asReached(access: PlatformAccess, reached: Reached): PlatformAccess {
  return reached.kind === "silent"
    ? access
    : { ...access, url: reached.url, identity: reached.identity };
}

/** The sentence that says what egma will not do instead, whatever went wrong. */
function boundPlatformLine(binding: PlatformBinding): string {
  return (
    `This repository is bound to the egma at ${binding.origin}. The ids in egma/config.yaml ` +
    `were minted there and exist nowhere else, so egma will not use another platform for ` +
    `them — not even Egma Cloud. Start that egma, then run this again.`
  );
}

/** What a developer is told when the address in hand is another egma. */
function differentPlatformRefusal(
  access: PlatformAccess,
  binding: PlatformBinding,
  found: PlatformIdentity,
): string {
  // Which of the two things happened is decided by the address rather than by
  // where the address came from: naming the bound origin and finding a
  // different egma behind it is a replaced platform, whoever typed it.
  const sameAddress = normalizePlatformOrigin(access.url) === binding.origin;
  const named = sameAddress
    ? null
    : access.source === "flag"
      ? "--url"
      : access.source === "environment"
        ? "EGMA_URL"
        : null;

  if (named === null) {
    // Nobody named anything: the bound origin is answering, and a different
    // egma is behind it. A new deployment, or a different database.
    return [
      `This repository is bound to the egma at ${binding.origin}, and the egma answering there now is a different one.`,
      "",
      `It calls itself ${found.instance}; this repository was bound to ${binding.instance}. That is a new deployment, or the same one on a different database, so the ids in egma/config.yaml do not exist on it. Nothing was sent.`,
    ].join("\n");
  }

  return [
    `${named} names the egma at ${access.url}, and this repository is bound to the egma at ${binding.origin}.`,
    "",
    `The agent, connection and test ids in egma/config.yaml were minted on ${binding.instance} and exist nowhere else, so egma sent that platform nothing. Run this without ${named} to use the platform this repository belongs to.`,
  ].join("\n");
}

/**
 * What every command answers with when the platform is the problem.
 *
 * Two numbers, the same for every verb, because the check happens before a verb
 * is chosen. The first is the number each verb already uses for "egma did not
 * answer", so nothing reading them has a new case; the second is its own,
 * because "a different egma" wants a different next action from "that egma is
 * down" and one number for both would make a reader guess.
 */
export const PLATFORM_UNREACHABLE_EXIT = 4;
export const BOUND_ELSEWHERE_EXIT = 8;

/** What binding this repository came to. */
export type Bound =
  /** It was not bound and now it is. */
  | { readonly kind: "bound"; readonly binding: PlatformBinding }
  /** It already named a platform, and that is the one it keeps. */
  | { readonly kind: "already"; readonly binding: PlatformBinding }
  /** There is no folder here yet, so there is nothing to write into. */
  | { readonly kind: "no-folder" };

/**
 * Write the binding, once, and from one place.
 *
 * Only into a folder that is already here, and only when it names no platform
 * yet: the file is somebody's committed file, and rebinding is not part of this
 * decision. Two callers reach this — the walk, the moment a developer is signed
 * in, and the step that makes the folder — and both hand it the same value, so
 * there is one writer and no second opinion about what a binding says.
 */
export async function bindRepository(
  repository: string,
  binding: PlatformBinding,
): Promise<Bound> {
  const config = folderPathsIn(repository).config;

  let held;
  try {
    held = await readConfig(config);
  } catch {
    return { kind: "no-folder" };
  }
  if (held.platform !== null) return { kind: "already", binding: held.platform };

  await updateConfig(config, { platform: binding });
  return { kind: "bound", binding };
}

/**
 * The binding for the platform in hand: the address this command settled on,
 * and the name that platform gave itself.
 *
 * **A platform that will not name itself still binds the repository**, by
 * origin alone. That is the case an older self-hosted deployment presents —
 * `/api/platform` is newer than the rest of the door — and the alternative is
 * the one thing ADR-0008 exists to prevent: a folder holding a self-hosted
 * platform's agent and test ids while naming no platform, so the next command
 * resolves to Egma Cloud and sends them there. `settleBinding` reads a binding
 * with no instance as "this origin, and never anywhere else", which keeps the
 * whole of that promise; what it gives up is only the ability to notice that a
 * *different* egma has since been served at the same address.
 */
export function bindingFor(access: PlatformAccess): PlatformBinding {
  return {
    origin: normalizePlatformOrigin(access.url),
    instance: access.identity?.instance ?? null,
  };
}
