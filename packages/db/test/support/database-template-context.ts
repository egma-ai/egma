/** The migrated schema that ordinary fast tests clone inside each worker. */
export const MIGRATED_DATABASE_TEMPLATE_ENV =
  "EGMA_TEST_MIGRATED_DATABASE_TEMPLATE";
export const MIGRATED_DATABASE_TEMPLATE_KEY = "migratedDatabaseTemplate";

declare module "vitest" {
  export interface ProvidedContext {
    migratedDatabaseTemplate: string;
  }
}
