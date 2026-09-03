# Guide to setup simulation testing for voice agents with egma platform

The broad order of things that need to be setup before we can run successful tests is as follows:
1. There needs to be an egma folder in this repo and it should be in sync with the platform.
2. Connect the voice agent that needs to be tested to the platform.
3. Author tests and how they need to be evaluated.
4. Now, we can run the test suite against the connected agent.


1. Setup the egma folder and sync state
  - Egma allows authoring voice agent tests locally as simple files so that tests can be maintained alongside the code. All egma tests should live inside a `egma/` folder in the repo.
  - Check if an `egma/` folder currently exists in this repo holding tests and config.
    - If it does not exist - run the `egma init` command to bootstrap it. This will create generate a `egma/config.yaml` file and an empty `egma/tests/` folder to store test suites. Once authored, the state can must be synced with the egma platform using `egma pull` & `egma push` commands. Run `egma pull` right now to pre-emptlively fetch if there are any agents or tests authored already via the platform UI.
    - If an `egma/` folder already exists, that means someone has already setup egma in this repo and you just need to run the pull command to fetch the latest state from remote.

2. Connect the agent in this repo with egma platform
 - The egma platform needs to reach the agent in this repo in order to run simulation tests with it. There are different connection strategies based on the agent platform and modality of connection. Example - retell agent with chat modality (i.e simulation testing a retell voice agent but without voice - just testing the behavior of the main LLM in a "STT-LLM-TTS" cascaded voice agent setup)
 - First off, identify which platform the agent in this repo built on. Currently egma supports connecting with agents built on livekit agents (python/ js) & retell.
 - Based on the platform - refer to the platform specific connection guides. Follow the guides and come back here for following the next step.
  - For connecting a livekit agent - you must look at [guide to connect a livekit agent](references/livekit-agent-connection-guide.md) which is a part of this skill's references
  - For connecting a retell agent - you must look at [guide to connect a retell agent](references/retell-agent-connection-guide.md) which is a part of this skill's references
