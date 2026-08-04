import { connect, disconnect, runMigrations } from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  loggingEmailSender,
  smtpEmailSender,
  type Email,
} from "../src/auth/email.ts";
import { loadConfig } from "../src/config.ts";
import { buildApi } from "../src/server.ts";
import { testConfig } from "./support/api.ts";
import {
  createEmptyDatabase,
  type EmptyDatabase,
} from "../../../packages/db/test/support/database.ts";

/** The least an environment can carry and still be startable. */
const enough = {
  DATABASE_URL: "postgres://x/y",
  EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
  EGMA_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
};

describe("configuration", () => {
  it("refuses to start without a database to talk to", () => {
    expect(() => loadConfig({ ...enough, DATABASE_URL: "" })).toThrow(
      /DATABASE_URL is required/,
    );
  });

  it("refuses to start without a secret to sign sessions with", () => {
    expect(() => loadConfig({ ...enough, EGMA_AUTH_SECRET: "" })).toThrow(
      /EGMA_AUTH_SECRET is required/,
    );
  });

  it("refuses to start without a well-formed encryption key", () => {
    expect(() => loadConfig({ ...enough, EGMA_ENCRYPTION_KEY: "" })).toThrow(
      /EGMA_ENCRYPTION_KEY is required/,
    );
    // The right length and a fraction of the entropy: a passphrase is refused
    // on its alphabet, not waved through on its byte count.
    expect(() =>
      loadConfig({
        ...enough,
        EGMA_ENCRYPTION_KEY: "not-hex-but-sixty-four-characters-long-oh-dear!!".padEnd(64, "x"),
      }),
    ).toThrow(/64 hex characters/);
  });

  it("refuses a port that is not a port", () => {
    expect(() => loadConfig({ ...enough, PORT: "not-a-port" })).toThrow(
      /not a usable port/,
    );
  });

  it("refuses a base URL that is not a URL", () => {
    expect(() => loadConfig({ ...enough, EGMA_BASE_URL: "not a url" })).toThrow(
      /not a URL/,
    );
  });

  it("defaults to the port the compose file publishes", () => {
    expect(loadConfig(enough).port).toBe(3100);
  });

  it("serves the pages from the instance's own origin, and no egma-run one", () => {
    expect(loadConfig(enough).baseUrl).toBe("http://localhost:3101");
    expect(
      loadConfig({ ...enough, EGMA_BASE_URL: "https://egma.acme.example/" })
        .baseUrl,
    ).toBe("https://egma.acme.example");
  });

  it("holds one organization by default, because the default deployment is somebody's own", () => {
    expect(loadConfig(enough).singleOrganization).toBe(true);
    expect(
      loadConfig({ ...enough, EGMA_SINGLE_ORGANIZATION: "false" })
        .singleOrganization,
    ).toBe(false);
  });

  it("believes no proxy until it is told there is one", () => {
    expect(loadConfig(enough).trustProxy).toBe(false);
    expect(loadConfig({ ...enough, EGMA_TRUST_PROXY: "yes" }).trustProxy).toBe(
      true,
    );
  });

  it("refuses a yes-or-no setting that is neither", () => {
    expect(() =>
      loadConfig({ ...enough, EGMA_SINGLE_ORGANIZATION: "perhaps" }),
    ).toThrow(/not a yes or a no/);
  });

  /**
   * Mail is the one setting whose *absence* is a supported way to run egma
   * rather than a mistake, so it is asserted as one. A self-hoster who never
   * sets it can still add a second person.
   */
  it("starts perfectly well with no mail transport, which is the ordinary case", () => {
    expect(loadConfig(enough).smtp).toBeUndefined();
  });

  it("takes a transport as one variable, with a from address it can derive", () => {
    expect(
      loadConfig({
        ...enough,
        EGMA_BASE_URL: "https://egma.acme.example",
        EGMA_SMTP_URL: "smtp://postmaster:secret@smtp.acme.example:587",
      }).smtp,
    ).toEqual({
      url: "smtp://postmaster:secret@smtp.acme.example:587",
      from: "egma <egma@egma.acme.example>",
    });
  });

  /**
   * Set-but-unusable refuses to start, and unset does not. A transport egma
   * believes in and cannot reach is worse than none: it turns verification on
   * and stops handing invitation links back, and then delivers neither.
   */
  it("refuses a transport it could never reach, rather than quietly delivering nothing", () => {
    expect(() => loadConfig({ ...enough, EGMA_SMTP_URL: "not a url" })).toThrow(
      /EGMA_SMTP_URL is not a URL/,
    );
    expect(() =>
      loadConfig({ ...enough, EGMA_SMTP_URL: "https://mail.acme.example" }),
    ).toThrow(/smtp/);
  });
});

/**
 * Which transport is configured decides two other things by itself — whether
 * signup waits for a verification click, and whether an invitation hands its
 * link back. There is deliberately no second setting for either to disagree
 * with, and `delivers` is the whole of how they are told apart.
 */
describe("the email seam", () => {
  it("says nothing was delivered when there is nowhere to deliver it", async () => {
    const sent: Email[] = [];
    const sender = loggingEmailSender((email) => sent.push(email));

    expect(sender.delivers).toBe(false);
    await sender.send({ to: "bob@acme.example", subject: "hi", body: "there" });

    // Written down rather than dropped: a self-hoster with no transport still
    // sees every message egma would have sent, where they are already looking.
    expect(sent.map((email) => email.to)).toEqual(["bob@acme.example"]);
  });

  it("says messages are delivered the moment SMTP is configured, with no second switch", () => {
    expect(
      smtpEmailSender({
        url: "smtp://postmaster:secret@smtp.acme.example:587",
        from: "egma <egma@acme.example>",
      }).delivers,
    ).toBe(true);
  });
});

describe("the API once it has booted", () => {
  let database: EmptyDatabase;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = await createEmptyDatabase("api_health");
    await runMigrations(database.url);
    connect({ databaseUrl: database.url, maxConnections: 2 });
    app = buildApi({ config: testConfig({ databaseUrl: database.url }) }).app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await disconnect();
    await database.drop();
  });

  it("reports healthy, having reached Postgres", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", postgres: "reachable" });
  });
});
