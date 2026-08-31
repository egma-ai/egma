export const PROTOCOL_VERSION = 1;

export const HELLO_METHOD = "egma.hello";
export const TOOL_METHOD = "egma.tool";

export const LARGEST_PAYLOAD_BYTES = 15 * 1_024;
export const LONGEST_DECLARED_DELAY_SECONDS = 30;
export const SERVING_MARGIN_SECONDS = 5;
export const MAX_ROUND_TRIP_SECONDS = 10;
export const RESPONSE_TIMEOUT_SECONDS =
  LONGEST_DECLARED_DELAY_SECONDS +
  SERVING_MARGIN_SECONDS +
  MAX_ROUND_TRIP_SECONDS;
export const HELLO_TIMEOUT_SECONDS =
  MAX_ROUND_TRIP_SECONDS + SERVING_MARGIN_SECONDS;

export const MALFORMED_REQUEST = 901;
export const UNKNOWN_TOOL = 902;
export const ANSWER_TOO_LARGE = 903;
export const UNSUPPORTED_PROTOCOL_VERSION = 904;

export const EGMA_NOT_REACHED: ReadonlySet<number> = new Set([
  1400, 1401, 1403, 1404, 1503,
]);
export const EGMA_NOT_LISTENING_YET: ReadonlySet<number> = new Set([1400]);

export function isEgmaRefusal(code: number): boolean {
  return code >= 901 && code < 1_000;
}

export function isEgmaNotReached(code: number): boolean {
  return EGMA_NOT_REACHED.has(code);
}

export function isEgmaNotListeningYet(code: number): boolean {
  return EGMA_NOT_LISTENING_YET.has(code);
}

export class SeamError extends Error {
  override readonly name = "SeamError";
}

export function helloRequest(
  census: readonly Record<string, unknown>[],
): string {
  return serialized({ protocol_version: PROTOCOL_VERSION, tools: census });
}

export function mockedToolsIn(reply: string): string[] {
  const answered = objectIn(HELLO_METHOD, reply);
  const version = answered.protocol_version;
  if (!Number.isInteger(version) || version !== PROTOCOL_VERSION) {
    throw new SeamError(
      `${HELLO_METHOD} was answered in protocol version ${String(version)}, and this SDK speaks ${PROTOCOL_VERSION}`,
    );
  }

  const mocked = answered.mocked_tools;
  if (!Array.isArray(mocked)) {
    throw new SeamError(
      `${HELLO_METHOD} answers with the tool names Egma covers, as a list of strings, and this reply carried ${kindOf(mocked)}`,
    );
  }

  const names: string[] = [];
  for (const name of mocked) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new SeamError(
        `${HELLO_METHOD} answers with tool names, and one of them was ${kindOf(name)}`,
      );
    }
    const trimmed = name.trim();
    if (!names.includes(trimmed)) {
      names.push(trimmed);
    }
  }
  return names;
}

export function toolRequest(
  name: string,
  arguments_: Record<string, unknown> | undefined,
): string {
  const asking: Record<string, unknown> = { name };
  if (arguments_ !== undefined) {
    asking.arguments = arguments_;
  }
  return serialized(asking);
}

export type Served =
  | { failed: false; value: unknown }
  | { failed: true; message: string };

export function servedIn(reply: string): Served {
  const answered = objectIn(TOOL_METHOD, reply);
  if (Object.hasOwn(answered, "error")) {
    const failure = answered.error;
    if (typeof failure !== "string") {
      throw new SeamError(
        `a ${TOOL_METHOD} failure carries the mock tool's own sentence, and this one carried ${kindOf(failure)}`,
      );
    }
    return { failed: true, message: failure };
  }
  if (Object.hasOwn(answered, "answer")) {
    return { failed: false, value: answered.answer };
  }
  throw new SeamError(
    `${TOOL_METHOD} answers with one tag — an answer to return or an error to raise — and this reply carried neither`,
  );
}

export function fitsOnTheWire(what: string, message: string): void {
  const bytesOverTheWire = new TextEncoder().encode(message).byteLength;
  if (bytesOverTheWire <= LARGEST_PAYLOAD_BYTES) {
    return;
  }
  throw new SeamError(
    `${what} is ${bytesOverTheWire} bytes, and one message of this exchange holds at most ${LARGEST_PAYLOAD_BYTES}`,
  );
}

function objectIn(method: string, payload: string): Record<string, unknown> {
  let answered: unknown;
  try {
    answered = JSON.parse(payload) as unknown;
  } catch (cause) {
    throw new SeamError(
      `${method} is answered with a JSON object, and this reply is not JSON`,
      { cause },
    );
  }
  if (
    answered === null ||
    typeof answered !== "object" ||
    Array.isArray(answered)
  ) {
    throw new SeamError(
      `${method} is answered with a JSON object, and this reply carried ${kindOf(answered)}`,
    );
  }
  return answered as Record<string, unknown>;
}

function serialized(value: unknown): string {
  const message = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
  if (message === undefined) {
    throw new SeamError("the mock-tool exchange could not encode this value as JSON");
  }
  return message;
}

function kindOf(value: unknown): string {
  if (value === null || value === undefined) {
    return "nothing";
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  switch (typeof value) {
    case "boolean":
      return "a boolean";
    case "number":
      return "a number";
    case "string":
      return "text";
    case "object":
      return "an object";
    default:
      return "something else";
  }
}
