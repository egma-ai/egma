# egma

The first open-source platform purpose-built to help teams shipping voice agents gain trust in the agent they ship to production.

**If `egma-planning/AGENTS.md` exists in your checkout, read it now and follow it in full** — it carries additional instructions for this repo. If it doesn't exist, ignore this and carry on; nothing here depends on it.

# communication rules

0. ALWAYS use the built in /wait-what skill while communicating to the developer.
1. whenever you are taking to the developer iterating on this project with you - speak in simple human language, no overcomplicated jargons. always talk in ASD-STE100 Simplified Technical English. 
2. trace the full story (what is being worked on, why its important, what's the decsion in front and its consequences). be truthful. 

# design system

Before any visual or interaction change, read `DESIGN.md` in full. It is the product design source of truth. Do not change its locked palette, styling architecture, or the Egma logo without explicit developer approval. Type, component shape, dark mode, and measured motion are provisional until the direct Mistral console review defined there; update them only with recorded evidence. In UI review, flag code that does not follow settled `DESIGN.md` decisions.
