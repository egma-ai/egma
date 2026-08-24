/**
 * The words the glossary bans, in the shapes that would slip past a reader.
 *
 * This is the whole banned list, not a sample of it, and it lives here rather
 * than beside any one check because there is more than one kind of text egma
 * writes for a person to read: the skills it puts in front of a coding agent,
 * and the cards it teaches a developer with while they wait. Two lists would
 * eventually differ, and the day they differed is the day one of them would be
 * wrong — and it would be the shorter one, quietly.
 *
 * Two kinds of entry are left out on purpose, and both are carve-outs the
 * glossary itself makes rather than gaps.
 *
 *   The bans the glossary qualifies — `result` as an entity, `metric` for
 *   scoring logic, `check` as a name for a grader — cannot be told apart from
 *   their ordinary English by a regular expression, and a guard that fires on
 *   "check the manifest" is a guard somebody turns off.
 *
 *   `session` is banned for an exchange and right for two seams: a signed-in
 *   browser session, and the protocol's own name for its connection to a
 *   driven coding agent. Neither belongs in text a developer reads, so the word
 *   is banned here in full — the carve-out lives in the code that speaks the
 *   protocol.
 */
export const BANNED = [
  /\beval\b/i,
  /\bevaluations?\b/i,
  /\bevaluators?\b/i,
  /\bscorers?\b/i,
  /\bcalls?\b/i,
  /\bcallers?\b/i,
  /\bconversations?\b/i,
  /\bdigital humans?\b/i,
  /\bsimulants?\b/i,
  /\bvirtual humans?\b/i,
  /\bsynthetic users?\b/i,
  /\bdigital twins?\b/i,
  /\bscenarios?\b/i,
  /\bsessions?\b/i,
  /\btrials?\b/i,
  /\battempts?\b/i,
  /\biterations?\b/i,
  /\bexperiments?\b/i,
  /\bbatch(?:es)?\b/i,
  /\bexpected outcomes?\b/i,
];

/**
 * The one banned word a skill legitimately writes, in the one shape it may.
 *
 * The glossary bans `scenario` **as an entity** and keeps it as the name of a
 * field on a test — and the test file format calls its first heading exactly
 * that. A skill that teaches the format has to write the heading, so the
 * heading is taken out before the bans are run and every other use of the word
 * still fails. Written as the heading it is, backticks and all, and no wider
 * than that: a hash and blank space on the same line, the word, and a boundary
 * after it. A sentence about "the scenario" has no hash in front of it and a
 * heading called `## Scenarios` is the entity the glossary bans — neither can
 * hide behind this, and both still fail.
 *
 * It is a carve-out for a file format, not for prose, so nothing that is only
 * ever prose takes it: the teaching deck is checked against the bans whole.
 */
export const SCENARIO_HEADING = /`?#{1,6}[ \t]*scenario(?!\w)`?/gi;

/**
 * The LiveKit SDK's own object, in the shapes a skill writes it as code.
 *
 * The glossary bans `session` for an exchange and carves it out twice already,
 * both times for the same reason: **a `session` is standing machinery you
 * connect to, never the exchange a persona has with an agent.** The auth
 * provider owns one, the Agent Client Protocol owns one, and LiveKit Agents
 * owns a third — `AgentSession`, the object a worker builds and starts, and
 * the third argument of the Egma SDK's own public line.
 *
 * A skill that teaches where that line goes has to write the line, exactly as
 * the SDK publishes it: a skill that renamed somebody's variable to dodge a
 * word would teach a customer's coding agent to write code the SDK's own
 * documentation contradicts. So the SDK's three code shapes come out before
 * the bans are run, and every other use of the word still fails — "the
 * session", "one session", `## Sessions` and the rest are all still caught.
 *
 * It is a carve-out for someone else's identifier, not for prose.
 */
export const LIVEKIT_SESSION_OBJECT =
  /(?:await )?mockable\(agent, ctx, session\)|session = AgentSession|session\.start\(/g;

/** Every ban this text breaks, in the words it broke them with. */
export function bannedWordsIn(text: string): readonly string[] {
  return BANNED.flatMap((banned) => banned.exec(text)?.[0] ?? []);
}
