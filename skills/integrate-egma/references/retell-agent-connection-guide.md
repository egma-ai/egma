# Connecting to a retell agent

We need to do two things to setup a retell agent for simulation testing.

1. Register the agent in the egma platform if it is not already registered.
2. Add the connection(s) through which a simulated persona can reach the agent and test it.

## 1. Register the agent if it is not already available

First off, check if the agent we wanna test is already present in `egma/config.yaml`.
- If its already registered, lets move to step 2.
- If the agent is not present, we need to register it. Use `egma agent register --help` to see how.

## 2. Add a connection to the registered retell agent

Important concepts to know before adding any connections

A. There are three connection strategies for a retell voice agent:
  1. Text mode - runs a chat simulation against the voice agent without invoking STT or TTS. This is faster and cheaper. It only works when Retell holds the agent's response engine and will not work for a custom LLM hosted outside Retell. Most retell customer use a retell hosted retell_llm or conversation_flow
  2. Web call - runs a full voice simulation over the internet without dialing a public phone number. This connection supports mocking tools and thus is preferred when the objective is testing full voice-to-voice interaction of an agent over approximate latency numbers
  3. Phone number - calls the public phone number routed to the agent. This uses the real phone path but can't use mock tools. Use it when you are explicitly asked for doing voice-voice simulation without mock tools to get real latency data over a phone connection.

B. Retell agent ID
  Retell accounts can have multiple voice agents. Inspect the repo and identify the exact agent ID. Do not choose one only because its name looks similar. `egma agent connection options --platform retell` lists the agent IDs, names, attached phone numbers and available connection commands. Text, web-call and phone connections to the same Retell agent should all be added to one Egma agent.

C. Retell credentials
  Retell discovery needs an API key. Use the credential already setup for this repo. Input it with `--credentials-stdin`. Once the agent is registered, Egma can reuse its stored key for later connections.

Now that you have the concepts clear - here's how to add the connection.

1. Have the Retell API key available with you. By default, you should use the credentials set up in the repo. Only if the developer asks to use a separate new api key explicitly, you should stop to ask them to mint a new key. Otherwise continue with the default one you know/ can access.
2. Create two connections by default - text mode with chat modality and web call with voice modality. Only create a phone-number connection when explicitly asked. Use the exact E.164 number that the `egma agent connection options` command says is routed to the selected agent.
3. Once you have all the above details, look at `egma agent connection add --help` and supply everything to add a connection. This should conclude step 2
