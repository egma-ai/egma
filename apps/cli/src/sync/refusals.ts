/**
 * The sentences a repository verb refuses with, written once.
 *
 * **These are contract.** A coding agent reads them off a terminal and decides
 * what to do next from them, so each is a fixed sentence with values dropped
 * into it and nothing about the shape left to the caller.
 *
 * They are said here rather than by the platform, and that is the point of
 * preflight: `push` decides what it will do about every readable file before it
 * uploads any of them, so a folder holding one file egma will not take never
 * lands the other eleven ahead of the refusal. A refusal only the platform can
 * make still arrives in the platform's own words.
 *
 * `agentNotApplicable` is the one sentence both ends say. The platform's copy
 * lives beside every other refusal it makes; this one is for the ordinary path,
 * where the request is never sent at all. They are held to each other by a
 * check, because a client that meets two wordings for one fact learns to read
 * neither.
 */

/**
 * A file pinned to a version, carrying no identity revision.
 *
 * It is the shape every file written before the live half had a token of its
 * own is in, and it is refused for what it cannot say rather than for what it
 * says: an edit that named no revision would be accepted over a rename somebody
 * made in the browser, and the rename would be silently gone. A pull migrates
 * the file where it can do so safely, which is the whole of the fix.
 */
export function formatOutdated(file: string): string {
  return (
    `Test file ${file} has a version pin but no identity revision. Run egma ` +
    "pull to migrate it; if Egma keeps the file unchanged, copy the draft " +
    "aside, pull the platform version, and reapply the draft."
  );
}

/**
 * A file for a test the browser has unlinked from this repository's agent.
 *
 * One repository is bound to one agent, and which agents a test applies to is
 * the browser's to edit. So this is not a conflict to be merged and not a stale
 * copy to be pulled: it is a file this folder is no longer entitled to write,
 * and the two ways out are both somebody's decision. Neither side is touched
 * either way, which the sentence says out loud.
 */
export function agentNotApplicable(testId: string, agentId: string): string {
  return (
    `Test ${testId} no longer applies to the agent bound to this repository. ` +
    `Link it to agent ${agentId} in Egma, or remove this local file; egma ` +
    "push changed neither side."
  );
}

/**
 * The same fact, said by the client after other files have already landed.
 *
 * **The last clause of the sentence above is a claim about the whole push, and
 * only the preflight can make it.** Once a file has been uploaded, "egma push
 * changed neither side" is not true of this run — and a refusal that says
 * something untrue about what just happened is worse than no refusal at all.
 * So the late one states what is true of this file, and the aggregate sentence
 * beside it says what landed. It names the **file** rather than the test id,
 * because the reader is looking at a folder and the preflight's sentence — the
 * one whose wording is contract with the platform's own — is the one that names
 * the test.
 */
export function agentNotApplicableLate(file: string, agentId: string): string {
  return (
    `${file} names a test that no longer applies to the agent bound to this ` +
    `repository — the link went away while this push was running, so this ` +
    `file was not written. Link the test to agent ${agentId} in Egma, or ` +
    "remove this local file."
  );
}

/**
 * A file for a test somebody archived.
 *
 * Its own sentence rather than the one above, because the fact is different and
 * so is the fix. A test that has left this repository's list has left it for
 * one of two reasons, and answering both with "it no longer applies to your
 * agent" would send somebody to a link editor for a test that is not in it.
 */
export function testArchived(testId: string, name: string): string {
  return (
    `Test ${testId} "${name}" is archived, so egma will not write to it. ` +
    "Restore it in Egma, or remove this local file; egma push changed " +
    "neither side."
  );
}

/**
 * A file whose pinned content or live name no longer matches what the platform
 * holds, on a pull that would otherwise have migrated it.
 *
 * The draft is left exactly as it is. egma cannot tell a name somebody changed
 * in the browser from one they changed in the file, and picking either would be
 * egma deciding whose edit was the real one.
 */
export function keptUnmigrated(file: string, because: string): string {
  return (
    `${file} has a version pin but no identity revision, and ${because}, so ` +
    "egma left it exactly as it is rather than guess which side the change " +
    "came from. Copy the draft aside, delete this file, run egma pull to " +
    "write the platform's version, then reapply the draft."
  );
}
