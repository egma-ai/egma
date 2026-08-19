/** The first version of Egma's vendor-neutral platform log contract. */
const LOG_SCHEMA_VERSION = 1;

type Attribute = string | number | boolean;

/**
 * The fields every deliberate platform event carries before the deployment
 * collector turns the JSON line into an OpenTelemetry log record.
 *
 * The event name is stable and low-cardinality. Variable facts stay in flat
 * scalar attributes so a collector can promote them without keeping customer
 * payloads or arbitrary objects.
 */
export function platformEvent(
  name: `egma.${string}`,
  body: string,
  attributes: Readonly<Record<string, Attribute>> = {},
): Record<string, Attribute> {
  return {
    "otel.event.name": name,
    "egma.log_schema_version": LOG_SCHEMA_VERSION,
    body,
    ...attributes,
  };
}

/**
 * A useful exception class without copying an exception message or stack.
 * Both can contain a request body, provider credential, or customer content.
 */
export function safeExceptionType(error: unknown): string {
  const type = error instanceof Error ? error.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(type) ? type : "Error";
}

/** The useful part of an exception, without its message, stack, or cause. */
export function safeException(error: unknown): {
  readonly type: string;
  readonly message: string;
  readonly stack: string;
} {
  return {
    type: safeExceptionType(error),
    message: "[redacted]",
    stack: "",
  };
}

/**
 * Pino applies these before a line reaches standard output. Request, response,
 * and provider-detail objects have no safe general representation, so they are
 * omitted. Exceptions retain only their class; Pino's required stack field is
 * present but empty.
 */
export const PRIVATE_LOG_SERIALIZERS = {
  err: safeException,
  req: (_request: unknown): Record<string, never> => ({}),
  res: (_response: unknown): Record<string, never> => ({}),
  details: (_details: unknown): undefined => undefined,
} as const;
