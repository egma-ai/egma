# ee — Egma's commercially licensed code

Everything under this directory is licensed under `ee/LICENSE`, not under the
repository's MIT license. The root `LICENSE` says so.

**Keep EE-only concerns out of open code paths.** The open product must build,
boot, test and run with this package absent. That is one rule with two halves:

- **Nothing outside `ee/` imports `@egma/ee`,** except one line in `apps/api`
  and one in `apps/grader` that reach it through a dynamic `import()` taken
  only when the deployment names a Stripe secret. A static import anywhere
  would put this package in every self-hoster's build.
- **Nothing in `ee/` is required by anything outside it.** No shared table
  gains a column for the cloud, no shared code reads a `cloud_` table, and no
  `cloud_` field ever enters a public API response or an SDK type.

**The cloud tables live in the shared migration tree and are read only from
here.** A self-hoster's schema carries them empty, so dropping them can break
nothing. Every read and write of one goes through a function in `src/access/`
that takes an `AuthContext` and builds its own tenancy predicate, exactly as
`packages/db/src/access/` does — this directory is the second fenced home of
the data-access boundary and the lint rules hold it to the same terms.

**Stripe is never simulated.** Billing logic is proven by seeding the rows
Stripe would have written. There is no in-memory Stripe anywhere in this
repository.

See ADR-0024 (the boundary) and ADR-0025 (the balance).
