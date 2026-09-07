import { appendSpans, priceUsageSpans, providerUsageSpan, type AuthContext, type NewUsageRecord } from "@egma/db";
import { acceptEvidence } from "./accept.ts";

/** Accounting recovery reuses one retained attempt, never another provider call. */
export async function persistProviderUsage(auth: AuthContext, record: NewUsageRecord): Promise<void> {
  let spans = [providerUsageSpan(record)];
  try {
    spans = await priceUsageSpans(auth, spans);
  } catch (cause) {
    console.error("usage pricing is unavailable; retain the unpriced paid attempt for recovery", cause);
  }
  try {
    // The grader's WAL replays this record on boot. Once uploaded, the API's
    // drainer owns completion even if this worker disappears permanently.
    await acceptEvidence(spans, { auth });
  } catch (cause) {
    console.error("provider usage could not reach the durable ingestion bucket; any staged WAL record remains recoverable", cause);
  }
  try {
    // Keep the direct grader append; the bucket copy is removed by the drainer
    // only after its identical append is confirmed.
    await appendSpans(auth, await priceUsageSpans(auth, spans));
  } catch (cause) {
    console.error("provider usage was not appended; recover the same attempt from durable ingestion, or absorb unprovable cost", cause);
  }
}
