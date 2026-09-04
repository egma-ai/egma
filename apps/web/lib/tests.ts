import type {
  CreateTestResponse,
  ListTestsResponse,
} from "@egma/platform-api/client";

/**
 * Test wire shapes, as the generated platform contract returns them.
 *
 * **What is left is what still has a reader.** The test full page and the
 * write-a-test sheet retired on 2026-08-24, and everything this file held for
 * them went with them: the address of a test's own page, the persona-overflow
 * cell, the live/versioned field lists that told a two-save form which half it
 * was saving, and the behavior checks that form ran before its Save. The grid
 * asks those questions of its own cells, and the version shapes have no reader
 * at all while versioning stays hidden from the interface.
 */
export type ListedTest = CreateTestResponse;
export type TestPage = ListTestsResponse;

/** One mocked answer a test carries, exactly as the platform stores it. */
export type TestMockTool = ListedTest["mockTools"][number];

/** The world outside the conversation, as the platform stores it. */
export type TestEnv = NonNullable<ListedTest["env"]>;

/** A value the platform will take, or the sentence saying why it will not. */
export type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly why: string };

/**
 * The two JSON fields, read the way the platform reads them.
 *
 * **These say the platform's own sentences, deliberately.** The grid's dialog
 * runs this before it sends anything, so a person who wrote `answer` twice sees
 * why without a round trip — and the sentence they see is the one they would
 * have got back, rather than a second, quieter opinion this screen invented.
 * The checks that need the exact serialized bytes stay on the server, because
 * only the server knows what it is about to write; a refusal from there is
 * shown in the same place.
 *
 * `packages/db/src/access/tests.ts` is where the same rules are kept for the
 * write itself, and it is the authority. What is here is a copy of the cheap
 * half of it, and it must say the same words.
 *
 * **The envelope has its own authority**, and it is
 * `apps/api/src/routes/tests.ts`: the door owns the shape of what arrives — a
 * list, of objects, with no key the shape has no place for — and the access
 * layer owns everything inside it. So the two sentences about the envelope are
 * copied from the door and the rest from the access layer, and a person who
 * writes the same mistake into the dialog and into a request reads one
 * sentence either way.
 */

/** The two keys an env may carry, and nothing else. */
const ENV_KEYS = ["retell_dynamic_variables", "job_dispatch_metadata"] as const;

/** Every variable beginning this is egma's own, written by the platform. */
const RESERVED_ENV_VARIABLE_PREFIX = "egma_";

/** Whether a parsed value is a plain JSON object rather than a list or null. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What somebody typed, as JSON, or the parser's own complaint about it. */
function parsed(text: string): Read<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (thrown) {
    const why = thrown instanceof Error ? thrown.message : String(thrown);
    return { ok: false, why: `Not valid JSON: ${why}` };
  }
}

/** An empty editor asks for nothing, which is what an empty list says. */
export function readMockTools(text: string): Read<readonly TestMockTool[]> {
  if (text.trim() === "") return { ok: true, value: [] };
  const held = parsed(text);
  if (!held.ok) return held;
  if (!Array.isArray(held.value)) {
    return { ok: false, why: "mockTools must be a list" };
  }

  const mockTools: TestMockTool[] = [];
  const seen = new Set<string>();
  for (const entry of held.value as readonly unknown[]) {
    if (!isObject(entry)) {
      return {
        ok: false,
        why:
          "each mock tool is an object naming the tool and what it answers " +
          "with, which looks like " +
          '{"tool": "get_availability", "answer": {"slots": []}}',
      };
    }
    // The envelope first, the way the door reads it: a key the shape has no
    // place for is answered before anything inside the entry is looked at, so
    // one entry with two mistakes is refused for the same one at both ends.
    for (const key of Object.keys(entry)) {
      if (key === "tool" || key === "answer" || key === "error") continue;
      return { ok: false, why: `a mock tool has no key "${key}"` };
    }
    const tool = entry.tool;
    if (typeof tool !== "string") {
      return {
        ok: false,
        why:
          "tool is the name of the agent's tool this mock tool answers for, " +
          `written as text, and this request sent ${typeof tool}.`,
      };
    }
    const named = tool.trim();
    if (named === "") {
      return {
        ok: false,
        why:
          "tool is the name of the agent's tool this mock tool answers for, " +
          "and this one is blank. Send the tool's name exactly as the agent " +
          "registers it.",
      };
    }
    if (seen.has(named)) {
      return {
        ok: false,
        why: `this test answers for "${named}" twice; mock each tool once`,
      };
    }
    seen.add(named);
    // A key that is there *and* says something. `answer: null` is an answer a
    // tool can give and counts; a key carrying nothing does not.
    const gives = "answer" in entry && entry.answer !== undefined;
    const fails = "error" in entry && entry.error !== undefined;
    if (gives && fails) {
      return {
        ok: false,
        why:
          `mock tool "${named}" answers with one thing: this one sent both ` +
          "answer and error. Send whichever branch the test needs.",
      };
    }
    if (!gives && !fails) {
      return {
        ok: false,
        why:
          `mock tool "${named}" answers with something: send answer with what ` +
          "the tool returns, or error with the failure it raises. This one " +
          "sent neither.",
      };
    }
    if (fails) {
      const message = entry.error;
      if (typeof message !== "string") {
        return {
          ok: false,
          why:
            `error is the failure mock tool "${named}" raises, written as ` +
            `text, and this request sent ${typeof message}.`,
        };
      }
      if (message.trim() === "") {
        return {
          ok: false,
          why:
            `error is the failure mock tool "${named}" raises, and this one ` +
            "is blank. Say what the agent's backend would have said.",
        };
      }
      mockTools.push({ tool: named, error: message });
      continue;
    }
    mockTools.push({ tool: named, answer: entry.answer });
  }
  return { ok: true, value: mockTools };
}

