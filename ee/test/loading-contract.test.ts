import { expectTypeOf, it } from "vitest";

import type {
  CloudBilling,
  CloudBillingSettings,
} from "../../apps/api/src/billing.ts";
import type { GraderBilling } from "../../apps/grader/src/billing.ts";
import { loadApiBilling, loadCloudBilling } from "../src/index.ts";

it("implements the API and grader loading contracts without shared EE types", () => {
  expectTypeOf(loadApiBilling).toMatchTypeOf<
    (settings: CloudBillingSettings) => Promise<CloudBilling>
  >();
  expectTypeOf(loadCloudBilling).toMatchTypeOf<() => Promise<GraderBilling>>();
});
