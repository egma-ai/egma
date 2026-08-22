import { afterEach, describe, expect, it } from "vitest";

import {
  DEVICE_POLL_OUTCOMES,
  IDENTITY_PROVIDER_SEAM,
  type IdentityProvider,
} from "../src/auth/seam.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * What egma asks of an auth provider, and the width of it.
 *
 * The seam is the whole reason a vendor decision taken today is not permanent,
 * and a seam nobody states is a seam that grows. So its width is written down
 * as a list and asserted here, and a build rule keeps the provider's own
 * package out of every file but the two that implement this.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

async function signedIn(): Promise<string> {
  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email: "ada@acme.example",
      password: "a-long-enough-password",
      organizationName: "Acme",
    },
  });
  expect(created.statusCode).toBe(201);
  return cookiesFrom(created.headers["set-cookie"]);
}

function requestWith(cookie: string | null): Request {
  return new Request("http://localhost:3101/api/me", {
    headers: cookie === null ? {} : { cookie },
  });
}

describe("the seam", () => {
  it("is four calls: resolve an identity, the two device-flow calls, revoke a session", () => {
    expect([...IDENTITY_PROVIDER_SEAM]).toEqual([
      "resolveIdentity",
      "startDeviceAuthorization",
      "pollDeviceAuthorization",
      "revokeSession",
    ]);
  });

  /**
   * Adding a call to the interface without listing it above stops the build
   * here rather than quietly widening what egma depends on. `satisfies` on the
   * list catches a name that is not in the interface; this catches the other
   * direction.
   */
  it("is stated in full, so a fifth call cannot be added quietly", () => {
    type Unlisted = Exclude<
      keyof IdentityProvider,
      (typeof IDENTITY_PROVIDER_SEAM)[number]
    >;
    type Complete = [Unlisted] extends [never] ? true : false;

    const complete: Complete = true;
    expect(complete).toBe(true);
  });

  /**
   * Written down and also true. The list above states what egma depends on;
   * this says the provider egma actually runs answers all of it, so a call that
   * exists only on paper cannot sit there unnoticed until a terminal needs it.
   */
  it("is implemented in full by the provider this instance runs", async () => {
    api = await createApi("seam_complete");

    for (const call of IDENTITY_PROVIDER_SEAM) {
      expect(api.identity.provider[call], call).toBeTypeOf("function");
    }
  });

  it("names every answer a device poll can give other than a person", () => {
    expect([...DEVICE_POLL_OUTCOMES]).toEqual([
      "pending",
      "slow_down",
      "denied",
      "expired",
    ]);
  });
});

describe("the provider's footprint on the schema", () => {
  /** Every table egma's own migrations create, and the whole of it. */
  const EGMA_TABLES = [
    "account",
    "agent",
    "api_key",
    "connection",
    "device_code",
    "grader",
    "grader_library",
    "grader_library_version",
    "grader_version",
    "grading_job",
    "grading_plan",
    "idempotent_operation",
    "invitation",
    "membership",
    "mock_tool",
    "mock_tool_agent",
    "monitoring_state",
    "organization",
    "organization_settings",
    "persona",
    "persona_version",
    "platform_setting",
    "project",
    "retell_call_retry",
      "run",
    "run_event",
    "session",
    "simulation",
    "test",
    "test_persona",
    "test_suite",
    "test_version",
    "user",
    "verification",
  ];

  it("is nothing at all: the provider reads and writes, and cannot alter", async () => {
    api = await createApi("seam_ddl");

    const before = await columns();
    await signedIn();
    expect(await columns()).toEqual(before);

    const { rows } = await api.database.sql<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual(EGMA_TABLES);
  });

  it("has no organization plugin behind it, and no team standing in for a project", async () => {
    api = await createApi("seam_no_plugins");
    await signedIn();

    // The provider ships an organization plugin whose tables are these. It is
    // not enabled: its authorization is organization-scoped and resource-blind,
    // and `teamMember` — the level that would have to carry a project role —
    // is the one table in it that takes no additional fields. So egma owns
    // `organization`, `project` and `membership`, with egma's own foreign keys.
    const { rows } = await api.database.sql<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('team', 'team_member', 'member', 'apikey', 'api_keys')`,
    );
    expect(rows).toEqual([]);
  });

  async function columns(): Promise<readonly string[]> {
    const { rows } = await api.database.sql<{ at: string }>(
      `select table_name || '.' || column_name as at
         from information_schema.columns
        where table_schema = 'public'
        order by table_name, column_name`,
    );
    return rows.map((row) => row.at);
  }
});

describe("resolving an identity", () => {
  it("turns a session cookie into a person", async () => {
    api = await createApi("seam_resolve");
    const cookie = await signedIn();

    expect(
      await api.identity.provider.resolveIdentity(requestWith(cookie)),
    ).toEqual({
      externalIdentityId: expect.stringMatching(/^usr_/),
      email: "ada@acme.example",
    });
  });

  it("answers nobody when there is no session", async () => {
    api = await createApi("seam_resolve_none");
    await signedIn();

    expect(
      await api.identity.provider.resolveIdentity(requestWith(null)),
    ).toBeNull();
  });

  it("answers nobody for a cookie that was never signed here", async () => {
    api = await createApi("seam_resolve_forged");
    await signedIn();

    expect(
      await api.identity.provider.resolveIdentity(
        requestWith("egma.session_token=not-a-real-token"),
      ),
    ).toBeNull();
  });
});

describe("revoking a session", () => {
  it("takes effect on the very next request", async () => {
    api = await createApi("seam_revoke");
    const cookie = await signedIn();

    const before = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    const { rows } = await api.database.sql<{ token: string }>(
      "select token from session",
    );
    const token = rows[0]?.token;
    expect(token).toBeTypeOf("string");

    await api.identity.provider.revokeSession(token as string);

    const after = await api.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});
