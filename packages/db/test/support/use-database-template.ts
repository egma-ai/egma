/** Pass the global schema template into this Vitest worker's test helpers. */

import { inject } from "vitest";

import {
  MIGRATED_DATABASE_TEMPLATE_ENV,
  MIGRATED_DATABASE_TEMPLATE_KEY,
} from "./database-template-context.ts";

process.env[MIGRATED_DATABASE_TEMPLATE_ENV] = inject(
  MIGRATED_DATABASE_TEMPLATE_KEY,
);
