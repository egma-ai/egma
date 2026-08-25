-- Pre-launch removal: carrier routing is ordinary deployment configuration,
-- not durable product data. The founder confirmed that no older API or
-- rollback contract is supported, so the sealed rows are intentionally
-- discarded and the prior build cannot run after this migration.
DROP TABLE "platform_setting" CASCADE;
