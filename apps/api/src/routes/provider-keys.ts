import {
  readProviderKeys,
  putProviderKey,
  deleteProviderKey,
  IdentityConflictError,
  NotPermittedError,
  UnprocessableInputError,
  type ProviderKeyEntry,
} from "@egma/db";
import { providerKeyOperations } from "@egma/platform-api/contract";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { OrganizationRoutesOptions } from "./organization.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import { sendRefusal } from "../http/refusals.ts";
function described(row: ProviderKeyEntry) {
  return {
    ...row,
    credential:
      row.credential === null
        ? null
        : {
            ...row.credential,
            updatedAt: row.credential.updatedAt.toISOString(),
          },
  };
}
function refused(reply: FastifyReply, fault: unknown) {
  if (fault instanceof IdentityConflictError)
    return sendRefusal(
      reply,
      "identity_conflict",
      "This provider key changed. Reload the page before replacing or removing it.",
    );
  if (fault instanceof NotPermittedError)
    return sendRefusal(
      reply,
      "not_permitted",
      fault.message,
    );
  if (fault instanceof UnprocessableInputError)
    return sendRefusal(reply, "unprocessable", fault.message);
  throw fault;
}
/** Organization-scoped credentials remain write-only, including mutation responses. */
export async function providerKeyRoutes(
  app: FastifyInstance,
  options: OrganizationRoutesOptions,
): Promise<void> {
  credentialed(app, options);
  app.setErrorHandler(async (error, _request, reply) => refused(reply, error));
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  registerPlatformOperation(
    app,
    providerKeyOperations.listProviderKeys,
    async (request, reply) => {
      const answer = await readProviderKeys(requesterOf(request).auth);
      return reply.send({
        ...answer,
        providers: answer.providers.map(described),
      });
    },
  );
  registerPlatformOperation(
    app,
    providerKeyOperations.putProviderKey,
    async (request, reply) => {
      const { provider } = request.params as { provider: string };
      const body = request.body as {
        key: string;
        expectedRevision: string | null;
      };
      try {
        return reply.send(
          described(
            await putProviderKey(
              requesterOf(request).auth,
              provider,
              body.key,
              body.expectedRevision,
            ),
          ),
        );
      } catch (fault) {
        return refused(reply, fault);
      }
    },
  );
  registerPlatformOperation(
    app,
    providerKeyOperations.deleteProviderKey,
    async (request, reply) => {
      const { provider } = request.params as { provider: string };
      const body = request.body as { expectedRevision: string };
      try {
        return reply.send(
          described(
            await deleteProviderKey(
              requesterOf(request).auth,
              provider,
              body.expectedRevision,
            ),
          ),
        );
      } catch (fault) {
        return refused(reply, fault);
      }
    },
  );
}
