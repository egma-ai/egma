import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  runMigrations,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  loggingEmailSender,
  smtpEmailSender,
  type Email,
} from "../src/auth/email.ts";
import { loadConfig } from "../src/config.ts";
import { LARGEST_STAGEABLE_RECORD_BYTES } from "../src/ingestion/record.ts";
import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { buildApi } from "../src/server.ts";
import { createApi, testConfig } from "./support/api.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import { mintKey, signUp, syntheticExport } from "./support/traces.ts";
import {
  createEmptyDatabase,
  type EmptyDatabase,
} from "../../../packages/db/test/support/database.ts";
import {
  createEmptyTraceStore,
  type EmptyTraceStore,
} from "../../../packages/db/test/support/clickhouse.ts";

/** The least an environment can carry and still be startable. */
const enough = {
  DATABASE_URL: "postgres://x/y",
  CLICKHOUSE_URL: "http://x:8123/y",
  EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
  EGMA_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
  EGMA_SIMULATOR_SERVICE_TOKEN: "egma_st_held-by-this-test-suite-alone",
};

describe("configuration", () => {
  it("refuses to start without a database to talk to", () => {
    expect(() => loadConfig({ ...enough, DATABASE_URL: "" })).toThrow(
      /DATABASE_URL is required/,
    );
  });

  /**
   * On the same terms as Postgres, and deliberately not as an optional extra.
   * There is no second analytical path behind ClickHouse, so an instance that
   * started without one would accept a trace and have nowhere to put it.
   */
  it("refuses to start without a trace store to talk to", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://x/y", EGMA_AUTH_SECRET: "s" }),
    ).toThrow(/CLICKHOUSE_URL is required/);
  });

  it("refuses a trace store address it could never reach", () => {
    expect(() =>
      loadConfig({ ...enough, CLICKHOUSE_URL: "not a url" }),
    ).toThrow(/CLICKHOUSE_URL is not a URL/);
    expect(() =>
      loadConfig({ ...enough, CLICKHOUSE_URL: "postgres://x/y" }),
    ).toThrow(/reaches ClickHouse over http/);
  });

  it("refuses to start without a secret to sign sessions with", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://x/y",
        CLICKHOUSE_URL: "http://x:8123/y",
      }),
    ).toThrow(/EGMA_AUTH_SECRET is required/);
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

  /**
   * On the auth secret's terms exactly: the claim door hands out customers'
   * live provider credentials, so an instance may not start with that door
   * unguarded — and a token the door could never match (the claim path only
   * reads bearers with the service prefix) is refused as loudly as none.
   */
  it("refuses to start without a usable simulator service token", () => {
    expect(() =>
      loadConfig({ ...enough, EGMA_SIMULATOR_SERVICE_TOKEN: "" }),
    ).toThrow(/EGMA_SIMULATOR_SERVICE_TOKEN is required/);
    expect(() =>
      loadConfig({
        ...enough,
        EGMA_SIMULATOR_SERVICE_TOKEN: "prefixless-token",
      }),
    ).toThrow(/must start with egma_st_/);
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

  /**
   * This one narrowed: a base URL carrying a path used to have its trailing
   * slashes trimmed and the rest kept. A deployment that had been running that
   * way meets the refusal for the first time on an upgrade, so the message has
   * to name the part to remove and the value to use — and it must never repeat
   * a password back, only the fact that there is one.
   */
  it("refuses a base URL that is not one HTTP origin, and says what to change", () => {
    expect(() =>
      loadConfig({ ...enough, EGMA_BASE_URL: "ftp://egma.acme.example" }),
    ).toThrow(/not an HTTP origin/);

    const cases: readonly [string, RegExp][] = [
      ["https://user:hunter2-not-real@egma.acme.example", /a username or password/],
      ["https://egma.acme.example/api", /the path \/api/],
      ["https://egma.acme.example?one=two", /a query/],
      ["https://egma.acme.example#part", /a fragment/],
    ];
    for (const [given, names] of cases) {
      expect(() => loadConfig({ ...enough, EGMA_BASE_URL: given })).toThrow(names);
      // The value to put there instead, so nobody has to work it out.
      expect(() => loadConfig({ ...enough, EGMA_BASE_URL: given })).toThrow(
        /Set it to https:\/\/egma\.acme\.example and start Egma again/,
      );
      expect(() => loadConfig({ ...enough, EGMA_BASE_URL: given })).not.toThrow(
        /hunter2-not-real/,
      );
    }
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
      from: "Egma <egma@egma.acme.example>",
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

  /**
   * The recording store, on the mail transport's exact terms: **unset is the
   * ordinary case and is never an error**, and set-but-unusable refuses to
   * start rather than being discovered by somebody pressing play.
   *
   * Naming where a browser reaches the store is the whole of what turns
   * resolution on — the pattern the simulator already uses, where naming an
   * endpoint is what sends recordings to object storage at all.
   */
  it("resolves no recording until somebody says where a browser reaches the store", () => {
    expect(loadConfig(enough).blob).toBeUndefined();

    const named = loadConfig({
      ...enough,
      EGMA_BLOB_PUBLIC_URL: "https://recordings.acme.example/",
      EGMA_BLOB_ACCESS_KEY_ID: "a-read-only-key-id",
      EGMA_BLOB_SECRET_ACCESS_KEY: "a-read-only-secret",
    });
    expect(named.blob).toEqual({
      // The trailing slash is dropped here rather than at every use, so the
      // path a signature is computed over cannot end up with a double slash in
      // it — which the store would treat as a different object entirely.
      publicUrl: "https://recordings.acme.example",
      bucket: "egma-recordings",
      region: "us-east-1",
      accessKeyId: "a-read-only-key-id",
      secretAccessKey: "a-read-only-secret",
    });
  });

  it("refuses half a store credential, by name, rather than losing every recording quietly", () => {
    // Half of this is a deployment where the platform runs, every run runs, and
    // every single press of play fails against the store's own refusal — which
    // nobody reading the product can see.
    expect(() =>
      loadConfig({
        ...enough,
        EGMA_BLOB_PUBLIC_URL: "https://recordings.acme.example",
        EGMA_BLOB_ACCESS_KEY_ID: "a-read-only-key-id",
      }),
    ).toThrow(/EGMA_BLOB_SECRET_ACCESS_KEY/);
    expect(() =>
      loadConfig({
        ...enough,
        EGMA_BLOB_PUBLIC_URL: "https://recordings.acme.example",
        EGMA_BLOB_SECRET_ACCESS_KEY: "a-read-only-secret",
      }),
    ).toThrow(/EGMA_BLOB_ACCESS_KEY_ID/);
  });

  it("refuses an address a browser could never fetch a recording from", () => {
    const withCredential = {
      ...enough,
      EGMA_BLOB_ACCESS_KEY_ID: "a-read-only-key-id",
      EGMA_BLOB_SECRET_ACCESS_KEY: "a-read-only-secret",
    };
    expect(() =>
      loadConfig({ ...withCredential, EGMA_BLOB_PUBLIC_URL: "not a url" }),
    ).toThrow(/EGMA_BLOB_PUBLIC_URL is not a URL/);
    // A scheme a browser cannot fetch over is refused here rather than becoming
    // a link that resolves to nothing on the one page that offers it.
    expect(() =>
      loadConfig({
        ...withCredential,
        EGMA_BLOB_PUBLIC_URL: "s3://egma-recordings",
      }),
    ).toThrow(/EGMA_BLOB_PUBLIC_URL speaks s3:/);
  });

  it("refuses a bucket name no store would take, for the reason a key is confined", () => {
    // A name carrying a separator puts a prefix nobody configured in front of
    // every key, so a reference the simulator can resolve resolves to nothing
    // here — and the store's answer names the object rather than the setting.
    expect(() =>
      loadConfig({
        ...enough,
        EGMA_BLOB_PUBLIC_URL: "https://recordings.acme.example",
        EGMA_BLOB_ACCESS_KEY_ID: "a-read-only-key-id",
        EGMA_BLOB_SECRET_ACCESS_KEY: "a-read-only-secret",
        EGMA_BLOB_BUCKET: "recordings/of-acme",
      }),
    ).toThrow(/EGMA_BLOB_BUCKET must be a bucket name/);
  });

  it("refuses a store address carrying anything after the port", () => {
    // The same narrowing EGMA_BASE_URL makes, for a reason of its own: a
    // signature covers the whole path, so a store served under a sub-path works
    // only if the proxy in front passes its own prefix through — and the
    // ordinary arrangement strips it, which makes every link signed for one
    // path and presented at another. Refused while this setting is new enough
    // that no deployment is on it.
    const withCredential = {
      ...enough,
      EGMA_BLOB_ACCESS_KEY_ID: "a-read-only-key-id",
      EGMA_BLOB_SECRET_ACCESS_KEY: "a-read-only-secret",
    };
    expect(() =>
      loadConfig({
        ...withCredential,
        EGMA_BLOB_PUBLIC_URL: "https://egma.acme.example/recordings",
      }),
    ).toThrow(/must be only the address a browser reaches/);
    // And it names what to set instead, because a deployment meeting this on an
    // upgrade should not have to work out which part offended.
    expect(() =>
      loadConfig({
        ...withCredential,
        EGMA_BLOB_PUBLIC_URL: "https://egma.acme.example/recordings",
      }),
    ).toThrow(/Set it to https:\/\/egma\.acme\.example/);
  });

  /**
   * The region, which has exactly one honest default and one deployment where
   * that default is a wrong answer rather than a default.
   *
   * MinIO ignores regions entirely and every signature must still carry one, so
   * `us-east-1` is what lets a deployment that named none work at all. Amazon's
   * own S3 does not ignore it: a bucket in `eu-west-1` signed for `us-east-1`
   * refuses every recording with `SignatureDoesNotMatch`, naming neither the
   * region nor the variable — which is the same nameless failure the browser's
   * address is a separate setting to prevent, arriving by a second route.
   */
  it("signs for us-east-1 where the store ignores regions, and refuses to guess where it does not", () => {
    const withCredential = {
      ...enough,
      EGMA_BLOB_ACCESS_KEY_ID: "a-read-only-key-id",
      EGMA_BLOB_SECRET_ACCESS_KEY: "a-read-only-secret",
    };

    expect(
      loadConfig({
        ...withCredential,
        EGMA_BLOB_PUBLIC_URL: "http://localhost:9000",
      }).blob?.region,
    ).toBe("us-east-1");

    expect(() =>
      loadConfig({
        ...withCredential,
        EGMA_BLOB_PUBLIC_URL: "https://egma-recordings.s3.eu-west-1.amazonaws.com",
      }),
    ).toThrow(/EGMA_BLOB_REGION/);

    // Named, and it is taken as named — the refusal is about guessing, never
    // about Amazon.
    expect(
      loadConfig({
        ...withCredential,
        EGMA_BLOB_PUBLIC_URL: "https://egma-recordings.s3.eu-west-1.amazonaws.com",
        EGMA_BLOB_REGION: "eu-west-1",
      }).blob?.region,
    ).toBe("eu-west-1");
  });

  /**
   * The one pair of schemes no browser will honour, and the one this file exists
   * to refuse by name.
   *
   * Both settings are addresses of the *same browser* — one to egma, one to the
   * store. A page served over https: may not fetch audio over http:: the browser
   * blocks it as mixed content before the request is sent, so the store is never
   * asked and the signature is never checked. The player fails and the only
   * sentence naming the reason is in a console the person pressing play is not
   * looking at. Which is exactly the failure the address binding and the region
   * were each refused at startup to prevent, arriving by a third route.
   */
  it("refuses an https egma pointed at an http store, and names both variables", () => {
    const withCredential = {
      ...enough,
      EGMA_BLOB_ACCESS_KEY_ID: "a-read-only-key-id",
      EGMA_BLOB_SECRET_ACCESS_KEY: "a-read-only-secret",
    };

    expect(() =>
      loadConfig({
        ...withCredential,
        EGMA_BASE_URL: "https://egma.acme.example",
        EGMA_BLOB_PUBLIC_URL: "http://192.168.1.10:9000",
      }),
    ).toThrow(/EGMA_BASE_URL is https:\/\/egma\.acme\.example/);
    expect(() =>
      loadConfig({
        ...withCredential,
        EGMA_BASE_URL: "https://egma.acme.example",
        EGMA_BLOB_PUBLIC_URL: "http://192.168.1.10:9000",
      }),
    ).toThrow(/EGMA_BLOB_PUBLIC_URL is http:\/\/192\.168\.1\.10:9000/);
    // And it says what the browser does, because "mixed content" is the word to
    // search for and egma is the only thing in a position to say it.
    expect(() =>
      loadConfig({
        ...withCredential,
        EGMA_BASE_URL: "https://egma.acme.example",
        EGMA_BLOB_PUBLIC_URL: "http://192.168.1.10:9000",
      }),
    ).toThrow(/mixed content/);
  });

  /**
   * The three coherent pairs, pinned together so that closing the incoherent one
   * cannot quietly close a deployment that works. The `http` + `http` case is the
   * whole of what `docker compose up` ships, and it is the one that would hurt.
   */
  it("starts on every pair of schemes a browser will actually honour", () => {
    const withCredential = {
      ...enough,
      EGMA_BLOB_ACCESS_KEY_ID: "a-read-only-key-id",
      EGMA_BLOB_SECRET_ACCESS_KEY: "a-read-only-secret",
    };

    // The default deployment: egma and its store both on this machine, in the
    // clear, which is what the compose file publishes.
    expect(
      loadConfig({
        ...withCredential,
        EGMA_BASE_URL: "http://localhost:3101",
        EGMA_BLOB_PUBLIC_URL: "http://localhost:9000",
      }).blob?.publicUrl,
    ).toBe("http://localhost:9000");

    // Both behind certificates, which is the deployment other people use.
    expect(
      loadConfig({
        ...withCredential,
        EGMA_BASE_URL: "https://egma.acme.example",
        EGMA_BLOB_PUBLIC_URL: "https://recordings.acme.example",
      }).blob?.publicUrl,
    ).toBe("https://recordings.acme.example");

    // The converse of the refusal above, and not a problem: a plaintext page
    // may fetch encrypted bytes. Nothing blocks this and egma must not either.
    expect(
      loadConfig({
        ...withCredential,
        EGMA_BASE_URL: "http://localhost:3101",
        EGMA_BLOB_PUBLIC_URL: "https://recordings.acme.example",
      }).blob?.publicUrl,
    ).toBe("https://recordings.acme.example");
  });

  /**
   * The judgement call, pinned so it is a decision rather than an oversight.
   *
   * A plaintext store at a *remote* address means the recording and a link
   * reusable for fifteen minutes are readable by anybody who can see the
   * traffic. It is allowed, because it is only reachable from an egma that is
   * itself plaintext — where the session cookie that opens every recording
   * already crosses the same network in the clear. Refusing the audio while
   * serving the cookie would apply a rule to one byte stream and not the other,
   * and would lock out a self-hoster on a private network egma cannot see. The
   * cost is written beside the example instead, in `.env.example`, the compose
   * file and the README.
   */
  it("allows a plaintext store on a remote address, because the page reaching it is plaintext too", () => {
    expect(
      loadConfig({
        ...enough,
        EGMA_BASE_URL: "http://192.168.1.10:3101",
        EGMA_BLOB_PUBLIC_URL: "http://192.168.1.10:9000",
        EGMA_BLOB_ACCESS_KEY_ID: "a-read-only-key-id",
        EGMA_BLOB_SECRET_ACCESS_KEY: "a-read-only-secret",
      }).blob?.publicUrl,
    ).toBe("http://192.168.1.10:9000");
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
        from: "Egma <egma@acme.example>",
      }).delivers,
    ).toBe(true);
  });
});

