/**
 * Egma self-observability, separate from customer and simulation evidence.
 * Load with node --import before application modules so instrumentation can
 * patch their imports.
 *
 * EGMA_TELEMETRY=on enables OTLP instrumentation and PostHog crash reporting.
 * Missing required configuration stops startup; SDK startup failures are logged
 * and allow the service to continue. Standard OTEL settings take precedence
 * over the Egma OTLP endpoint default.
 */

const environment = process.env;

if (environment.EGMA_TELEMETRY?.trim().toLowerCase() === "on") {
  const endpoint = environment.EGMA_TELEMETRY_OTLP_ENDPOINT?.trim();
  const posthogKey = environment.EGMA_POSTHOG_KEY?.trim();
  if (endpoint === undefined || endpoint === "" || posthogKey === undefined || posthogKey === "") {
    const missing = [
      ...(endpoint ? [] : ["EGMA_TELEMETRY_OTLP_ENDPOINT"]),
      ...(posthogKey ? [] : ["EGMA_POSTHOG_KEY"]),
    ];
    throw new Error(
      `EGMA_TELEMETRY is on, so ${missing.join(" and ")} must be set — ` +
        "on means everything reports, and an absent destination or key must never be a quiet no",
    );
  }

  try {
    // The loader hook has to exist for instrumentation to reach modules this
    // process imports as ES modules; without it only require() calls are
    // seen.
    const { register } = await import("node:module");
    register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

    // The SDK reads the standard OTEL_* variables on its own. The egma-named
    // collector address is written through to the standard one rather than
    // replacing it, so a deployment that already speaks OpenTelemetry's own
    // names is believed as-is.
    environment.OTEL_EXPORTER_OTLP_ENDPOINT ??= endpoint;
    environment.OTEL_SERVICE_NAME ??= "egma-api";

    const [{ NodeSDK }, http, undici, pg, pino, { PostHog }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-undici"),
      import("@opentelemetry/instrumentation-pg"),
      import("@opentelemetry/instrumentation-pino"),
      import("posthog-node"),
    ]);

    const sdk = new NodeSDK({
      instrumentations: [
        // Inbound requests and outbound calls, the two stores' queries, and
        // trace ids written into each pino line so a log line and the span
        // it happened inside can find each other. Pino still writes one JSON
        // line to standard output, where the deployment's filelog collector
        // reads it. It does not also send the same line through the
        // OpenTelemetry Logs SDK.
        new http.HttpInstrumentation(),
        new undici.UndiciInstrumentation(),
        new pg.PgInstrumentation(),
        new pino.PinoInstrumentation({ disableLogSending: true }),
      ],
    });
    sdk.start();

    const posthog = new PostHog(posthogKey, {
      host: environment.EGMA_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
      // Uncaught exceptions and unhandled rejections, captured with their
      // stacks before the process goes down. Ordinary request errors are
      // already on standard output as log lines.
      enableExceptionAutocapture: true,
    });

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      // Beside the entry module's own handlers, not instead of them: `once`
      // listeners stack, and these only flush what batching still holds.
      process.once(signal, () => {
        void sdk.shutdown().catch(() => undefined);
        void posthog.shutdown().catch(() => undefined);
      });
    }
  } catch (cause) {
    console.error("telemetry stayed off: its SDKs did not start", cause);
  }
}
