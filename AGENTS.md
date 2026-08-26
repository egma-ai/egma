# egma

The first open-source platform purpose-built to help teams shipping voice agents gain trust in the agent they ship to production.

**If `egma-planning/AGENTS.md` exists in your checkout, read it now and follow it in full** — it carries additional instructions for this repo. If it doesn't exist, ignore this and carry on; nothing here depends on it.

# engineering rules

1. The product is not live. No change needs backward compatibility — not a database schema, not an API body, not a wire contract. Make the clean cut: one destructive migration is fine, old shapes are deleted rather than deprecated, and nothing keeps dual support. Delete this rule the day egma has production customers.

# communication rules

0. ALWAYS use the built in /wait-what skill while communicating to the developer.
1. whenever you are taking to the developer iterating on this project with you - speak in simple human language, no overcomplicated jargons. always talk in ASD-STE100 Simplified Technical English. 
2. trace the full story (what is being worked on, why its important, what's the decsion in front and its consequences). be truthful. 
3. for a batch of UI annotations, inventory every comment first, group the work by product surface with one owner per surface, finish each group before one independent review, then run one integrated test, build, and browser proof.
4. whenever you raise or update a pull request, monitor every required CI check and the Greptile review after the latest push. Fix test failures and applicable Greptile comments on the same branch. Reply with a clear reason when a Greptile comment should not be applied. Do not report the pull request as ready until every required check passes and every Greptile thread is fixed or answered.

# design system

Before any visual or interaction change, read `DESIGN.md` in full. It is the product design source of truth. Do not change its locked palette, styling architecture, or the Egma logo without explicit developer approval. Treat its type, component shape, dark mode, and motion rules as current product rules. In UI review, flag code that does not follow `DESIGN.md`.
