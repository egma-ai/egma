/**
 * Telemetry about this process itself, off unless the deployment says where it
 * goes.
 *
 * **This is not the trace store.** What customers' agents and simulations send
 * through the OTLP door is their data, in this deployment's ClickHouse. What
 * this file emits is telemetry about egma's own process — request spans, crash
 * reports — into whatever backend the deployment chose. The two must never
 * share a pipe, which is why nothing here reads `CLICKHOUSE_URL` and nothing
 * in the OTLP door reads anything here.
 *
 * It is loaded before the entry module — `node --import` in the Dockerfile —
 * because instrumentation works by patching modules as they load: registered
 * after `pg` or `fastify` have arrived, it would see nothing. That is also why
 * it reads the environment directly rather than through `loadConfig`, which
 * does not exist yet when this runs.
 *
 * One flag, off by default, so a self-hosted `docker compose up` sends
 * nothing anywhere. While the flag is off nothing below is even imported —
 * whatever else is set — and the cost of the default is zero modules and zero
 * requests. `EGMA_TELEMETRY=on` is the whole decision; the rest is address
 * book:
 *
 *   EGMA_TELEMETRY                on | off. Off, and anything but `on`, means
 *                                 off.
 *   EGMA_TELEMETRY_OTLP_ENDPOINT  where this process's own spans go, as an
 *                                 OTLP/HTTP base URL — a collector beside it,
 *                                 or a vendor that speaks OTLP. Empty: no SDK
 *                                 starts even with the flag on.
 *   EGMA_POSTHOG_KEY              crash reporting, a PostHog project token.
 *                                 Empty: no reporter exists.
 *
 * A broken telemetry backend must never take the platform down with it, so
 * everything here fails by saying so on standard error and carrying on — the
 * one place in this app where an error at boot is not fatal, because this is
 * the one capability the product does not depend on.
 */

const environment = process.env;

const enabled = environment.EGMA_TELEMETRY?.trim().toLowerCase() === "on";

const endpoint = enabled ? environment.EGMA_TELEMETRY_OTLP_ENDPOINT?.trim() : undefined;
const posthogKey = enabled ? environment.EGMA_POSTHOG_KEY?.trim() : undefined;

if (endpoint !== undefined && endpoint !== "") {
  try {
    // The loader hook has to exist for instrumentation to reach modules this
    // process imports as ES modules; without it only require() calls are seen.
    const { register } = await import("node:module");
    register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

    // The SDK reads the standard OTEL_* variables on its own. The egma-named
    // variable is written through to the standard one rather than replacing
    // it, so a deployment that already speaks OpenTelemetry's own names is
    // believed as-is.
    environment.OTEL_EXPORTER_OTLP_ENDPOINT ??= endpoint;
    environment.OTEL_SERVICE_NAME ??= "egma-api";
    const headers = environment.EGMA_TELEMETRY_OTLP_HEADERS?.trim();
    if (headers !== undefined && headers !== "") {
      environment.OTEL_EXPORTER_OTLP_HEADERS ??= headers;
    }

    const [{ NodeSDK }, http, undici, pg, pino] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-undici"),
      import("@opentelemetry/instrumentation-pg"),
      import("@opentelemetry/instrumentation-pino"),
    ]);

    const sdk = new NodeSDK({
      instrumentations: [
        // Inbound requests and outbound calls, the two stores' queries, and
        // trace ids written into each pino line so a log line and the span it
        // happened inside can find each other.
        new http.HttpInstrumentation(),
        new undici.UndiciInstrumentation(),
        new pg.PgInstrumentation(),
        new pino.PinoInstrumentation(),
      ],
    });
    sdk.start();

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      // Beside the entry module's own handlers, not instead of them: `once`
      // listeners stack, and this one only flushes what batching still holds.
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
      // The reporter's whole job here: uncaught exceptions and unhandled
      // rejections, captured with their stacks before the process goes down.
      // Ordinary request errors are already on standard output as log lines.
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