describe("the API once it has booted", () => {
  let database: EmptyDatabase;
  let traceStore: EmptyTraceStore;
  let storage: ObjectStorage;
  let logDirectory: string;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = await createEmptyDatabase("api_health");
    traceStore = await createEmptyTraceStore("api_health");
    storage = await startObjectStorage("api_health");
    logDirectory = mkdtempSync(path.join(tmpdir(), "egma-health-"));
    await runMigrations(database.url);
    connect({ databaseUrl: database.url, maxConnections: 2 });
    connectClickHouse({ clickhouseUrl: traceStore.url, maxOpenConnections: 2 });
    const base = testConfig({
      databaseUrl: database.url,
      clickhouseUrl: traceStore.url,
    });
    app = buildApi({
      config: storage.available
        ? {
            ...base,
            ingestion: {
              ...base.ingestion,
              store: storage.ingestStore,
              logDirectory,
            },
          }
        : base,
    }).app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await disconnect();
    await disconnectClickHouse();
    if (storage.available) storage.stop();
    rmSync(logDirectory, { recursive: true, force: true });
    await database.drop();
    await traceStore.drop();
  });

  /**
   * `/health` is write readiness: whether this process can still accept
   * evidence and keep the promise it makes when it does. Its body still names
   * every store, so an operator reading it sees which one is in trouble.
   */
  it("reports ready, having reached everything acceptance depends on", async () => {
    if (!storage.available) return;
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      role: "all",
      postgres: "reachable",
      clickhouse: "reachable",
      ingestion: "reachable",
      localLog: "writable",
    });
  });

  /**
   * The failure this whole release exists to remove. A slow or absent trace
   * store used to answer `503` here, which took the container out of its own
   * health check and the hosted address down with it — while the write path
   * was perfectly able to accept evidence and drain it later.
   *
   * Last in the file, because it takes the trace store away and does not put
   * it back.
   */
  it("stays ready while the trace store is unreachable, and says so", async () => {
    if (!storage.available) return;
    await disconnectClickHouse();

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      postgres: "reachable",
      clickhouse: "unreachable",
      ingestion: "reachable",
      localLog: "writable",
    });
  });
});

