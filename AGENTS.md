# egma

The first open-source platform purpose-built to help teams shipping voice agents gain trust in the agent they ship to production.

**If `egma-planning/.agents/AGENTS.md` exists in your checkout, read it now and follow it in full** — it carries additional instructions for this repo. If it doesn't exist, ignore this and carry on; nothing here depends on it.

# skills

Project-level agent skills come from [mattpocock/skills](https://github.com/mattpocock/skills), installed via the [skills CLI](https://github.com/vercel-labs/skills). The real files live in `.agents/skills/` (the CLI's canonical, agent-agnostic location); `.claude/skills/` contains relative symlinks into it so Claude Code picks them up. `skills-lock.json` tracks each skill's source and content hash.

- Update all skills to the latest versions: `pnpm skills:update`
- Add more skills from a repo: `npx skills add <owner>/<repo>`
- List what's installed: `npx skills ls`

Don't hand-edit files under `.claude/skills/` — changes get overwritten on update. To customize a skill, fork it upstream or copy it out under a new name.

# communication rules

1. whenever you are taking to the developer iterating on this project with you - speak in simple human language, no overcomplicated jargons. 
2. trace the full story (what is being worked on, why its important, what's the decsion in front and its consequences). be truthful.