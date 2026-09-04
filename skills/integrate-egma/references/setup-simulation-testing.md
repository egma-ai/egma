# Guide to setup simulation testing for voice agents with egma platform

The broad order of things that need to be setup before we can run successful tests is as follows:
1. There needs to be an egma folder in this repo and it should be in sync with the platform.
2. Create an agent in egma platform and a connection to it so that it can be reached by a simulated persona for testing purposes.
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
  - For connecting a livekit agent - you must look at [guide to connect a livekit agent](./livekit-agent-connection-guide.md) which is a part of this skill's references
  - For connecting a retell agent - you must look at [guide to connect a retell agent](./retell-agent-connection-guide.md) which is a part of this skill's references

3. Author tests
  - If this is the first time egma tests are being written in this repository, create at max four tests in one suite covering 4 most common scenrios the voice agent here encounters.
  - Refer to the `/write-voice-agent-tests` skill. This will teach you how to create a test suite and write good tests that actually move the needle in terms of trusting the voice agent's behavior. Egma tests are just simple markdown files. If this skill is not installed, you MUST first install it using `npx skills add egma-ai/egma --yes`. It contains important instructions regarding test creation, tool mocking and dynamically passing session data to simulation environment.
  - If the livekit agent has gone through modifications because of integrating the egma sdk for mock tools, you must eiter start a local worker so that the agent with the updated code can join the simulation room. Once the first run has happened successfully, this local worker won't need to start as the cloud deployed agent would have egma sdk setup. 

4. Run the tests
- Once there is a suite you wanna run use `egma run --help` to look at how to run a suite against a particular agent and one of its connections. Your job is only complete one a suite is running and you have given the developer a link to the UI where the developer can see the suite running against an agent (and its connection).
