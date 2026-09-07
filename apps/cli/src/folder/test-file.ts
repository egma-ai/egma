/**
 * Parse and serialize format 5 test Markdown.
 * Frontmatter holds identity, persona references, version, and identity_revision.
 * The body contains Scenario, Expected behaviors, and optional Mock tools and Env.
 * Mock tools and env are test-owned versioned content. Reject other format versions.
 *
 * version tracks content independently of identity_revision for name and description.
 * Unsynced files omit both tokens. Persona IDs are authoritative when present;
 * new files may name personas for platform resolution during push.
 * One serializer produces stable pull/push output.
 */

import { FolderProblem } from "./problem.ts";
import { ENV_LINE, readEnv, writeEnv, type TestEnv } from "./env.ts";
import {
  MOCK_TOOLS_LINE,
  readMockTools,
  writeMockTools,
  type MockToolEntry,
} from "./mock-tools.ts";
import {
  readYaml,
  sequenceAt,
  textAt,
  yamlScalar,
  type YamlMapping,
} from "./yaml.ts";
import { portableTestFileName } from "./portable-path.ts";

/**
 * The format this serializer writes, and the number a file says out loud.
 *
 * A number rather than a feature list, because every folder-reading command
 * must decide the same thing before it writes: this exact shape is supported,
 * and every other shape is refused. There is no legacy reader.
 */
export const TEST_FILE_FORMAT = 5;

/**
 * One statement about what should happen — a plain sentence, and nothing else.
 *
 * It carried a priority in format 2 and it does not now. Every expected
 * behavior has to hold, so there was nothing left for a per-sentence marker to
 * say; how loudly a *grader* speaks is a setting on the grader.
 */
export type ExpectedBehavior = string;

/** One statement as a file wrote it down, which is the same shape. */
export type FileBehavior = string;

/**
 * One persona a test names: who they are on the platform, and what a reviewer
 * reads. The id is authoritative when present. Format 5 permits an empty id on
 * a newly authored name until a push and pull write the stable identity.
 */
export type FilePersona = {
  /** The `prs_` id, or empty on a file that has only ever carried names. */
  readonly id: string;
  /** What a reviewer reads. Refreshed by every pull. */
  readonly name: string;
};

/** What one file says. */
export type TestFile = {
  /** What the file itself claimed. Everything Egma writes says 5. */
  readonly format: number;
  readonly name: string;
  /** Live metadata beside the name; `null` when the file names none. */
  readonly description: string | null;
  /** Named only when the situation demands one; empty takes the default. */
  readonly personas: readonly FilePersona[];
  /** The content version this file was last pulled or pushed at, or `null`. */
  readonly version: string | null;
  /** The live-half revision this file was last synced at, or `null`. */
  readonly identityRevision: string | null;
  /** The situation the agent is put in, as prose. */
  readonly scenario: string;
  /** In the order they were authored. */
  readonly expectedBehaviors: readonly FileBehavior[];
  /**
   * The tools this test answers for itself. Empty leaves every one of the
   * agent's tools running for real.
   */
  readonly mockTools: readonly MockToolEntry[];
  /** The world this test is conducted in, or `null` when it names none. */
  readonly env: TestEnv | null;
};

export const SCENARIO_HEADING = "## Scenario";
export const EXPECTED_BEHAVIORS_HEADING = "## Expected behaviors";

/** The first two headings, however many hashes and in whatever case. */
const SCENARIO_LINE = /^#{1,6}\s*scenario\s*$/iu;
const EXPECTED_BEHAVIORS_LINE = /^#{1,6}\s*expected\s+behaviou?rs\s*$/iu;

/** `1. `, `1) `, `- ` or `* ` — the four ways a list gets typed. */
const LIST_ITEM = /^(?:\d+[.)]|[-*])\s+(.*)$/u;

function frontmatterOf(document: string, where: string): {
  readonly mapping: YamlMapping;
  readonly body: string;
} {
  // A document that does not open with the fence has no frontmatter, which is
  // what a hand-written first draft looks like. It is a body and nothing else.
  if (!/^---\s*\r?\n/u.test(document)) return { mapping: {}, body: document };

  const opened = document.slice(document.indexOf("\n") + 1);
  const close = opened.search(/^---\s*$/mu);
  if (close === -1) return { mapping: {}, body: document };

  const raw = opened.slice(0, close);
  const after = opened.slice(close);
  return {
    mapping: readYaml(raw, where),
    body: after.slice(after.indexOf("\n") + 1),
  };
}

