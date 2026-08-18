/**
 * Telemetry about this process itself, behind one flag.
 *
 * **This is not the trace store.** What customers' agents and simulations
 * send through the OTLP door is their data, in this deployment's ClickHouse.
 * What this file emits is telemetry about egma's own process — request
 * spans, crash reports — into whatever backend the deployment chose. The two
 * must never share a pipe, which is why nothing here reads `CLICKHOUSE_URL`
 * and nothing in the OTLP door reads anything here.
 *
 * It is loaded before the entry module — `node --import` in the Dockerfile —
 * because instrumentation works by patching modules as they load: registered
 * after `pg` or `fastify` have arrived, it would see nothing. That is also
 * why it reads the environment directly rather than through `loadConfig`,
 * which does not exist yet when this runs.
 *
 * **`EGMA_TELEMETRY=on` is the whole decision.** Off — the default, and
 * anything that is not `on` — means nothing below is imported and nothing is
 * sent anywhere, whatever else is set. On means all of it at once: the
 * OpenTelemetry SDK exporting spans to `EGMA_TELEMETRY_OTLP_ENDPOINT`, and
 * crash reporting to `EGMA_POSTHOG_KEY`. There are no smaller switches
 * inside it. A deployment that says `on` without both addresses is refused
 * at boot, by name — an absent setting must never be a quiet no, which is
 * the same deal every other setting in this deployment lives under.
 *
 * Past that check, a broken telemetry backend must never take the platform
 * down with it: an SDK that fails to start says so on standard error and
 * the service carries on, because this is the one capability the product
 * does not depend on.
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
        "on means everything reports, and an absent address must never be a quiet no",
    );
  }

  try {
    // The loader hook has to exist for instrumentation to reach modules this
    // process imports as ES modules; without it only require() calls are
    // seen.
    const { register } = await import("node:module");
    register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

    // The SDK reads the standard OTEL_* variables on its own. The egma-named
    // variable is written through to the standard one rather than replacing
    // it, so a deployment that already speaks OpenTelemetry's own names is
    // believed as-is.
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
        // it happened inside can find each other.
        new http.HttpInstrumentation(),
        new undici.UndiciInstrumentation(),
        new pg.PgInstrumentation(),
        new pino.PinoInstrumentation(),
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
