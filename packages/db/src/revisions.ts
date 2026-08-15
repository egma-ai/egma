import { randomBytes } from "node:crypto";

/**
 * The opaque token that says which state of a resource an edit was written
 * against.
 *
 * **It carries no information and that is the whole of its job.** A counter
 * would invite a caller to add one to it, and a timestamp would invite a
 * caller to compare two — and either would turn "read it again" into "guess
 * what it is now", which is the failure the token exists to make impossible.
 * So it is random, it is never parsed, and the only correct thing anybody can
 * do with one is hand back the one they were given.
 *
 * It changes on every identity write and on every lifecycle change. The
 * version id is a separate thing and answers a separate question: a revision
 * says *this resource has not moved*, and a version id says *this content has
 * not moved*. A trait write names both, because it changes both.
 */
export function newRevision(): string {
  return randomBytes(16).toString("hex");
}
