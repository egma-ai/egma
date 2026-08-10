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
 * Three rules, and every one of them is here rather than spread over the verbs:
 *
 * **A bound repository is checked before anything is sent.** Every command
 * reads the platform's own identity first, and only then talks to it.
 *
 * **A bound platform that is unavailable stops the command.** It never falls
 * back to Egma Cloud, because the ids in hand do not exist there and a cloud
 * that answered "no such agent" would look like a broken repository rather than
 * like a stopped container.
 *
 * **A different platform stops the command too.** Rebinding a repository is not
 * part of this decision (ADR-0008), so an explicit address naming another egma
 * is refused with what it would have taken to be right, and nothing is sent.
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
  readonly url: string;
  readonly credentialsFile: string;
  /** Which of the four places named this platform. */
  readonly source: PlatformSource;
  /** What this repository is bound to, or `null` when it is bound to nothing. */
  readonly binding: PlatformBinding | null;
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
  return { url, credentialsFile: credentialsFileIn(choice.env), source, binding };
}

/** Where a platform says who it is. The one unauthenticated read egma makes. */
const IDENTITY_PATH = "/api/platform";

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
      ...(options.signal === undefined ? {} : { signal: options.signal }),
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

/** How a bound repository's check came out. */
export type Settled =
  /** Nothing stands in the way. The identity is read only when it was needed. */
  | { readonly kind: "ok"; readonly identity: PlatformIdentity | null }
  /** The platform this repository belongs to did not answer. */
  | { readonly kind: "unreachable"; readonly reason: string }
  /** The address in hand leads to a different egma from the bound one. */
  | { readonly kind: "elsewhere"; readonly reason: string };

export type SettleOptions = {
  readonly fetchImpl?: Fetch;
  readonly signal?: AbortSignal;
};

/**
 * Check the platform in hand against the one this repository belongs to.
 *
 * An unbound repository is asked nothing and refused nothing: there is no
 * identifier here that belongs anywhere, so any platform is a fair target and
 * Egma Cloud is the default one. It costs no request either, which matters
 * because a bare `npx egma` in a repository with nothing in it should not put
 * a round trip in front of the first screen.
 */
export async function settlePlatform(
  access: PlatformAccess,
  options: SettleOptions = {},
): Promise<Settled> {
  if (access.binding === null) {
    return { kind: "ok", identity: null };
  }

  const bound = access.binding;
  let identity: PlatformIdentity;
  try {
    identity = await readPlatformIdentity(access.url, {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { kind: "unreachable", reason: `${reason}\n\n${boundPlatformLine(bound)}` };
  }

  if (bound.instance === null || bound.instance === identity.instance) {
    return { kind: "ok", identity };
  }
  return {
    kind: "elsewhere",
    reason: differentPlatformRefusal(access, bound, identity),
  };
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

/**
 * Who this platform is, asked at most once and only when somebody asks.
 *
 * Lazy on purpose. The answer is needed exactly when something belonging to
 * this platform is about to be written into the repository, and a walk that
 * never gets that far — no coding agent, no key, a developer who quit at the
 * first screen — should not have spent a request on it. A platform that will
 * not say answers `null`: the walk carries on and the repository stays bound to
 * nothing, which is what it already was.
 */
export type IdentityHolder = () => Promise<PlatformIdentity | null>;

export function identityOnce(
  url: string,
  known: PlatformIdentity | null | undefined,
  options: { readonly fetchImpl?: Fetch; readonly signal?: AbortSignal } = {},
): IdentityHolder {
  let asked: Promise<PlatformIdentity | null> | undefined;
  return () => {
    if (known !== null && known !== undefined) return Promise.resolve(known);
    asked ??= readPlatformIdentity(url, options).catch(() => null);
    return asked;
  };
}

/** What binding this repository came to. */
export type Bound =
  /** It was not bound and now it is. */
  | { readonly kind: "bound"; readonly binding: PlatformBinding }
  /** It already named a platform, and that is the one it keeps. */
  | { readonly kind: "already"; readonly binding: PlatformBinding }
  /** There is no folder here yet, so there is nothing to write into. */
  | { readonly kind: "no-folder" }
  /** The platform would not say who it is, so there is nothing to write. */
  | { readonly kind: "unknown-platform" };

/**
 * Write the binding, once.
 *
 * Only into a folder that is already here, and only when it names no platform
 * yet: the file is somebody's committed file, and rebinding is not part of this
 * decision. A repository with no folder is bound by the step that makes one,
 * which is the same moment its first platform-owned id lands in it.
 */
export async function bindRepository(
  repository: string,
  identityOf: IdentityHolder,
): Promise<Bound> {
  const config = folderPathsIn(repository).config;

  let held;
  try {
    held = await readConfig(config);
  } catch {
    return { kind: "no-folder" };
  }
  if (held.platform !== null) return { kind: "already", binding: held.platform };

  const identity = await identityOf();
  if (identity === null) return { kind: "unknown-platform" };

  const binding = bindingFor(identity);
  await updateConfig(config, { platform: binding });
  return { kind: "bound", binding };
}

/** The two lines a binding is, from what the platform said about itself. */
export function bindingFor(identity: PlatformIdentity): PlatformBinding {
  return { origin: identity.origin, instance: identity.instance };
}
