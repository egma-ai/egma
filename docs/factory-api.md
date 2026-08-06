# Factory API prototype

The CLI uses this small JSON API to create and read an agent, its Retell
connection, the project's default persona and one test. Every route needs a
session cookie or `Authorization: Bearer egma_sk_...`. A `viewer` can read. A
`member` or `admin` can create.

This is a prototype contract. Response fields use `snake_case`. List responses
always include `next_cursor`, which is `null` on the last page. `limit` is an
integer from 1 through 200. `cursor` is the last ID from the prior page. The
optional `name` query is an exact match.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/personas/default` | Read the acting project's living default persona. |
| `GET` | `/v1/agents` | List agents. Supports `limit`, `cursor` and `name`. |
| `POST` | `/v1/agents` | Create an agent, with an optional first connection. |
| `GET` | `/v1/agents/:agent_id` | Read one visible agent. |
| `GET` | `/v1/agents/retell/:retell_agent_id` | Find connections that point to one Retell agent. |
| `GET` | `/v1/agents/:agent_id/connections` | List an agent's connections. |
| `POST` | `/v1/agents/:agent_id/connections` | Add a connection. |
| `GET` | `/v1/agents/:agent_id/connections/:connection_id` | Read one connection. |
| `GET` | `/v1/tests` | List tests. Supports `limit`, `cursor` and `name`. |
| `POST` | `/v1/tests` | Create a test. Omit `persona_ids` to use the project default. |
| `GET` | `/v1/tests/:test_id` | Read one test and its personas. |

An agent create accepts `name`, optional `description`, and optional
`connection`. A Retell connection is shaped like this:

```json
{
  "name": "retell-chat",
  "type": "retell",
  "modality": "chat",
  "environment": "development",
  "config": { "retellAgentId": "agent_..." },
  "credentials": { "apiKey": "..." }
}
```

The API seals the credential. Responses never contain it. They contain only
`credentials_hint`.

A test create accepts `name`, optional `description`, `scenario`, a non-empty
`expected_behaviors` list, optional `persona_ids`, and optional
`idempotency_key`. Requests with the same idempotency key and test name are
serialized, so concurrent onboarding commands reuse one test. Ordinary test
names remain non-unique.

## Errors

Errors use `{ "error": "code", "message": "plain explanation" }`.

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | A field, cursor or resource reference is invalid. |
| `401` | `not_authenticated` | No usable session or API key was sent. |
| `403` | `not_permitted` | The current role cannot take this action. |
| `404` | `no_such_*` | The resource is absent or outside the acting project. |
| `409` | `resource_conflict` | A living agent or connection already owns the name. |
| `429` | `too_many_requests` | The organization used its request budget. |
