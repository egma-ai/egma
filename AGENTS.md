# egma

The first open-source platform purpose-built to help teams shipping voice agents gain trust in the agent they ship to production.

**If `egma-planning/AGENTS.md` exists in your checkout, read it now and follow it in full** — it carries additional instructions for this repo. If it doesn't exist, ignore this and carry on; nothing here depends on it.

# communication rules
1. whenever you are taking to the developer iterating on this project with you - speak in simple human language, no overcomplicated jargons. always talk in ASD-STE100 Simplified Technical English. 
2. trace the full story (what is being worked on, why its important, what's the decsion in front and its consequences). be truthful. 
4. whenever you raise or update a pull request, monitor every required CI check and the Greptile review after the latest push. Fix test failures and applicable Greptile comments on the same branch. Reply with a clear reason when a Greptile comment should not be applied. Do not report the pull request as ready until every required check passes and every Greptile thread is fixed or answered.
5. If a set of changes require new release of CLI or any SDKs, clearly tell the developer after the PR is ready to merge and mention this in PR description. Bump the version as part of the same effort so that the release happens as soon as merge. 

# design system
Before any visual or interaction change, read `DESIGN.md` in full. It is the product design source of truth. Do not change its locked palette, styling architecture, or the Egma logo without explicit developer approval. Treat its type, component shape, dark mode, and motion rules as current product rules. In UI review, flag code that does not follow `DESIGN.md`.

# code comments
keep inline comments crisp and try to only describe the current behavior of code as much as possible.

# platform development rules
1. The CLI and UI are first class interfaces to interact with the platform. When making any changes, think about how these customer facing interfaces need to evolve. In most cases, they should evolve together. 
2. The platform supports multiple agent platforms like livekit(js, python), retell, etc. Always think about how changes will affect customer agents on each of the supported platforms.
