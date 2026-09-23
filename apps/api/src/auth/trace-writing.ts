import { authorize, NotPermittedError, type AuthContext } from "@egma/db";

/**
 * Whether a credential may write an agent's traces into one project: the OTLP
 * door and the Egma SDK's seam ask the same question of the same key.
 */
export type TraceWriting =
  | { readonly may: true }
  | { readonly may: false; readonly why: "no_project" }
  | {
      readonly may: false;
      readonly why: "not_permitted";
      readonly cause: NotPermittedError;
    };

/**
 * A key scoped to one project, acting at a role that may ingest traces there.
 * An organization-wide credential names no project for the traffic to file
 * under, and a read-only role may not write.
 */
export function traceWritingOf(auth: AuthContext): TraceWriting {
  if (auth.projectId === undefined) return { may: false, why: "no_project" };
  try {
    authorize(auth, "ingest_traces", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });
  } catch (cause) {
    if (cause instanceof NotPermittedError) {
      return { may: false, why: "not_permitted", cause };
    }
    throw cause;
  }
  return { may: true };
}
