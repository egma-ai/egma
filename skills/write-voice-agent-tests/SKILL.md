---
name: write-egma-tests
description: Write or edit tests for a voice agent that can run on the Egma platform.
---

# Writing tests for voice agents that can run on the Egma platform

An Egma Test describes one situation that a voice agent should handle and the expected behaviors that should hold during that situation. Tests are grouped inside Suites. Each Test runs once for every Persona named in it.

A Suite and its Tests do not store the Agent or Connection they run against. The Agent and Connection are selected later when starting a Run.

Currently, Egma supports these voice agents platforms - retell & livekit-agents (python/ js) framework.

We need to do three things to create good tests:

1. Find or create the Suite that should hold the Tests.
2. Understand the voice agent and create appropriate tests for it.
3. Write test files and push them to Egma.

## 1. Find or create the Suite

1. First off, check whether `egma/config.yaml` exists.
  - If it does not exist, run `egma init`. This initializes the repository and pulls its current Egma state.
  - If it already exists, run `egma pull` before deciding whether a Suite needs to be created.
2. Every direct directory under `egma/tests/` is one Suite. Its `suite.yaml` file holds the Suite ID and display name. 
  - If the correct Suite already exists, use it.
  - If a new Suite is needed, create it through the CLI: `egma suite create appointment-booking --name "Appointment booking"`


## 2. Understand the voice agent and decide the tests

This is one of the most crucial step. Here you should read the voice agent’s prompt, tools, the overall harness that makes this voice agent behave the way it does (example multiple subagents, context strategies, etc) and any crucial metadata the voice agent should have before a production session startup path before writing Tests such as organisation name, tenant ID, locale, or agent configuration.

Important concepts to know before writing them:

A. One Test is one situation
  - Write the Scenario as a situation that a real human might find themselves in while speaking with the voice agent being tested. 
  - Each Test should cover one clear situation. For example, “call the recepionist to book an appointment at medspa "ABC" but ask for a specific provider "XYZ" and be flexible around dates but you don't know which treatment is right for your skin and so first you'd like to discuss some options but you're someone who's not very decisive". Replace with actual values that you infer from calling the tools attached to this voice agent. 
  

B. Each scenario has one or more personas
  - A persona is just a digital human who is enacting the scenario. Different personas have different characteristics. Creating new personas is out of scope for this skill but use one of the default personas. you can run `egma persona list` find the available persona names/ their IDs. If several personas could be appropriate, choose one or two most appropriate by default.

C. Expected behaviors
  - An expected behavior is simply a lens through which an LLM based grader should look at the entire transcript of a simulation and determine whether that expected behavior is actually observed or not. Each expected behavior should be a binary 0/1 decision for the LLM grader. This of an expected behavior like an assertion in classical testing. 
  - Each behavior should make one clear claim. What these behaviors should be must be grounded in the voice agent’s actual prompt, harness, tools, and the product requirements to the best of your knowledge.
  - Usually aim to write around three or four expected behaviors for one Test. Split unrelated requirements into separate Tests.

D. Mock tools
  - You can add mock tools to a test when you don't want real writes to happen or want to use a controlled backend state. Egma supplies mock tools to the vocie agent of supported platforms and leaves any tools whose mocks were not supplied as it is. For example, you might want to read real availability slots / provider info for a appointment booking voice agent but don't want to create fake appointments in prodution CRM systems. 
  - To create a mock tool, use the exact tool name supplied to the agent and the same response shape that the real tool returns. A Mock Tool contains exactly one of the following in its result json that will be supplied to the agent during simulation
    - `answer` for a successful result
    - `error` for a failed/erronous result
  - For livekit agents, you will need to setup the agent with egma sdk in order to use mock tools. egma has support for livekit-agents python and js/ts with dedicated sdks. Refer [Egma livekit python sdk](https://docs.egma.ai/integrations/python-sdk) or [Egma livekit js sdk](https://docs.egma.ai/integrations/javascript-sdk) for info on how to setup the agent code to listen for mock tools.

E. Session initiation data
  - Many agents need per-session context and certain dynamic variables supplied before they speak even a single word - such as an organisation name which they represent, tenant ID, or some other agent configuration needed for the agent to do its job properly in production. Egma provides a way to supply this data for each simulation so that it is as close to the agent's production behavior as possible. 
  - To find what dynamic variables / job dispatch metadata/ inbound webhooks etc that the agent being tested depends on - carefully look at its code and setting. Inspect the agent’s entrypoint, the normal path it goes through before speaking anything and identify which variables need to be supplied in the simulation. Once you have the required session initiation metadata needed, you can use the `## Env` section of each test to supply curated data that makes the most sense for that test.
  - For each of the supported agent platforms, egma has a specifc field in its env json that it supplies. 
    - If the agent is based on retell - use `retell_dynamic_variables` in the env section to supply any inbound webhook and dynamic variables data used by the agent. Egma passes it as is to the retell agent as its dynamic variables. 
    - If the agent is based on livekit, use a `job_dispatch_metadata` in the env section. for values the LiveKit agent reads from `ctx.job.metadata`. Make sure the code of the livekit agent is able to read the needed data from `ctx.job.metadata`. If the agent must detect whether its running in an Egma simulation, you can add a check when `ctx.room.name` starts with `egma-sim-`. 
  - Finally, use realistic, non-secret values to pass in the env section. Ask the developer only when a required value cannot be found or safely inferred. Use the default test orgs that usually the developer uses while iterating on the voice agent themselves.

## 3. Write the Test files and push them

You can now actually start writing the tests. A test can be created by simply creating a new md file in a suite directory. Once all tests are created, push them to the platform using `egma push`.

A test file should look like this:

````markdown
---
format: 5
name: booking-happy-path
description: The caller wants to book an available appointment.
personas:
  - name: Everyday person
---

## Scenario

Call the recepionist to book an appointment at medspa "ABC" but ask for a specific provider "XYZ" and be flexible around dates but you don't know which treatment is right for your skin and so first you'd like to discuss some options but you're someone who's not very decisive.

## Expected behaviors

1. The agent walks the patient through avaialble options. It calls get_available_treatments tool before  quoting any treatments and does not hallucinate anything that wasn't provided by the tool call.
2. The agent calls check_providers tool before suggesting a provider. 
3. The agent calls the check_availability tool to get the appointment slots. it passes the right provider_id which the patient selected and offer slots in the default 7 day window. 

## Mock tools

### check_availability

```json
{
  "answer": {
    "slots": [
      "Wednesday 15:00",
      "Wednesday 16:30"
    ]
  }
}
```

## Env

```json
{
  "retell_dynamic_variables": {
    "clinic_name": "Youth Medspa, Walnut Creek branch",
    "assistant_name": "Emily"
  },
  "job_dispatch_metadata": {
    "clinic_name": "Youth Medspa, Walnut Creek branch",
    "assistant_name": "Emily"
  }
}
```
## Env
```json
{ "retell_dynamic_variables": { "caller_name": "Margaret" } }
```
````

The above example shows both retell_dynamic_variables & job_dispatch_metadata for reference. In reality, you should only supply the field corresponding to the platform the agent is built on.