/** The last line matching one heading, inside one window of the body. */
function lastHeadingIn(
  lines: readonly string[],
  heading: RegExp,
  from: number,
  to: number,
): number {
  for (let at = to - 1; at >= from; at -= 1) {
    if (heading.test((lines[at] as string).trim())) return at;
  }
  return -1;
}

/**
 * Split Scenario, Expected behaviors, Mock tools, and Env in their serialized order.
 * The first Scenario heading opens scenario content; use the last valid later
 * boundary inside each section's order window. This preserves headings quoted
 * inside scenario prose. Content before Scenario, or without headings, is scenario text.
 */
function partsOf(body: string): {
  readonly scenario: string;
  readonly behaviors: string;
  readonly mockTools: readonly string[];
  /** Null where the file carries no env heading at all, which is not `{}`. */
  readonly env: readonly string[] | null;
} {
  const lines = body.split("\n");
  const startsAt = lines.findIndex((line) => SCENARIO_LINE.test(line.trim()));
  const behaviorsAt = lastHeadingIn(lines, EXPECTED_BEHAVIORS_LINE, 0, lines.length);
  const below = behaviorsAt + 1;
  const envAt = lastHeadingIn(lines, ENV_LINE, below, lines.length);
  const mockToolsAt = lastHeadingIn(
    lines,
    MOCK_TOOLS_LINE,
    below,
    envAt === -1 ? lines.length : envAt,
  );

  const ends = [behaviorsAt, mockToolsAt, envAt].filter((at) => at !== -1);
  const from = startsAt === -1 ? 0 : startsAt + 1;
  const scenarioTo = ends.length === 0 ? lines.length : Math.min(...ends);
  const behaviorsTo =
    mockToolsAt !== -1 ? mockToolsAt : envAt !== -1 ? envAt : lines.length;
  const mockToolsTo = envAt === -1 ? lines.length : envAt;

  return {
    scenario: lines.slice(from, Math.max(from, scenarioTo)).join("\n").trim(),
    behaviors: behaviorsAt === -1 ? "" : lines.slice(behaviorsAt + 1, behaviorsTo).join("\n"),
    mockTools: mockToolsAt === -1 ? [] : lines.slice(mockToolsAt + 1, mockToolsTo),
    env: envAt === -1 ? null : lines.slice(envAt + 1),
  };
}

/**
 * The ordered list under the heading.
 *
 * A statement that wrapped onto a second line is one statement, so a line that
 * is not itself a list item joins the one above it. An empty list is read as an
 * empty list and never as a failure: a test with nothing to check is refused at
 * egma's door, in egma's own words, and reading it here is what lets it get
 * there to be refused.
 */
function behaviorsIn(text: string): readonly FileBehavior[] {
  const behaviors: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      const said = (item[1] as string).trim();
      behaviors.push(said);
      continue;
    }
    const last = behaviors.length - 1;
    if (last >= 0) behaviors[last] = `${behaviors[last] as string} ${line}`;
  }
  return behaviors.filter((one) => one !== "");
}

/**
 * The personas one file names, in the order it named them.
 *
 * Format 5 accepts a stable `id` plus display `name`, or a name-only authored
 * entry that has not been resolved by the platform yet.
 */
function personasIn(mapping: YamlMapping): readonly FilePersona[] {
  const found: FilePersona[] = [];
  for (const entry of sequenceAt(mapping, "personas")) {
    if (typeof entry === "string") {
      const name = entry.trim();
      if (name !== "") found.push({ id: "", name });
      continue;
    }
    if (typeof entry !== "object") continue;
    const id = textAt(entry, "id") ?? "";
    const name = textAt(entry, "name") ?? "";
    if (id === "" && name === "") continue;
    found.push({ id, name });
  }
  return found;
}

/**
 * Read one file. `where` names it in anything this refuses.
 *
 * The name falls back to the file's own name when the frontmatter carries none,
 * because a file called `missed-appointment-reschedule.md` has already said what
 * it is called and refusing it would be pedantry.
 */
