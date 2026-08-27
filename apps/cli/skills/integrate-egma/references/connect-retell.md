# Connect a Retell agent

Use this phase after discovery corroborates a voice agent running with
`retell-sdk`. Use committed repository evidence and the Retell API response
Egma supplies. Keep the supplied Retell key out of output.

## Trace the response engine

Retell can keep the prompt and tools in a managed response engine, or connect
the agent to repository code:

- A managed engine commonly carries `type: retell-llm` and an `llm_id`. Report
  the external Retell boundary when the repository has no authored source.
- A repository-managed engine commonly carries `type: custom-llm` and a
  websocket URL. Follow that server entrypoint to its prompt and tools.
- A repository can author a prompt locally and publish it with an SDK update.
  Report both the authored file and the publishing script or workflow.

Absence of a prompt file does not prove dashboard ownership. Mark the source
unknown unless committed code or configuration proves the boundary.

## Trace tools and identity

Search Retell configuration and SDK writes for `general_tools`, state tools,
and state prompts. Follow custom-tool URLs to repository routes and handlers.
Keep Retell-provided tools separate from repository handlers.

Report the committed path that records an `agent_` or `llm_` identifier. Do not
print the identifier value when the task asks only for its location.

## Create the Egma connection

Use the agent and response-engine records returned for the supplied Retell key.
Select the exact agent the developer chose. Preserve its provider identifier
and modality in the Egma connection. Do not infer an agent from a similar name.

Finish when the selected Retell agent, response-engine boundary, prompt,
tools, production path, and identifier location are all accounted for.
