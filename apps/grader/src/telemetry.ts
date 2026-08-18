/**
 * Telemetry about this process itself, behind one flag. The API's
 * `telemetry.ts` carries the full story — what the flag means, why this
 * loads before the entry module, why `on` without both addresses is refused
 * at boot by name, and why a backend that fails past that check says so on
 * standard error instead of stopping the service. This is that file one app
 * over, minus what a grader does not have: no fastify, and no pino —
 * `log.ts` writes its own JSON lines, which the deployment's log shipping
 * reads from standard output like everything else's.
 *
 * `EGMA_TELEMETRY=on` is the whole decision. Off — the default, and
 * anything that is not `on` — means nothing below is imported and nothing
 * is sent anywhere, whatever else is set.
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
    const { register } = await import("node:module");
    register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

    environment.OTEL_EXPORTER_OTLP_ENDPOINT ??= endpoint;
    environment.OTEL_SERVICE_NAME ??= "egma-grader";

    const [{ NodeSDK }, http, undici, pg, { PostHog }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-undici"),
      import("@opentelemetry/instrumentation-pg"),
      import("posthog-node"),
    ]);

    const sdk = new NodeSDK({
      instrumentations: [
        // The claim loop's calls to the stores, and the judge calls a
        // grading replays to the provider — which is where a slow verdict's
        // time goes.
        new http.HttpInstrumentation(),
        new undici.UndiciInstrumentation(),
        new pg.PgInstrumentation(),
      ],
    });
    sdk.start();

    const posthog = new PostHog(posthogKey, {
      host: environment.EGMA_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
      enableExceptionAutocapture: true,
    });

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void sdk.shutdown().catch(() => undefined);
        void posthog.shutdown().catch(() => undefined);
      });
    }
  } catch (cause) {
    console.error("telemetry stayed off: its SDKs did not start", cause);
  }
}
