---
name: integrate-egma
description: Integrate Egma into a repository containing voice agent code. Use when the developer asks to integrate voice agent testing, monitoring or both
---

# Quick background on Egma
Egma is an open-source platform that helps developers and their coding agents in building reliable voice agents and making sure they work well in production. egma does it by providing two things - infrasturcture to do simulation testing to test an agent pre-release - similar to unit tests that run in CI every prod push. Other is by providing a way to monitor voice agent's behavior in production, identifying issues, etc. This skill is all about configuring the voice agents in this repo to work with egma platform.

# Getting started
1. If the `egma` command is unavailable, install it with `npm install --global egma-cli`.
2. Use --help command in the cli to see all the available options.
3. Login to the egma platform using `egma login`. If it is already logged in, continue. If not, use your built-in browser skills or ask the developer to authorize the login.

# Setting up testing and/or monitoring based on agent platform
- To setup testing with egma platform - refer to [simulation testing setup guide](references/setup-simulation-testing.md)
- To setup monitoring of voice agents on egma platform - refer to [monitoring setup guide](references/setup-monitoring.md)
- If the developer wants to setup both testing and monitoring - first setup monitoring and then testing - but do it as one continuous chunk of work rather than exiting. Reuse credentials across testing and monitoring unless stated otherwise.
