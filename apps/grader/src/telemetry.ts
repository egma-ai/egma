/**
 * Telemetry about this process itself, off unless the deployment says where it
 * goes. The API's `telemetry.ts` carries the full story — what these switches
 * are, why this loads before the entry module, and why a broken backend says
 * so on standard error instead of stopping the service. This is that file one
 * app over, minus what a grader does not have: no fastify, and no pino —
 * `log.ts` writes its own JSON lines, which the deployment's log shipping
 * reads from standard output like everything else's.
 *
 *   EGMA_TELEMETRY                on | off. Off, and anything but `on`, means
 *                                 off — whatever else is set.
 *   EGMA_TELEMETRY_OTLP_ENDPOINT  where this process's own spans go. Empty:
 *                                 no SDK starts, nothing below is imported.
 *   EGMA_POSTHOG_KEY              crash reporting. Empty: no reporter exists.
 */

const environment = process.env;

const enabled = environment.EGMA_TELEMETRY?.trim().toLowerCase() === "on";

const endpoint = enabled ? environment.EGMA_TELEMETRY_OTLP_ENDPOINT?.trim() : undefined;
const posthogKey = enabled ? environment.EGMA_POSTHOG_KEY?.trim() : undefined;

if (endpoint !== undefined && endpoint !== "") {
  try {
    const { register } = await import("node:module");
    register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

    environment.OTEL_EXPORTER_OTLP_ENDPOINT ??= endpoint;
    environment.OTEL_SERVICE_NAME ??= "egma-grader";
    const headers = environment.EGMA_TELEMETRY_OTLP_HEADERS?.trim();
    if (headers !== undefined && headers !== "") {
      environment.OTEL_EXPORTER_OTLP_HEADERS ??= headers;
    }

    const [{ NodeSDK }, http, undici, pg] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-undici"),
      import("@opentelemetry/instrumentation-pg"),
    ]);

    const sdk = new NodeSDK({
      instrumentations: [
        // The claim loop's calls to the stores, and the judge calls a grading
        // replays to the provider — which is where a slow verdict's time goes.
        new http.HttpInstrumentation(),
        new undici.UndiciInstrumentation(),
        new pg.PgInstrumentation(),
      ],
    });
    sdk.start();

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void sdk.shutdown().catch(() => undefined);
      });
    }
  } catch (cause) {
    console.error("telemetry stayed off: the OpenTelemetry SDK did not start", cause);
  }
}

if (posthogKey !== undefined && posthogKey !== "") {
  try {
    const { PostHog } = await import("posthog-node");
    const posthog = new PostHog(posthogKey, {
      host: environment.EGMA_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
      enableExceptionAutocapture: true,
    });

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void posthog.shutdown().catch(() => undefined);
      });
    }
  } catch (cause) {
    console.error("crash reporting stayed off: the PostHog client did not start", cause);
  }
}
