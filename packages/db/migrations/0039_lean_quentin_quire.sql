-- Pre-launch removal: the founder confirmed that no installed client or
-- customer depends on platform identity, and this release has no rollback
-- compatibility requirement for the retired table.
DROP TABLE "platform_instance" CASCADE;
