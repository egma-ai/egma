import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMigratedDatabase,
  openSingleConnection,
  type MigratedDatabase,
  type SingleConnection,
} from "./support/database.ts";

describe("the project grader records", () => {
  let database: MigratedDatabase;
  let connection: SingleConnection;

  beforeAll(async () => {
    database = await createMigratedDatabase("project_grader_schema");
    connection = await openSingleConnection(database.url);
  });

  afterAll(async () => {
    await connection?.close();
    await database?.drop();
  });

  it("keeps shared definition history separate from one project's live policy", async () => {
    const { rows } = await connection.sql<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'grader_definition',
            'grader_definition_version',
            'project_grader',
            'grader_library',
            'grader_library_version',
            'grader',
            'grader_version'
          )
        order by table_name`,
    );

    expect(rows.map((row) => row.table_name)).toEqual([
      "grader_definition",
      "grader_definition_version",
      "project_grader",
    ]);
  });

  it("creates a definition and its first immutable version in one transaction", async () => {
    const definitionId = newId("grl");
    await connection.sql("begin");
    await connection.sql(
      `insert into grader_definition
         (id, name, scope_editable, current_definition_version)
       values ($1, 'Expected behaviors fixture', false, 1)`,
      [definitionId],
    );
    await connection.sql(
      `insert into grader_definition_version
         (definition_id, version, type, prompt, parameter_contract,
          modalities, judge_model)
       values ($1, 1, 'llm_as_judge', 'Grade it', '[]'::jsonb,
               '["chat", "voice"]'::jsonb,
               '{"provider":"openai","model":"gpt-5"}'::jsonb)`,
      [definitionId],
    );
    await connection.sql("commit");

    const { rows } = await connection.sql<{ version: number }>(
      `select version from grader_definition_version where definition_id = $1`,
      [definitionId],
    );
    expect(rows).toEqual([{ version: 1 }]);

    const constraint = await connection.sql<{
      is_deferrable: string;
      initially_deferred: string;
    }>(
      `select is_deferrable, initially_deferred
         from information_schema.table_constraints
        where constraint_schema = 'public'
          and table_name = 'grader_definition'
          and constraint_name = 'grader_definition_current_version_fk'`,
    );
    expect(constraint.rows).toEqual([
      { is_deferrable: "YES", initially_deferred: "YES" },
    ]);

    await expect(
      connection.sql(
        `update grader_definition_version set prompt = 'rewritten' where definition_id = $1 and version = 1`,
        [definitionId],
      ),
    ).rejects.toThrow("grader definition versions are immutable");
  });
});
