import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  runMigrations,
} from "@egma/db";
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
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = await createEmptyDatabase("api_health");
    traceStore = await createEmptyTraceStore("api_health");
    await runMigrations(database.url);
    connect({ databaseUrl: database.url, maxConnections: 2 });
    connectClickHouse({ clickhouseUrl: traceStore.url, maxOpenConnections: 2 });
    app = buildApi({
      config: testConfig({
        databaseUrl: database.url,
        clickhouseUrl: traceStore.url,
      }),
    }).app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await disconnect();
    await disconnectClickHouse();
    await database.drop();
    await traceStore.drop();
  });

  /**
   * Both stores, because the container health check is what the web service
   * waits on and what an operator reads. An API that answered `ok` while the
   * trace store was unreachable would be reporting on half of egma.
   */
  it("reports healthy, having reached both stores", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      postgres: "reachable",
      clickhouse: "reachable",
    });
  });

  /**
   * Last in the file, because it takes the trace store away and does not put it
   * back. What it proves is that the response names which store is missing:
   * "unavailable" on its own sends an operator looking at both.
   */
  it("says which store it could not reach, rather than only that it failed", async () => {
    await disconnectClickHouse();

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "unavailable",
      postgres: "reachable",
      clickhouse: "unreachable",
    });
  });
});
