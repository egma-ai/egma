/**
 * The third belt of the `.env` fence.
 *
 * The protocol lets an agent read files through the client, and egma refuses a
 * fenced file when it does. But an agent may also read files itself, and then
 * the client never sees the path — so a fence that stands only in the protocol
 * is a fence with a gap in it.
 *
 * The protocol's `_meta` field on `session/new` is how a client passes an agent
 * something only that agent understands. Here it carries the one thing each
 * adapter needs in order to refuse a fenced file inside its own engine, where
 * the refusal reaches the model as the tool's own error and it moves on. This
 * is not a launch table: the command still comes from the registry, and an
 * agent with no entry here is still driven, still fenced at the protocol, and
 * still fully supported.
 */

/**
 * What the agent must refuse itself, in the shape Claude Code writes permission
 * rules. Two kinds, because an agent reaches a file two ways.
 *
 * By path, for the file tools: a bare name for the working folder, and the `//`
 * form for an absolute path anywhere on the machine.
 *
 * By the text of the command, for the terminal. `cat .env` carries no path
 * field for a path rule to read, so the rule matches the command itself: a
 * wildcard with no space in front of it binds nowhere, so `Bash(*.env*)` refuses
 * any command with `.env` anywhere in it, in any of the pieces a compound
 * command is split into. It refuses more than it must — a command that only
 * mentions `process.env` is refused too — and that is the side to be wrong on.
 */
const CLAUDE_DENY_RULES = [
  "Read(.env)",
  "Read(.env.*)",
  "Read(//**/.env)",
  "Read(//**/.env.*)",
  "Bash(*.env*)",
];

const SESSION_META: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  claude: {
    claudeCode: { options: { settings: { permissions: { deny: CLAUDE_DENY_RULES } } } },
  },
};

/** What to attach to `session/new` for this agent, or `null` for none. */
export function sessionMetaFor(drivenAgentId: string): Readonly<Record<string, unknown>> | null {
  return SESSION_META[drivenAgentId] ?? null;
}