/** An empty editor, `{}`, and an env of empty objects all say the same: none. */
export function readEnv(text: string): Read<TestEnv | null> {
  if (text.trim() === "") return { ok: true, value: null };
  const held = parsed(text);
  if (!held.ok) return held;
  if (!isObject(held.value)) {
    return {
      ok: false,
      why:
        "env is an object with at most retell_dynamic_variables and " +
        "job_dispatch_metadata in it",
    };
  }
  for (const key of Object.keys(held.value)) {
    if (!(ENV_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        why:
          `env has no ${JSON.stringify(key)} in it. An env carries ` +
          `${ENV_KEYS.join(" and ")}, and nothing else.`,
      };
    }
  }

  const env: { -readonly [K in keyof TestEnv]: TestEnv[K] } = {};
  const variables = held.value.retell_dynamic_variables;
  if (variables !== undefined && variables !== null) {
    if (!isObject(variables)) {
      return {
        ok: false,
        why:
          "env.retell_dynamic_variables is an object of text values, which " +
          'looks like {"caller_name": "Margaret"}',
      };
    }
    const checked: Record<string, string> = {};
    for (const [name, value] of Object.entries(variables)) {
      if (name.startsWith(RESERVED_ENV_VARIABLE_PREFIX)) {
        return {
          ok: false,
          why:
            `env.retell_dynamic_variables names ${JSON.stringify(name)}, and ` +
            `Egma keeps every variable beginning ` +
            `"${RESERVED_ENV_VARIABLE_PREFIX}" for the facts it writes into ` +
            `the conversation itself. Name the variable something else.`,
        };
      }
      if (typeof value !== "string") {
        return {
          ok: false,
          why:
            `env.retell_dynamic_variables.${name} is the text Retell ` +
            `substitutes into the prompt, and this request sent ${typeof value}.`,
        };
      }
      checked[name] = value;
    }
    if (Object.keys(checked).length > 0) env.retell_dynamic_variables = checked;
  }
  const dispatch = held.value.job_dispatch_metadata;
  if (dispatch !== undefined && dispatch !== null) {
    if (!isObject(dispatch)) {
      return {
        ok: false,
        why:
          "env.job_dispatch_metadata is a JSON object handed to your worker, " +
          'which looks like {"tenant": "acme"}',
      };
    }
    if (Object.keys(dispatch).length > 0) env.job_dispatch_metadata = dispatch;
  }
  return {
    ok: true,
    value: Object.keys(env).length === 0 ? null : (env as TestEnv),
  };
}

/** What a Mock tools cell says at rest, and nothing when it holds none. */
export function mockToolsSummary(mockTools: readonly TestMockTool[]): string {
  if (mockTools.length === 0) return "";
  return mockTools.length === 1
    ? "1 mock tool"
    : `${String(mockTools.length)} mock tools`;
}

/** The env keys present, in the platforms' own words. Nothing when there are none. */
export function envSummary(env: TestEnv | null): string {
  if (env === null) return "";
  return ENV_KEYS.filter((key) => env[key] !== undefined).join(", ");
}