describe("write readiness", () => {
  let storage: ObjectStorage;

  beforeAll(async () => {
    storage = await startObjectStorage("api_write_readiness");
    if (!storage.available) {
      process.stderr.write(`\nskipping write readiness — ${storage.why}\n\n`);
    }
  });

  afterAll(() => {
    if (storage.available) storage.stop();
  });

  it("is unavailable when the ingestion object store cannot be reached", async () => {
    if (!storage.available) return;
    const api = await createApi("health_ingest_unreachable", {
      ingestStore: {
        ...storage.ingestStore,
        // A port nothing listens on: the acceptance promise cannot be kept,
        // and a health check that answered `ok` would be promising it.
        endpoint: "http://127.0.0.1:1",
      },
      ingestionRequestTimeoutMilliseconds: 300,
    });
    try {
      const response = await api.app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "unavailable",
        postgres: "reachable",
        ingestion: "unreachable",
      });
    } finally {
      await api.close();
    }
  });

  it("is unavailable when the local log will take no more records", async () => {
    if (!storage.available) return;
    const api = await createApi("health_log_full", {
      ingestStore: storage.ingestStore,
      // Zero records is a log that is full before anything is staged, which is
      // the same refusal a real bound reaches and the only way to reach it
      // without writing half a gigabyte in a suite.
      ingestionLogMaxRecords: 0,
    });
    try {
      const response = await api.app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "unavailable",
        postgres: "reachable",
        ingestion: "reachable",
        localLog: "full",
      });
    } finally {
      await api.close();
    }
  });

  /**
   * Both bounds bind, and they bind on different things: half a gigabyte of
   * transcripts and two hundred thousand tiny records are the same answer.
   * Readiness that watched only the count would report a writable log while
   * every request was already being refused for bytes — a health check saying
   * the opposite of what the door says, which is worse than no check at all.
   */
  it("is unavailable when the local log will take no more bytes", async () => {
    if (!storage.available) return;
    const api = await createApi("health_log_full_bytes", {
      ingestStore: storage.ingestStore,
      // Room for plenty of records, and no room at all for their bytes.
      ingestionLogMaxRecords: 1_000,
      ingestionLogMaxBytes: 0,
    });
    try {
      const response = await api.app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "unavailable",
        postgres: "reachable",
        ingestion: "reachable",
        localLog: "full",
        stagedRecords: 0,
      });
    } finally {
      await api.close();
    }
  });

  /**
   * The sliver between "under the bound" and "will take another record".
   *
   * A bound is on frames and a frame is a record plus the log's own header, so
   * a log can sit under its byte bound with less room left than the next
   * record needs. Readiness that compared usage against the bound called that
   * instance ready and left it in front of traffic every request of which the
   * door was already refusing — invisible from outside, because the health
   * check and the door disagreed.
   */
  it("is unavailable while under the byte bound but out of room for a record", async () => {
    if (!storage.available) return;
    const api = await createApi("health_log_sliver", {
      ingestStore: storage.ingestStore,
      // Room for one largest-record reserve and 512 bytes over it, so an empty
      // log is ready and the first staged record is what closes the gap.
      ingestionLogMaxBytes: LARGEST_STAGEABLE_RECORD_BYTES + 512,
      // Long enough that nothing seals and uploads during the case, so the
      // record stays staged and the bytes stay held.
      ingestionFlushMilliseconds: 60_000,
    });
    try {
      const empty = await api.app.inject({ method: "GET", url: "/health" });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toMatchObject({ localLog: "writable" });

      const acme = await signUp(api.app, "ada@acme.example", "Acme");
      const secret = await mintKey(
        api.app,
        acme.cookie,
        "a terminal",
        acme.projectId,
      );
      const accepted = api.app.inject({
        method: "POST",
        url: OTLP_TRACES_PATH,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        payload: syntheticExport({
          traceId: "cc00000000000000000000000000cc00",
          startedAt: new Date("2026-08-20T10:00:00.000Z"),
        }),
      });
      // The request is still open — its evidence is staged and waiting for the
      // flush that will not come inside this case — which is exactly the state
      // the health check has to read correctly.
      await vi.waitFor(async () => {
        const held = await api.app.inject({ method: "GET", url: "/health" });
        expect(held.json()).toMatchObject({ localLog: "full" });
      });

      const response = await api.app.inject({ method: "GET", url: "/health" });
      const body = response.json() as {
        stagedBytes: number;
        stagedRecords: number;
      };
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "unavailable",
        postgres: "reachable",
        ingestion: "reachable",
        localLog: "full",
      });
      // Under the bound the whole time, and out of room all the same.
      expect(body.stagedRecords).toBeGreaterThan(0);
      // Comfortably over the 512 bytes of slack and nowhere near the bound:
      // the log is barely used and has no room for a record all the same.
      expect(body.stagedBytes).toBeGreaterThan(512);
      expect(body.stagedBytes).toBeLessThan(
        LARGEST_STAGEABLE_RECORD_BYTES + 512,
      );
      void accepted;
    } finally {
      await api.close();
    }
  });

  it("is unavailable when Postgres has gone, whatever else is reachable", async () => {
    if (!storage.available) return;
    const api = await createApi("health_no_postgres", {
      ingestStore: storage.ingestStore,
    });
    try {
      await disconnect();
      const response = await api.app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "unavailable",
        postgres: "unreachable",
      });
    } finally {
      await api.close();
    }
  });
});

