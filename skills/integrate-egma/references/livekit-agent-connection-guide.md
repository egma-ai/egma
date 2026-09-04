# Connecting to a livekit agent

We need to do two things to setup a livekit agent for simulation testing.

1. Register the agent in the egma platform if it is not already registered.
2. Add the connection(s) through which a simulated persona can reach the agent and test it.

## 1. Register the agent if it is not already available

First off, check if the agent we wanna test is already present in `egma/config.yaml`.
- If its already registered, lets move to step 2.
- If the agent is not present, we need to register it. use `egma agent register --help` to see how. 

## 2. Add a connection to the registered livekit agent

Important concepts to know before adding any connections 
A. There are two connection strategies for a livekit agent:
  1. Project credentials - it allows egma to automatically dispatch the livekit agent to a room and run the simulation. 
  2. Token endpoint - egma calls an API endpoint that is authored and maintained by you (the creators of the livekit agent to be tested). This endpoint gives egma a livekit wss server_url and participant_token which egma can use and send its persona to. You must dispatch the livekit agent yourself and pass any required session initiation metadata for successful simulation yourself. This isn't recommended and should be used only when explicitly stated in your instructions. 

B. Agent name
  Livekit workers only dispatch the agent reliably when the agent name is set explicitly. Make sure the agent uses explicit agent_name (Python) or agentName (Node.js) in the code. You will need this agent name while setting up the connection. 

C. There are two modality strategies as well:
  1. Run full voice-to-voice simulations (invokes the full STT-LLM-TTS pipeline of the livekit agent being tested)
  2. Run the simulation in text mode (tests the LLM/ Harness of the agent). This is faster and cheaper.


Now that you have the concepts clear - here's how to add the connection.

1. Default to using project credential based access strategy. Do not use token endpoint method unless explicitly asked to do so in prior instructions.
2. The next step is to get the credentials themselves. By default, you should use the credentials set up in the repo. That means livekit wss url, api key and api secret for the livekit project. Only if the developer asks to use a separate new credentials explicitly, should you stop to ask them to mint a new key. Otherwise continue with the default ones you know/ can access.
2. You should also create two connections by default - one with voice modality and the second with text modality.
3. Identify and set the right agent name. 
4. Once you have all the above details, look at `egma agent connection add --help` and supply everything to add a connection. If there's any confusion, you can also use `egma agent connection options --help` to list available connection options for livekit and what all needs to be supplied to set up a successful connection. This should conclude step 2.
