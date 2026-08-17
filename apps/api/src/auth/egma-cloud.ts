import { INFERENCE_KEY_HEADER } from "./inference-key.ts";
import type { ManagedValidation } from "../routes/model-access.ts";

/**
 * The one request this deployment makes to Egma Cloud on a person's behalf, and
 * everything that is deliberately not in it.
 *
 * When an administrator pastes an inference key, the deployment asks Egma Cloud
 * one question — is this key good, and which organization owns it — and stores
 * nothing until it has an answer. That is what "Connected only after
 * organization-bound validation" means, and it is the only outbound call the
 * product makes here.
 *
 * **Content-free, and the shape is what keeps it that way.** The credential
 * travels in its own header and there is no body at all, so there is no field
 * anybody could later put a simulation, a persona or a model into. The answer
 * is an organization identifier and a key identifier.
 *
 * **Not an exchange.** Nothing here comes back that a later connection uses:
 * the key that was pasted is the credential every gateway connection presents,
 * and no provider credential and no per-simulation grant is issued by either
 * side.
 */

/**
 * How long the ask may take before this deployment says it does not know.
 *
 * An administrator is watching a form, so it is short. Ten seconds is far
 * longer than a control plane takes to hash a string and read one row, and
 * short enough that Egma Cloud being down looks like Egma Cloud being down
 * rather than like a page that hangs.
 */
const VALIDATION_TIMEOUT_MS = 10_000;

export const INFERENCE_KEY_VALIDATION_PATH = "/v1/inference-keys/validation";

/**
 * Where Egma Cloud answers. A deployment may point this elsewhere — a staging
 * Egma Cloud, or the deterministic suite's own — and one that names nothing
 * reports every paste as unreachable rather than quietly connecting it.
 */
export function validateAtEgmaCloud(
  cloudOrigin: string | undefined,
  request: typeof fetch = fetch,
): (key: string) => Promise<ManagedValidation> {
  return async (key: string): Promise<ManagedValidation> => {
    if (cloudOrigin === undefined || cloudOrigin === "") {
      return { outcome: "unreachable" };
    }

    let answer: Response;
    try {
      answer = await request(
        `${cloudOrigin.replace(/\/+$/, "")}${INFERENCE_KEY_VALIDATION_PATH}`,
        {
          method: "POST",
          headers: { [INFERENCE_KEY_HEADER]: key, "content-length": "0" },
          signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
        },
      );
    } catch {
      return { outcome: "unreachable" };
    }

    if (answer.status === 401 || answer.status === 403) return { outcome: "refused" };
    if (!answer.ok) return { outcome: "unreachable" };

    let said: { organization_id?: unknown };
    try {
      said = (await answer.json()) as { organization_id?: unknown };
    } catch {
      return { outcome: "unreachable" };
    }

    const organizationId = said.organization_id;
    if (typeof organizationId !== "string" || organizationId === "") {
      // An answer this deployment cannot read is not a refusal: the key may be
      // perfectly good and the thing on the other end may not be Egma Cloud.
      return { outcome: "unreachable" };
    }
    return { outcome: "valid", organizationId };
  };
}
