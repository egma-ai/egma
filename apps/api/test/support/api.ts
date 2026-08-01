import { connect, disconnect } from "@egma/db";
import type { FastifyInstance } from "fastify";

import { loadConfig, type Config } from "../../src/config.ts";
import type { Email, EmailSender } from "../../src/auth/email.ts";
import type { RateLimit } from "../../src/http/rate-limit.ts";
import { buildApi } from "../../src/server.ts";
import type { Identity } from "../../src/auth/better-auth.ts";
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from "../../../../packages/db/test/support/database.ts";

/**
 * A running API with a database of its own.
 *
 * These are the flows that never pass through the data-access module's own
 * seam — signing up, the provider's HTTP surface, the adapter under it — so
 * they are driven over HTTP, in process, with no port bound. The database is
 * real, because every guarantee underneath is a Postgres one.
 */

export type TestApi = {
  readonly app: FastifyInstance;
  /** The provider the API was built on, so the seam can be driven directly. */
  readonly identity: Identity;
  readonly config: Config;
  /** Raw SQL, for checking what actually landed rather than asking the API. */
  readonly database: MigratedDatabase;
  /** Everything the email transport was handed, in order. */
  readonly mail: readonly Email[];
  close(): Promise<void>;
};

export type TestApiOptions = {
  readonly singleOrganization?: boolean;
  readonly trustProxy?: boolean;
  /** Whether the transport claims a message actually reaches anybody. */
  readonly emailDelivers?: boolean;
  /** A budget small enough to reach, for the tests about reaching it. */
  readonly rateLimit?: RateLimit;
};

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      DATABASE_URL: "postgres://unused/unused",
      EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
      EGMA_BASE_URL: "http://localhost:3101",
    }),
    ...overrides,
  };
}

export async function createApi(
  label: string,
  options: TestApiOptions = {},
): Promise<TestApi> {
  const database = await createMigratedDatabase(label);
  connect({ databaseUrl: database.url, maxConnections: 4 });

  const mail: Email[] = [];
  const emailSender: EmailSender = {
    delivers: options.emailDelivers ?? false,
    async send(email) {
      mail.push(email);
    },
  };

  const config = testConfig({
    databaseUrl: database.url,
    singleOrganization: options.singleOrganization ?? false,
    trustProxy: options.trustProxy ?? false,
  });

  const { app, identity } = buildApi({
    config,
    emailSender,
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  });
  await app.ready();

  return {
    app,
    identity,
    config,
    database,
    mail,
    async close() {
      await app.close();
      await disconnect();
      await database.drop();
    },
  };
}

/** The cookie header a browser would send back, given what it was just set. */
export function cookiesFrom(setCookie: string | string[] | undefined): string {
  const all = setCookie === undefined ? [] : [setCookie].flat();
  return all.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}
