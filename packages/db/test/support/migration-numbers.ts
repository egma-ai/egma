import type { Migration } from "../../src/migrate.ts";

/**
 * The four-digit numbers that more than one migration file wears, in order.
 *
 * **A repeated number is the one migration mistake that no tool anywhere
 * notices.** Both runners read a directory, sort by filename and apply in that
 * order, so two files numbered 0003 are not a git conflict, not a journal
 * mismatch and not a hash mismatch — they are two migrations that both run,
 * where the second gets whatever schema the first left. It is the shape a merge
 * produces on its own: two efforts each take the next free number from where
 * they are standing, and neither is wrong until they meet.
 *
 * Returned rather than thrown, so the caller can name the number in its
 * failure. An empty array is a directory in good order.
 */
export function repeatedMigrationNumbers(
  migrations: readonly Migration[],
): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();

  for (const migration of migrations) {
    const number = migration.name.slice(0, 4);
    if (seen.has(number)) repeated.add(number);
    seen.add(number);
  }

  return [...repeated].sort();
}