describe("the three roles one image serves", () => {
  let storage: ObjectStorage;

  beforeAll(async () => {
    storage = await startObjectStorage("api_roles");
  });

  afterAll(() => {
    if (storage.available) storage.stop();
  });

  it("refuses a role that is not one of the three, by name", () => {
    expect(() => loadConfig({ ...enough, EGMA_ROLE: "worker" })).toThrow(
      /EGMA_ROLE must be all, ingest or drain/,
    );
  });

  it("runs the whole path by default, which is what every deployment runs", () => {
    expect(loadConfig(enough).ingestion.role).toBe("all");
  });

  it("accepts each role, and lets only the accepting ones serve the door", async () => {
    if (!storage.available) return;
    for (const role of ["all", "ingest", "drain"] as const) {
      const api = await createApi(`health_role_${role}`, {
        ingestStore: storage.ingestStore,
        role,
      });
      try {
        const response = await api.app.inject({ method: "GET", url: "/health" });
        expect(response.json(), role).toMatchObject({ role });
        expect(response.statusCode, role).toBe(200);

        const door = await api.app.inject({
          method: "POST",
          url: OTLP_TRACES_PATH,
          headers: { "content-type": "application/json" },
          payload: "{}",
        });
        // `drain` serves no acceptance path at all, so the door is not there
        // rather than there and refusing.
        expect(door.statusCode === 404, role).toBe(role === "drain");
      } finally {
        await api.close();
      }
    }
  });
});
