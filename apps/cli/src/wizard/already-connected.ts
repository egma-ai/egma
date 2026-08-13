/**
 * The step before connect: is this repository already connected?
 *
 * A folder that already names an agent and a way to reach it has been through
 * connect once, and everything connect would do again has been done. Asking a
 * developer for their provider key a second time, so that egma can look up an
 * agent whose identifier is written in the file it just read, is a question
 * with the answer already in it.
 *
 * **The folder is not taken at its word.** Two identifiers in a committed file
 * are a claim, not a fact: a repository cloned from somebody else's platform, a
 * folder written against a database that has since been rebuilt, and a key
 * belonging to a different project all produce a config that reads perfectly
 * and names nothing this key can see. So the platform is asked, and the skip
 * happens only when it confirms **both** halves — the agent, and that
 * connection on that agent. Anything else, and connect runs exactly as before.
 * That is the whole safety of it: a wrong answer here would mean a run pinned
 * against something the developer never chose.
 *
 * What is deliberately lost by skipping: the provider's own prompt and its tool
 * count, which connect fetches and test generation is grounded in. Discovery
 * has already found where the words live in the repository, so the generator
 * works from the source rather than from the provider's copy of it — and the
 * prompt was always allowed to be absent, for the agent whose model the
 * customer runs themselves.
 */

import { readConfig, folderPathsIn } from "../folder/egma-folder.ts";
import { readAgent, type Registered } from "../platform/agents.ts";
import type { SignedIn } from "../platform/signed-in.ts";

/** What connect would have produced, when connect did not need to run. */
export type AlreadyConnected = {
  readonly registered: Registered;
  /** The number this connection dials, or `null` when it dials nowhere. */
  readonly number: string | null;
};

/**
 * The agent and connection this folder already points at, or `null`.
 *
 * `null` for every doubt there is: nothing written down, nothing this key can
 * see, a connection that is not on that agent, or a platform that did not
 * answer. Each of those is a reason to run connect, and none of them is a
 * reason to stop the walk — so nothing here throws and nothing here is an
 * ending.
 */
export async function alreadyConnected(
  signedIn: SignedIn,
  cwd: string,
): Promise<AlreadyConnected | null> {
  let agentId: string;
  let connectionId: string;
  try {
    const config = await readConfig(folderPathsIn(cwd).config);
    agentId = config.agent?.id ?? "";
    connectionId = config.connection?.id ?? "";
  } catch {
    // No folder, or one egma cannot read. Connect makes the first and names
    // the second, so either way it is connect's to answer.
    return null;
  }
  if (agentId === "" || connectionId === "") return null;

  const held = await readAgent(agentId, { url: signedIn.url, key: signedIn.key });
  if (held.kind !== "agent") return null;

  const connection = held.connections.find((one) => one.id === connectionId);
  if (connection === undefined) return null;

  return {
    registered: {
      // `reused` is the truth of it: nothing was written, and the same word is
      // what connect answers when it finds a registration already there.
      result: "reused",
      agent: { id: held.agent.id, name: held.agent.name },
      connection,
    },
    number: connection.config["phoneNumber"] ?? null,
  };
}
