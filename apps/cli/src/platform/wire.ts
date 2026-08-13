/**
 * The wire every group of this client speaks: one request, one read of what
 * came back, and the two rules that apply whatever the request was about.
 *
 * It sits on its own because the groups above it — tests, mock tools, runs —
 * differ in what they ask for and agree completely about how to ask. Three
 * copies of that agreement is three chances for one of them to drift, and the
 * drift would be invisible: each copy works perfectly until the day somebody
 * improves one of them.
 *
 * **Nothing read off the wire carries anything a terminal would obey.**
 * Everything named here is either printed on a line a coding agent parses or
 * written into a file in the developer's repository, and a terminal reads a
 * control character as an instruction rather than as text: a test name carrying
 * an escape sequence could redraw what egma just said, and one carrying a line
 * break would turn one printed fact into two. They come off at this one edge,
 * so nothing above here has to remember. Same rule, same reason, as the login
 * end of this seam.
 *
 * **An instance that did not answer is not an instance that refused.** A
 * transport failure is thrown as `PlatformUnreachableError` naming the address,
 * because "egma is not at that address" and "egma would not do that" want
 * different next moves from whoever reads them.
 */

import { PlatformUnreachableError, type Fetch } from "./device-flow.ts";
import type { SignedIn } from "./signed-in.ts";

/** A string off the wire, with nothing in it a terminal would obey. */
export function text(value: unknown): string {
  return typeof value === "string" ? value.replaceAll(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
}

/**
 * Prose off the wire: a value that is written into a file and read by a person,
 * rather than printed as one fact on one line.
 *
 * The rule above takes a line break off with everything else, because a line
 * break in a *printed fact* turns one line into two and a reader cannot tell
 * which. That reasoning does not reach a paragraph. Taking the breaks out of a
 * scenario does not make it one line — it welds the last word of each line to
 * the first word of the next, so "they have\nbeen before" comes back as "they
 * havebeen before", and that is what gets written into the developer's
 * repository and read out to their agent.
 *
 * So the line breaks stay and everything else a terminal would obey still goes,
 * which is the whole of what the rule was protecting against here: this value
 * is never a printed fact. Carriage returns are folded into the break they
 * belong to rather than deleted, so a file written on Windows does not come
 * back a line short.
 */
export function prose(value: unknown): string {
  if (typeof value !== "string") return "";
  // Split on the break, clean each line, put the breaks back. The same rule as
  // above is applied to every line, and it cannot reach a break because there
  // is none left inside a line to reach.
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replaceAll(/[\p{Cc}\p{Cf}]/gu, "").trimEnd())
    .join("\n")
    .trim();
}

/** A list of such strings, with anything that read as nothing left out. */
export function textList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter((item) => item !== "");
}

/** Whatever JSON came back, or an empty body when it was not JSON at all. */
export async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/** What the platform said about a refusal, or egma's own words for a silence. */
export function saidBy(body: Record<string, unknown>, status: number): string {
  const message = text(body.message);
  return message === "" ? `egma answered ${status} and said nothing about it` : message;
}

export type Call = {
  readonly signedIn: SignedIn;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly fetchImpl?: Fetch;
  /** For a request somebody may stop part way through — following a run. */
  readonly signal?: AbortSignal;
};

export async function ask(
  call: Call,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const fetchImpl = call.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${call.signedIn.url}${call.path}`, {
      method: call.method ?? "GET",
      headers: {
        authorization: `Bearer ${call.signedIn.key}`,
        ...(call.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });
  } catch (cause) {
    throw new PlatformUnreachableError(call.signedIn.url, cause);
  }

  return { response, body: await bodyOf(response) };
}