export function parseTestFile(
  document: string,
  where: string,
  fallbackName: string,
): TestFile {
  const { mapping, body } = frontmatterOf(document, where);
  const { scenario, behaviors, mockTools, env } = partsOf(body);
  const writtenFormat = mapping["format"];
  if (writtenFormat !== TEST_FILE_FORMAT) {
    const said =
      typeof writtenFormat === "string" || typeof writtenFormat === "number"
        ? String(writtenFormat)
        : "none";
    throw new FolderProblem(where, 
      `${where} uses test file format ${said}. This Egma requires format ${String(TEST_FILE_FORMAT)} and has no legacy reader.`,
    );
  }
  // The env is a section rather than a frontmatter key: it is a whole JSON
  // value, and the frontmatter carries only what a machine reads at a glance.
  const supported = [
    "format",
    "name",
    "description",
    "personas",
    "version",
    "identity_revision",
  ];
  const unsupported = Object.keys(mapping).filter((key) => !supported.includes(key));
  if (unsupported.length > 0) {
    throw new FolderProblem(where, `${where} has unsupported frontmatter: ${unsupported.join(", ")}.`);
  }

  return {
    format: TEST_FILE_FORMAT,
    name: textAt(mapping, "name") ?? fallbackName,
    description: textAt(mapping, "description"),
    personas: personasIn(mapping),
    version: textAt(mapping, "version"),
    identityRevision: textAt(mapping, "identity_revision"),
    scenario,
    expectedBehaviors: behaviorsIn(behaviors),
    mockTools: readMockTools(mockTools, where),
    env: env === null ? null : readEnv(env, where),
  };
}

/**
 * One expected behavior as the format holds it: one statement on one line.
 *
 * A statement that arrives with a line break in it is written as one line,
 * because that is the only shape the list has and it is exactly what reading
 * the file gives back — a line that is not itself a list item joins the one
 * above it with a space. Writing the break would mean the file said one thing
 * and read as another.
 */
function oneLine(behavior: string): string {
  return behavior.replaceAll(/\s+/gu, " ").trim();
}

/**
 * Serialize from normalized values, without retaining old file formatting.
 * This makes push followed by pull stable. Expected behaviors are one blocking
 * statement per line, with no priority marker in format 5.
 */
export function serializeTestFile(file: TestFile): string {
  const personas = file.personas.filter(
    (persona) => persona.id.trim() !== "" || persona.name.trim() !== "",
  );
  const frontmatter = [
    `format: ${String(TEST_FILE_FORMAT)}`,
    `name: ${yamlScalar(file.name)}`,
  ];
  if (file.description !== null && file.description.trim() !== "") {
    frontmatter.push(`description: ${yamlScalar(file.description)}`);
  }
  if (file.version !== null && file.version !== "") {
    frontmatter.push(`version: ${yamlScalar(file.version)}`);
  }
  if (file.identityRevision !== null && file.identityRevision !== "") {
    frontmatter.push(`identity_revision: ${yamlScalar(file.identityRevision)}`);
  }
  if (personas.length > 0) {
    frontmatter.push("personas:");
    for (const persona of personas) {
      // The id opens the entry because it is the one egma resolves. A persona
      // Egma has no id for a newly authored persona name until push resolves
      // it. The name-only mapping is part of format 5, not a legacy reader.
      const lines =
        persona.id.trim() === ""
          ? [`  - name: ${yamlScalar(persona.name)}`]
          : [
              `  - id: ${yamlScalar(persona.id)}`,
              ...(persona.name.trim() === ""
                ? []
                : [`    name: ${yamlScalar(persona.name)}`]),
            ];
      frontmatter.push(...lines);
    }
  }

  const scenario = file.scenario.trim();
  const behaviors = file.expectedBehaviors
    .map(oneLine)
    .filter((one) => one !== "")
    .map((one, index) => `${String(index + 1)}. ${one}`);

  return [
    "---",
    ...frontmatter,
    "---",
    SCENARIO_HEADING,
    ...(scenario === "" ? [] : [scenario]),
    EXPECTED_BEHAVIORS_HEADING,
    ...behaviors,
    // Last, and each absent altogether on the ordinary test that says nothing
    // under it: a heading with nothing under it would read as a claim about a
    // mocked world, or a world outside the call, that this test does not make.
    ...writeMockTools(file.mockTools),
    ...writeEnv(file.env),
    "",
  ].join("\n");
}

/**
 * The file name a test is written under: its own name, in the shape a file name
 * can be. Two tests that reduce to the same name are told apart by the caller,
 * which is the only place that knows what else is in the folder.
 */
export function fileNameFor(name: string): string {
  return portableTestFileName(name);
}
